// shortcuts.* — global hotkeys through Carbon RegisterEventHotKey (the
// reliable global path; needs no Accessibility permission).
// Ops: register {accelerator|accel, id?} -> {id}, unregister {id} -> {unregistered},
//      unregisterAll|unregister_all -> {unregistered: n}, isRegistered {id} -> bool.
// Events: shortcutPressed {id}, shortcutReleased {id}.
#include "platform_internal.h"

#import <Carbon/Carbon.h>

static const OSType kSignature = 'sgfx';

@interface SDHotKey : NSObject
@property(nonatomic) EventHotKeyRef ref;
@property(nonatomic) UInt32 numeric;
@property(nonatomic) UInt64 combo; // keycode << 32 | modifiers
@end
@implementation SDHotKey
@end

static NSMutableDictionary<NSString *, SDHotKey *> *g_keys; // id -> registration
static NSMutableDictionary<NSNumber *, NSString *> *g_ids;  // numeric -> id
static UInt32 g_next = 1;
static BOOL g_installed = NO;

static OSStatus hotkey_handler(EventHandlerCallRef, EventRef event, void *) {
  EventHotKeyID hk = {0, 0};
  OSStatus st = GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof hk, NULL, &hk);
  if (st != noErr) return st;
  if (hk.signature != kSignature) return eventNotHandledErr; // someone else's hotkey
  NSString *ident = g_ids[@(hk.id)];
  if (!ident) return noErr;
  switch (GetEventKind(event)) {
    case kEventHotKeyPressed: platform_emit(@"shortcutPressed", @{@"id" : ident}); break;
    case kEventHotKeyReleased: platform_emit(@"shortcutReleased", @{@"id" : ident}); break;
  }
  return noErr;
}

static BOOL install(void) {
  if (g_installed) return YES;
  EventTypeSpec types[] = {{kEventClassKeyboard, kEventHotKeyPressed}, {kEventClassKeyboard, kEventHotKeyReleased}};
  g_installed = InstallEventHandler(GetApplicationEventTarget(), hotkey_handler, 2, types, NULL, NULL) == noErr;
  return g_installed;
}

// ---------------------------------------------------------------------------
// Accelerator parsing ("CmdOrCtrl+Shift+K", "Alt+Space", "F5", "Cmd++")

static UInt32 modifier_mask(NSString *p) {
  static NSDictionary<NSString *, NSNumber *> *m;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    m = @{
      @"cmdorctrl" : @(cmdKey), @"commandorcontrol" : @(cmdKey), @"cmd" : @(cmdKey), @"command" : @(cmdKey),
      @"super" : @(cmdKey), @"meta" : @(cmdKey), @"shift" : @(shiftKey), @"alt" : @(optionKey), @"option" : @(optionKey),
      @"ctrl" : @(controlKey), @"control" : @(controlKey),
    };
  });
  return m[p].unsignedIntValue;
}

// Key name -> ANSI virtual keycode (Carbon maps it against the active layout).
static int key_code(NSString *name) {
  static NSDictionary<NSString *, NSNumber *> *m;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSMutableDictionary *d = [@{
      @"a" : @(kVK_ANSI_A), @"b" : @(kVK_ANSI_B), @"c" : @(kVK_ANSI_C), @"d" : @(kVK_ANSI_D), @"e" : @(kVK_ANSI_E),
      @"f" : @(kVK_ANSI_F), @"g" : @(kVK_ANSI_G), @"h" : @(kVK_ANSI_H), @"i" : @(kVK_ANSI_I), @"j" : @(kVK_ANSI_J),
      @"k" : @(kVK_ANSI_K), @"l" : @(kVK_ANSI_L), @"m" : @(kVK_ANSI_M), @"n" : @(kVK_ANSI_N), @"o" : @(kVK_ANSI_O),
      @"p" : @(kVK_ANSI_P), @"q" : @(kVK_ANSI_Q), @"r" : @(kVK_ANSI_R), @"s" : @(kVK_ANSI_S), @"t" : @(kVK_ANSI_T),
      @"u" : @(kVK_ANSI_U), @"v" : @(kVK_ANSI_V), @"w" : @(kVK_ANSI_W), @"x" : @(kVK_ANSI_X), @"y" : @(kVK_ANSI_Y),
      @"z" : @(kVK_ANSI_Z), @"0" : @(kVK_ANSI_0), @"1" : @(kVK_ANSI_1), @"2" : @(kVK_ANSI_2), @"3" : @(kVK_ANSI_3),
      @"4" : @(kVK_ANSI_4), @"5" : @(kVK_ANSI_5), @"6" : @(kVK_ANSI_6), @"7" : @(kVK_ANSI_7), @"8" : @(kVK_ANSI_8),
      @"9" : @(kVK_ANSI_9),
      @"=" : @(kVK_ANSI_Equal), @"equal" : @(kVK_ANSI_Equal), @"plus" : @(kVK_ANSI_Equal), @"+" : @(kVK_ANSI_Equal),
      @"-" : @(kVK_ANSI_Minus), @"minus" : @(kVK_ANSI_Minus), @"]" : @(kVK_ANSI_RightBracket),
      @"rightbracket" : @(kVK_ANSI_RightBracket), @"[" : @(kVK_ANSI_LeftBracket), @"leftbracket" : @(kVK_ANSI_LeftBracket),
      @"'" : @(kVK_ANSI_Quote), @"quote" : @(kVK_ANSI_Quote), @"apostrophe" : @(kVK_ANSI_Quote),
      @";" : @(kVK_ANSI_Semicolon), @"semicolon" : @(kVK_ANSI_Semicolon), @"\\" : @(kVK_ANSI_Backslash),
      @"backslash" : @(kVK_ANSI_Backslash), @"," : @(kVK_ANSI_Comma), @"comma" : @(kVK_ANSI_Comma),
      @"/" : @(kVK_ANSI_Slash), @"slash" : @(kVK_ANSI_Slash), @"." : @(kVK_ANSI_Period), @"period" : @(kVK_ANSI_Period),
      @"`" : @(kVK_ANSI_Grave), @"grave" : @(kVK_ANSI_Grave), @"backquote" : @(kVK_ANSI_Grave), @"backtick" : @(kVK_ANSI_Grave),
      @"return" : @(kVK_Return), @"enter" : @(kVK_Return), @"tab" : @(kVK_Tab), @"space" : @(kVK_Space),
      @"spacebar" : @(kVK_Space), @"backspace" : @(kVK_Delete), @"delete" : @(kVK_Delete), @"escape" : @(kVK_Escape),
      @"esc" : @(kVK_Escape), @"home" : @(kVK_Home), @"pageup" : @(kVK_PageUp), @"forwarddelete" : @(kVK_ForwardDelete),
      @"del" : @(kVK_ForwardDelete), @"end" : @(kVK_End), @"pagedown" : @(kVK_PageDown), @"help" : @(kVK_Help),
      @"insert" : @(kVK_Help), @"left" : @(kVK_LeftArrow), @"leftarrow" : @(kVK_LeftArrow), @"right" : @(kVK_RightArrow),
      @"rightarrow" : @(kVK_RightArrow), @"down" : @(kVK_DownArrow), @"downarrow" : @(kVK_DownArrow),
      @"up" : @(kVK_UpArrow), @"uparrow" : @(kVK_UpArrow),
      @"f1" : @(kVK_F1), @"f2" : @(kVK_F2), @"f3" : @(kVK_F3), @"f4" : @(kVK_F4), @"f5" : @(kVK_F5), @"f6" : @(kVK_F6),
      @"f7" : @(kVK_F7), @"f8" : @(kVK_F8), @"f9" : @(kVK_F9), @"f10" : @(kVK_F10), @"f11" : @(kVK_F11),
      @"f12" : @(kVK_F12), @"f13" : @(kVK_F13), @"f14" : @(kVK_F14), @"f15" : @(kVK_F15), @"f16" : @(kVK_F16),
      @"f17" : @(kVK_F17), @"f18" : @(kVK_F18), @"f19" : @(kVK_F19), @"f20" : @(kVK_F20),
      @"numdec" : @(kVK_ANSI_KeypadDecimal), @"numpaddecimal" : @(kVK_ANSI_KeypadDecimal),
      @"nummult" : @(kVK_ANSI_KeypadMultiply), @"numpadmultiply" : @(kVK_ANSI_KeypadMultiply),
      @"numadd" : @(kVK_ANSI_KeypadPlus), @"numpadadd" : @(kVK_ANSI_KeypadPlus),
      @"numclear" : @(kVK_ANSI_KeypadClear), @"numpadclear" : @(kVK_ANSI_KeypadClear),
      @"numdiv" : @(kVK_ANSI_KeypadDivide), @"numpaddivide" : @(kVK_ANSI_KeypadDivide),
      @"numenter" : @(kVK_ANSI_KeypadEnter), @"numpadenter" : @(kVK_ANSI_KeypadEnter),
      @"numsub" : @(kVK_ANSI_KeypadMinus), @"numpadsubtract" : @(kVK_ANSI_KeypadMinus),
      @"numeq" : @(kVK_ANSI_KeypadEquals), @"numpadequals" : @(kVK_ANSI_KeypadEquals),
    } mutableCopy];
    const int keypad[] = {kVK_ANSI_Keypad0, kVK_ANSI_Keypad1, kVK_ANSI_Keypad2, kVK_ANSI_Keypad3, kVK_ANSI_Keypad4,
                          kVK_ANSI_Keypad5, kVK_ANSI_Keypad6, kVK_ANSI_Keypad7, kVK_ANSI_Keypad8, kVK_ANSI_Keypad9};
    for (int i = 0; i < 10; i++) {
      d[[NSString stringWithFormat:@"num%d", i]] = @(keypad[i]);
      d[[NSString stringWithFormat:@"numpad%d", i]] = @(keypad[i]);
    }
    m = d;
  });
  NSNumber *n = m[[name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString];
  return n ? n.intValue : -1;
}

// Returns nil on success (filling code/mods), or an error message.
static NSString *parse_accelerator(NSString *accel, UInt32 *code, UInt32 *mods) {
  if (![accel stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length)
    return @"shortcuts.register: accelerator must not be empty";
  // The key is the last `+` segment; a trailing `+` means the +/= key itself.
  NSRange last = [accel rangeOfString:@"+" options:NSBackwardsSearch];
  NSString *modsStr = last.location == NSNotFound ? @"" : [accel substringToIndex:last.location];
  NSString *keyStr = last.location == NSNotFound ? accel : [accel substringFromIndex:last.location + 1];
  if (!keyStr.length) {
    keyStr = @"+";
    if ([modsStr hasSuffix:@"+"]) modsStr = [modsStr substringToIndex:modsStr.length - 1]; // "Cmd++"
  }
  *mods = 0;
  if (modsStr.length) {
    for (NSString *raw in [modsStr componentsSeparatedByString:@"+"]) {
      NSString *p = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString;
      UInt32 m = modifier_mask(p);
      if (!m) return [NSString stringWithFormat:@"shortcuts.register: unknown modifier `%@` in `%@`", p, accel];
      *mods |= m;
    }
  }
  NSString *keyLower = [keyStr stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString;
  if (modifier_mask(keyLower)) return [NSString stringWithFormat:@"shortcuts.register: `%@` needs a non-modifier key", accel];
  int c = key_code(keyStr);
  if (c < 0) return [NSString stringWithFormat:@"shortcuts.register: unknown key `%@` in `%@`", keyStr, accel];
  *code = (UInt32)c;
  return nil;
}

// ---------------------------------------------------------------------------
// Ops

static void register_shortcut(PlatformCall *call) {
  NSString *accel = [call string:@"accelerator"] ?: [call string:@"accel"];
  if (!accel) return [call fail:@"invalid_args" message:@"shortcuts.register: missing `accelerator`"];
  NSString *ident = [call string:@"id"];
  if (!ident.length) ident = accel;
  UInt32 code = 0, mods = 0;
  if (NSString *e = parse_accelerator(accel, &code, &mods)) return [call fail:@"invalid_args" message:e];
  UInt64 combo = ((UInt64)code << 32) | mods;
  if (g_keys[ident])
    return [call fail:@"invalid_args" message:[NSString stringWithFormat:@"shortcuts.register: id `%@` is already registered", ident]];
  for (SDHotKey *k in g_keys.allValues)
    if (k.combo == combo)
      return [call fail:@"invalid_args" message:[NSString stringWithFormat:@"shortcuts.register: `%@` is already registered", accel]];
  if (!install()) return [call fail:@"internal" message:@"shortcuts.register: InstallEventHandler failed"];
  UInt32 numeric = g_next++;
  EventHotKeyRef ref = NULL;
  OSStatus st = RegisterEventHotKey(code, mods, (EventHotKeyID){kSignature, numeric}, GetApplicationEventTarget(), 0, &ref);
  if (st != noErr || !ref)
    return [call fail:@"denied"
              message:[NSString stringWithFormat:@"shortcuts.register: `%@` could not be registered (OSStatus %d); it may "
                                                 @"collide with another app or a system shortcut",
                                                 accel, (int)st]];
  SDHotKey *k = [SDHotKey new];
  k.ref = ref;
  k.numeric = numeric;
  k.combo = combo;
  g_keys[ident] = k;
  g_ids[@(numeric)] = ident;
  [call ok:@{@"id" : ident}];
}

static void unregister_shortcut(PlatformCall *call) {
  NSString *ident = [call string:@"id"];
  if (!ident) return [call fail:@"invalid_args" message:@"shortcuts.unregister: missing `id`"];
  SDHotKey *k = g_keys[ident];
  if (!k) return [call ok:@{@"unregistered" : @NO}];
  UnregisterEventHotKey(k.ref);
  [g_keys removeObjectForKey:ident];
  [g_ids removeObjectForKey:@(k.numeric)];
  [call ok:@{@"unregistered" : @YES}];
}

static void unregister_all(PlatformCall *call) {
  NSUInteger n = g_keys.count;
  for (SDHotKey *k in g_keys.allValues) UnregisterEventHotKey(k.ref);
  [g_keys removeAllObjects];
  [g_ids removeAllObjects];
  [call ok:@{@"unregistered" : @(n)}];
}

void platform_register_shortcuts(void) {
  g_keys = [NSMutableDictionary dictionary];
  g_ids = [NSMutableDictionary dictionary];
  install();
  platform_register(@"shortcuts", @"register", ^(PlatformCall *call) { register_shortcut(call); });
  platform_register(@"shortcuts", @"unregister", ^(PlatformCall *call) { unregister_shortcut(call); });
  platform_register_many(@"shortcuts", @[ @"unregisterAll", @"unregister_all" ], ^(PlatformCall *call) { unregister_all(call); });
  platform_register(@"shortcuts", @"isRegistered", ^(PlatformCall *call) {
    NSString *ident = [call string:@"id"];
    if (!ident) return [call fail:@"invalid_args" message:@"shortcuts.isRegistered: missing `id`"];
    [call ok:@(g_keys[ident] != nil)];
  });
}
