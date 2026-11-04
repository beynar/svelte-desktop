// app.metrics: memory and CPU of the app's processes — the shell (UI thread, the Bun Worker with the
// server), each web view's WebKit content process, and the children it started (the Python process,
// services, jobs, sidecars) — like Electron's app.getAppMetrics(). Memory is the footprint macOS
// counts for the process (what Activity Monitor shows as Memory), and its resident size; CPU is the
// time used so far, and the share of one core since the previous call.
#import "platform_internal.h"
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <sys/resource.h>
#include <vector>

static void collect_webviews(NSView *v, NSMutableArray<WKWebView *> *out) {
  if ([v isKindOfClass:WKWebView.class]) [out addObject:(WKWebView *)v];
  for (NSView *s in v.subviews) collect_webviews(s, out);
}

static pid_t content_pid(WKWebView *wv) {
  SEL sel = NSSelectorFromString(@"_webProcessIdentifier"); // WebKit has no public API for it
  if (![wv respondsToSelector:sel]) return 0;
  pid_t pid = ((pid_t (*)(id, SEL))objc_msgSend)(wv, sel);
  return pid > 1 ? pid : 0;
}

static NSDictionary *sample(pid_t pid, NSString *type, NSDictionary *extra) {
  struct rusage_info_v4 ri;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) != 0) return nil;
  static mach_timebase_info_data_t tb;
  if (!tb.denom) mach_timebase_info(&tb);
  double cpu = (double)(ri.ri_user_time + ri.ri_system_time) * tb.numer / tb.denom / 1e9;
  double now = CACurrentMediaTime();
  // The share of one core since the previous call (null the first time a process is seen).
  static NSMutableDictionary<NSNumber *, NSArray<NSNumber *> *> *last;
  if (!last) last = [NSMutableDictionary new];
  NSArray<NSNumber *> *prev = last[@(pid)];
  id percent = prev && now > prev[1].doubleValue ? (id)@(MAX(0, (cpu - prev[0].doubleValue) / (now - prev[1].doubleValue) * 100)) : NSNull.null;
  last[@(pid)] = @[ @(cpu), @(now) ];
  char name[2 * MAXCOMLEN + 1] = {0};
  proc_name(pid, name, sizeof name);
  NSMutableDictionary *row = [@{
    @"pid" : @(pid),
    @"type" : type,
    @"name" : @(name),
    @"memory" : @{@"footprint" : @(ri.ri_phys_footprint), @"resident" : @(ri.ri_resident_size)},
    @"cpu" : @{@"time" : @(cpu), @"percent" : percent},
  } mutableCopy];
  [row addEntriesFromDictionary:extra ?: @{}];
  return row;
}

static void children(pid_t parent, int depth, NSMutableArray<NSNumber *> *out) {
  if (depth > 3) return;
  int n = proc_listchildpids(parent, NULL, 0);
  if (n <= 0) return;
  std::vector<pid_t> pids((size_t)n + 16);
  n = proc_listchildpids(parent, pids.data(), (int)(pids.size() * sizeof(pid_t)));
  for (int i = 0; i < n; i++) {
    if (pids[i] <= 1) continue;
    [out addObject:@(pids[i])];
    children(pids[i], depth + 1, out);
  }
}

void platform_register_metrics(void) {
  platform_register(@"app", @"metrics", ^(PlatformCall *c) {
    NSMutableArray *rows = [NSMutableArray new];
    NSMutableSet *seen = [NSMutableSet new];
    pid_t me = getpid();
    if (NSDictionary *r = sample(me, @"main", nil)) [rows addObject:r], [seen addObject:@(me)];
    // Web content processes: the windows' pages, kept-alive tabs' views, popovers.
    NSMutableDictionary<NSNumber *, NSNumber *> *windowOf = [NSMutableDictionary new]; // content pid → window id
    for (NSNumber *wid in platform_window_ids())
      if (pid_t pid = content_pid(platform_webview(wid.intValue))) windowOf[@(pid)] = wid;
    for (NSWindow *w in NSApp.windows) {
      NSMutableArray<WKWebView *> *views = [NSMutableArray new];
      collect_webviews(w.contentView.superview ?: w.contentView, views);
      for (WKWebView *wv in views) {
        pid_t pid = content_pid(wv);
        if (!pid || [seen containsObject:@(pid)]) continue;
        [seen addObject:@(pid)];
        NSDictionary *extra = windowOf[@(pid)] ? @{@"windowId" : windowOf[@(pid)]} : @{};
        if (NSDictionary *r = sample(pid, @"webview", extra)) [rows addObject:r];
      }
    }
    // What the app started: the Python process, services, jobs (the app's own executable again),
    // sidecars — and what they started.
    NSMutableArray<NSNumber *> *kids = [NSMutableArray new];
    children(me, 0, kids);
    char exe[2 * MAXCOMLEN + 1] = {0};
    proc_name(me, exe, sizeof exe);
    for (NSNumber *pid in kids) {
      if ([seen containsObject:pid]) continue;
      [seen addObject:pid];
      char name[2 * MAXCOMLEN + 1] = {0};
      proc_name(pid.intValue, name, sizeof name);
      NSString *type = strncmp(name, "python", 6) == 0 ? @"python" : strcmp(name, exe) == 0 ? @"helper" : @"child";
      if (NSDictionary *r = sample(pid.intValue, type, nil)) [rows addObject:r];
    }
    unsigned long long total = 0;
    for (NSDictionary *r in rows) total += [r[@"memory"][@"footprint"] unsignedLongLongValue];
    [c ok:@{@"processes" : rows, @"memory" : @{@"footprint" : @(total)}}];
  });
}
