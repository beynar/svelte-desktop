// clipboard.* — general pasteboard: text, html, rtf, png images, file paths.
#include "platform_internal.h"

static NSPasteboard *pb(void) { return NSPasteboard.generalPasteboard; }

// Contract format names <-> pasteboard types.
static NSDictionary<NSString *, NSString *> *formats(void) {
  return @{
    @"text/plain" : NSPasteboardTypeString, @"text/html" : NSPasteboardTypeHTML, @"text/rtf" : NSPasteboardTypeRTF,
    @"image/png" : NSPasteboardTypePNG, @"image/tiff" : NSPasteboardTypeTIFF, @"files" : NSPasteboardTypeFileURL,
  };
}

static NSString *read_type(NSPasteboardType t) {
  NSString *s = [pb() stringForType:t];
  return s.length ? s : nil;
}

static void write_string(PlatformCall *c, NSString *key, NSPasteboardType type, BOOL alsoPlain) {
  NSString *v = [c string:key];
  if (!v) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"clipboard.%@: `%@` must be a string", c.op, key]];
  [pb() clearContents];
  [pb() setString:v forType:type];
  if (alsoPlain && type == NSPasteboardTypeHTML) {
    NSData *d = [v dataUsingEncoding:NSUTF8StringEncoding];
    NSAttributedString *a = [[NSAttributedString alloc] initWithHTML:d documentAttributes:nil];
    if (a.string.length) [pb() setString:a.string forType:NSPasteboardTypeString];
  }
  [c ok:nil];
}

void platform_register_clipboard(void) {
  platform_register(@"clipboard", @"readText", ^(PlatformCall *c) { [c ok:[pb() stringForType:NSPasteboardTypeString]]; });
  platform_register(@"clipboard", @"writeText", ^(PlatformCall *c) { write_string(c, @"text", NSPasteboardTypeString, NO); });
  platform_register(@"clipboard", @"readHtml", ^(PlatformCall *c) { [c ok:read_type(NSPasteboardTypeHTML)]; });
  platform_register(@"clipboard", @"writeHtml", ^(PlatformCall *c) { write_string(c, @"html", NSPasteboardTypeHTML, YES); });
  platform_register(@"clipboard", @"readRtf", ^(PlatformCall *c) { [c ok:read_type(NSPasteboardTypeRTF)]; });
  platform_register(@"clipboard", @"writeRtf", ^(PlatformCall *c) { write_string(c, @"rtf", NSPasteboardTypeRTF, NO); });
  platform_register(@"clipboard", @"clear", ^(PlatformCall *c) {
    [pb() clearContents];
    [c ok:nil];
  });
  platform_register(@"clipboard", @"availableFormats", ^(PlatformCall *c) {
    NSMutableArray *out = [NSMutableArray array];
    NSArray *types = pb().types ?: @[];
    [formats() enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSString *type, BOOL *) {
      if ([types containsObject:type]) [out addObject:name];
    }];
    [c ok:[out sortedArrayUsingSelector:@selector(compare:)]];
  });
  platform_register(@"clipboard", @"has", ^(PlatformCall *c) {
    NSString *f = [c string:@"format"];
    if (!f) return [c fail:@"invalid_args" message:@"clipboard.has: `format` is required"];
    NSString *type = formats()[f] ?: f; // raw UTIs pass through
    [c ok:@([pb().types containsObject:type])];
  });
  platform_register(@"clipboard", @"readImage", ^(PlatformCall *c) {
    NSData *png = [pb() dataForType:NSPasteboardTypePNG];
    if (!png) {
      NSData *tiff = [pb() dataForType:NSPasteboardTypeTIFF];
      if (tiff) png = [[NSBitmapImageRep imageRepWithData:tiff] representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    }
    if (!png) return [c ok:nil];
    [c ok:@{@"bytes" : [png base64EncodedStringWithOptions:0], @"format" : @"png"}];
  });
  platform_register(@"clipboard", @"writeImage", ^(PlatformCall *c) {
    NSString *b64 = [c string:@"bytes"];
    NSData *data = b64 ? [[NSData alloc] initWithBase64EncodedString:b64 options:NSDataBase64DecodingIgnoreUnknownCharacters] : nil;
    NSBitmapImageRep *rep = data ? [NSBitmapImageRep imageRepWithData:data] : nil;
    if (!rep) return [c fail:@"invalid_args" message:@"clipboard.writeImage: `bytes` must be base64 image data"];
    [pb() clearContents];
    [pb() setData:[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] forType:NSPasteboardTypePNG];
    [pb() setData:rep.TIFFRepresentation forType:NSPasteboardTypeTIFF];
    [c ok:nil];
  });
  platform_register(@"clipboard", @"readPaths", ^(PlatformCall *c) {
    NSArray<NSURL *> *urls = [pb() readObjectsForClasses:@[ NSURL.class ] options:@{NSPasteboardURLReadingFileURLsOnlyKey : @YES}];
    if (!urls.count) return [c ok:nil];
    NSMutableArray *paths = [NSMutableArray array];
    for (NSURL *u in urls) [paths addObject:u.path];
    [c ok:paths];
  });
  platform_register(@"clipboard", @"writePaths", ^(PlatformCall *c) {
    NSArray *paths = c.args[@"paths"];
    if (![paths isKindOfClass:NSArray.class]) return [c fail:@"invalid_args" message:@"clipboard.writePaths: `paths` must be an array"];
    NSMutableArray *urls = [NSMutableArray array];
    for (id p in paths)
      if ([p isKindOfClass:NSString.class]) [urls addObject:[NSURL fileURLWithPath:p]];
    [pb() clearContents];
    [pb() writeObjects:urls];
    [c ok:nil];
  });
}
