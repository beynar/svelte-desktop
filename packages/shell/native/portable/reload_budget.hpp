// How a view comes back from a dead web process, on all three backends: reload it, after a growing
// delay, until it has died too often for that to be useful. Then the app's server shows a page that
// says so (src/gate.ts), and the user decides: a page that kills its process would reload forever.
#pragma once

#include <cctype>
#include <cstdio>
#include <string>

namespace sd {

struct ReloadBudget {
  static constexpr int kLimit = 3;
  static constexpr double kWindowSeconds = 300;
  double times[kLimit] = {};
  int used = 0;

  /// Milliseconds to wait before reloading, or -1 to stop reloading.
  int next(double nowSeconds) {
    static constexpr int delays[kLimit] = {100, 1000, 4000};
    int kept = 0;
    for (int i = 0; i < used; i++)
      if (nowSeconds - times[i] < kWindowSeconds) times[kept++] = times[i];
    used = kept;
    if (used >= kLimit) return -1;
    times[used] = nowSeconds;
    return delays[used++];
  }
};

/// The page to show once a view at `url` has stopped reloading. Empty for what the app's server
/// doesn't serve (another site, no server yet) and for that page itself, if it's the one crashing.
inline std::string crashed_page_url(const std::string &origin, const std::string &url) {
  static const std::string path = "/__desktop/page-crashed";
  if (origin.empty() || url.compare(0, origin.size(), origin) != 0) return "";
  std::string to = url.substr(origin.size());
  if (!to.empty() && to[0] != '/' && to[0] != '?' && to[0] != '#') return ""; // a longer port, a longer host
  if (to.compare(0, path.size(), path) == 0) return "";
  std::string encoded;
  for (unsigned char c : to.empty() || to[0] != '/' ? "/" + to : to) {
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || c == '/') encoded += (char)c;
    else {
      char hex[4];
      snprintf(hex, sizeof hex, "%%%02X", c);
      encoded += hex;
    }
  }
  return origin + path + "?to=" + encoded;
}

} // namespace sd
