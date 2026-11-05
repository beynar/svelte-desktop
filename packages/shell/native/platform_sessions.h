#pragma once
#import <WebKit/WebKit.h>
NS_ASSUME_NONNULL_BEGIN
// Main-thread owners of website stores and per-view lifecycle policy.
void platform_register_sessions(void);
/// The page of `nativeId` went: its cookie-change subscription goes with it.
void platform_sessions_page_unloaded(int nativeId);
WKWebsiteDataStore *_Nullable platform_session_store(NSString *_Nullable ident);
NSString *_Nullable platform_session_of(WKWebView *_Nullable webview); // its named session, nil for the default
void platform_session_window_creation(NSString *_Nullable ident);
void platform_session_prepare(WKWebViewConfiguration *configuration, NSString *_Nullable session);
void platform_session_track(int nativeId, WKWebView *webview);
void platform_session_detach(int nativeId);
BOOL platform_webview_options_valid(NSDictionary *options);
void platform_lifecycle_configure(WKWebView *webview, NSDictionary *target, NSString *_Nullable recovery, int windowNative = 0);
NSString *platform_lifecycle_recovery(WKWebView *webview);
NSDictionary *platform_lifecycle_target(WKWebView *_Nullable webview);
void platform_lifecycle_emit(WKWebView *webview, NSString *type, NSError *_Nullable error, BOOL provisional, WKNavigation *_Nullable navigation = nil);
NSURLRequest *platform_webview_request(WKWebView *webview, NSURL *url);
void platform_webview_load(WKWebView *webview, NSURLRequest *request);
void platform_webview_stop(WKWebView *webview);
void platform_webview_reload(WKWebView *webview, BOOL ignoreCache = NO);
BOOL platform_webview_terminated(WKWebView *webview);
NS_ASSUME_NONNULL_END
