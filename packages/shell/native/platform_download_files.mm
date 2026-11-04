// Pair opaque WebKit resume data with the exact partial file it was made from.
// Reusing that checkpoint avoids corrupt offsets in data produced after a resume.
#include "platform_download_files.h"
#include <sys/clonefile.h>
#include <errno.h>
#include <stdio.h>

NSString *platform_download_prefix(NSString *path, NSString *ident) {
  return [path.stringByDeletingLastPathComponent stringByAppendingPathComponent:
      [NSString stringWithFormat:@".sd-%@.resume-prefix", ident]];
}
static NSNumber *file_size(NSString *path, NSError **error) {
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:error];
  if (attributes && ![attributes[NSFileType] isEqual:NSFileTypeRegular]) {
    if (error) *error = [NSError errorWithDomain:@"svelte-desktop.download" code:1 userInfo:@{NSLocalizedDescriptionKey:@"download checkpoint must be a regular file"}];
    return nil;
  }
  return attributes[NSFileSize];
}
static BOOL copy_atomic(NSString *from, NSString *to, NSError **error) {
  NSString *temporary = [to stringByAppendingFormat:@".%@.tmp", NSUUID.UUID.UUIDString];
  BOOL ok = clonefile(from.fileSystemRepresentation, temporary.fileSystemRepresentation, 0) == 0;
  if (!ok) ok = [NSFileManager.defaultManager copyItemAtPath:from toPath:temporary error:error];
  if (ok && rename(temporary.fileSystemRepresentation, to.fileSystemRepresentation) != 0) {
    if (error) *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
    ok = NO;
  }
  if (!ok) [NSFileManager.defaultManager removeItemAtPath:temporary error:nil];
  return ok;
}
BOOL platform_download_checkpoint(NSString *path, NSString *prefix, int64_t *bytes, NSError **error) {
  NSNumber *size = file_size(path, error);
  if (!size || !copy_atomic(path, prefix, error)) return NO;
  *bytes = size.longLongValue;
  return YES;
}
BOOL platform_download_rewind(NSString *path, NSString *prefix, int64_t bytes, NSError **error) {
  NSNumber *size = file_size(prefix, error);
  if (!size) return NO;
  if (size.longLongValue != bytes) {
    if (error) *error = [NSError errorWithDomain:@"svelte-desktop.download" code:2 userInfo:@{NSLocalizedDescriptionKey:@"download checkpoint size changed"}];
    return NO;
  }
  return copy_atomic(prefix, path, error);
}
