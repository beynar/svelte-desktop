// dialog.* — message box, open, save. Sheets on the calling window when there is
// one, app-modal otherwise; the reply arrives when the user answers.
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include "platform_internal.h"

static NSWindow *parent_for(PlatformCall *c) {
  NSWindow *w = platform_window(platform_resolve_window(c));
  return w.isVisible ? w : nil;
}

static void apply_filters(NSSavePanel *panel, id filters) {
  if (![filters isKindOfClass:NSArray.class]) return;
  NSMutableArray *types = [NSMutableArray array];
  for (NSDictionary *f in filters) {
    if (![f isKindOfClass:NSDictionary.class]) continue;
    for (NSString *ext in f[@"extensions"]) {
      if ([ext isEqual:@"*"]) return; // "all files" disables filtering
      if (UTType *t = [UTType typeWithFilenameExtension:ext]) [types addObject:t];
    }
  }
  if (types.count) panel.allowedContentTypes = types;
}

static void present(NSWindow *parent, NSSavePanel *panel, void (^done)(NSModalResponse)) {
  if (parent) [panel beginSheetModalForWindow:parent completionHandler:done];
  else {
    [NSApp activateIgnoringOtherApps:YES];
    [panel beginWithCompletionHandler:done];
  }
}

static void message_box(PlatformCall *c, BOOL confirm) {
  NSAlert *alert = [NSAlert new];
  alert.messageText = [c string:@"message"] ?: [c string:@"title"] ?: @"";
  if (NSString *detail = [c string:@"detail"]) alert.informativeText = detail;
  NSString *type = [c string:@"type"];
  alert.alertStyle = ([type isEqual:@"critical"] || [type isEqual:@"error"]) ? NSAlertStyleCritical
                     : [type isEqual:@"warning"]                            ? NSAlertStyleWarning
                                                                            : NSAlertStyleInformational;
  NSArray *buttons = [c.args[@"buttons"] isKindOfClass:NSArray.class] ? c.args[@"buttons"] : (confirm ? @[ @"OK", @"Cancel" ] : @[ @"OK" ]);
  for (id b in buttons) [alert addButtonWithTitle:[b description]];
  NSInteger cancelId = (NSInteger)[c number:@"cancelId" or:(buttons.count > 1 ? (double)buttons.count - 1 : -1)];
  if (cancelId >= 0 && cancelId < (NSInteger)alert.buttons.count) alert.buttons[cancelId].keyEquivalent = @"\033";
  void (^done)(NSModalResponse) = ^(NSModalResponse r) {
    NSInteger response = r - NSAlertFirstButtonReturn;
    if (confirm) [c ok:@(response == 0)];
    else [c ok:@{@"response" : @(response), @"canceled" : @(response == cancelId)}];
  };
  NSWindow *parent = parent_for(c);
  if (parent) [alert beginSheetModalForWindow:parent completionHandler:done];
  else {
    [NSApp activateIgnoringOtherApps:YES];
    done([alert runModal]);
  }
}

void platform_register_dialog(void) {
  platform_register(@"dialog", @"showMessageBox", ^(PlatformCall *c) { message_box(c, NO); });
  platform_register(@"dialog", @"showConfirm", ^(PlatformCall *c) { message_box(c, YES); });
  platform_register(@"dialog", @"showOpenDialog", ^(PlatformCall *c) {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = [c boolean:@"files" or:YES];
    panel.canChooseDirectories = [c boolean:@"directories" or:NO];
    panel.allowsMultipleSelection = [c boolean:@"multiple" or:NO];
    if (NSString *prompt = [c string:@"prompt"]) panel.prompt = prompt;
    if (NSString *title = [c string:@"title"]) panel.message = title;
    if (NSString *dir = [c string:@"defaultPath"]) panel.directoryURL = [NSURL fileURLWithPath:dir.stringByExpandingTildeInPath];
    apply_filters(panel, c.args[@"filters"]);
    present(parent_for(c), panel, ^(NSModalResponse r) {
      NSMutableArray *paths = [NSMutableArray array];
      if (r == NSModalResponseOK)
        for (NSURL *u in panel.URLs) [paths addObject:u.path];
      [c ok:@{@"canceled" : @(r != NSModalResponseOK), @"paths" : paths}];
    });
  });
  platform_register(@"dialog", @"showSaveDialog", ^(PlatformCall *c) {
    NSSavePanel *panel = [NSSavePanel savePanel];
    NSString *def = [c string:@"defaultPath"].stringByExpandingTildeInPath;
    BOOL isDir = NO;
    if (def.length && [NSFileManager.defaultManager fileExistsAtPath:def isDirectory:&isDir] && isDir) {
      panel.directoryURL = [NSURL fileURLWithPath:def];
    } else if (def.length) {
      panel.directoryURL = [NSURL fileURLWithPath:def.stringByDeletingLastPathComponent];
      panel.nameFieldStringValue = def.lastPathComponent;
    }
    if (NSString *name = [c string:@"suggestedName"]) panel.nameFieldStringValue = name;
    apply_filters(panel, c.args[@"filters"]);
    present(parent_for(c), panel, ^(NSModalResponse r) {
      [c ok:@{@"canceled" : @(r != NSModalResponseOK), @"path" : (r == NSModalResponseOK && panel.URL) ? panel.URL.path : NSNull.null}];
    });
  });
}
