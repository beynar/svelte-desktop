// menu.* — app menu bar, Dock menu, context menus, live item updates.
// MenuItemSpec (index.ts): {type, id, label, submenu, checked, disabled, role, icon}
// plus `accelerator` ("CmdOrCtrl+Shift+K"). Items with an id emit menuAction {id}.
// Roles: standard edit/window/app selectors, reload/zoom/devtools on the key
// window's web view, and preset submenus appMenu/fileMenu/editMenu/viewMenu/windowMenu.
#import <objc/message.h>

#include "platform_internal.h"

static NSMapTable<NSString *, NSMenuItem *> *g_items; // id -> item (weak values)
static NSMenu *g_dock_menu;

@interface SDMenuTarget : NSObject
@end

static SDMenuTarget *menu_target(void) {
  static SDMenuTarget *t;
  if (!t) t = [SDMenuTarget new];
  return t;
}

static WKWebView *key_webview(void) {
  NSWindow *key = NSApp.keyWindow ?: NSApp.mainWindow;
  for (NSNumber *n in platform_window_ids())
    if (platform_window(n.intValue) == key) return platform_webview(n.intValue);
  NSArray *ids = platform_window_ids();
  return ids.count ? platform_webview([ids[0] intValue]) : nil;
}

@implementation SDMenuTarget
- (void)itemAction:(NSMenuItem *)sender {
  if ([sender.representedObject isKindOfClass:NSString.class]) platform_emit(@"menuAction", @{@"id" : sender.representedObject});
}
- (void)reload:(id)sender { [key_webview() reload]; }
- (void)zoomIn:(id)sender { key_webview().pageZoom = MIN(3.0, key_webview().pageZoom + 0.1); }
- (void)zoomOut:(id)sender { key_webview().pageZoom = MAX(0.3, key_webview().pageZoom - 0.1); }
- (void)resetZoom:(id)sender { key_webview().pageZoom = 1.0; }
- (void)toggleDevTools:(id)sender {
  // No public API; the inspector exists only when the window was created with debug.
  WKWebView *wv = key_webview();
  SEL getter = NSSelectorFromString(@"_inspector");
  if (![wv respondsToSelector:getter]) return;
  id inspector = ((id(*)(id, SEL))objc_msgSend)(wv, getter);
  SEL isVisible = NSSelectorFromString(@"isVisible");
  BOOL visible = [inspector respondsToSelector:isVisible] && ((BOOL(*)(id, SEL))objc_msgSend)(inspector, isVisible);
  SEL toggle = NSSelectorFromString(visible ? @"close" : @"show");
  if ([inspector respondsToSelector:toggle]) ((void (*)(id, SEL))objc_msgSend)(inspector, toggle);
}
@end

static void apply_accelerator(NSMenuItem *item, NSString *acc) {
  if (![acc isKindOfClass:NSString.class] || !acc.length) return;
  NSEventModifierFlags mask = 0;
  NSString *key = @"";
  NSDictionary *named = @{
    @"plus" : @"+", @"space" : @" ", @"tab" : @"\t", @"enter" : @"\r", @"return" : @"\r", @"backspace" : @"\b",
    @"delete" : [NSString stringWithFormat:@"%C", (unichar)NSDeleteFunctionKey], @"escape" : @"\033", @"esc" : @"\033",
    @"up" : [NSString stringWithFormat:@"%C", (unichar)NSUpArrowFunctionKey], @"down" : [NSString stringWithFormat:@"%C", (unichar)NSDownArrowFunctionKey],
    @"left" : [NSString stringWithFormat:@"%C", (unichar)NSLeftArrowFunctionKey], @"right" : [NSString stringWithFormat:@"%C", (unichar)NSRightArrowFunctionKey],
  };
  for (NSString *part in [acc componentsSeparatedByString:@"+"]) {
    NSString *p = part.lowercaseString;
    if (!p.length) key = @"+";
    else if ([@[ @"cmd", @"command", @"cmdorctrl", @"commandorcontrol", @"super", @"meta" ] containsObject:p]) mask |= NSEventModifierFlagCommand;
    else if ([p isEqual:@"shift"]) mask |= NSEventModifierFlagShift;
    else if ([@[ @"alt", @"option" ] containsObject:p]) mask |= NSEventModifierFlagOption;
    else if ([@[ @"ctrl", @"control" ] containsObject:p]) mask |= NSEventModifierFlagControl;
    else if (named[p]) key = named[p];
    else if (p.length > 1 && [p hasPrefix:@"f"] && [p substringFromIndex:1].intValue > 0)
      key = [NSString stringWithFormat:@"%C", (unichar)(NSF1FunctionKey + [p substringFromIndex:1].intValue - 1)];
    else key = p;
  }
  item.keyEquivalent = key;
  item.keyEquivalentModifierMask = mask;
}

static NSArray *preset(NSString *role) {
  NSString *name = platform_app_name();
  if ([role isEqual:@"appmenu"])
    return @[
      @{@"role" : @"about"}, @{@"type" : @"separator"}, @{@"role" : @"services"}, @{@"type" : @"separator"},
      @{@"role" : @"hide", @"accelerator" : @"Cmd+H"}, @{@"role" : @"hideOthers", @"accelerator" : @"Cmd+Alt+H"},
      @{@"role" : @"showAll"}, @{@"type" : @"separator"}, @{@"role" : @"quit", @"accelerator" : @"Cmd+Q", @"label" : [@"Quit " stringByAppendingString:name]}
    ];
  if ([role isEqual:@"filemenu"]) return @[ @{@"role" : @"close", @"accelerator" : @"Cmd+W"} ];
  if ([role isEqual:@"editmenu"])
    return @[
      @{@"role" : @"undo", @"accelerator" : @"Cmd+Z"}, @{@"role" : @"redo", @"accelerator" : @"Cmd+Shift+Z"}, @{@"type" : @"separator"},
      @{@"role" : @"cut", @"accelerator" : @"Cmd+X"}, @{@"role" : @"copy", @"accelerator" : @"Cmd+C"},
      @{@"role" : @"paste", @"accelerator" : @"Cmd+V"}, @{@"role" : @"pasteAndMatchStyle", @"accelerator" : @"Cmd+Alt+Shift+V"},
      @{@"role" : @"delete"}, @{@"role" : @"selectAll", @"accelerator" : @"Cmd+A"}
    ];
  if ([role isEqual:@"viewmenu"])
    return @[
      @{@"role" : @"reload", @"accelerator" : @"Cmd+R"}, @{@"role" : @"toggleDevTools", @"accelerator" : @"Cmd+Alt+I"},
      @{@"type" : @"separator"}, @{@"role" : @"resetZoom", @"accelerator" : @"Cmd+0"}, @{@"role" : @"zoomIn", @"accelerator" : @"Cmd+Plus"},
      @{@"role" : @"zoomOut", @"accelerator" : @"Cmd+-"}, @{@"type" : @"separator"}, @{@"role" : @"toggleFullscreen", @"accelerator" : @"Cmd+Ctrl+F"}
    ];
  if ([role isEqual:@"windowmenu"] || [role isEqual:@"window"])
    return @[ @{@"role" : @"minimize", @"accelerator" : @"Cmd+M"}, @{@"role" : @"zoom"}, @{@"type" : @"separator"}, @{@"role" : @"front"} ];
  return nil;
}

static NSString *preset_title(NSString *role) {
  return @{@"appmenu" : platform_app_name(), @"filemenu" : @"File", @"editmenu" : @"Edit", @"viewmenu" : @"View",
           @"windowmenu" : @"Window", @"window" : @"Window", @"help" : @"Help"}[role];
}

// Returns nil on success, or an error message.
static NSString *apply_role(NSMenuItem *item, NSString *role) {
  NSString *r = role.lowercaseString;
  NSString *name = platform_app_name();
  NSDictionary<NSString *, NSArray *> *roles = @{
    // role : [selector, target (nil = responder chain, @"app", @"self"), default title]
    @"undo" : @[ @"undo:", @"", @"Undo" ], @"redo" : @[ @"redo:", @"", @"Redo" ], @"cut" : @[ @"cut:", @"", @"Cut" ],
    @"copy" : @[ @"copy:", @"", @"Copy" ], @"paste" : @[ @"paste:", @"", @"Paste" ],
    @"pasteandmatchstyle" : @[ @"pasteAsPlainText:", @"", @"Paste and Match Style" ], @"delete" : @[ @"delete:", @"", @"Delete" ],
    @"selectall" : @[ @"selectAll:", @"", @"Select All" ], @"minimize" : @[ @"performMiniaturize:", @"", @"Minimize" ],
    @"zoom" : @[ @"performZoom:", @"", @"Zoom" ], @"close" : @[ @"performClose:", @"", @"Close Window" ],
    @"togglefullscreen" : @[ @"toggleFullScreen:", @"", @"Toggle Full Screen" ],
    @"about" : @[ @"orderFrontStandardAboutPanel:", @"app", [@"About " stringByAppendingString:name] ],
    @"quit" : @[ @"terminate:", @"app", [@"Quit " stringByAppendingString:name] ], // graceful via applicationShouldTerminate:
    @"hide" : @[ @"hide:", @"app", [@"Hide " stringByAppendingString:name] ],
    @"hideothers" : @[ @"hideOtherApplications:", @"app", @"Hide Others" ],
    @"showall" : @[ @"unhideAllApplications:", @"app", @"Show All" ], @"unhide" : @[ @"unhideAllApplications:", @"app", @"Show All" ],
    @"front" : @[ @"arrangeInFront:", @"app", @"Bring All to Front" ],
    @"reload" : @[ @"reload:", @"self", @"Reload" ], @"zoomin" : @[ @"zoomIn:", @"self", @"Zoom In" ],
    @"zoomout" : @[ @"zoomOut:", @"self", @"Zoom Out" ], @"resetzoom" : @[ @"resetZoom:", @"self", @"Actual Size" ],
    @"toggledevtools" : @[ @"toggleDevTools:", @"self", @"Toggle Developer Tools" ],
  };
  if ([r isEqual:@"services"]) {
    if (!item.title.length) item.title = @"Services";
    if (!item.submenu) item.submenu = [[NSMenu alloc] initWithTitle:@"Services"];
    NSApp.servicesMenu = item.submenu;
    return nil;
  }
  if ([r isEqual:@"help"]) {
    if (!item.title.length) item.title = @"Help";
    if (!item.submenu) item.submenu = [[NSMenu alloc] initWithTitle:@"Help"];
    NSApp.helpMenu = item.submenu;
    return nil;
  }
  NSArray *def = roles[r];
  if (!def) return [NSString stringWithFormat:@"unknown menu item role `%@`", role];
  item.action = NSSelectorFromString(def[0]);
  item.target = [def[1] isEqual:@"app"] ? NSApp : [def[1] isEqual:@"self"] ? menu_target() : nil;
  item.representedObject = nil;
  if (!item.title.length) item.title = def[2];
  return nil;
}

static NSMenu *build_menu(NSArray *items, NSString *ctx, NSString **error);

static NSMenuItem *build_item(id spec, NSString *ctx, NSString **error) {
  if (![spec isKindOfClass:NSDictionary.class]) {
    *error = [ctx stringByAppendingString:@": menu items must be objects"];
    return nil;
  }
  NSString *type = [spec[@"type"] isKindOfClass:NSString.class] ? [spec[@"type"] lowercaseString] : @"action";
  NSString *role = [spec[@"role"] isKindOfClass:NSString.class] ? spec[@"role"] : nil;
  if ([type isEqual:@"separator"] || [role.lowercaseString isEqual:@"separator"]) return [NSMenuItem separatorItem];

  id label = spec[@"label"] ?: spec[@"text"] ?: spec[@"title"];
  NSString *title = [label isKindOfClass:NSString.class] ? label : @"";
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];

  NSArray *children = [spec[@"submenu"] isKindOfClass:NSArray.class] ? spec[@"submenu"] : nil;
  NSArray *presetItems = role ? preset(role.lowercaseString) : nil;
  if (presetItems && !children) {
    children = presetItems;
    if (!title.length) item.title = title = preset_title(role.lowercaseString);
    role = nil;
  }
  if (children) {
    NSMenu *sub = build_menu(children, ctx, error);
    if (!sub) return nil;
    sub.title = title;
    item.submenu = sub;
    if ([title isEqual:@"Window"]) NSApp.windowsMenu = sub;
  } else if ([type isEqual:@"submenu"]) {
    *error = [ctx stringByAppendingString:@": type `submenu` needs a `submenu` array"];
    return nil;
  }
  if (role) {
    if (NSString *e = apply_role(item, role)) {
      *error = [NSString stringWithFormat:@"%@: %@", ctx, e];
      return nil;
    }
  } else if (!children) {
    NSString *ident = [spec[@"id"] isKindOfClass:NSString.class] ? spec[@"id"] : title;
    item.target = menu_target();
    item.action = @selector(itemAction:);
    item.representedObject = ident;
  }
  if ([spec[@"id"] isKindOfClass:NSString.class]) [g_items setObject:item forKey:spec[@"id"]];
  if ([spec[@"checked"] isKindOfClass:NSNumber.class]) item.state = [spec[@"checked"] boolValue] ? NSControlStateValueOn : NSControlStateValueOff;
  if ([spec[@"disabled"] isKindOfClass:NSNumber.class] && [spec[@"disabled"] boolValue]) item.enabled = NO;
  apply_accelerator(item, spec[@"accelerator"]);
  id icon = spec[@"icon"];
  if (icon && icon != NSNull.null) {
    NSImage *img = platform_icon(icon, ctx, error);
    if (!img) return nil;
    if (img.size.height > 16) img.size = NSMakeSize(img.size.width * 16 / img.size.height, 16);
    item.image = img;
  }
  return item;
}

static NSMenu *build_menu(NSArray *items, NSString *ctx, NSString **error) {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  menu.autoenablesItems = NO; // `disabled` is explicit; roles stay enabled
  for (id spec in items) {
    NSMenuItem *item = build_item(spec, ctx, error);
    if (!item) return nil;
    [menu addItem:item];
  }
  return menu;
}

NSMenu *platform_build_menu(NSArray *items, NSString *context, NSString **error) {
  NSString *e = nil;
  NSMenu *m = build_menu(items, context, &e);
  if (error) *error = e;
  return m;
}

static NSDictionary *item_state(NSMenuItem *item) {
  if (item.isSeparatorItem) return @{@"separator" : @YES};
  NSMutableDictionary *d = [@{@"text" : item.title ?: @"", @"enabled" : @(item.isEnabled), @"checked" : @(item.state == NSControlStateValueOn)} mutableCopy];
  if ([item.representedObject isKindOfClass:NSString.class]) d[@"id"] = item.representedObject;
  for (NSString *key in g_items.keyEnumerator)
    if ([g_items objectForKey:key] == item) d[@"id"] = key;
  if (item.submenu) {
    NSMutableArray *sub = [NSMutableArray array];
    for (NSMenuItem *child in item.submenu.itemArray) [sub addObject:item_state(child)];
    d[@"submenu"] = sub;
  }
  return d;
}

static NSInteger bar_index(NSString *name) {
  NSArray *items = NSApp.mainMenu.itemArray;
  for (NSUInteger i = 0; i < items.count; i++)
    if ([[items[i] title] isEqualToString:name] || [[items[i] submenu].title isEqualToString:name]) return (NSInteger)i;
  return -1;
}

void platform_register_menu(void) {
  g_items = [NSMapTable strongToWeakObjectsMapTable];
  platform_register_many(@"menu", @[ @"setAppMenu", @"setApplicationMenu" ], ^(PlatformCall *c) {
    NSArray *menus = c.args[@"menus"];
    if (![menus isKindOfClass:NSArray.class]) return [c fail:@"invalid_args" message:@"menu.setAppMenu: `menus` must be an array of {name, items}"];
    NSMenu *bar = [NSMenu new];
    NSString *error = nil;
    for (NSDictionary *m in menus) {
      if (![m isKindOfClass:NSDictionary.class]) return [c fail:@"invalid_args" message:@"menu.setAppMenu: each menu is {name, items}"];
      NSString *name = [m[@"name"] isKindOfClass:NSString.class] ? m[@"name"] : @"";
      NSMenu *sub = build_menu([m[@"items"] isKindOfClass:NSArray.class] ? m[@"items"] : @[], @"menu.setAppMenu", &error);
      if (!sub) return [c fail:@"invalid_args" message:error];
      sub.title = name;
      NSMenuItem *top = [[NSMenuItem alloc] initWithTitle:name action:nil keyEquivalent:@""];
      top.submenu = sub;
      [bar addItem:top];
      if ([name isEqual:@"Window"]) NSApp.windowsMenu = sub;
      if ([name isEqual:@"Help"]) NSApp.helpMenu = sub;
    }
    NSApp.mainMenu = bar; // first menu = app menu (macOS shows the app name)
    [c ok:nil];
  });
  platform_register(@"menu", @"insert", ^(PlatformCall *c) {
    NSString *name = [c string:@"name"];
    if (!name.length) return [c fail:@"invalid_args" message:@"menu.insert: `name` is required"];
    NSMenuItem *top = [[NSMenuItem alloc] initWithTitle:name action:nil keyEquivalent:@""];
    NSString *error = nil;
    if ([c.args[@"items"] isKindOfClass:NSArray.class]) {
      NSMenu *sub = build_menu(c.args[@"items"], @"menu.insert", &error);
      if (!sub) return [c fail:@"invalid_args" message:error];
      sub.title = name;
      top.submenu = sub;
    } else {
      top.target = menu_target();
      top.action = @selector(itemAction:);
      top.representedObject = [c string:@"id"] ?: name;
    }
    if ([c has:@"icon"]) {
      NSImage *img = platform_icon(c.args[@"icon"], @"menu.insert", &error);
      if (!img) return [c fail:@"invalid_args" message:error];
      top.image = img;
    }
    NSMenu *bar = NSApp.mainMenu ?: [NSMenu new];
    NSInteger existing = bar_index(name);
    if (existing >= 0) [bar removeItemAtIndex:existing];
    NSInteger idx = [c has:@"index"] ? (NSInteger)[c number:@"index" or:0] : bar_index(@"Window");
    if (idx < 0 || idx > bar.numberOfItems) idx = bar.numberOfItems;
    [bar insertItem:top atIndex:idx];
    NSApp.mainMenu = bar;
    [c ok:@{@"inserted" : @YES, @"name" : name}];
  });
  platform_register(@"menu", @"remove", ^(PlatformCall *c) {
    NSString *name = [c string:@"name"] ?: @"";
    NSInteger idx = bar_index(name);
    if (idx >= 0) [NSApp.mainMenu removeItemAtIndex:idx];
    [c ok:@{@"removed" : @(idx >= 0), @"name" : name}];
  });
  platform_register(@"menu", @"setDockMenu", ^(PlatformCall *c) {
    NSString *error = nil;
    NSMenu *m = build_menu([c.args[@"items"] isKindOfClass:NSArray.class] ? c.args[@"items"] : @[], @"menu.setDockMenu", &error);
    if (!m) return [c fail:@"invalid_args" message:error];
    g_dock_menu = m.numberOfItems ? m : nil;
    platform_dock_menu = ^NSMenu *(void) { return g_dock_menu; };
    [c ok:nil];
  });
  platform_register(@"menu", @"addRecentDocument", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"];
    if (!path.length) return [c fail:@"invalid_args" message:@"menu.addRecentDocument: `path` is required"];
    [NSDocumentController.sharedDocumentController noteNewRecentDocumentURL:[NSURL fileURLWithPath:path]];
    [c ok:nil];
  });
  platform_register(@"menu", @"popup", ^(PlatformCall *c) {
    NSString *error = nil;
    NSMenu *m = build_menu([c.args[@"items"] isKindOfClass:NSArray.class] ? c.args[@"items"] : @[], @"menu.popup", &error);
    if (!m) return [c fail:@"invalid_args" message:error];
    NSPoint at = NSEvent.mouseLocation;
    if ([c has:@"x"] && [c has:@"y"])
      at = platform_from_top_left(NSMakeRect([c number:@"x" or:0], [c number:@"y" or:0], 0, 0)).origin;
    // Off the current call stack: the menu runs a nested tracking loop until dismissed.
    dispatch_async(dispatch_get_main_queue(), ^{
      [m popUpMenuPositioningItem:nil atLocation:at inView:nil];
      [c ok:@{@"dismissed" : @YES}];
    });
  });
  platform_register(@"menu", @"update", ^(PlatformCall *c) {
    NSString *ident = [c string:@"id"];
    NSMenuItem *item = ident ? [g_items objectForKey:ident] : nil;
    if (!item) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"menu.update: unknown item id `%@`", ident]];
    if (NSString *text = [c string:@"text"] ?: [c string:@"label"]) item.title = text;
    if ([c has:@"enabled"]) item.enabled = [c boolean:@"enabled" or:YES];
    if ([c has:@"checked"]) item.state = [c boolean:@"checked" or:NO] ? NSControlStateValueOn : NSControlStateValueOff;
    if ([c has:@"accelerator"]) apply_accelerator(item, [c string:@"accelerator"]);
    [c ok:nil];
  });
  platform_register(@"menu", @"get", ^(PlatformCall *c) {
    NSString *ident = [c string:@"id"];
    NSMenuItem *item = ident ? [g_items objectForKey:ident] : nil;
    if (!item) return [c ok:nil];
    NSMutableDictionary *d = [item_state(item) mutableCopy];
    d[@"id"] = ident;
    [c ok:d];
  });
  platform_register(@"menu", @"items", ^(PlatformCall *c) {
    NSMutableArray *out = [NSMutableArray array];
    for (NSMenuItem *top in NSApp.mainMenu.itemArray) [out addObject:item_state(top)];
    [c ok:out];
  });
}
