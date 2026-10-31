// Shared half of notifications.* for the portable backends (Linux, Windows): show
// argument parsing, responses (seq, ring of 64, claim queue, per-page `target`),
// the records of what this process showed, repeat arithmetic, the persisted
// schedule queue and data: URL images. Contract: ../NOTIFICATIONS.md.
//
// Header-only: include it from exactly one file per backend (svc_notifications.cc),
// which also defines the two hooks below. Main thread only.
#pragma once
#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>

#include "core.hpp"

namespace sd::notif {

// ---- hooks the backend defines -------------------------------------------------
/// The window that should run a response's default action: `preferred` (the window
/// that showed it) when it is open and its page loaded, else the active window, else
/// the first loaded one. 0 = no page is loaded.
int target_window(int preferred);
/// Unminimize, show and focus a window (click / foreground action).
void bring_to_front(int native_id);

// ---- show arguments --------------------------------------------------------------
struct Action {
  std::string id, title, placeholder, button;
  bool input = false, destructive = false, foreground = true;
};

struct Show {
  std::string id, title, body, subtitle, group, image, icon, sound, urgency = "normal", repeat, payload;
  std::string closeButtonText, toastXml; // a dismiss button · Windows raw toast XML
  bool silent = false, renotify = true, requireInteraction = false, hasAt = false, hasTimestamp = false;
  bool ongoing = false, autoCancel = true;
  double at = 0, timestamp = 0;
  std::vector<Action> actions;
  std::vector<std::string> lines; // inbox lines (TS also joins them into body when it has none)
};

inline double now_ms() {
  return (double)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

inline std::string jstr(const json &o, const char *k, const std::string &f = "") {
  auto it = o.find(k);
  return it != o.end() && it->is_string() ? it->get<std::string>() : f;
}

inline bool valid_repeat(const std::string &r) {
  return r == "minute" || r == "hour" || r == "day" || r == "week" || r == "month" || r == "year";
}

/// Parse + validate `show` args. false + *error ("invalid_args" message) on bad input.
inline bool parse_show(const json &a, Show &s, std::string *error) {
  static int gen = 1;
  auto fail = [&](const std::string &m) { return *error = "notifications.show: " + m, false; };
  if (!a.is_object()) return fail("arguments must be an object");
  if (!a.contains("title") || !a["title"].is_string()) return fail("`title` must be a string");
  s.title = a["title"].get<std::string>();
  s.id = jstr(a, "id", jstr(a, "tag"));
  if (s.id.empty()) s.id = "n" + std::to_string(gen++) + "-" + std::to_string((long long)now_ms());
  s.body = jstr(a, "body", jstr(a, "message"));
  s.subtitle = jstr(a, "subtitle");
  s.group = jstr(a, "group");
  s.image = jstr(a, "image");
  s.icon = jstr(a, "icon");
  s.sound = jstr(a, "sound");
  s.urgency = jstr(a, "urgency", "normal");
  if (s.urgency != "low" && s.urgency != "normal" && s.urgency != "critical") return fail("`urgency` must be low, normal or critical");
  s.silent = a.value("silent", false) == true;
  s.renotify = !(a.contains("renotify") && a["renotify"].is_boolean() && !a["renotify"].get<bool>());
  s.requireInteraction = a.contains("requireInteraction") && a["requireInteraction"].is_boolean() && a["requireInteraction"].get<bool>();
  if (a.contains("timestamp") && a["timestamp"].is_number()) s.hasTimestamp = true, s.timestamp = a["timestamp"].get<double>();
  if (a.contains("at") && !a["at"].is_null()) {
    if (!a["at"].is_number()) return fail("`at` must be epoch milliseconds");
    s.hasAt = true, s.at = a["at"].get<double>();
  }
  if (a.contains("repeat") && !a["repeat"].is_null()) {
    s.repeat = jstr(a, "repeat");
    if (!valid_repeat(s.repeat)) return fail("`repeat` must be minute, hour, day, week, month or year");
    if (!s.hasAt) return fail("`repeat` needs `at`");
  }
  s.ongoing = a.contains("ongoing") && a["ongoing"].is_boolean() && a["ongoing"].get<bool>();
  s.autoCancel = !(a.contains("autoCancel") && a["autoCancel"].is_boolean() && !a["autoCancel"].get<bool>());
  s.closeButtonText = jstr(a, "closeButtonText");
  s.toastXml = jstr(a, "toastXml");
  if (a.contains("lines") && a["lines"].is_array())
    for (auto &l : a["lines"])
      if (l.is_string()) s.lines.push_back(l.get<std::string>());
  // summary, color, visibility: Android only
  if (a.contains("payload") && !a["payload"].is_null()) s.payload = a["payload"].is_string() ? a["payload"].get<std::string>() : a["payload"].dump();
  if (a.contains("actions") && !a["actions"].is_null()) {
    if (!a["actions"].is_array()) return fail("`actions` must be an array");
    for (auto &x : a["actions"]) {
      if (!x.is_object() || !x.contains("id") || !x["id"].is_string() || x["id"].get<std::string>().empty())
        return fail("each action needs a string `id`");
      Action ac;
      ac.id = x["id"].get<std::string>();
      ac.title = jstr(x, "title", jstr(x, "label", ac.id));
      ac.destructive = x.value("destructive", false) == true;
      ac.foreground = !(x.contains("foreground") && x["foreground"].is_boolean() && !x["foreground"].get<bool>());
      if (x.contains("input") && !x["input"].is_null() && x["input"] != false) {
        ac.input = true;
        if (x["input"].is_object()) ac.placeholder = jstr(x["input"], "placeholder"), ac.button = jstr(x["input"], "button");
      }
      s.actions.push_back(ac);
    }
  }
  return true;
}

// ---- what this process showed ------------------------------------------------------
struct Record {
  std::string id, title, body, subtitle, group, payload;
  double date = 0;
  int window = 0;                       // native id of the window that showed it (0 = Worker)
  std::map<std::string, bool> foreground; // action id → brings the app to front
  bool acted = false;                   // a click/action was reported (ignore the close that follows)
  bool keep = false;                    // autoCancel:false / ongoing: stays after a click
};

inline std::map<std::string, Record> &records() {
  static std::map<std::string, Record> m;
  return m;
}

inline Record make_record(const Show &s, int window) {
  Record r{s.id, s.title, s.body, s.subtitle, s.group, s.payload, now_ms(), window, {}, false};
  for (auto &a : s.actions) r.foreground[a.id] = a.foreground;
  r.keep = s.ongoing || !s.autoCancel;
  return r;
}

inline json record_json(const Record &r) {
  json o{{"id", r.id}, {"title", r.title}, {"body", r.body}};
  if (!r.subtitle.empty()) o["subtitle"] = r.subtitle;
  if (!r.group.empty()) o["group"] = r.group;
  if (!r.payload.empty()) o["payload"] = r.payload;
  if (r.date > 0) o["date"] = r.date;
  return o;
}

/// What a toast clicked after a restart needs (Windows keeps its notifications across runs).
/// The window is process-local: not kept.
inline json record_to_disk(const Record &r) {
  json o = record_json(r);
  o["foreground"] = r.foreground;
  o["keep"] = r.keep;
  return o;
}

inline bool record_from_disk(const json &o, Record &r) {
  if (!o.is_object() || !o.contains("id") || !o["id"].is_string()) return false;
  r = Record{};
  r.id = o["id"];
  r.title = jstr(o, "title"), r.body = jstr(o, "body"), r.subtitle = jstr(o, "subtitle");
  r.group = jstr(o, "group"), r.payload = jstr(o, "payload");
  if (o.contains("date") && o["date"].is_number()) r.date = o["date"];
  if (o.contains("foreground") && o["foreground"].is_object())
    for (auto &[k, v] : o["foreground"].items())
      if (v.is_boolean()) r.foreground[k] = v;
  r.keep = o.contains("keep") && o["keep"].is_boolean() && o["keep"].get<bool>();
  return true;
}

// ---- responses ------------------------------------------------------------------
inline json &ring() {
  static json r = json::array();
  return r;
}
inline json &claim_queue() {
  static json q = json::array();
  return q;
}

/// notificationResponse: the Worker gets every response; pages get it with `target`
/// true in one window only. With no loaded page it waits in the claim queue.
/// `kind`: click | action | reply | dismiss. `input`: reply text or null.
inline void respond(const std::string &id, const std::string &kind, const std::string &actionId, const json &input, std::string payload,
                    int window) {
  static long long seq = 0;
  bool foreground = kind == "click";
  auto rec = records().find(id);
  if (rec != records().end()) {
    if (payload.empty()) payload = rec->second.payload;
    if (!window) window = rec->second.window;
    if (kind == "action" || kind == "reply") {
      auto f = rec->second.foreground.find(actionId);
      foreground = f == rec->second.foreground.end() || f->second;
    }
  } else if (kind == "action" || kind == "reply") foreground = true;
  json r{{"seq", ++seq}, {"id", id}, {"tag", id}, {"kind", kind}, {"actionId", actionId.empty() ? json(nullptr) : json(actionId)},
         {"payload", payload.empty() ? json(nullptr) : json(payload)}};
  if (input.is_string()) r["input"] = input;
  json &rg = ring();
  rg.push_back(r);
  while (rg.size() > 64) rg.erase(rg.begin());
  emit_raw(json{{"type", "platform"}, {"name", "notificationResponse"}, {"data", r}});
  int target = target_window(window);
  if (!target) {
    claim_queue().push_back(r);
    return;
  }
  for (int page : backend_page_ids()) {
    json p = r;
    p["target"] = page == target;
    backend_eval_in_page(page, deliver_js("notificationResponse", p));
  }
  if (foreground && kind != "dismiss") bring_to_front(target);
}

inline json take_claims() {
  json out = claim_queue();
  claim_queue() = json::array();
  return out;
}

inline void shown_event(const std::string &id, const std::string &payload) {
  emit("notificationShown", json{{"id", id}, {"payload", payload.empty() ? json(nullptr) : json(payload)}, {"push", false}});
}

// ---- repeats ----------------------------------------------------------------------
/// The next occurrence strictly after `after_ms` of a series that started at `at_ms`
/// (local calendar: a daily 9:00 stays 9:00 across DST). 0 when `repeat` is invalid.
inline double next_occurrence(double at_ms, const std::string &repeat, double after_ms) {
  if (!valid_repeat(repeat)) return 0;
  time_t base = (time_t)(at_ms / 1000);
  double frac = at_ms - (double)base * 1000;
  std::tm start{};
#if defined(_WIN32)
  localtime_s(&start, &base);
#else
  localtime_r(&base, &start);
#endif
  // Fixed-length steps: jump close first, then walk.
  long long n = 0;
  double step = repeat == "minute" ? 60e3 : repeat == "hour" ? 3600e3 : repeat == "day" ? 86400e3 : repeat == "week" ? 604800e3 : 0;
  if (step > 0 && after_ms > at_ms) n = (long long)((after_ms - at_ms) / step) - 2;
  if (repeat == "month" && after_ms > at_ms) n = (long long)((after_ms - at_ms) / (31 * 86400e3)) - 1;
  if (repeat == "year" && after_ms > at_ms) n = (long long)((after_ms - at_ms) / (366 * 86400e3)) - 1;
  if (n < 0) n = 0;
  for (int guard = 0; guard < 100000; guard++, n++) {
    if (repeat == "minute" || repeat == "hour") { // absolute steps
      double ms = at_ms + (double)n * step;
      if (ms > after_ms) return ms;
      continue;
    }
    std::tm t = start;
    t.tm_isdst = -1;
    if (repeat == "day") t.tm_mday += (int)n;
    else if (repeat == "week") t.tm_mday += (int)(7 * n);
    else if (repeat == "month") t.tm_mon += (int)n;
    else t.tm_year += (int)n;
    time_t v = mktime(&t);
    if (v == (time_t)-1) return 0;
    double ms = (double)v * 1000 + frac;
    if (ms > after_ms) return ms;
  }
  return 0;
}

// ---- persisted schedule: [{id, at, repeat?, args}] ----------------------------------
struct Store {
  std::string path;
  json items = json::array();

  void load() {
    items = json::array();
    std::ifstream f(std::filesystem::u8path(path), std::ios::binary);
    if (!f) return;
    std::stringstream ss;
    ss << f.rdbuf();
    json v = json::parse(ss.str(), nullptr, false);
    if (v.is_array())
      for (auto &e : v)
        if (e.is_object() && e.contains("id") && e["id"].is_string() && e.contains("at") && e["at"].is_number() && e.contains("args") &&
            e["args"].is_object())
          items.push_back(e);
  }
  /// "" when the queue is on disk, else why not (the caller refuses what it couldn't persist).
  std::string save() const {
    std::error_code ec;
    auto p = std::filesystem::u8path(path);
    std::filesystem::create_directories(p.parent_path(), ec);
    auto tmp = p;
    tmp += ".tmp";
    {
      std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
      if (!f) return "cannot write " + tmp.string();
      f << items.dump();
      if (!f.flush()) return "cannot write " + tmp.string();
    }
    std::filesystem::rename(tmp, p, ec);
    if (ec) {
      std::filesystem::remove(tmp, ec);
      return "cannot save " + p.string();
    }
    return "";
  }
  json *find(const std::string &id) {
    for (auto &e : items)
      if (e["id"] == id) return &e;
    return nullptr;
  }
  bool erase(const std::string &id) {
    for (size_t i = 0; i < items.size(); i++)
      if (items[i]["id"] == id) {
        items.erase(items.begin() + (long)i);
        return true;
      }
    return false;
  }
  void put(const std::string &id, double at, const std::string &repeat, const json &args) {
    erase(id);
    json e{{"id", id}, {"at", (long long)at}, {"args", args}};
    if (!repeat.empty()) e["repeat"] = repeat;
    items.push_back(e);
  }
};

/// pending entry for a stored item.
inline json pending_json(const json &e) {
  const json &a = e["args"];
  json o{{"id", e["id"]}, {"title", jstr(a, "title")}, {"body", jstr(a, "body")}, {"at", e["at"]}};
  if (e.contains("repeat")) o["repeat"] = e["repeat"];
  if (a.contains("payload") && !a["payload"].is_null()) o["payload"] = a["payload"].is_string() ? a["payload"] : json(a["payload"].dump());
  return o;
}

// ---- Windows toast activator ------------------------------------------------------
/// Per-app COM class id of the toast activator, derived from the identifier (same
/// derivation as toastActivatorClsid in src/build/package-windows.ts):
/// FNV-1a 64 of "svelte-desktop:toast-activator:" + id, then of the same bytes + "#",
/// laid out as a GUID with version 5 / RFC 4122 variant bits. "{XXXXXXXX-XXXX-…}".
inline std::string activator_clsid(const std::string &identifier) {
  auto fnv = [](const std::string &s) {
    unsigned long long h = 14695981039346656037ULL;
    for (unsigned char ch : s) h = (h ^ ch) * 1099511628211ULL;
    return h;
  };
  std::string base = "svelte-desktop:toast-activator:" + identifier;
  unsigned long long a = fnv(base), b = fnv(base + "#");
  unsigned d1 = (unsigned)(a >> 32), d2 = (unsigned)((a >> 16) & 0xffff), d3 = (unsigned)((a & 0x0fff) | 0x5000);
  unsigned char d4[8];
  for (int i = 0; i < 8; i++) d4[i] = (unsigned char)(b >> (56 - 8 * i));
  d4[0] = (unsigned char)((d4[0] & 0x3f) | 0x80);
  char buf[40];
  snprintf(buf, sizeof buf, "{%08X-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}", d1, d2, d3, d4[0], d4[1], d4[2], d4[3], d4[4], d4[5], d4[6], d4[7]);
  return buf;
}

// ---- images: path | file:// URL | data: URL → a local file path -------------------------
inline std::string b64decode(const std::string &in, bool *ok) {
  std::string out;
  int val = 0, bits = -8;
  *ok = true;
  for (unsigned char ch : in) {
    int d;
    if (ch >= 'A' && ch <= 'Z') d = ch - 'A';
    else if (ch >= 'a' && ch <= 'z') d = ch - 'a' + 26;
    else if (ch >= '0' && ch <= '9') d = ch - '0' + 52;
    else if (ch == '+' || ch == '-') d = 62;
    else if (ch == '/' || ch == '_') d = 63;
    else if (ch == '=' || ch == '\n' || ch == '\r' || ch == ' ') continue;
    else return *ok = false, "";
    val = (val << 6) | d;
    bits += 6;
    if (bits >= 0) {
      out.push_back((char)((val >> bits) & 0xff));
      bits -= 8;
    }
  }
  return out;
}

inline std::string percent_decode(const std::string &s) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '%' && i + 2 < s.size() && isxdigit((unsigned char)s[i + 1]) && isxdigit((unsigned char)s[i + 2])) {
      out.push_back((char)strtol(s.substr(i + 1, 2).c_str(), nullptr, 16));
      i += 2;
    } else out.push_back(s[i]);
  }
  return out;
}

/// Resolves an image spec to a local file: plain paths pass through, file:// URLs are
/// decoded, data: URLs are written once to `cache_dir` (named by content hash).
/// "" + *error when unusable.
inline std::string image_file(const std::string &spec, const std::string &cache_dir, std::string *error) {
  if (spec.rfind("file://", 0) == 0) {
    std::string p = percent_decode(spec.substr(7));
    if (p.rfind("localhost/", 0) == 0) p = p.substr(9);
#if defined(_WIN32)
    if (p.size() > 2 && p[0] == '/' && p[2] == ':') p = p.substr(1); // file:///C:/x → C:/x
#endif
    return p;
  }
  if (spec.rfind("data:", 0) != 0) return spec;
  size_t comma = spec.find(',');
  if (comma == std::string::npos) return *error = "malformed data: URL", "";
  std::string meta = spec.substr(5, comma - 5);
  bool b64 = meta.size() >= 7 && meta.compare(meta.size() - 7, 7, ";base64") == 0, ok = true;
  std::string bytes = b64 ? b64decode(spec.substr(comma + 1), &ok) : percent_decode(spec.substr(comma + 1));
  if (!ok || bytes.empty()) return *error = "undecodable data: URL", "";
  std::string ext = meta.find("image/jpeg") == 0 ? ".jpg" : meta.find("image/gif") == 0 ? ".gif" : meta.find("image/svg") == 0 ? ".svg"
                    : meta.find("image/webp") == 0 ? ".webp" : meta.find("image/bmp") == 0 ? ".bmp" : meta.find("image/x-icon") == 0 ? ".ico" : ".png";
  unsigned long long h = 14695981039346656037ULL; // FNV-1a
  for (unsigned char ch : bytes) h = (h ^ ch) * 1099511628211ULL;
  char name[40];
  snprintf(name, sizeof name, "%016llx", h);
  std::string path = cache_dir + "/" + name + ext;
  std::error_code ec;
  auto p = std::filesystem::u8path(path);
  if (std::filesystem::exists(p, ec)) return path;
  std::filesystem::create_directories(p.parent_path(), ec);
  std::ofstream f(p, std::ios::binary | std::ios::trunc);
  if (!f) return *error = "cannot write " + path, "";
  f.write(bytes.data(), (std::streamsize)bytes.size());
  return path;
}

} // namespace sd::notif
