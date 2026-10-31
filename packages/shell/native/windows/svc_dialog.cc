// dialog.* — message boxes (TaskDialogIndirect through a comctl32 v6
// activation context, MessageBox fallback) and IFileOpenDialog/IFileSaveDialog.
// Every dialog runs from a posted task, never inside the call that requested
// it (WebView2 event handlers must not host nested modal loops); the reply
// arrives when the user answers.
#include "win.hpp"

#include <commctrl.h>
#include <shobjidl.h>


namespace sd::win {

// comctl32 v6 (TaskDialogIndirect) without relying on the executable's manifest:
// activate the manifest shell32.dll embeds (resource 124) around the call.
static HANDLE v6_context() {
  static HANDLE ctx = INVALID_HANDLE_VALUE;
  static bool tried = false;
  if (tried) return ctx;
  tried = true;
  wchar_t sys[MAX_PATH];
  GetSystemDirectoryW(sys, MAX_PATH);
  std::wstring shell32 = std::wstring(sys) + L"\\shell32.dll";
  ACTCTXW ac{};
  ac.cbSize = sizeof ac;
  ac.dwFlags = ACTCTX_FLAG_RESOURCE_NAME_VALID;
  ac.lpSource = shell32.c_str();
  ac.lpResourceName = MAKEINTRESOURCEW(124);
  ctx = CreateActCtxW(&ac);
  return ctx;
}

using TaskDialogIndirect_t = HRESULT(WINAPI *)(const TASKDIALOGCONFIG *, int *, int *, BOOL *);

static bool task_dialog(const json &o, HWND parent, const std::vector<std::wstring> &buttons, int cancelId, int &result) {
  HANDLE ctx = v6_context();
  ULONG_PTR cookie = 0;
  bool active = ctx != INVALID_HANDLE_VALUE && ActivateActCtx(ctx, &cookie);
  HMODULE comctl = LoadLibraryW(L"comctl32.dll");
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-function-type"
  auto fn = comctl ? reinterpret_cast<TaskDialogIndirect_t>(GetProcAddress(comctl, "TaskDialogIndirect")) : nullptr;
#pragma GCC diagnostic pop
  bool ok = false;
  if (fn) {
    std::wstring title = wide(jstr(o, "title", app_name()));
    std::wstring message = wide(jstr(o, "message", jstr(o, "title")));
    std::wstring detail = wide(jstr(o, "detail"));
    std::string type = jstr(o, "type", jstr(o, "style", "info"));
    std::vector<TASKDIALOG_BUTTON> tb;
    for (size_t i = 0; i < buttons.size(); i++) tb.push_back(TASKDIALOG_BUTTON{(int)(100 + i), buttons[i].c_str()});
    TASKDIALOGCONFIG cfg{};
    cfg.cbSize = sizeof cfg;
    cfg.hwndParent = parent;
    cfg.dwFlags = TDF_POSITION_RELATIVE_TO_WINDOW | (cancelId >= 0 ? TDF_ALLOW_DIALOG_CANCELLATION : 0);
    cfg.pszWindowTitle = title.c_str();
    cfg.pszMainInstruction = message.c_str();
    cfg.pszContent = detail.empty() ? nullptr : detail.c_str();
    cfg.pszMainIcon = (type == "critical" || type == "error") ? TD_ERROR_ICON : type == "warning" ? TD_WARNING_ICON : TD_INFORMATION_ICON;
    cfg.cButtons = (UINT)tb.size();
    cfg.pButtons = tb.data();
    cfg.nDefaultButton = 100;
    int pressed = 0;
    if (SUCCEEDED(fn(&cfg, &pressed, nullptr, nullptr))) {
      ok = true;
      result = pressed >= 100 ? pressed - 100 : (cancelId >= 0 ? cancelId : (int)buttons.size() - 1);
    }
  }
  if (active) DeactivateActCtx(0, cookie);
  return ok;
}

static int message_box_fallback(const json &o, HWND parent, const std::vector<std::wstring> &buttons, int cancelId) {
  std::wstring text = wide(jstr(o, "message", jstr(o, "title")));
  std::string detail = jstr(o, "detail");
  if (!detail.empty()) text += L"\n\n" + wide(detail);
  std::string type = jstr(o, "type", jstr(o, "style", "info"));
  UINT icon = (type == "critical" || type == "error") ? MB_ICONERROR : type == "warning" ? MB_ICONWARNING : MB_ICONINFORMATION;
  UINT kind = buttons.size() >= 3 ? MB_YESNOCANCEL : buttons.size() == 2 ? MB_OKCANCEL : MB_OK;
  int r = MessageBoxW(parent, text.c_str(), wide(jstr(o, "title", app_name())).c_str(), kind | icon | MB_SETFOREGROUND);
  switch (r) {
    case IDOK:
    case IDYES: return 0;
    case IDNO: return 1;
    case IDCANCEL: return buttons.size() >= 3 ? 2 : buttons.size() == 2 ? 1 : (cancelId >= 0 ? cancelId : 0);
  }
  return 0;
}

void run_message_box(const json &o, HWND parent, std::function<void(int button)> done) {
  std::vector<std::wstring> buttons;
  if (o.contains("buttons") && o["buttons"].is_array())
    for (auto &b : o["buttons"]) buttons.push_back(wide(b.is_string() ? b.get<std::string>() : b.dump()));
  if (buttons.empty()) buttons.push_back(L"OK");
  int cancelId = (int)jnum(o, "cancelId", buttons.size() > 1 ? (double)buttons.size() - 1 : -1);
  backend_run_on_main([o, parent, buttons, cancelId, done] {
    int result = 0;
    if (!task_dialog(o, parent, buttons, cancelId, result)) result = message_box_fallback(o, parent, buttons, cancelId);
    done(result);
  });
}

static IShellItem *item_for(const std::wstring &path) {
  IShellItem *item = nullptr;
  if (FAILED(SHCreateItemFromParsingName(path.c_str(), nullptr, IID_IShellItem, reinterpret_cast<void **>(&item)))) return nullptr;
  return item;
}

static std::string item_path(IShellItem *item) {
  wchar_t *p = nullptr;
  std::string out;
  if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p)) && p) out = utf8(p);
  if (p) CoTaskMemFree(p);
  return out;
}

void run_file_dialog(const json &o, bool save, HWND parent, std::function<void(bool canceled, std::vector<std::string> paths)> done) {
  backend_run_on_main([o, save, parent, done] {
    IFileDialog *dlg = nullptr;
    HRESULT hr = CoCreateInstance(save ? CLSID_FileSaveDialog : CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                  save ? IID_IFileSaveDialog : IID_IFileOpenDialog, reinterpret_cast<void **>(&dlg));
    if (FAILED(hr) || !dlg) return done(true, {});
    FILEOPENDIALOGOPTIONS opts = 0;
    dlg->GetOptions(&opts);
    opts |= FOS_FORCEFILESYSTEM;
    if (!save) {
      if (jbool(o, "multiple", false)) opts |= FOS_ALLOWMULTISELECT;
      if (jbool(o, "directories", false)) opts |= FOS_PICKFOLDERS; // Windows picks files or folders, not both
      opts |= FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST;
    } else {
      opts |= FOS_OVERWRITEPROMPT;
    }
    dlg->SetOptions(opts);
    std::string title = jstr(o, "title", jstr(o, "message"));
    if (!title.empty()) dlg->SetTitle(wide(title).c_str());
    std::string prompt = jstr(o, "prompt");
    if (!prompt.empty()) dlg->SetOkButtonLabel(wide(prompt).c_str());

    // Filters: [{name, extensions}] (platform API) or extensions[] (shell_dialog).
    std::vector<std::pair<std::wstring, std::wstring>> specs;
    std::wstring defaultExt;
    auto add = [&](const std::string &name, const json &exts) {
      std::wstring pattern;
      for (auto &e : exts) {
        if (!e.is_string()) continue;
        std::string ext = e.get<std::string>();
        if (!ext.empty() && ext[0] == '.') ext = ext.substr(1);
        if (!pattern.empty()) pattern += L";";
        pattern += ext == "*" ? L"*.*" : L"*." + wide(ext);
        if (defaultExt.empty() && ext != "*") defaultExt = wide(ext);
      }
      if (!pattern.empty()) specs.emplace_back(wide(name.empty() ? "Files" : name), pattern);
    };
    if (o.contains("filters") && o["filters"].is_array())
      for (auto &f : o["filters"])
        if (f.is_object() && f.contains("extensions") && f["extensions"].is_array()) add(jstr(f, "name"), f["extensions"]);
    if (o.contains("extensions") && o["extensions"].is_array()) add("Files", o["extensions"]);
    std::vector<COMDLG_FILTERSPEC> filter;
    for (auto &[name, pattern] : specs) filter.push_back(COMDLG_FILTERSPEC{name.c_str(), pattern.c_str()});
    if (!filter.empty() && !(opts & FOS_PICKFOLDERS)) dlg->SetFileTypes((UINT)filter.size(), filter.data());
    if (save && !defaultExt.empty()) dlg->SetDefaultExtension(defaultExt.c_str());

    std::string def = jstr(o, "defaultPath");
    if (!def.empty()) {
      std::wstring p = wide(def);
      for (auto &ch : p)
        if (ch == L'/') ch = L'\\';
      DWORD attrs = GetFileAttributesW(p.c_str());
      if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
        if (IShellItem *folder = item_for(p)) {
          dlg->SetFolder(folder);
          folder->Release();
        }
      } else {
        auto slash = p.find_last_of(L'\\');
        if (slash != std::wstring::npos)
          if (IShellItem *folder = item_for(p.substr(0, slash))) {
            dlg->SetFolder(folder);
            folder->Release();
          }
        dlg->SetFileName((slash == std::wstring::npos ? p : p.substr(slash + 1)).c_str());
      }
    }
    std::string name = jstr(o, "suggestedName", jstr(o, "defaultName"));
    if (!name.empty()) dlg->SetFileName(wide(name).c_str());

    hr = dlg->Show(parent);
    std::vector<std::string> paths;
    if (SUCCEEDED(hr)) {
      if (save) {
        IShellItem *item = nullptr;
        if (SUCCEEDED(dlg->GetResult(&item)) && item) {
          paths.push_back(item_path(item));
          item->Release();
        }
      } else {
        IShellItemArray *items = nullptr;
        if (SUCCEEDED(static_cast<IFileOpenDialog *>(dlg)->GetResults(&items)) && items) {
          DWORD n = 0;
          items->GetCount(&n);
          for (DWORD i = 0; i < n; i++) {
            IShellItem *item = nullptr;
            if (SUCCEEDED(items->GetItemAt(i, &item)) && item) {
              std::string p = item_path(item);
              if (!p.empty()) paths.push_back(p);
              item->Release();
            }
          }
          items->Release();
        }
      }
    }
    dlg->Release();
    done(FAILED(hr) || paths.empty(), paths);
  });
}

static HWND parent_for(const Call &c) {
  Window *w = find_window(resolve_window(c));
  return w && IsWindowVisible(w->hwnd) ? w->hwnd : nullptr;
}

static void message_box(CallPtr c, bool confirm) {
  json o = c->args;
  if (!(o.contains("buttons") && o["buttons"].is_array())) o["buttons"] = confirm ? json::array({"OK", "Cancel"}) : json::array({"OK"});
  int count = (int)o["buttons"].size();
  int cancelId = (int)jnum(o, "cancelId", count > 1 ? count - 1 : -1);
  o["cancelId"] = cancelId;
  run_message_box(o, parent_for(*c), [c, confirm, cancelId](int response) {
    if (confirm) c->ok(response == 0);
    else c->ok(json{{"response", response}, {"canceled", response == cancelId}});
  });
}

void register_dialog() {
  reg("dialog", "showMessageBox", [](CallPtr c) { message_box(c, false); });
  reg("dialog", "showConfirm", [](CallPtr c) { message_box(c, true); });
  reg("dialog", "showOpenDialog", [](CallPtr c) {
    run_file_dialog(c->args, false, parent_for(*c), [c](bool canceled, std::vector<std::string> paths) {
      c->ok(json{{"canceled", canceled}, {"paths", paths}});
    });
  });
  reg("dialog", "showSaveDialog", [](CallPtr c) {
    run_file_dialog(c->args, true, parent_for(*c), [c](bool canceled, std::vector<std::string> paths) {
      c->ok(json{{"canceled", canceled}, {"path", canceled ? json(nullptr) : json(paths[0])}});
    });
  });
}

} // namespace sd::win
