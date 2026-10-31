// window.* — every op of the GPUI-era contract (packages/platform/src/index.ts).
// Coordinates: top-left origin of the primary screen, y down. `windowId` is the
// public id (0 = primary); absent → the calling page's window (or key/primary).
// Events (emitted by shell_macos.mm): focusChanged, boundsChanged,
// scaleFactorChanged, willClose, closed, created.
#include <map>

#include "platform_internal.h"

typedef void (^WindowOp)(PlatformCall *c, NSWindow *w, int nativeId);

static void reg(NSString *op, WindowOp body) {
  platform_register(@"window", op, ^(PlatformCall *c) {
    int id = platform_resolve_window(c);
    NSWindow *w = platform_window(id);
    if (!w) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"window.%@: no such window", c.op]];
    body(c, w, id);
  });
}

static void reg_flag(NSString *setter, NSString *getter, NSString *key, void (^set)(NSWindow *, BOOL), BOOL (^get)(NSWindow *)) {
  reg(setter, ^(PlatformCall *c, NSWindow *w, int) {
    set(w, [c boolean:@"enabled" or:YES]);
    [c ok:nil];
  });
  if (getter)
    reg(getter, ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{key : @(get(w))}]; });
}

static void set_mask(NSWindow *w, NSWindowStyleMask bit, BOOL on) {
  w.styleMask = on ? (w.styleMask | bit) : (w.styleMask & ~bit);
}

static NSString *state_name(NSWindow *w) {
  if (w.styleMask & NSWindowStyleMaskFullScreen) return @"fullscreen";
  if (w.isZoomed) return @"maximized";
  return @"normal";
}

static NSDictionary *info_row(int id) {
  NSWindow *w = platform_window(id);
  return @{
    @"windowId" : @(platform_public_window_id(id)),
    @"label" : platform_window_label(id) ?: @"",
    @"focused" : @(w.isKeyWindow),
    @"bounds" : platform_rect_dict(platform_to_top_left(w.frame)),
  };
}

// Simple fullscreen: borderless frame over the whole screen, menu bar and Dock
// auto-hidden, no new Space.
static std::map<int, NSRect> g_simple_fs_frames;
static std::map<int, NSWindowStyleMask> g_simple_fs_masks;

static NSRect controls_rect(NSWindow *w, NSWindowButton b) {
  NSButton *btn = [w standardWindowButton:b];
  if (!btn || !btn.superview) return NSZeroRect;
  NSRect inWindow = [btn convertRect:btn.bounds toView:nil];
  CGFloat h = w.frame.size.height;
  return NSMakeRect(inWindow.origin.x, h - NSMaxY(inWindow), inWindow.size.width, inWindow.size.height);
}

void platform_register_window(void) {
  // ── multi-window ──────────────────────────────────────────────────────
  platform_register(@"window", @"create", ^(PlatformCall *c) {
    int id = platform_create_window(c.args);
    if (id == -4) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"window.create: label `%@` is already used", [c string:@"label"]]];
    if (id <= 0) return [c fail:@"internal" message:@"window.create failed"];
    if ([c has:@"opacity"]) platform_window(id).alphaValue = [c number:@"opacity" or:1];
    if ([c boolean:@"focus" or:YES] && [c boolean:@"visible" or:YES]) [NSApp activateIgnoringOtherApps:YES];
    [c ok:@{@"windowId" : @(platform_public_window_id(id)), @"label" : platform_window_label(id) ?: @""}];
  });
  platform_register(@"window", @"list", ^(PlatformCall *c) {
    NSMutableArray *rows = [NSMutableArray array];
    for (NSNumber *n in platform_window_ids()) [rows addObject:info_row(n.intValue)];
    [c ok:rows];
  });
  platform_register(@"window", @"get", ^(PlatformCall *c) {
    NSString *label = [c string:@"label"];
    for (NSNumber *n in platform_window_ids())
      if ([platform_window_label(n.intValue) isEqualToString:label]) return [c ok:info_row(n.intValue)];
    [c ok:nil];
  });

  // ── geometry ──────────────────────────────────────────────────────────
  reg(@"getBounds", ^(PlatformCall *c, NSWindow *w, int) {
    [c ok:@{@"bounds" : platform_rect_dict(platform_to_top_left(w.frame)), @"state" : state_name(w)}];
  });
  reg(@"setBounds", ^(PlatformCall *c, NSWindow *w, int) {
    NSRect r = NSMakeRect([c number:@"x" or:0], [c number:@"y" or:0], [c number:@"width" or:w.frame.size.width],
                          [c number:@"height" or:w.frame.size.height]);
    [w setFrame:platform_from_top_left(r) display:YES];
    [c ok:nil];
  });
  void (^size)(PlatformCall *, NSWindow *, int) = ^(PlatformCall *c, NSWindow *w, int) {
    NSSize s = [w contentRectForFrameRect:w.frame].size;
    [c ok:@{@"width" : @(s.width), @"height" : @(s.height)}];
  };
  reg(@"getSize", size);
  reg(@"getContentSize", size);
  reg(@"innerSize", size);
  reg(@"outerSize", ^(PlatformCall *c, NSWindow *w, int) {
    [c ok:@{@"width" : @(w.frame.size.width), @"height" : @(w.frame.size.height)}];
  });
  reg(@"setSize", ^(PlatformCall *c, NSWindow *w, int) {
    NSRect f = w.frame;
    NSRect content = [w contentRectForFrameRect:f];
    content.size = NSMakeSize([c number:@"width" or:content.size.width], [c number:@"height" or:content.size.height]);
    NSRect next = [w frameRectForContentRect:content];
    next.origin.y = NSMaxY(f) - next.size.height; // keep the top edge fixed
    [w setFrame:next display:YES animate:NO];
    [c ok:nil];
  });
  void (^pos)(PlatformCall *, NSWindow *, int) = ^(PlatformCall *c, NSWindow *w, int) {
    NSRect r = platform_to_top_left(w.frame);
    [c ok:@{@"x" : @(r.origin.x), @"y" : @(r.origin.y)}];
  };
  reg(@"getPosition", pos);
  reg(@"outerPosition", pos);
  reg(@"innerPosition", ^(PlatformCall *c, NSWindow *w, int) {
    NSRect r = platform_to_top_left([w contentRectForFrameRect:w.frame]);
    [c ok:@{@"x" : @(r.origin.x), @"y" : @(r.origin.y)}];
  });
  reg(@"setPosition", ^(PlatformCall *c, NSWindow *w, int) {
    NSRect r = platform_to_top_left(w.frame);
    r.origin = NSMakePoint([c number:@"x" or:r.origin.x], [c number:@"y" or:r.origin.y]);
    [w setFrame:platform_from_top_left(r) display:YES];
    [c ok:nil];
  });
  reg(@"center", ^(PlatformCall *c, NSWindow *w, int) {
    [w center];
    [c ok:nil];
  });
  reg(@"positionTo", ^(PlatformCall *c, NSWindow *w, int) {
    NSString *preset = [c string:@"preset"] ?: @"";
    NSRect f = platform_to_top_left(w.frame);
    NSPoint mouse = NSEvent.mouseLocation;
    NSRect m = platform_to_top_left(NSMakeRect(mouse.x, mouse.y, 0, 0));
    if ([preset isEqual:@"center"]) {
      [w center];
      return [c ok:nil];
    } else if ([preset isEqual:@"cursorTopLeft"]) {
      f.origin = m.origin;
    } else if ([preset isEqual:@"cursorBottomLeft"]) {
      f.origin = NSMakePoint(m.origin.x, m.origin.y - f.size.height);
    } else if ([preset hasPrefix:@"tray"]) {
      NSDictionary *t = platform_tray_button_rect();
      if (!t) return [c fail:@"unavailable" message:@"window.positionTo: no tray item is placed"];
      double tx = [t[@"x"] doubleValue], ty = [t[@"y"] doubleValue], tw = [t[@"width"] doubleValue], th = [t[@"height"] doubleValue];
      if ([preset isEqual:@"trayCenter"] || [preset isEqual:@"trayBottom"]) f.origin = NSMakePoint(tx + tw / 2 - f.size.width / 2, ty + th);
      else if ([preset isEqual:@"trayLeft"]) f.origin = NSMakePoint(tx, ty + th);
      else if ([preset isEqual:@"trayRight"]) f.origin = NSMakePoint(tx + tw - f.size.width, ty + th);
      else if ([preset isEqual:@"trayTop"]) f.origin = NSMakePoint(tx + tw / 2 - f.size.width / 2, ty - f.size.height);
      else return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"window.positionTo: unknown preset `%@`", preset]];
    } else {
      return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"window.positionTo: unknown preset `%@`", preset]];
    }
    [w setFrame:platform_from_top_left(f) display:YES];
    [c ok:nil];
  });
  reg(@"setMinSize", ^(PlatformCall *c, NSWindow *w, int) {
    double width = [c number:@"width" or:0], height = [c number:@"height" or:0];
    w.contentMinSize = (width || height) ? NSMakeSize(width, height) : NSMakeSize(1, 1);
    [c ok:nil];
  });
  reg(@"setMaxSize", ^(PlatformCall *c, NSWindow *w, int) {
    double width = [c number:@"width" or:0], height = [c number:@"height" or:0];
    w.contentMaxSize = (width || height) ? NSMakeSize(width ?: CGFLOAT_MAX, height ?: CGFLOAT_MAX) : NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
    [c ok:nil];
  });
  reg(@"getScaleFactor", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.backingScaleFactor)]; });
  reg(@"getCursorPoint", ^(PlatformCall *c, NSWindow *w, int) {
    NSPoint p = w.mouseLocationOutsideOfEventStream;
    NSRect content = w.contentLayoutRect;
    [c ok:@{@"x" : @(p.x), @"y" : @(NSMaxY(content) - p.y)}];
  });
  reg(@"controlsArea", ^(PlatformCall *c, NSWindow *w, int) {
    NSButton *close = [w standardWindowButton:NSWindowCloseButton];
    if (!close || close.superview == nil) return [c ok:nil];
    NSDictionary *names = @{@"close" : @(NSWindowCloseButton), @"minimize" : @(NSWindowMiniaturizeButton), @"zoom" : @(NSWindowZoomButton)};
    NSMutableDictionary *buttons = [NSMutableDictionary dictionary];
    NSRect u = NSZeroRect;
    for (NSString *name in names) {
      NSWindowButton b = (NSWindowButton)[names[name] integerValue];
      NSRect r = controls_rect(w, b);
      if (NSIsEmptyRect(r)) continue;
      NSMutableDictionary *d = [platform_rect_dict(r) mutableCopy];
      d[@"visible"] = @(![w standardWindowButton:b].isHidden);
      buttons[name] = d;
      u = NSIsEmptyRect(u) ? r : NSUnionRect(u, r);
    }
    NSMutableDictionary *out = [platform_rect_dict(u) mutableCopy];
    out[@"contentTop"] = @(w.frame.size.height - NSMaxY(w.contentLayoutRect));
    out[@"side"] = @"left";
    out[@"buttons"] = buttons;
    [c ok:out];
  });

  // ── state ─────────────────────────────────────────────────────────────
  reg(@"getTitle", ^(PlatformCall *c, NSWindow *w, int) { [c ok:w.title ?: @""]; });
  // Run JS in the window's page; resolves with its JSON-serializable result.
  reg(@"eval", ^(PlatformCall *c, NSWindow *, int wid) {
    NSString *js = [c string:@"js"];
    if (!js) return [c fail:@"invalid_args" message:@"window.eval: `js` is required"];
    [platform_webview(wid) evaluateJavaScript:js completionHandler:^(id result, NSError *err) {
      if (err) return [c fail:@"internal" message:err.localizedDescription];
      [c ok:[NSJSONSerialization isValidJSONObject:@[ result ?: NSNull.null ]] ? result : [result description]];
    }];
  });
  reg(@"setTitle", ^(PlatformCall *c, NSWindow *w, int) {
    w.title = [c string:@"title"] ?: @"";
    [c ok:nil];
  });
  reg(@"minimize", ^(PlatformCall *c, NSWindow *w, int) {
    [w miniaturize:nil];
    [c ok:nil];
  });
  reg(@"unminimize", ^(PlatformCall *c, NSWindow *w, int) {
    [w deminiaturize:nil];
    [c ok:nil];
  });
  reg(@"isMinimized", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"minimized" : @(w.isMiniaturized)}]; });
  reg(@"maximize", ^(PlatformCall *c, NSWindow *w, int) {
    if (!w.isZoomed) [w zoom:nil];
    [c ok:@{@"maximized" : @(w.isZoomed)}];
  });
  reg(@"unmaximize", ^(PlatformCall *c, NSWindow *w, int) {
    if (w.isZoomed) [w zoom:nil];
    [c ok:@{@"maximized" : @(w.isZoomed)}];
  });
  reg(@"toggleMaximize", ^(PlatformCall *c, NSWindow *w, int) {
    [w zoom:nil];
    [c ok:@{@"maximized" : @(w.isZoomed)}];
  });
  reg(@"isMaximized", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.isZoomed)]; });
  reg(@"isFullscreen", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@((w.styleMask & NSWindowStyleMaskFullScreen) != 0)]; });
  reg(@"setFullscreen", ^(PlatformCall *c, NSWindow *w, int) {
    BOOL want = [c boolean:@"fullscreen" or:YES];
    BOOL is = (w.styleMask & NSWindowStyleMaskFullScreen) != 0;
    if (want != is) [w toggleFullScreen:nil];
    [c ok:@{@"fullscreen" : @(want)}]; // the transition animates; the state lands ~0.5–1 s later
  });
  reg(@"toggleFullscreen", ^(PlatformCall *c, NSWindow *w, int) {
    BOOL is = (w.styleMask & NSWindowStyleMaskFullScreen) != 0;
    [w toggleFullScreen:nil];
    [c ok:@{@"fullscreen" : @(!is)}];
  });
  reg(@"restore", ^(PlatformCall *c, NSWindow *w, int) {
    if (w.isMiniaturized) [w deminiaturize:nil];
    if (w.styleMask & NSWindowStyleMaskFullScreen) [w toggleFullScreen:nil];
    else if (w.isZoomed) [w zoom:nil];
    [c ok:nil];
  });
  reg(@"setSimpleFullscreen", ^(PlatformCall *c, NSWindow *w, int id) {
    BOOL on = [c boolean:@"enabled" or:YES];
    BOOL is = g_simple_fs_frames.count(id) > 0;
    if (on && !is) {
      g_simple_fs_frames[id] = w.frame;
      g_simple_fs_masks[id] = w.styleMask;
      NSApp.presentationOptions = NSApplicationPresentationAutoHideMenuBar | NSApplicationPresentationAutoHideDock;
      w.styleMask = NSWindowStyleMaskBorderless;
      [w setFrame:(w.screen ?: NSScreen.mainScreen).frame display:YES];
    } else if (!on && is) {
      NSApp.presentationOptions = NSApplicationPresentationDefault;
      w.styleMask = g_simple_fs_masks[id];
      [w setFrame:g_simple_fs_frames[id] display:YES];
      g_simple_fs_frames.erase(id);
      g_simple_fs_masks.erase(id);
    }
    [c ok:nil];
  });
  reg(@"isSimpleFullscreen", ^(PlatformCall *c, NSWindow *, int id) { [c ok:@{@"simpleFullscreen" : @(g_simple_fs_frames.count(id) > 0)}]; });
  reg(@"isFocused", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.isKeyWindow)]; });
  reg(@"isActive", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.isKeyWindow && NSApp.isActive)]; });
  reg(@"focus", ^(PlatformCall *c, NSWindow *w, int) {
    [NSApp activateIgnoringOtherApps:YES];
    [w makeKeyAndOrderFront:nil];
    [c ok:nil];
  });
  reg(@"blur", ^(PlatformCall *c, NSWindow *w, int) {
    [w resignKeyWindow];
    for (NSNumber *n in platform_window_ids())
      if (platform_window(n.intValue) != w && platform_window(n.intValue).isVisible) {
        [platform_window(n.intValue) makeKeyWindow];
        break;
      }
    [c ok:nil];
  });
  reg(@"isHovered", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"hovered" : @(NSPointInRect(NSEvent.mouseLocation, w.frame))}]; });
  reg(@"isOccluded", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(!(w.occlusionState & NSWindowOcclusionStateVisible))]; });
  reg(@"isVisible", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.isVisible && w.alphaValue > 0)]; });
  reg(@"show", ^(PlatformCall *c, NSWindow *w, int) {
    if (w.alphaValue == 0) w.alphaValue = 1;
    [w makeKeyAndOrderFront:nil];
    [c ok:nil];
  });
  reg(@"hide", ^(PlatformCall *c, NSWindow *w, int) {
    [w orderOut:nil];
    [c ok:nil];
  });
  reg(@"close", ^(PlatformCall *c, NSWindow *w, int id) {
    [c ok:nil];
    platform_set_close_veto(id, NO); // programmatic close bypasses the veto
    [w performClose:nil];
  });
  reg(@"setCloseVeto", ^(PlatformCall *c, NSWindow *, int id) {
    BOOL on = [c boolean:@"enabled" or:YES];
    platform_set_close_veto(id, on);
    [c ok:@{@"armed" : @(on)}];
  });
  reg_flag(@"requestAttention", nil, nil, ^(NSWindow *, BOOL) { [NSApp requestUserAttention:NSInformationalRequest]; }, nil);
  reg(@"flashFrame", ^(PlatformCall *c, NSWindow *, int) {
    [NSApp requestUserAttention:NSInformationalRequest];
    [c ok:nil];
  });
  reg(@"setRepresentedFilename", ^(PlatformCall *c, NSWindow *w, int) {
    NSString *path = [c string:@"path"];
    w.representedURL = path.length ? [NSURL fileURLWithPath:path] : nil;
    [c ok:nil];
  });
  reg(@"showCharacterPalette", ^(PlatformCall *c, NSWindow *w, int) {
    [w makeKeyAndOrderFront:nil];
    [NSApp orderFrontCharacterPalette:nil];
    [c ok:nil];
  });

  // ── z-order + chrome ──────────────────────────────────────────────────
  reg_flag(@"setAlwaysOnTop", nil, nil, ^(NSWindow *w, BOOL on) { w.level = on ? NSFloatingWindowLevel : NSNormalWindowLevel; }, nil);
  reg_flag(@"setAlwaysOnBottom", nil, nil, ^(NSWindow *w, BOOL on) { w.level = on ? kCGDesktopIconWindowLevel + 1 : NSNormalWindowLevel; }, nil);
  reg_flag(@"setResizable", @"isResizable", @"resizable", ^(NSWindow *w, BOOL on) { set_mask(w, NSWindowStyleMaskResizable, on); },
           ^BOOL(NSWindow *w) { return (w.styleMask & NSWindowStyleMaskResizable) != 0; });
  reg_flag(@"setClosable", @"isClosable", @"closable", ^(NSWindow *w, BOOL on) { set_mask(w, NSWindowStyleMaskClosable, on); },
           ^BOOL(NSWindow *w) { return (w.styleMask & NSWindowStyleMaskClosable) != 0; });
  reg_flag(@"setMinimizable", @"isMinimizable", @"minimizable", ^(NSWindow *w, BOOL on) { set_mask(w, NSWindowStyleMaskMiniaturizable, on); },
           ^BOOL(NSWindow *w) { return (w.styleMask & NSWindowStyleMaskMiniaturizable) != 0; });
  reg_flag(@"setMaximizable", @"isMaximizable", @"maximizable",
           ^(NSWindow *w, BOOL on) { [w standardWindowButton:NSWindowZoomButton].enabled = on; },
           ^BOOL(NSWindow *w) { return [w standardWindowButton:NSWindowZoomButton].isEnabled; });
  reg(@"setTitleBarStyle", ^(PlatformCall *c, NSWindow *w, int) {
    NSString *style = [c string:@"style"] ?: @"default";
    BOOL transparent = ![style isEqual:@"default"];
    w.titlebarAppearsTransparent = transparent;
    set_mask(w, NSWindowStyleMaskFullSizeContentView, transparent);
    w.titleVisibility = [style hasPrefix:@"hidden"] ? NSWindowTitleHidden : NSWindowTitleVisible;
    if ([style isEqual:@"hiddenInset"]) {
      // An empty unified toolbar pushes the traffic lights inward (Electron's hiddenInset).
      if (!w.toolbar) w.toolbar = [[NSToolbar alloc] initWithIdentifier:@"sd-inset"];
      w.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
    } else if ([w.toolbar.identifier isEqual:@"sd-inset"]) {
      w.toolbar = nil;
    }
    [c ok:nil];
  });
  reg_flag(@"setDecorations", nil, nil, ^(NSWindow *w, BOOL on) {
    if (on) w.styleMask |= NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable;
    else w.styleMask &= ~(NSWindowStyleMaskTitled);
  }, nil);
  reg_flag(@"setHasShadow", nil, nil, ^(NSWindow *w, BOOL on) { w.hasShadow = on; }, nil);
  reg(@"invalidateShadow", ^(PlatformCall *c, NSWindow *w, int) {
    [w invalidateShadow];
    [c ok:nil];
  });

  // ── appearance + behavior ─────────────────────────────────────────────
  reg(@"setOpacity", ^(PlatformCall *c, NSWindow *w, int) {
    w.alphaValue = MAX(0, MIN(1, [c number:@"opacity" or:1]));
    [c ok:nil];
  });
  reg(@"getOpacity", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"opacity" : @(w.alphaValue)}]; });
  reg_flag(@"setMovable", nil, nil, ^(NSWindow *w, BOOL on) { w.movable = on; }, nil);
  reg_flag(@"setMovableByWindowBackground", nil, nil, ^(NSWindow *w, BOOL on) { w.movableByWindowBackground = on; }, nil);
  reg_flag(@"setIgnoresMouseEvents", @"ignoresMouseEvents", @"ignored", ^(NSWindow *w, BOOL on) { w.ignoresMouseEvents = on; },
           ^BOOL(NSWindow *w) { return w.ignoresMouseEvents; });
  reg(@"setContentProtected", ^(PlatformCall *c, NSWindow *w, int) {
    BOOL on = [c boolean:@"enabled" or:YES];
    w.sharingType = on ? NSWindowSharingNone : NSWindowSharingReadOnly;
    // Observed on macOS 26: once a window is NSWindowSharingNone it can't be
    // switched back (the setter is ignored). Report it instead of faking state.
    if (!on && w.sharingType == NSWindowSharingNone)
      return [c fail:@"unsupported" message:@"window.setContentProtected(false): macOS keeps a window protected once enabled"];
    [c ok:nil];
  });
  reg(@"isContentProtected", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"contentProtected" : @(w.sharingType == NSWindowSharingNone)}]; });
  reg_flag(@"setVisibleOnAllWorkspaces", nil, nil, ^(NSWindow *w, BOOL on) {
    w.collectionBehavior = on ? (w.collectionBehavior | NSWindowCollectionBehaviorCanJoinAllSpaces)
                              : (w.collectionBehavior & ~NSWindowCollectionBehaviorCanJoinAllSpaces);
  }, nil);
  reg(@"setDocumentEdited", ^(PlatformCall *c, NSWindow *w, int) {
    w.documentEdited = [c boolean:@"edited" or:YES];
    [c ok:nil];
  });
  reg(@"isDocumentEdited", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"edited" : @(w.isDocumentEdited)}]; });
  reg(@"setFocusable", ^(PlatformCall *c, NSWindow *, int) {
    [c fail:@"unsupported" message:@"window.setFocusable: NSWindow focusability is fixed by its class on macOS"];
  });
  reg(@"setCursorHidden", ^(PlatformCall *c, NSWindow *, int) {
    [c boolean:@"hidden" or:YES] ? [NSCursor hide] : [NSCursor unhide];
    [c ok:nil];
  });
  reg(@"setCursorPosition", ^(PlatformCall *c, NSWindow *, int) {
    CGWarpMouseCursorPosition(CGPointMake([c number:@"x" or:0], [c number:@"y" or:0])); // CG space is top-left already
    [c ok:nil];
  });
  reg(@"setTheme", ^(PlatformCall *c, NSWindow *w, int) {
    NSString *t = [c string:@"theme"] ?: @"system";
    w.appearance = [t isEqual:@"dark"]    ? [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]
                   : [t isEqual:@"light"] ? [NSAppearance appearanceNamed:NSAppearanceNameAqua]
                                          : nil;
    [c ok:nil];
  });
}
