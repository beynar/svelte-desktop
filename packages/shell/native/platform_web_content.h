#pragma once
#import <WebKit/WebKit.h>
void platform_web_content_set_schemes(NSArray *schemes);
BOOL platform_web_content_is_scheme(NSString *scheme);
void platform_web_content_prepare(WKWebViewConfiguration *configuration);
void platform_web_content_attach(WKWebView *webview);
void platform_register_web_content(void);
BOOL platform_web_content_decide_navigation(WKWebView *webview, WKNavigationAction *action, void (^decision)(WKNavigationActionPolicy));
