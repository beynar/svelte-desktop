#pragma once
#import <WebKit/WebKit.h>
void platform_register_web_policy(void);
void platform_web_permission(WKWebView *view, WKSecurityOrigin *origin, WKFrameInfo *frame,
                             NSString *permission, void (^done)(NSString *decision));
void platform_web_auth(WKWebView *view, NSURLAuthenticationChallenge *challenge,
                      void (^done)(NSURLSessionAuthChallengeDisposition, NSURLCredential *));
// The bridge registry in platform_core.mm owns whether a view is still live.
BOOL platform_webview_is_attached(WKWebView *view);
