// tray.* — one NSStatusItem with title, tooltip, icon, badge dot and menu.
// Ops: set|create, remove|destroy, isSet|exists, getBounds, performClick.
// Events: trayClick {x,y,width,height} (button rect, top-left origin against the
// primary screen, same convention as menu.popup) when the item has no menu;
// menu item actions emit menuAction {id}.
// `set` is a partial update: only keys present in args change; null clears.
#include "platform_internal.h"

static NSStatusItem *g_item;
static NSImage *g_icon;       // unbadged icon (nil = none)
static NSColor *g_badge;      // badge dot color (nil = none)

// ---------------------------------------------------------------------------
// Targets

@interface SDTrayTarget : NSObject
@end

static SDTrayTarget *target(void) {
  static SDTrayTarget *t;
  if (!t) t = [SDTrayTarget new];
  return t;
}

static NSDictionary *button_rect(void) {
  NSWindow *w = g_item.button.window;
  NSScreen *primary = NSScreen.screens.firstObject;
  if (!w || !primary) return nil;
  NSRect f = w.frame;
  // Until the menu bar places it, the item window sits at a placeholder frame
  // outside every screen.
  BOOL placed = NO;
  for (NSScreen *s in NSScreen.screens) placed = placed || (f.size.height > 0 && NSContainsRect(s.frame, f));
  if (!placed) return nil;
  return @{
    @"x" : @(f.origin.x),
    @"y" : @(NSHeight(primary.frame) - f.origin.y - f.size.height),
    @"width" : @(f.size.width),
    @"height" : @(f.size.height),
  };
}

// The menu bar positions a new item asynchronously: retry on later run loop
// passes (never blocking) until the frame is real, nil after ~1 s.
static void with_button_rect(void (^done)(NSDictionary *_Nullable), int attempts) {
  NSDictionary *r = g_item ? button_rect() : nil;
  if (r || !g_item || attempts <= 0) return done(r);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 16 * NSEC_PER_MSEC), dispatch_get_main_queue(),
                 ^{ with_button_rect(done, attempts - 1); });
}

@implementation SDTrayTarget
- (void)itemAction:(NSMenuItem *)sender {
  id rep = sender.representedObject;
  if ([rep isKindOfClass:NSString.class]) platform_emit(@"menuAction", @{@"id" : rep});
}
- (void)trayClick:(id)sender {
  platform_popover_tray_click(); // a bound popover toggles natively, no JS round trip
  with_button_rect(^(NSDictionary *r) { platform_emit(@"trayClick", r ?: @{}); }, 60);
}
@end

// ---------------------------------------------------------------------------
// Icons

static NSString *lower(id v) {
  return [v isKindOfClass:NSString.class] ? [v lowercaseString] : nil;
}

// NATIVE_ICON_NAMES (index.ts) -> AppKit NSImageName values, as the GPUI build
// mapped them. Names AppKit no longer ships fall back to SF Symbols.
static NSImage *native_image(NSString *name) {
  static NSDictionary<NSString *, NSString *> *appkit, *symbols;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    appkit = @{
      @"add" : @"NSAddTemplate", @"advanced" : @"NSAdvanced", @"bluetooth" : @"NSBluetoothTemplate",
      @"bookmarks" : @"NSBookmarksTemplate", @"caution" : @"NSCaution", @"color" : @"NSColorPanel",
      @"colorpanel" : @"NSColorPanel", @"columnview" : @"NSColumnViewTemplate", @"computer" : @"NSComputer",
      @"enterfullscreen" : @"NSEnterFullScreenTemplate", @"exitfullscreen" : @"NSExitFullScreenTemplate",
      @"folder" : @"NSFolder", @"folderburnable" : @"NSFolderBurnable", @"foldersmart" : @"NSFolderSmart",
      @"followlinkfreestandingtemplate" : @"NSFollowLinkFreestandingTemplate", @"fontpanel" : @"NSFontPanel",
      @"goleft" : @"NSGoLeftTemplate", @"goright" : @"NSGoRightTemplate", @"home" : @"NSHomeTemplate",
      @"ichattheater" : @"NSIChatTheaterTemplate", @"listview" : @"NSListViewTemplate",
      @"locklocked" : @"NSLockLockedTemplate", @"lockunlocked" : @"NSLockUnlockedTemplate",
      @"menumixedstate" : @"NSMenuMixedStateTemplate", @"preferencesgeneral" : @"NSPreferencesGeneral",
      @"quicklook" : @"NSQuickLookTemplate", @"refresh" : @"NSRefreshTemplate",
      @"refreshfreestanding" : @"NSRefreshFreestandingTemplate", @"remove" : @"NSRemoveTemplate",
      @"revealfreestanding" : @"NSRevealFreestandingTemplate", @"rightfacingtriangle" : @"NSRightFacingTriangleTemplate",
      @"share" : @"NSShareTemplate", @"slideshow" : @"NSSlideshowTemplate", @"smartbadge" : @"NSSmartBadgeTemplate",
      @"statusavailable" : @"NSStatusAvailable", @"statusnone" : @"NSStatusNone",
      @"statuspartiallyavailable" : @"NSStatusPartiallyAvailable", @"statusunavailable" : @"NSStatusUnavailable",
      @"stopprogress" : @"NSStopProgressTemplate", @"stopprogressfreestanding" : @"NSStopProgressFreestandingTemplate",
      @"trashempty" : @"NSTrashEmpty", @"trashfull" : @"NSTrashFull", @"user" : @"NSUser",
      @"useraccounts" : @"NSUserAccounts", @"usergroup" : @"NSUserGroup", @"userguest" : @"NSUserGuest",
      @"actiontemplate" : @"NSActionTemplate", @"leftfacingtriangle" : @"NSLeftFacingTriangleTemplate",
      @"multipledocuments" : @"NSMultipleDocuments", @"network" : @"NSNetwork", @"bonjour" : @"NSBonjour",
      @"everyone" : @"NSEveryone", @"invaliddatafreestanding" : @"NSInvalidDataFreestandingTemplate",
      @"mobileme" : @"NSMobileMe",
    };
    // No AppKit image under the GPUI-era names (NSMe, NSNoAccounts, ...).
    symbols = @{
      @"me" : @"person.crop.circle",
      @"noaccounts" : @"person.crop.circle.badge.xmark",
      @"openpanel" : @"folder",
      @"reveal" : @"magnifyingglass",
      @"freestandingtemplate" : @"square.dashed",
    };
  });
  NSString *key = name.lowercaseString;
  NSImage *img = appkit[key] ? [NSImage imageNamed:appkit[key]] : nil;
  if (!img && symbols[key]) img = [NSImage imageWithSystemSymbolName:symbols[key] accessibilityDescription:name];
  if (!img) img = [NSImage imageWithSystemSymbolName:name accessibilityDescription:name]; // any SF Symbol name
  return [img copy]; // imageNamed: is a shared instance; never mutate it
}

static BOOL looks_like_path(NSString *s) {
  return [s rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"/\\.:~"]].location != NSNotFound;
}

static NSImage *fit(NSImage *img, CGFloat maxHeight) {
  NSSize s = img.size;
  if (s.height > maxHeight && s.height > 0) img.size = NSMakeSize(s.width * maxHeight / s.height, maxHeight);
  return img;
}

// {native}|{symbol}|{path}|string -> image. Returns nil and sets *error on failure.
static NSImage *icon_from_spec(id icon, NSString *ctx, NSString **error) {
  NSString *native = nil, *path = nil;
  if ([icon isKindOfClass:NSString.class]) {
    if (looks_like_path(icon)) path = icon;
    else native = icon;
  } else if ([icon isKindOfClass:NSDictionary.class]) {
    id n = icon[@"native"] ?: icon[@"symbol"];
    id p = icon[@"path"] ?: icon[@"file"];
    if ([n isKindOfClass:NSString.class]) native = n;
    else if ([p isKindOfClass:NSString.class]) path = p;
  }
  if (native) {
    NSImage *img = native_image(native);
    if (!img) *error = [NSString stringWithFormat:@"%@: unknown native icon `%@` (not in NATIVE_ICON_NAMES, not an SF Symbol)", ctx, native];
    return img;
  }
  if (path) {
    NSImage *img = [[NSImage alloc] initWithContentsOfFile:path.stringByExpandingTildeInPath];
    // A dotted bare word ("star.fill") is path-shaped by the IconSource rule;
    // when no such file exists, try it as an SF Symbol before giving up.
    if (!img && [icon isKindOfClass:NSString.class] &&
        [path rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"/\\~"]].location == NSNotFound)
      img = native_image(path);
    if (!img) *error = [NSString stringWithFormat:@"%@: could not load image `%@`", ctx, path];
    return img;
  }
  *error = [NSString stringWithFormat:@"%@: icon needs `native` (AppKit/SF Symbol name) or `path` (file)", ctx];
  return nil;
}

// ---------------------------------------------------------------------------
// Colors: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba() (commas or spaces, %, "/ a"),
// and the common CSS named colors.

static NSColor *parse_color(NSString *text) {
  NSString *s = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString;
  if (!s.length) return nil;
  static NSDictionary<NSString *, NSString *> *named;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    named = @{
      @"black" : @"000000", @"white" : @"ffffff", @"red" : @"ff0000", @"green" : @"008000", @"lime" : @"00ff00",
      @"blue" : @"0000ff", @"yellow" : @"ffff00", @"orange" : @"ffa500", @"purple" : @"800080", @"pink" : @"ffc0cb",
      @"gray" : @"808080", @"grey" : @"808080", @"silver" : @"c0c0c0", @"cyan" : @"00ffff", @"aqua" : @"00ffff",
      @"magenta" : @"ff00ff", @"fuchsia" : @"ff00ff", @"maroon" : @"800000", @"navy" : @"000080", @"olive" : @"808000",
      @"teal" : @"008080", @"brown" : @"a52a2a", @"gold" : @"ffd700", @"crimson" : @"dc143c", @"tomato" : @"ff6347",
      @"coral" : @"ff7f50", @"indigo" : @"4b0082", @"violet" : @"ee82ee", @"rebeccapurple" : @"663399",
      @"transparent" : @"00000000",
    };
  });
  if (named[s]) s = [@"#" stringByAppendingString:named[s]];
  if ([s hasPrefix:@"#"]) {
    NSString *h = [s substringFromIndex:1];
    if (h.length == 3 || h.length == 4) {
      NSMutableString *x = [NSMutableString string];
      for (NSUInteger i = 0; i < h.length; i++) [x appendFormat:@"%C%C", [h characterAtIndex:i], [h characterAtIndex:i]];
      h = x;
    }
    if (h.length != 6 && h.length != 8) return nil;
    if ([h rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"].invertedSet].location != NSNotFound)
      return nil;
    unsigned long long v = 0;
    [[NSScanner scannerWithString:h] scanHexLongLong:&v];
    if (h.length == 6) v = (v << 8) | 0xff;
    return [NSColor colorWithSRGBRed:((v >> 24) & 0xff) / 255.0 green:((v >> 16) & 0xff) / 255.0 blue:((v >> 8) & 0xff) / 255.0 alpha:(v & 0xff) / 255.0];
  }
  if ([s hasPrefix:@"rgb"]) {
    NSRange open = [s rangeOfString:@"("], close = [s rangeOfString:@")" options:NSBackwardsSearch];
    if (open.location == NSNotFound || close.location == NSNotFound || close.location < open.location) return nil;
    NSString *inner = [s substringWithRange:NSMakeRange(open.location + 1, close.location - open.location - 1)];
    inner = [[inner stringByReplacingOccurrencesOfString:@"," withString:@" "] stringByReplacingOccurrencesOfString:@"/" withString:@" "];
    NSMutableArray *parts = [NSMutableArray array];
    for (NSString *p in [inner componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceCharacterSet])
      if (p.length) [parts addObject:p];
    if (parts.count != 3 && parts.count != 4) return nil;
    double c[4] = {0, 0, 0, 1};
    for (NSUInteger i = 0; i < parts.count; i++) {
      NSString *p = parts[i];
      NSScanner *sc = [NSScanner scannerWithString:p];
      double v;
      if (![sc scanDouble:&v]) return nil;
      BOOL pct = [p hasSuffix:@"%"];
      if (i < 3) c[i] = pct ? v / 100.0 : v / 255.0;
      else c[i] = pct ? v / 100.0 : v;
      c[i] = MAX(0, MIN(1, c[i]));
    }
    return [NSColor colorWithSRGBRed:c[0] green:c[1] blue:c[2] alpha:c[3]];
  }
  return nil;
}

// The status item API has no badge channel: bake a dot into the icon's top-right
// corner. The result is not a template (AppKit would recolor the dot).
static NSImage *badged(NSImage *base, NSColor *color) {
  NSSize size = base ? base.size : NSMakeSize(18, 18);
  return [NSImage imageWithSize:size
                        flipped:NO
                 drawingHandler:^BOOL(NSRect rect) {
                   if (base) {
                     if (base.isTemplate) {
                       // Templates draw black; tint to the menu bar's label color.
                       [base drawInRect:rect];
                       [NSColor.labelColor set];
                       NSRectFillUsingOperation(rect, NSCompositingOperationSourceAtop);
                     } else {
                       [base drawInRect:rect];
                     }
                   }
                   CGFloat d = MAX(6, MIN(size.width, size.height) * 0.36);
                   [color set];
                   [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(size.width - d, size.height - d, d, d)] fill];
                   return YES;
                 }];
}

static void refresh_image(void) {
  NSStatusBarButton *button = g_item.button;
  button.image = g_badge ? badged(g_icon, g_badge) : g_icon;
  button.imagePosition = button.image && button.title.length ? NSImageLeft : (button.image ? NSImageOnly : NSNoImage);
}

// ---------------------------------------------------------------------------
// Menu (MenuItemSpec)

static NSString *const kRoleTitles[][2] = {
    {@"copy", @"Copy"}, {@"cut", @"Cut"}, {@"paste", @"Paste"}, {@"selectall", @"Select All"}, {@"undo", @"Undo"},
    {@"redo", @"Redo"}, {@"delete", @"Delete"}, {@"minimize", @"Minimize"}, {@"zoom", @"Zoom"}, {@"close", @"Close"},
    {@"quit", @"Quit"}, {@"hide", @"Hide"}, {@"hideothers", @"Hide Others"}, {@"showall", @"Show All"},
    {@"about", @"About"}, {@"front", @"Bring All to Front"}, {@"togglefullscreen", @"Toggle Full Screen"},
    {@"pasteandmatchstyle", @"Paste and Match Style"}, {@"reload", @"Reload"},
};

// Returns nil on success, or an error message.
static NSString *apply_role(NSMenuItem *item, NSString *role) {
  NSString *r = role.lowercaseString;
  SEL action = NULL;
  id tgt = nil;
  NSDictionary<NSString *, NSString *> *chain = @{
    @"copy" : @"copy:", @"paste" : @"paste:", @"cut" : @"cut:", @"selectall" : @"selectAll:", @"undo" : @"undo:",
    @"redo" : @"redo:", @"pasteandmatchstyle" : @"pasteAsPlainText:", @"pasteasplaintext" : @"pasteAsPlainText:",
    @"delete" : @"delete:", @"minimize" : @"performMiniaturize:", @"zoom" : @"performZoom:", @"maximize" : @"performZoom:",
    @"close" : @"performClose:", @"closewindow" : @"performClose:", @"togglefullscreen" : @"toggleFullScreen:",
    @"fullscreen" : @"toggleFullScreen:", @"startspeaking" : @"startSpeaking:", @"stopspeaking" : @"stopSpeaking:",
    @"about" : @"orderFrontStandardAboutPanel:", @"reload" : @"reload:",
  };
  NSDictionary<NSString *, NSString *> *app = @{
    @"quit" : @"terminate:", @"hide" : @"hide:", @"hideothers" : @"hideOtherApplications:",
    @"hideotherapplications" : @"hideOtherApplications:", @"showall" : @"unhideAllApplications:",
    @"unhideall" : @"unhideAllApplications:", @"front" : @"arrangeInFront:",
  };
  if (chain[r]) action = NSSelectorFromString(chain[r]);
  else if (app[r]) action = NSSelectorFromString(app[r]), tgt = NSApp;
  else if ([r isEqual:@"services"]) {
    if (!item.submenu) item.submenu = [[NSMenu alloc] initWithTitle:@"Services"];
    NSApp.servicesMenu = item.submenu;
    if (!item.title.length) item.title = @"Services";
    return nil;
  } else return [NSString stringWithFormat:@"tray.set: unknown menu item role `%@`", role];
  item.action = action;
  item.target = tgt;
  item.representedObject = nil;
  if (!item.title.length) {
    for (auto &pair : kRoleTitles)
      if ([pair[0] isEqual:r]) item.title = [r isEqual:@"quit"] || [r isEqual:@"hide"] || [r isEqual:@"about"]
                                               ? [NSString stringWithFormat:@"%@ %@", pair[1], platform_app_name()]
                                               : pair[1];
  }
  return nil;
}

static NSMenu *build_menu(NSArray *items, NSString **error);

static NSMenuItem *build_item(id spec, NSString **error) {
  if (![spec isKindOfClass:NSDictionary.class]) {
    *error = @"tray.set: menu items must be objects";
    return nil;
  }
  NSString *type = lower(spec[@"type"]) ?: @"action";
  NSString *role = [spec[@"role"] isKindOfClass:NSString.class] ? spec[@"role"] : nil;
  if (spec[@"role"] && spec[@"role"] != NSNull.null && !role) {
    *error = @"tray.set: menu `role` must be a string";
    return nil;
  }
  if ([type isEqual:@"separator"] || [type isEqual:@"divider"] || [role.lowercaseString isEqual:@"separator"])
    return [NSMenuItem separatorItem];
  id label = spec[@"label"] ?: spec[@"title"] ?: spec[@"name"];
  NSString *title = [label isKindOfClass:NSString.class] ? label : @"";
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
  id children = spec[@"submenu"];
  if ([children isKindOfClass:NSArray.class] && [children count]) {
    NSMenu *sub = build_menu(children, error);
    if (!sub) return nil;
    sub.title = title;
    item.submenu = sub;
  } else if ([type isEqual:@"submenu"]) {
    *error = @"tray.set: type `submenu` needs a non-empty `submenu` array";
    return nil;
  } else {
    id ident = spec[@"id"];
    item.target = target();
    item.action = @selector(itemAction:);
    item.representedObject = [ident isKindOfClass:NSString.class] ? ident : title; // label fallback, as before
  }
  if ([spec[@"checked"] isKindOfClass:NSNumber.class] && [spec[@"checked"] boolValue]) item.state = NSControlStateValueOn;
  if ([spec[@"disabled"] isKindOfClass:NSNumber.class] && [spec[@"disabled"] boolValue]) item.enabled = NO;
  if (role) {
    if (NSString *e = apply_role(item, role)) {
      *error = e;
      return nil;
    }
  }
  id icon = spec[@"icon"];
  if (icon && icon != NSNull.null) {
    NSImage *img = icon_from_spec(icon, @"tray.set menu icon", error);
    if (!img) return nil;
    item.image = fit(img, 16);
  }
  return item;
}

static NSMenu *build_menu(NSArray *items, NSString **error) {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  menu.autoenablesItems = NO;
  for (id spec in items) {
    NSMenuItem *item = build_item(spec, error);
    if (!item) return nil;
    [menu addItem:item];
  }
  return menu;
}

// ---------------------------------------------------------------------------
// Ops

static void tray_set(PlatformCall *call) {
  NSDictionary *a = call.args;
  // Validate everything before touching the status bar.
  NSString *error = nil;
  BOOL iconGiven = NO;
  NSImage *icon = nil;
  BOOL template_ = [call boolean:@"template" or:YES];
  id nameArg = a[@"imageName"] ?: a[@"symbol"];
  id pathArg = a[@"imagePath"] ?: a[@"image"];
  id iconArg = a[@"icon"];
  if ([nameArg isKindOfClass:NSString.class]) {
    iconGiven = YES;
    icon = icon_from_spec(@{@"native" : nameArg}, @"tray.set", &error);
    if (!icon) return [call fail:@"invalid_args" message:error];
  } else if ([pathArg isKindOfClass:NSString.class]) {
    iconGiven = YES;
    icon = icon_from_spec(@{@"path" : pathArg}, @"tray.set", &error);
    if (!icon) return [call fail:@"unavailable" message:error];
  } else if (iconArg && iconArg != NSNull.null) {
    iconGiven = YES;
    icon = icon_from_spec(iconArg, @"tray.set", &error);
    BOOL isPath = [iconArg isKindOfClass:NSDictionary.class] ? (iconArg[@"path"] || iconArg[@"file"])
                  : [iconArg isKindOfClass:NSString.class]   ? looks_like_path(iconArg)
                                                             : NO;
    if (!icon) return [call fail:isPath ? @"unavailable" : @"invalid_args" message:error];
  } else if (a[@"imageName"] == NSNull.null || a[@"imagePath"] == NSNull.null || iconArg == NSNull.null) {
    iconGiven = YES; // explicit null clears
  }
  if (icon) {
    [icon setTemplate:template_];
    fit(icon, 18);
  }

  BOOL badgeGiven = a[@"badgeColor"] != nil;
  NSColor *badge = nil;
  if (badgeGiven && a[@"badgeColor"] != NSNull.null) {
    NSString *text = [call string:@"badgeColor"];
    if (!text) return [call fail:@"invalid_args" message:@"tray.set: `badgeColor` needs a color string"];
    badge = parse_color(text);
    if (!badge) return [call fail:@"invalid_args" message:[NSString stringWithFormat:@"tray.set: unknown `badgeColor` `%@`", text]];
  }

  id menuArg = a[@"menu"];
  NSMenu *menu = nil;
  if (menuArg && menuArg != NSNull.null) {
    id items = [menuArg isKindOfClass:NSDictionary.class] ? menuArg[@"items"] : menuArg;
    if (![items isKindOfClass:NSArray.class]) return [call fail:@"invalid_args" message:@"tray.set: `menu` needs an `items` array"];
    menu = build_menu(items, &error);
    if (!menu) return [call fail:@"invalid_args" message:error];
  }

  if (!g_item) {
    g_item = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    if (!g_item.button) {
      g_item = nil;
      return [call fail:@"unavailable" message:@"tray.set: could not create an NSStatusItem"];
    }
    g_icon = nil;
    g_badge = nil;
    g_item.button.target = target();
    g_item.button.action = @selector(trayClick:);
    [g_item.button sendActionOn:NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp];
  }
  NSStatusBarButton *button = g_item.button;
  if (a[@"title"]) button.title = [call string:@"title"] ?: @"";
  if (a[@"tooltip"]) button.toolTip = [call string:@"tooltip"];
  if (iconGiven) g_icon = icon;
  if (badgeGiven) g_badge = badge;
  // A status item with neither title nor image is invisible and unclickable.
  if (!g_icon && !g_badge && !button.title.length) button.title = platform_app_name();
  refresh_image();
  // With a menu attached AppKit opens it on click and sends no action (no trayClick).
  if (menuArg) g_item.menu = menu;
  // `popover: "<id>"` — clicks toggle that popover (see popover.create); null unbinds.
  if (a[@"popover"]) platform_popover_bind_tray([call string:@"popover"]);
  [call ok:@{@"set" : @YES}];
}

static void tray_remove(PlatformCall *call) {
  if (!g_item) return [call ok:@{@"removed" : @NO}];
  [NSStatusBar.systemStatusBar removeStatusItem:g_item];
  platform_popover_bind_tray(nil);
  g_item = nil;
  g_icon = nil;
  g_badge = nil;
  [call ok:@{@"removed" : @YES}];
}

void platform_register_tray(void) {
  platform_register_many(@"tray", @[ @"set", @"create" ], ^(PlatformCall *call) { tray_set(call); });
  platform_register_many(@"tray", @[ @"remove", @"destroy" ], ^(PlatformCall *call) { tray_remove(call); });
  platform_register_many(@"tray", @[ @"isSet", @"exists" ], ^(PlatformCall *call) { [call ok:@(g_item != nil)]; });
  // Screen rect of the status item button (top-left origin), null when unset.
  platform_register(@"tray", @"getBounds", ^(PlatformCall *call) {
    with_button_rect(^(NSDictionary *r) { [call ok:r]; }, 60);
  });
  // Programmatic click (automation/tests): emits trayClick like a real click.
  // Refused while a menu is attached: that would open the menu's modal tracking loop.
  platform_register(@"tray", @"performClick", ^(PlatformCall *call) {
    if (!g_item) return [call fail:@"unavailable" message:@"tray.performClick: no status item is set"];
    if (g_item.menu) return [call fail:@"unsupported" message:@"tray.performClick: the item has a menu; clicks open it"];
    [g_item.button performClick:nil];
    [call ok:@{@"clicked" : @YES}];
  });
}

// Shared with the other modules (platform_internal.h).
NSImage *platform_icon(id icon, NSString *context, NSString **error) {
  NSString *e = nil;
  NSImage *img = icon_from_spec(icon, context, &e);
  if (error) *error = e;
  return img;
}
NSDictionary *platform_tray_button_rect(void) { return g_item ? button_rect() : nil; }
NSStatusBarButton *platform_tray_button(void) { return g_item.button; }
