#pragma once
#import <Foundation/Foundation.h>
NSString *platform_download_prefix(NSString *path, NSString *ident);
BOOL platform_download_checkpoint(NSString *path, NSString *prefix, int64_t *bytes, NSError **error);
BOOL platform_download_rewind(NSString *path, NSString *prefix, int64_t bytes, NSError **error);
