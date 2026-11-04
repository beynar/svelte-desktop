// Window-local shortcuts, decided before WebKit or menu accelerators run.
#include "platform_internal.h"
#include "platform_input.h"
#import <objc/runtime.h>

static char policyKey;
static id monitor;
static const NSEventModifierFlags inputFlags = NSEventModifierFlagCommand | NSEventModifierFlagControl |
  NSEventModifierFlagOption | NSEventModifierFlagShift;

static NSString *input_key(NSString *key) {
  if ([key isEqual:@"\003"]) return @"\r"; // Keypad Enter.
  NSDictionary *names = @{@"enter": @"\r", @"return": @"\r", @"escape": @"\033", @"tab": @"\t",
    @"space": @" ", @"backspace": @"\177", @"arrowup": @"\uF700", @"arrowdown": @"\uF701",
    @"arrowleft": @"\uF702", @"arrowright": @"\uF703", @"delete": @"\uF728"};
  return names[key.lowercaseString] ?: key.lowercaseString;
}

static NSDictionary *window_policy(NSWindow *window) {
  return window ? objc_getAssociatedObject(window, &policyKey) : nil;
}

void platform_register_input(void) {
  // Menus consult only the event's own window. Other windows keep their accelerators.
  Method method = class_getInstanceMethod(NSMenu.class, @selector(performKeyEquivalent:));
  IMP original = method_getImplementation(method);
  method_setImplementation(method, imp_implementationWithBlock(^BOOL(NSMenu *menu, NSEvent *event) {
    if ([window_policy(event.window ?: NSApp.keyWindow)[@"menuShortcuts"] isEqual:@NO]) return NO;
    return ((BOOL (*)(id, SEL, NSEvent *))original)(menu, @selector(performKeyEquivalent:), event);
  }));
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown | NSEventMaskKeyUp handler:^NSEvent *(NSEvent *event) {
    NSDictionary *policy = window_policy(event.window);
    for (NSDictionary *shortcut in policy[@"intercept"]) {
      if (![input_key(event.charactersIgnoringModifiers ?: @"") isEqual:shortcut[@"nativeKey"]] ||
          (event.modifierFlags & inputFlags) != [shortcut[@"mask"] unsignedLongLongValue]) continue;
      int nativeId = 0;
      for (NSNumber *ident in platform_window_ids()) if (platform_window(ident.intValue) == event.window) nativeId = ident.intValue;
      NSDictionary *payload = @{@"windowId": @(platform_public_window_id(nativeId)), @"key": shortcut[@"key"],
        @"keyCode": @(event.keyCode), @"type": event.type == NSEventTypeKeyDown ? @"keyDown" : @"keyUp",
        @"isAutoRepeat": @(event.isARepeat), @"modifiers": shortcut[@"modifiers"], @"intercepted": @YES};
      dispatch_async(dispatch_get_main_queue(), ^{ platform_emit_targeted(@"beforeInput", payload, nativeId); });
      return nil;
    }
    return event;
  }];
  platform_register(@"webview", @"setInputPolicy", ^(PlatformCall *c) {
    NSWindow *window = platform_window(platform_resolve_window(c));
    if (!window) return [c fail:@"unavailable" message:@"input policy window is not open"];
    id intercept = c.args[@"intercept"] ?: @[];
    if (![intercept isKindOfClass:NSArray.class] || ([c has:@"menuShortcuts"] && ![c.args[@"menuShortcuts"] isKindOfClass:NSNumber.class]))
      return [c fail:@"invalid_args" message:@"intercept must be an array and menuShortcuts a boolean"];
    NSMutableArray *rules = [NSMutableArray array];
    NSDictionary *flags = @{@"meta": @(NSEventModifierFlagCommand), @"control": @(NSEventModifierFlagControl),
      @"alt": @(NSEventModifierFlagOption), @"shift": @(NSEventModifierFlagShift)};
    for (id rule in intercept) {
      if (![rule isKindOfClass:NSDictionary.class] || ![rule[@"key"] isKindOfClass:NSString.class] || ![rule[@"key"] length] ||
          (rule[@"modifiers"] && ![rule[@"modifiers"] isKindOfClass:NSArray.class]))
        return [c fail:@"invalid_args" message:@"each input shortcut needs key and optional modifiers array"];
      NSUInteger mask = 0;
      for (id modifier in rule[@"modifiers"] ?: @[]) {
        if (![modifier isKindOfClass:NSString.class] || !flags[modifier])
          return [c fail:@"invalid_args" message:@"input modifiers: meta, control, alt, shift"];
        mask |= [flags[modifier] unsignedLongLongValue];
      }
      [rules addObject:@{@"key": rule[@"key"], @"nativeKey": input_key(rule[@"key"]), @"mask": @(mask), @"modifiers": rule[@"modifiers"] ?: @[]}];
    }
    if (!monitor) return [c fail:@"unavailable" message:@"native input monitor could not be installed"];
    objc_setAssociatedObject(window, &policyKey, @{@"intercept": rules, @"menuShortcuts": @([c boolean:@"menuShortcuts" or:YES])}, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [c ok:@{@"monitorInstalled": @YES, @"interceptCount": @(rules.count), @"menuShortcuts": @([c boolean:@"menuShortcuts" or:YES])}];
  });
  platform_register(@"webview", @"getInputPolicy", ^(PlatformCall *c) {
    NSWindow *window = platform_window(platform_resolve_window(c));
    if (!window) return [c fail:@"unavailable" message:@"input policy window is not open"];
    NSDictionary *policy = window_policy(window);
    NSMutableArray *rules = [NSMutableArray array];
    for (NSDictionary *rule in policy[@"intercept"]) [rules addObject:@{@"key": rule[@"key"], @"modifiers": rule[@"modifiers"]}];
    [c ok:@{@"monitorInstalled": @(monitor != nil), @"intercept": rules, @"menuShortcuts": policy[@"menuShortcuts"] ?: @YES}];
  });
}
