#include "platform_download_files.h"
// Included by platform_webview.mm: one owner for legacy webview.* and host.downloads.
@interface SDDownload : NSObject
@property(nonatomic, copy) NSString *ident;
@property(nonatomic, copy) NSString *url;
@property(nonatomic, copy) NSString *path;
@property(nonatomic, copy) NSString *explicitPath;
@property(nonatomic, copy) NSDictionary *source;
@property(nonatomic, strong) WKDownload *download;
@property(nonatomic, strong) WKWebsiteDataStore *store;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, strong) NSData *resumeData;
@property(nonatomic, copy) NSString *state;
@property(nonatomic, copy) NSString *filename;
@property(nonatomic, copy) NSString *mimeType;
@property(nonatomic, copy) NSString *error;
@property(nonatomic, copy) void (^destination)(NSURL *);
@property(nonatomic, copy) NSString *handlerId;
@property(nonatomic) BOOL resumed;
@property(nonatomic) int64_t checkpointBytes;
@property(nonatomic) int64_t lastBytes;
@property(nonatomic) int64_t expected;
@property(nonatomic) NSTimeInterval startedAt;
@property(nonatomic) NSTimeInterval updatedAt;
@end
@implementation SDDownload
@end
@interface SDDownloadDelegate : NSObject <WKDownloadDelegate>
@end
static NSMutableDictionary<NSString *, SDDownload *> *g_downloads;
static SDDownloadDelegate *g_download_delegate;
static NSString *g_download_handler;
static NSUserDefaults *g_download_history;

static BOOL download_can_resume(SDDownload *d) {
  return d.resumeData.length > 0 && d.expected >= 0 && [@[@"paused", @"canceled", @"interrupted"] containsObject:d.state];
}
static int64_t download_bytes(SDDownload *d) {
  NSProgress *p = d.download.progress;
  int64_t bytes = p.completedUnitCount;
  return MAX(d.lastBytes, bytes);
}
static BOOL download_active(SDDownload *d) {
  return [@[@"requested", @"downloading", @"pausing", @"finishing"] containsObject:d.state];
}
static NSString *download_path_key(NSString *path) {
  NSString *full = [NSURL fileURLWithPath:path].path.stringByStandardizingPath;
  return [full.stringByDeletingLastPathComponent.stringByResolvingSymlinksInPath stringByAppendingPathComponent:full.lastPathComponent];
}
static BOOL download_path_busy(NSString *path, SDDownload *except) {
  NSString *key = download_path_key(path);
  for (SDDownload *other in g_downloads.allValues)
    if (other != except && other.path && download_active(other) && [download_path_key(other.path) isEqual:key]) return YES;
  return NO;
}
static NSDictionary *with_source(SDDownload *d, NSDictionary *extra) {
  NSMutableDictionary *m = [NSMutableDictionary dictionaryWithDictionary:d.source ?: @{}];
  m[@"id"] = d.ident;
  m[@"url"] = d.url;
  if (d.path) m[@"path"] = d.path;
  [m addEntriesFromDictionary:extra];
  return m;
}
static NSDictionary *download_snapshot(SDDownload *d) {
  NSMutableDictionary *m = [with_source(d, @{
    @"state" : d.state, @"suggestedFilename" : d.filename ?: @"", @"mimeType" : d.mimeType ?: NSNull.null,
    @"receivedBytes" : @(d.lastBytes), @"totalBytes" : @(d.expected),
    @"fraction" : @([d.state isEqual:@"completed"] ? 1 : d.expected > 0 ? MIN(1.0, (double)d.lastBytes / d.expected) : -1),
    @"canResume" : @(download_can_resume(d)), @"startedAt" : @(d.startedAt * 1000), @"updatedAt" : @(d.updatedAt * 1000)
  }) mutableCopy];
  if (d.resumeData.length) {
    m[@"resumeData"] = d.ident; // opaque reference; request credentials stay native
    m[@"resumeBytes"] = @(d.checkpointBytes);
  }
  if (d.error) m[@"error"] = d.error;
  return m;
}
static void save_downloads(void) {
  NSMutableArray *items = [NSMutableArray array];
  for (SDDownload *d in g_downloads.allValues) {
    NSMutableDictionary *item = [download_snapshot(d) mutableCopy];
    if (d.resumeData.length) item[@"resumeData"] = [d.resumeData base64EncodedStringWithOptions:0];
    [items addObject:item];
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:items options:0 error:nil];
  if (data) { [g_download_history setObject:data forKey:@"history"]; [g_download_history synchronize]; }
}
static void download_changed(SDDownload *d) {
  d.updatedAt = NSDate.date.timeIntervalSince1970;
  save_downloads();
  platform_emit(@"downloadChanged", download_snapshot(d));
}
static void ensure_downloads(void) {
  if (g_downloads) return;
  g_downloads = [NSMutableDictionary dictionary];
  g_download_delegate = [SDDownloadDelegate new];
  g_download_history = [[NSUserDefaults alloc] initWithSuiteName:[platform_app_identifier() stringByAppendingString:@".downloads"]];
  NSData *data = [g_download_history dataForKey:@"history"];
  id items = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![items isKindOfClass:NSArray.class]) return;
  for (NSDictionary *m in items) {
    if (![m isKindOfClass:NSDictionary.class] || ![m[@"id"] isKindOfClass:NSString.class] || ![m[@"url"] isKindOfClass:NSString.class]) continue;
    SDDownload *d = [SDDownload new];
    d.ident = m[@"id"]; d.url = m[@"url"]; d.path = m[@"path"];
    d.filename = m[@"suggestedFilename"]; d.mimeType = [m[@"mimeType"] isKindOfClass:NSString.class] ? m[@"mimeType"] : nil;
    d.state = m[@"state"] ?: @"interrupted";
    if (download_active(d)) d.state = @"interrupted";
    d.resumeData = [[NSData alloc] initWithBase64EncodedString:m[@"resumeData"] ?: @"" options:0];
    d.lastBytes = [m[@"receivedBytes"] longLongValue]; d.expected = [m[@"totalBytes"] longLongValue];
    d.checkpointBytes = [m[@"resumeBytes"] longLongValue];
    if ([d.state isEqual:@"paused"] && d.expected < 0) d.state = @"interrupted";
    d.startedAt = [m[@"startedAt"] doubleValue] / 1000; d.updatedAt = [m[@"updatedAt"] doubleValue] / 1000; d.error = m[@"error"];
    NSMutableDictionary *source = [NSMutableDictionary dictionary];
    for (NSString *key in @[@"windowId", @"popoverId", @"viewId"]) if (m[key]) source[key] = m[key];
    d.source = source; g_downloads[d.ident] = d;
  }
}
static SDDownload *record_for(WKDownload *download) {
  for (SDDownload *d in g_downloads.allValues) if (d.download == download) return d;
  return nil;
}
static NSString *download_dir(void) {
  return g_download_dir ?: NSSearchPathForDirectoriesInDomains(NSDownloadsDirectory, NSUserDomainMask, YES).firstObject
      ?: [NSHomeDirectory() stringByAppendingPathComponent:@"Downloads"];
}
static NSString *unique_path(NSString *dir, NSString *name) {
  NSString *base = name.stringByDeletingPathExtension, *ext = name.pathExtension;
  NSString *candidate = [dir stringByAppendingPathComponent:name];
  for (int i = 1; ([NSFileManager.defaultManager fileExistsAtPath:candidate] || download_path_busy(candidate, nil)); i++) {
    NSString *n = [NSString stringWithFormat:@"%@ (%d)", base, i];
    candidate = [dir stringByAppendingPathComponent:ext.length ? [n stringByAppendingPathExtension:ext] : n];
  }
  return candidate;
}
static void stop_download(SDDownload *d) {
  [d.timer invalidate]; d.timer = nil;
  d.download = nil;
  if (!d.resumeData.length || d.expected < 0) d.store = nil;
}
static void track_download(SDDownload *d) {
  d.state = @"downloading";
  download_changed(d);
  SDDownload *__weak weak = d;
  d.timer = [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:YES block:^(NSTimer *timer) {
    SDDownload *x = weak;
    if (!x.download) return [timer invalidate];
    NSProgress *p = x.download.progress;
    int64_t bytes = download_bytes(x);
    if (bytes <= x.lastBytes) return;
    x.lastBytes = bytes;
    if (p.totalUnitCount > 0) x.expected = MAX(x.expected, p.totalUnitCount);
    x.updatedAt = NSDate.date.timeIntervalSince1970;
    NSDictionary *snapshot = download_snapshot(x);
    platform_emit(@"downloadProgress", snapshot);
    platform_emit(@"downloadChanged", snapshot);
  }];
}
static void choose_destination(SDDownload *d, id decision) {
  void (^completion)(NSURL *) = d.destination;
  if (!completion) return;
  d.destination = nil;
  if ([decision isEqual:@"cancel"]) {
    d.state = @"canceled";
    completion(nil);
    stop_download(d); download_changed(d);
    platform_emit(@"downloadFailed", with_source(d, @{@"error": @"canceled before saving", @"canceled": @YES}));
    return;
  }
  NSString *requested = [decision isKindOfClass:NSDictionary.class] ? decision[@"path"] : d.explicitPath;
  NSString *path = requested.stringByExpandingTildeInPath;
  if (!path) {
    NSString *name = [d.filename.lastPathComponent stringByReplacingOccurrencesOfString:@":" withString:@"-"];
    if (!name.length || [name hasPrefix:@"."]) name = [@"download" stringByAppendingString:name ?: @""];
    path = unique_path(download_dir(), name);
  }
  NSError *error = nil;
  NSFileManager *fm = NSFileManager.defaultManager;
  if (download_path_busy(path, d)) {
    d.error = @"download destination is in use by another transfer"; d.state = @"interrupted";
    completion(nil); stop_download(d); download_changed(d);
    platform_emit(@"downloadFailed", with_source(d, @{@"error": d.error, @"canceled": @NO}));
    return;
  }
  BOOL directory = NO;
  if ([fm fileExistsAtPath:path isDirectory:&directory] && directory) {
    d.error = @"download destination is a directory"; d.state = @"interrupted";
    completion(nil); stop_download(d); download_changed(d);
    platform_emit(@"downloadFailed", with_source(d, @{@"error": d.error, @"canceled": @NO}));
    return;
  }
  if (![fm createDirectoryAtPath:path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:&error] ||
      ([fm fileExistsAtPath:path] && ![fm removeItemAtPath:path error:&error])) {
    d.error = error.localizedDescription; d.state = @"interrupted";
    completion(nil); stop_download(d); download_changed(d);
    platform_emit(@"downloadFailed", with_source(d, @{@"error": d.error ?: @"destination unavailable", @"canceled": @NO}));
    return;
  }
  d.path = path;
  track_download(d);
  platform_emit(@"downloadStarted", download_snapshot(d));
  completion([NSURL fileURLWithPath:path]);
}
@implementation SDDownloadDelegate
- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
    suggestedFilename:(NSString *)suggestedFilename completionHandler:(void (^)(NSURL *))completionHandler {
  SDDownload *d = record_for(download);
  if (!d) return completionHandler(nil);
  d.filename = suggestedFilename ?: @""; d.mimeType = response.MIMEType;
  d.expected = response.expectedContentLength >= 0 ? response.expectedContentLength : -1;
  d.destination = completionHandler;
  if (!g_download_handler) return choose_destination(d, @"default");
  d.handlerId = g_download_handler;
  download_changed(d);
  platform_emit(@"downloadRequested", with_source(d, @{@"handlerId": d.handlerId, @"suggestedFilename": d.filename,
      @"mimeType": d.mimeType ?: NSNull.null, @"size": @(d.expected)}));
  // A lost page/handler must never silently authorize a destination.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (d.destination) choose_destination(d, @"cancel");
  });
}
- (void)downloadDidFinish:(WKDownload *)download {
  SDDownload *d = record_for(download);
  if (!d) return;
  d.state = @"finishing";
  stop_download(d); download_changed(d);
  NSString *path = d.path, *prefix = platform_download_prefix(d.path, d.ident);
  BOOL resumed = d.resumed; int64_t expected = d.expected;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSError *error = nil;
    NSNumber *size = [NSFileManager.defaultManager attributesOfItemAtPath:path error:&error][NSFileSize];
    BOOL ok = size && (!resumed || size.longLongValue == expected);
    if (ok) [NSFileManager.defaultManager removeItemAtPath:prefix error:nil];
    dispatch_async(dispatch_get_main_queue(), ^{
      d.lastBytes = size ? size.longLongValue : d.lastBytes;
      d.state = ok ? @"completed" : @"interrupted";
      d.error = ok ? nil : error.localizedDescription ?: @"resumed file size does not match its expected length";
      if (ok) { d.resumeData = nil; d.store = nil; }
      download_changed(d);
      if (d.error) platform_emit(@"downloadFailed", with_source(d, @{@"error": d.error, @"canceled": @NO}));
      else platform_emit(@"downloadFinished", with_source(d, @{@"bytes": @(d.lastBytes)}));
    });
  });
}
- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
  SDDownload *d = record_for(download);
  if (!d || [@[@"pausing", @"finishing", @"interrupted"] containsObject:d.state]) return;
  void (^destination)(NSURL *) = d.destination;
  d.destination = nil;
  if (destination) destination(nil);
  d.lastBytes = download_bytes(d);
  d.state = @"pausing"; d.error = error.localizedDescription ?: @"download failed";
  NSString *path = d.path, *prefix = path ? platform_download_prefix(path, d.ident) : nil;
  NSData *checkpoint = d.resumeData;
  int64_t savedBytes = d.checkpointBytes;
  BOOL capture = resumeData.length && d.expected >= 0 && path;
  WKWebsiteDataStore *store = d.store;
  stop_download(d); download_changed(d);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSError *fileError = nil;
    int64_t checkpointBytes = savedBytes;
    BOOL captured = (checkpoint.length && d.expected >= 0) || (capture && platform_download_checkpoint(path, prefix, &checkpointBytes, &fileError));
    dispatch_async(dispatch_get_main_queue(), ^{
      d.resumeData = checkpoint ?: (captured || d.expected < 0 ? resumeData : nil);
      d.checkpointBytes = checkpointBytes; d.state = @"interrupted";
      d.store = captured ? store : nil;
      if (fileError) d.error = [NSString stringWithFormat:@"%@; checkpoint: %@", d.error, fileError.localizedDescription];
      download_changed(d);
      platform_emit(@"downloadFailed", with_source(d, @{@"error": d.error, @"canceled": @([error.domain isEqual:NSURLErrorDomain] && error.code == NSURLErrorCancelled)}));
    });
  });
}
@end
static SDDownload *adopt_download(WKDownload *download, NSDictionary *source, NSString *explicitPath) {
  ensure_downloads();
  SDDownload *d = [SDDownload new];
  d.ident = [@"dl-" stringByAppendingString:NSUUID.UUID.UUIDString];
  d.url = download.originalRequest.URL.absoluteString ?: @""; d.source = source ?: @{};
  d.download = download; d.store = download.webView.configuration.websiteDataStore; d.explicitPath = explicitPath;
  d.state = @"requested"; d.expected = -1; d.startedAt = NSDate.date.timeIntervalSince1970;
  g_downloads[d.ident] = d; download.delegate = g_download_delegate;
  download_changed(d);
  return d;
}
static void cancel_download(PlatformCall *c, BOOL pause) {
  SDDownload *d = g_downloads[[c string:@"id"] ?: @""];
  if (!d) return [c fail:@"invalid_args" message:@"unknown download id"];
  if (!d.download || [d.state isEqual:@"pausing"]) return [c fail:@"unavailable" message:@"download is not transferring"];
  if (d.destination) {
    choose_destination(d, @"cancel");
    return [c ok:pause || [c boolean:@"snapshot" or:NO] ? download_snapshot(d) : nil];
  }
  d.lastBytes = download_bytes(d);
  d.state = @"pausing"; download_changed(d);
  BOOL snapshot = pause || [c boolean:@"snapshot" or:NO];
  if (!snapshot) [c ok:nil]; // preserve the legacy cancelDownload acknowledgement
  [d.download cancel:^(NSData *resumeData) {
    dispatch_async(dispatch_get_main_queue(), ^{
      d.lastBytes = download_bytes(d);
      NSString *path = d.path, *prefix = path ? platform_download_prefix(path, d.ident) : nil;
      NSData *checkpoint = d.resumeData;
      int64_t savedBytes = d.checkpointBytes;
      WKWebsiteDataStore *store = d.store;
      BOOL capture = resumeData.length && d.expected >= 0 && path;
      stop_download(d);
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSError *fileError = nil;
        int64_t checkpointBytes = savedBytes;
        BOOL captured = checkpoint.length && d.expected >= 0;
        if (!captured && capture) captured = platform_download_checkpoint(path, prefix, &checkpointBytes, &fileError);
        dispatch_async(dispatch_get_main_queue(), ^{
          d.resumeData = checkpoint ?: (captured || d.expected < 0 ? resumeData : nil);
          d.checkpointBytes = checkpointBytes;
          d.store = captured ? store : nil;
          BOOL resumable = captured;
          d.state = pause ? (resumable ? @"paused" : @"interrupted") : @"canceled";
          // Nothing will resume from it: no half a file left under the name the user would look for.
          if (!pause && !resumable && path) [NSFileManager.defaultManager removeItemAtPath:path error:nil];
          d.error = captured ? nil : fileError ? fileError.localizedDescription : !resumeData.length ? @"WebKit supplied no resume data" : d.expected < 0 ? @"unknown-length transfers cannot safely resume" : nil;
          download_changed(d);
          platform_emit(@"downloadFailed", with_source(d, @{@"error": d.error ?: (pause ? @"paused" : @"canceled"), @"canceled": @YES, @"canResume": @(resumable)}));
          if (snapshot) [c ok:download_snapshot(d)];
        });
      });
    });
  }];
}
static void register_download_controls(void) {
  ensure_downloads();
  platform_register(@"webview", @"setDownloadHandler", ^(PlatformCall *c) {
    NSString *ident = [c string:@"handlerId"];
    if (!ident.length) return [c fail:@"invalid_args" message:@"handlerId required"];
    for (SDDownload *d in g_downloads.allValues) if (d.destination) choose_destination(d, @"cancel");
    g_download_handler = ident; [c ok:nil];
  });
  platform_register(@"webview", @"clearDownloadHandler", ^(PlatformCall *c) {
    if ([g_download_handler isEqual:[c string:@"handlerId"]]) {
      g_download_handler = nil;
      for (SDDownload *d in g_downloads.allValues) if (d.destination) choose_destination(d, @"cancel");
    }
    [c ok:nil];
  });
  platform_register(@"webview", @"decideDownload", ^(PlatformCall *c) {
    SDDownload *d = g_downloads[[c string:@"id"] ?: @""];
    if (!d.destination || ![d.handlerId isEqual:[c string:@"handlerId"]]) return [c fail:@"unavailable" message:@"download request expired"];
    id decision = c.args[@"decision"];
    BOOL valid = [decision isEqual:@"default"] || [decision isEqual:@"cancel"];
    if ([decision isKindOfClass:NSDictionary.class]) valid = [decision[@"path"] isKindOfClass:NSString.class] && [decision[@"path"] stringByExpandingTildeInPath].isAbsolutePath;
    if (!valid) { choose_destination(d, @"cancel"); return [c fail:@"invalid_args" message:@"decision must be default, cancel or an absolute path"] ; }
    choose_destination(d, decision); [c ok:nil];
  });
  platform_register(@"webview", @"pauseDownload", ^(PlatformCall *c) { cancel_download(c, YES); });
  platform_register(@"webview", @"cancelDownload", ^(PlatformCall *c) { cancel_download(c, NO); });
  platform_register(@"webview", @"getDownload", ^(PlatformCall *c) {
    SDDownload *d = g_downloads[[c string:@"id"] ?: @""]; [c ok:d ? download_snapshot(d) : NSNull.null];
  });
  platform_register(@"webview", @"listDownloads", ^(PlatformCall *c) {
    NSMutableArray *items = [NSMutableArray array];
    for (SDDownload *d in g_downloads.allValues) [items addObject:download_snapshot(d)];
    [items sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [b[@"startedAt"] compare:a[@"startedAt"]]; }];
    [c ok:items];
  });
}
