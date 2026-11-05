// The Python bridge: a native plugin (native/include/kitop.h) that registers the app's
// Python commands as platform ops and runs them in one Python process of the app's own.
//
// It reads its manifest — written by the build — next to the library (libapp-python.manifest), or
// in the macOS bundle's Resources/python/manifest. One directive per line:
//
//   python <interpreter>        argv[0]
//   arg <argument>              each following argv entry
//   env <NAME>=<value>          added to the inherited environment
//   cwd <directory>
//   command <service> <op>      one per command
//   describe <json>             what sd_plugin_describe returns (the commands' TypeScript types)
//
// `${here}` in a value is the manifest's folder. The process starts with the plugin (Python boots
// while the page loads); calls are written on its stdin as JSON lines, and it answers on stdout
// (see native/sdk/python/kitop/_protocol.py). When it exits, its pending calls reject and
// the next call starts a new one. It ends with the app: its stdin closes and it exits.
//
// `__python.restart` replaces the process (the dev server calls it when a .py file changes).
#include "kitop.h"

#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#define NOMINMAX
#include <windows.h>
#define SD_EXPORT extern "C" __declspec(dllexport)
#else
#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#define SD_EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace {

const sd_host *H = nullptr;

struct Manifest {
  std::string dir, python, cwd, describe;
  std::vector<std::string> args;
  std::vector<std::pair<std::string, std::string>> env;
  std::vector<std::pair<std::string, std::string>> commands;
};
Manifest M;
bool loaded = false;

void log(const std::string &s) {
  if (H) H->log(("[python] " + s).c_str());
  else fprintf(stderr, "[python] %s\n", s.c_str());
}

// ---------------------------------------------------------------------------
// The manifest

std::string library_path() {
#if defined(_WIN32)
  HMODULE mod = nullptr;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, reinterpret_cast<LPCWSTR>(&library_path), &mod);
  wchar_t buf[32768];
  DWORD n = GetModuleFileNameW(mod, buf, 32768);
  int len = WideCharToMultiByte(CP_UTF8, 0, buf, (int)n, nullptr, 0, nullptr, nullptr);
  std::string out(len, '\0');
  WideCharToMultiByte(CP_UTF8, 0, buf, (int)n, out.data(), len, nullptr, nullptr);
  return out;
#else
  Dl_info info{};
  if (dladdr(reinterpret_cast<void *>(&library_path), &info) && info.dli_fname) return info.dli_fname;
  return "";
#endif
}

std::string dirname_of(const std::string &p) {
  size_t i = p.find_last_of("/\\");
  return i == std::string::npos ? "." : p.substr(0, i);
}

std::string expand(std::string v, const std::string &here) {
  for (size_t i; (i = v.find("${here}")) != std::string::npos;) v.replace(i, 7, here);
  return v;
}

bool read_manifest() {
  if (loaded) return !M.python.empty() || !M.describe.empty();
  loaded = true;
  std::string lib = library_path();
  std::string dir = dirname_of(lib);
  std::string base = lib.substr(dir.size() + (dir.size() < lib.size() ? 1 : 0));
  size_t dot = base.find_last_of('.');
  std::vector<std::string> candidates = {dir + "/" + (dot == std::string::npos ? base : base.substr(0, dot)) + ".manifest",
                                         dir + "/../../Resources/python/manifest",  // Contents/Frameworks/plugins → Contents/Resources
                                         dir + "/python/manifest"};
  for (const auto &file : candidates) {
    std::ifstream in(file, std::ios::binary);
    if (!in) continue;
    M.dir = dirname_of(file);
    std::string line;
    while (std::getline(in, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      size_t sp = line.find(' ');
      if (sp == std::string::npos) continue;
      std::string key = line.substr(0, sp), value = line.substr(sp + 1);
      if (key == "describe") M.describe = value;
      else if (key == "python") M.python = expand(value, M.dir);
      else if (key == "arg") M.args.push_back(expand(value, M.dir));
      else if (key == "cwd") M.cwd = expand(value, M.dir);
      else if (key == "env") {
        size_t eq = value.find('=');
        if (eq != std::string::npos) M.env.emplace_back(value.substr(0, eq), expand(value.substr(eq + 1), M.dir));
      } else if (key == "command") {
        size_t s2 = value.find(' ');
        if (s2 != std::string::npos) M.commands.emplace_back(value.substr(0, s2), value.substr(s2 + 1));
      }
    }
    return true;
  }
  log("no manifest next to " + lib + " — the Python commands are unavailable");
  return false;
}

// ---------------------------------------------------------------------------
// One Python process

struct Process {
  std::mutex mu;
  std::map<long, sd_call *> pending;
  std::deque<std::string> stderr_tail;
  std::deque<std::string> outbox;
  std::condition_variable outbox_cv;
  bool alive = false, closing = false, ready = false, replaced = false;
#if defined(_WIN32)
  HANDLE proc = nullptr, in = nullptr, out = nullptr, err = nullptr;
#else
  pid_t pid = -1;
  int in = -1, out = -1, err = -1;
#endif

  std::string tail() {
    std::string s;
    for (const auto &l : stderr_tail) s += (s.empty() ? "" : " | ") + l;
    return s;
  }
};

std::mutex current_mu;
std::shared_ptr<Process> current;
std::atomic<long> next_id{1};
std::atomic<bool> quitting{false};

void fail_all(const std::shared_ptr<Process> &p, const std::string &why) {
  std::map<long, sd_call *> calls;
  {
    std::lock_guard<std::mutex> g(p->mu);
    calls.swap(p->pending);
  }
  for (auto &[id, call] : calls) H->reject(call, "internal", why.c_str());
}

bool write_all(const std::shared_ptr<Process> &p, const std::string &data) {
  const char *buf = data.data();
  size_t left = data.size();
  while (left) {
#if defined(_WIN32)
    DWORD n = 0;
    if (!WriteFile(p->in, buf, (DWORD)left, &n, nullptr)) return false;
#else
    ssize_t n = write(p->in, buf, left);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
#endif
    buf += n;
    left -= (size_t)n;
  }
  return true;
}

// Reads lines from a pipe until EOF.
template <typename F>
void read_lines(const std::shared_ptr<Process> &p, bool stdout_pipe, F on_line) {
  std::string buf;
  char chunk[65536];
  for (;;) {
#if defined(_WIN32)
    DWORD n = 0;
    if (!ReadFile(stdout_pipe ? p->out : p->err, chunk, sizeof chunk, &n, nullptr) || n == 0) break;
#else
    ssize_t n = read(stdout_pipe ? p->out : p->err, chunk, sizeof chunk);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
#endif
    buf.append(chunk, (size_t)n);
    size_t start = 0;
    for (size_t nl; (nl = buf.find('\n', start)) != std::string::npos; start = nl + 1) {
      std::string line = buf.substr(start, nl - start);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      on_line(line);
    }
    buf.erase(0, start);
  }
}

void on_reply(const std::shared_ptr<Process> &p, const std::string &line) {
  if (line == "READY") {
    std::lock_guard<std::mutex> g(p->mu);
    p->ready = true;
    return;
  }
  if (line.size() < 2 || line[1] != ' ') return;
  char kind = line[0];
  std::string rest = line.substr(2);
  if (kind == 'R' || kind == 'E') {
    size_t sp = rest.find(' ');
    long id = std::strtol(rest.substr(0, sp).c_str(), nullptr, 10);
    sd_call *call = nullptr;
    {
      std::lock_guard<std::mutex> g(p->mu);
      auto it = p->pending.find(id);
      if (it == p->pending.end()) return;
      call = it->second;
      p->pending.erase(it);
    }
    std::string body = sp == std::string::npos ? "" : rest.substr(sp + 1);
    if (kind == 'R') H->resolve(call, body.empty() ? "null" : body.c_str());
    else {
      size_t sp2 = body.find(' ');
      std::string code = body.substr(0, sp2), message = sp2 == std::string::npos ? code : body.substr(sp2 + 1);
      H->reject(call, code.c_str(), message.c_str());
    }
  } else if (kind == 'V') {
    size_t sp = rest.find(' ');
    std::string name = rest.substr(0, sp), data = sp == std::string::npos ? "null" : rest.substr(sp + 1);
    H->emit(name.c_str(), data.c_str());
  } else if (kind == 'L') {
    H->log(rest.c_str());
  }
}

#if defined(_WIN32)
std::wstring widen(const std::string &s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
  return w;
}

// The MSVC runtime's argument quoting.
std::wstring quote(const std::wstring &a) {
  if (!a.empty() && a.find_first_of(L" \t\n\v\"") == std::wstring::npos) return a;
  std::wstring q = L"\"";
  for (size_t i = 0;; ++i) {
    size_t slashes = 0;
    while (i < a.size() && a[i] == L'\\') ++i, ++slashes;
    if (i == a.size()) {
      q.append(slashes * 2, L'\\');
      break;
    }
    if (a[i] == L'"') q.append(slashes * 2 + 1, L'\\');
    else q.append(slashes, L'\\');
    q.push_back(a[i]);
  }
  return q + L"\"";
}

HANDLE job() {
  // Every Python process in a job that dies with the app, even when it's killed.
  static HANDLE j = [] {
    HANDLE h = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (h) SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info, sizeof info);
    return h;
  }();
  return j;
}
#endif

// Starts a process; on failure returns null with `error` set.
std::shared_ptr<Process> spawn(std::string &error) {
  auto p = std::make_shared<Process>();
#if defined(_WIN32)
  SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
  HANDLE in_r, in_w, out_r, out_w, err_r, err_w;
  if (!CreatePipe(&in_r, &in_w, &sa, 0) || !CreatePipe(&out_r, &out_w, &sa, 0) || !CreatePipe(&err_r, &err_w, &sa, 0)) {
    error = "could not create pipes";
    return nullptr;
  }
  SetHandleInformation(in_w, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0);
  std::wstring cmd = quote(widen(M.python));
  for (const auto &a : M.args) cmd += L" " + quote(widen(a));
  // The inherited environment with the manifest's variables on top.
  std::map<std::wstring, std::wstring, bool (*)(const std::wstring &, const std::wstring &)> vars(
      [](const std::wstring &a, const std::wstring &b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
  if (wchar_t *block = GetEnvironmentStringsW()) {
    for (wchar_t *e = block; *e; e += wcslen(e) + 1) {
      std::wstring kv = e;
      size_t eq = kv.find(L'=', 1);
      if (eq != std::wstring::npos) vars[kv.substr(0, eq)] = kv.substr(eq + 1);
    }
    FreeEnvironmentStringsW(block);
  }
  for (const auto &[k, v] : M.env) vars[widen(k)] = widen(v);
  std::wstring env;
  for (const auto &[k, v] : vars) env += k + L"=" + v + L'\0';
  env += L'\0';
  STARTUPINFOW si{sizeof si};
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = in_r;
  si.hStdOutput = out_w;
  si.hStdError = err_w;
  PROCESS_INFORMATION pi{};
  std::wstring cwd = widen(M.cwd);
  BOOL ok = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED, env.data(),
                           cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  CloseHandle(in_r);
  CloseHandle(out_w);
  CloseHandle(err_w);
  if (!ok) {
    error = "could not start " + M.python + " (error " + std::to_string(GetLastError()) + ")";
    CloseHandle(in_w), CloseHandle(out_r), CloseHandle(err_r);
    return nullptr;
  }
  if (HANDLE j = job()) AssignProcessToJobObject(j, pi.hProcess);
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  p->proc = pi.hProcess, p->in = in_w, p->out = out_r, p->err = err_r;
#else
  int in[2], out[2], err[2];
  if (pipe(in) || pipe(out) || pipe(err)) {
    error = std::string("could not create pipes: ") + strerror(errno);
    return nullptr;
  }
  for (int fd : {in[0], in[1], out[0], out[1], err[0], err[1]}) fcntl(fd, F_SETFD, FD_CLOEXEC);
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, in[0], 0);
  posix_spawn_file_actions_adddup2(&fa, out[1], 1);
  posix_spawn_file_actions_adddup2(&fa, err[1], 2);
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
#if defined(__APPLE__)
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_CLOEXEC_DEFAULT);  // nothing else of the app leaks in
  posix_spawn_file_actions_addinherit_np(&fa, 0);
  posix_spawn_file_actions_addinherit_np(&fa, 1);
  posix_spawn_file_actions_addinherit_np(&fa, 2);
#endif
  std::vector<std::string> argv_s = {M.python};
  argv_s.insert(argv_s.end(), M.args.begin(), M.args.end());
  std::vector<char *> argv;
  for (auto &a : argv_s) argv.push_back(a.data());
  argv.push_back(nullptr);
  std::vector<std::string> env_s;
  for (char **e = environ; *e; ++e) {
    std::string kv = *e;
    std::string key = kv.substr(0, kv.find('='));
    bool overridden = false;
    for (const auto &[k, v] : M.env) overridden |= k == key;
    if (!overridden) env_s.push_back(kv);
  }
  for (const auto &[k, v] : M.env) env_s.push_back(k + "=" + v);
  std::vector<char *> envp;
  for (auto &e : env_s) envp.push_back(e.data());
  envp.push_back(nullptr);
  // posix_spawn has no cwd before macOS 26 / glibc 2.29's addchdir: the interpreter is given
  // absolute paths, so the working directory only matters to the app's own code.
#if defined(__APPLE__) || (defined(__GLIBC__) && (__GLIBC__ > 2 || (__GLIBC__ == 2 && __GLIBC_MINOR__ >= 29)))
  if (!M.cwd.empty()) posix_spawn_file_actions_addchdir_np(&fa, M.cwd.c_str());
#endif
  pid_t pid;
  int rc = posix_spawn(&pid, M.python.c_str(), &fa, &attr, argv.data(), envp.data());
  posix_spawn_file_actions_destroy(&fa);
  posix_spawnattr_destroy(&attr);
  close(in[0]), close(out[1]), close(err[1]);
  if (rc != 0) {
    error = "could not start " + M.python + ": " + strerror(rc);
    close(in[1]), close(out[0]), close(err[0]);
    return nullptr;
  }
  p->pid = pid, p->in = in[1], p->out = out[0], p->err = err[0];
#endif
  p->alive = true;

  // stdin: written by one thread, so a busy process never blocks the UI thread.
  std::thread([p] {
    for (;;) {
      std::string data;
      {
        std::unique_lock<std::mutex> g(p->mu);
        p->outbox_cv.wait(g, [&] { return !p->outbox.empty() || p->closing || !p->alive; });
        if (p->outbox.empty()) break;
        data.swap(p->outbox.front());
        p->outbox.pop_front();
      }
      if (!write_all(p, data)) break;
    }
#if defined(_WIN32)
    CloseHandle(p->in);
#else
    close(p->in);
#endif
  }).detach();

  // stderr: forwarded to the app's stderr (the dev terminal, the log file), the last lines kept
  // for the error of the calls a crash rejects.
  std::thread([p] {
    read_lines(p, false, [&](const std::string &line) {
      fprintf(stderr, "%s\n", line.c_str());
      std::lock_guard<std::mutex> g(p->mu);
      p->stderr_tail.push_back(line);
      if (p->stderr_tail.size() > 6) p->stderr_tail.pop_front();
    });
  }).detach();

  // stdout: the replies, until the process ends.
  std::thread([p] {
    read_lines(p, true, [&](const std::string &line) { on_reply(p, line); });
    int code = -1;
#if defined(_WIN32)
    WaitForSingleObject(p->proc, INFINITE);
    DWORD c = 0;
    GetExitCodeProcess(p->proc, &c);
    code = (int)c;
    CloseHandle(p->proc), CloseHandle(p->out), CloseHandle(p->err);
#else
    int status = 0;
    while (waitpid(p->pid, &status, 0) < 0 && errno == EINTR) {
    }
    code = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
    close(p->out), close(p->err);
#endif
    std::this_thread::sleep_for(std::chrono::milliseconds(50));  // the last stderr lines
    {
      std::lock_guard<std::mutex> g(p->mu);
      p->alive = false;
    }
    p->outbox_cv.notify_all();
    {
      std::lock_guard<std::mutex> g(current_mu);
      if (current == p) current.reset();
    }
    if (quitting) return;
    bool replaced;
    {
      std::lock_guard<std::mutex> g(p->mu);
      replaced = p->replaced;
    }
    if (replaced) {
      fail_all(p, "the Python process was restarted");
      return;
    }
    std::string why = "the Python process exited (" + (code < 0 ? "signal " + std::to_string(-code) : "code " + std::to_string(code)) + ")";
    std::string tail;
    {
      std::lock_guard<std::mutex> g(p->mu);
      if (!p->ready) tail = p->tail();  // it failed to start: the reason is in its last lines
    }
    if (!tail.empty()) why += " while starting: " + tail;
    log(why);
    fail_all(p, why);
  }).detach();
  return p;
}

std::shared_ptr<Process> ensure(std::string &error) {
  std::lock_guard<std::mutex> g(current_mu);
  if (!current) current = spawn(error);
  return current;
}

void stop_all() {
  quitting = true;
  std::shared_ptr<Process> p;
  {
    std::lock_guard<std::mutex> g(current_mu);
    p = current;
  }
  if (!p) return;
  {
    std::lock_guard<std::mutex> g(p->mu);
    p->closing = true;
  }
  p->outbox_cv.notify_all();  // stdin closes: the runner exits
#if !defined(_WIN32)
  if (p->pid > 0) {
    for (int i = 0; i < 20 && kill(p->pid, 0) == 0; ++i) usleep(25000);
    kill(p->pid, SIGTERM);
  }
#endif
}

void kill_process(const std::shared_ptr<Process> &p) {
#if defined(_WIN32)
  TerminateProcess(p->proc, 1);
#else
  kill(p->pid, SIGKILL);
#endif
}

void restart(sd_call *call, const char *, void *) {
  std::shared_ptr<Process> old;
  {
    std::lock_guard<std::mutex> g(current_mu);
    old.swap(current);
  }
  if (old) {
    {
      std::lock_guard<std::mutex> g(old->mu);
      old->replaced = true;
    }
    kill_process(old);
  }
  std::string error;
  if (ensure(error)) H->resolve(call, "null");
  else H->reject(call, "unavailable", ("Python: " + error).c_str());
}

void dispatch(sd_call *call, const char *args_json, void *user) {
  const auto &cmd = M.commands[(size_t)(uintptr_t)user];
  std::string error;
  auto p = ensure(error);
  if (!p) {
    H->reject(call, "unavailable", ("Python: " + error).c_str());
    return;
  }
  long id = next_id++;
  std::string args = args_json && *args_json ? args_json : "{}";
  for (char &c : args)
    if (c == '\n' || c == '\r') c = ' ';  // whitespace between JSON tokens: the request stays one line
  std::string line = "{\"id\":" + std::to_string(id) + ",\"service\":\"" + cmd.first + "\",\"op\":\"" + cmd.second + "\",\"args\":" + args + "}\n";
  {
    std::lock_guard<std::mutex> g(p->mu);
    if (!p->alive) {
      H->reject(call, "internal", "the Python process exited");
      return;
    }
    p->pending[id] = call;
    p->outbox.push_back(std::move(line));
  }
  p->outbox_cv.notify_one();
}

}  // namespace

SD_EXPORT int sd_plugin_init(const sd_host *host) {
  if (!host || host->abi != SD_ABI_VERSION) return -1;
  H = host;
  if (!read_manifest() || M.python.empty()) return 0;
  for (size_t i = 0; i < M.commands.size(); ++i) {
    const auto &[service, op] = M.commands[i];
    if (H->register_op(service.c_str(), op.c_str(), dispatch, (void *)(uintptr_t)i) != 0)
      log("command " + service + "." + op + " not registered: the name is already taken (the shell or another plugin)");
  }
  H->register_op("__python", "restart", restart, nullptr);
  std::string error;
  if (!ensure(error)) log(error);
  std::atexit(stop_all);
  return 0;
}

SD_EXPORT const char *sd_plugin_describe(void) {
  read_manifest();
  static std::string d = M.describe.empty() ? std::string("{\"language\":\"python\",\"commands\":[]}") : M.describe;
  return d.c_str();
}
