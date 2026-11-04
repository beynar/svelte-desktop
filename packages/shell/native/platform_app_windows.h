#pragma once
#import <Cocoa/Cocoa.h>
NS_ASSUME_NONNULL_BEGIN

// Main-thread owners for the shell's quit and window lifecycle hooks.
void platform_app_install_quit_hook(void);
void platform_app_request_quit(NSString *reason);
void platform_app_page_unloaded(int nativeId);
void platform_window_creation_options(NSDictionary *_Nullable options);
BOOL platform_window_options_valid(NSDictionary *options);
void platform_window_configure_relationship(NSWindow *window, NSDictionary *options);
void platform_window_present(NSWindow *window);
void platform_window_visibility_changed(NSWindow *window);
void platform_window_observe(int nativeId, NSWindow *window);
BOOL platform_window_last_family(NSWindow *window);
void platform_window_suspend_sheets_for_quit(void (^ready)(NSArray<NSWindow *> *sheets));
void platform_window_restore_sheets_after_quit(NSArray<NSWindow *> *sheets);
NS_ASSUME_NONNULL_END
