// shell.* — hand URLs/files to the OS: open, reveal, trash, share (the system share menu), drag out
// (files dragged from the page to the Finder, a mail, another app).
#include "platform_internal.h"
#import <Quartz/Quartz.h>
#include <objc/runtime.h>

// Calls in flight (their delegates are weak in AppKit): kept until they answer.
static NSMutableSet *g_pending;
static void keep(id o) { [(g_pending ?: (g_pending = [NSMutableSet set])) addObject:o]; }
static void drop(id o) { [g_pending removeObject:o]; }

/// The page's web view of the window the call names (or comes from), and that window.
static WKWebView *page_of(PlatformCall *c, NSWindow **win) {
  int id = platform_resolve_window(c);
  WKWebView *wv = platform_webview(id);
  if (win) *win = wv.window;
  return wv;
}

/// A rect in the page's CSS pixels ({x, y, width, height}), else 1×1 at the pointer.
static NSRect anchor_in(WKWebView *wv, id rect) {
  if ([rect isKindOfClass:NSDictionary.class]) {
    double z = wv.pageZoom ?: 1;
    return NSMakeRect([rect[@"x"] doubleValue] * z, [rect[@"y"] doubleValue] * z, MAX(1, [rect[@"width"] doubleValue] * z), MAX(1, [rect[@"height"] doubleValue] * z));
  }
  NSPoint p = [wv convertPoint:[wv.window mouseLocationOutsideOfEventStream] fromView:nil];
  return NSMakeRect(p.x, p.y, 1, 1);
}

static NSArray<NSURL *> *file_urls(id list, NSString **missing) {
  NSMutableArray *urls = [NSMutableArray array];
  for (id f in [list isKindOfClass:NSArray.class] ? list : @[]) {
    NSString *path = [f isKindOfClass:NSString.class] ? [f stringByExpandingTildeInPath] : nil;
    if (!path.length || ![NSFileManager.defaultManager fileExistsAtPath:path]) {
      if (missing) *missing = [f description];
      return nil;
    }
    [urls addObject:[NSURL fileURLWithPath:path]];
  }
  return urls;
}

@interface SDShare : NSObject <NSSharingServicePickerDelegate>
@property(nonatomic, strong) PlatformCall *call;
@property(nonatomic, strong) NSSharingServicePicker *picker;
@end
@implementation SDShare
- (void)sharingServicePicker:(NSSharingServicePicker *)picker didChooseSharingService:(NSSharingService *)service {
  // nil: dismissed without choosing.
  [self.call ok:@{@"service" : service.title ?: NSNull.null}];
  drop(self);
}
@end

// Quick Look: the system's preview panel (space bar in the Finder) on files of the app. The panel
// takes its controller from the responder chain: the app delegate answers for it while a preview is
// asked.
@interface SDPreview : NSObject <QLPreviewPanelDataSource, QLPreviewPanelDelegate>
@property(nonatomic, copy) NSArray<NSURL *> *items;
@end
@implementation SDPreview
- (NSInteger)numberOfPreviewItemsInPreviewPanel:(QLPreviewPanel *)panel {
  return (NSInteger)self.items.count;
}
- (id<QLPreviewItem>)previewPanel:(QLPreviewPanel *)panel previewItemAtIndex:(NSInteger)index {
  return self.items[(NSUInteger)index];
}
@end

static SDPreview *g_preview;
static BOOL preview_accepts(id, SEL, QLPreviewPanel *) { return g_preview != nil; }
static void preview_begin(id, SEL, QLPreviewPanel *panel) {
  panel.dataSource = g_preview;
  panel.delegate = g_preview;
}
static void preview_end(id, SEL, QLPreviewPanel *panel) {
  panel.dataSource = nil;
  panel.delegate = nil;
  g_preview = nil;
}

@interface SDDragOut : NSObject <NSDraggingSource>
@property(nonatomic, strong) PlatformCall *call;
@end
@implementation SDDragOut
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return NSDragOperationCopy;
}
- (void)draggingSession:(NSDraggingSession *)session endedAtPoint:(NSPoint)point operation:(NSDragOperation)operation {
  [self.call ok:@{@"dropped" : @(operation != NSDragOperationNone)}];
  drop(self);
}
@end

void platform_register_shell(void) {
  platform_register(@"shell", @"openExternal", ^(PlatformCall *c) {
    NSURL *url = [NSURL URLWithString:[c string:@"url"] ?: @""];
    NSSet *allowed = [NSSet setWithArray:@[ @"http", @"https", @"mailto", @"tel", @"sms", @"facetime", @"maps" ]];
    if (!url || ![allowed containsObject:url.scheme.lowercaseString])
      return [c fail:@"invalid_args" message:@"shell.openExternal: only http(s)/mailto/tel/sms/facetime/maps URLs (use openPath for files)"];
    [NSWorkspace.sharedWorkspace openURL:url configuration:[NSWorkspaceOpenConfiguration configuration]
                       completionHandler:^(NSRunningApplication *, NSError *err) {
                         dispatch_async(dispatch_get_main_queue(), ^{
                           err ? [c fail:@"internal" message:err.localizedDescription] : [c ok:nil];
                         });
                       }];
  });
  platform_register(@"shell", @"openPath", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"].stringByExpandingTildeInPath;
    if (!path.length || ![NSFileManager.defaultManager fileExistsAtPath:path])
      return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"shell.openPath: no such file `%@`", path]];
    [NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:path] configuration:[NSWorkspaceOpenConfiguration configuration]
                       completionHandler:^(NSRunningApplication *, NSError *err) {
                         dispatch_async(dispatch_get_main_queue(), ^{
                           err ? [c fail:@"internal" message:err.localizedDescription] : [c ok:nil];
                         });
                       }];
  });
  platform_register(@"shell", @"showItemInFolder", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"].stringByExpandingTildeInPath;
    if (!path.length || ![NSFileManager.defaultManager fileExistsAtPath:path])
      return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"shell.showItemInFolder: no such file `%@`", path]];
    [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[ [NSURL fileURLWithPath:path] ]];
    [c ok:nil];
  });
  platform_register(@"shell", @"trashItem", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"].stringByExpandingTildeInPath;
    NSError *err = nil;
    if (!path.length || ![NSFileManager.defaultManager trashItemAtURL:[NSURL fileURLWithPath:path] resultingItemURL:nil error:&err])
      return [c fail:@"invalid_args" message:err.localizedDescription ?: @"shell.trashItem: `path` is required"];
    [c ok:nil];
  });
  // The system share menu (AirDrop, Mail, Messages, Notes…) for text, a URL and files, anchored on a
  // rect of the page (else at the pointer). Answers the service chosen, or null if dismissed.
  platform_register(@"shell", @"share", ^(PlatformCall *c) {
    NSWindow *win = nil;
    WKWebView *wv = page_of(c, &win);
    if (!wv) return [c fail:@"invalid_args" message:@"shell.share: no such window"];
    NSMutableArray *items = [NSMutableArray array];
    if (NSString *text = [c string:@"text"]) [items addObject:text];
    if (NSString *u = [c string:@"url"]) {
      NSURL *url = [NSURL URLWithString:u];
      if (!url.scheme) return [c fail:@"invalid_args" message:@"shell.share: `url` must be an absolute URL"];
      [items addObject:url];
    }
    NSString *missing = nil;
    NSArray *files = file_urls(c.args[@"files"], &missing);
    if (!files) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"shell.share: no such file `%@`", missing]];
    [items addObjectsFromArray:files];
    if (!items.count) return [c fail:@"invalid_args" message:@"shell.share: give `text`, `url` or `files`"];
    SDShare *share = [SDShare new];
    share.call = c;
    share.picker = [[NSSharingServicePicker alloc] initWithItems:items];
    share.picker.delegate = share;
    keep(share);
    [share.picker showRelativeToRect:anchor_in(wv, c.args[@"anchor"]) ofView:wv preferredEdge:NSRectEdgeMinY];
  });
  // Files dragged out of the page, to the Finder or another app: call it from a `dragstart` (after
  // preventDefault) or `mousedown` handler, while the button is still down. Answers whether they
  // were dropped somewhere.
  platform_register(@"shell", @"startDrag", ^(PlatformCall *c) {
    NSWindow *win = nil;
    WKWebView *wv = page_of(c, &win);
    if (!wv) return [c fail:@"invalid_args" message:@"shell.startDrag: no such window"];
    NSString *missing = nil;
    NSArray<NSURL *> *files = file_urls(c.args[@"files"], &missing);
    if (!files) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"shell.startDrag: no such file `%@`", missing]];
    if (!files.count) return [c fail:@"invalid_args" message:@"shell.startDrag: `files` is required"];
    if (!(NSEvent.pressedMouseButtons & 1))
      return [c fail:@"not_dragging" message:@"shell.startDrag: the mouse button isn't down — call it from a dragstart or mousedown handler"];
    NSImage *icon = nil;
    if (NSString *path = [c string:@"icon"]) icon = [[NSImage alloc] initWithContentsOfFile:path.stringByExpandingTildeInPath];
    NSPoint at = [wv convertPoint:[win mouseLocationOutsideOfEventStream] fromView:nil];
    NSMutableArray *items = [NSMutableArray array];
    [files enumerateObjectsUsingBlock:^(NSURL *url, NSUInteger i, BOOL *) {
      NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:url];
      NSImage *image = icon ?: [NSWorkspace.sharedWorkspace iconForFile:url.path];
      [item setDraggingFrame:NSMakeRect(at.x - 32 + i * 6, at.y - 32 + i * 6, 64, 64) contents:image];
      [items addObject:item];
    }];
    NSEvent *e = NSApp.currentEvent;
    if (!(e.type == NSEventTypeLeftMouseDown || e.type == NSEventTypeLeftMouseDragged) || e.window != win)
      e = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:[win mouseLocationOutsideOfEventStream] modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:win.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
    SDDragOut *source = [SDDragOut new];
    source.call = c;
    keep(source);
    [wv beginDraggingSessionWithItems:items event:e source:source];
  });
  platform_register(@"shell", @"previewFile", ^(PlatformCall *c) {
    id paths = c.args[@"paths"];
    if ([paths isKindOfClass:NSString.class]) paths = @[ paths ];
    NSString *missing = nil;
    NSArray<NSURL *> *files = file_urls(paths, &missing);
    if (!files) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"shell.previewFile: no such file `%@`", missing]];
    if (!files.count) return [c fail:@"invalid_args" message:@"shell.previewFile: `paths` is required"];
    id delegate = NSApp.delegate;
    if (!delegate) return [c fail:@"unavailable" message:@"shell.previewFile: no app delegate to control the panel"];
    Class cls = object_getClass(delegate);
    class_addMethod(cls, @selector(acceptsPreviewPanelControl:), (IMP)preview_accepts, "c@:@");
    class_addMethod(cls, @selector(beginPreviewPanelControl:), (IMP)preview_begin, "v@:@");
    class_addMethod(cls, @selector(endPreviewPanelControl:), (IMP)preview_end, "v@:@");
    g_preview = [SDPreview new];
    g_preview.items = files;
    QLPreviewPanel *panel = QLPreviewPanel.sharedPreviewPanel;
    [panel updateController];
    if (panel.dataSource != g_preview) preview_begin(nil, nil, panel); // the controller already in place
    [panel reloadData];
    panel.currentPreviewItemIndex = 0;
    [panel makeKeyAndOrderFront:nil];
    [c ok:nil];
  });
  platform_register(@"shell", @"beep", ^(PlatformCall *c) {
    NSBeep();
    [c ok:nil];
  });
}
