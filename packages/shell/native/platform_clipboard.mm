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

static const NSUInteger clipboardLimit = 16 * 1024 * 1024;

static void write_multi(PlatformCall *c) {
  NSPasteboard *pasteboard = pb();
  NSInteger previousChangeCount = pasteboard.changeCount;
  NSMutableDictionary<NSString *, NSData *> *data = [NSMutableDictionary dictionary];
  NSDictionary *strings = @{@"text": NSPasteboardTypeString, @"html": NSPasteboardTypeHTML, @"rtf": NSPasteboardTypeRTF};
  for (NSString *key in strings) if ([c has:key]) {
    NSString *value = [c string:key];
    if (!value) return [c fail:@"invalid_args" message:@"clipboard.write: text, html and rtf must be strings"];
    data[strings[key]] = [value dataUsingEncoding:NSUTF8StringEncoding];
  }
  if ([c has:@"image"]) {
    NSString *encoded = [c string:@"image"];
    if (!encoded || encoded.length > clipboardLimit * 4 / 3 + 4) return [c fail:@"invalid_args" message:@"clipboard.write: invalid or oversized image"];
    NSData *bytes = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
    NSBitmapImageRep *image = bytes ? [NSBitmapImageRep imageRepWithData:bytes] : nil;
    NSData *png = image ? [image representationUsingType:NSBitmapImageFileTypePNG properties:@{}] : nil;
    if (!png) return [c fail:@"invalid_args" message:@"clipboard.write: image must be base64 image bytes"];
    data[NSPasteboardTypePNG] = png;
  }
  if ([c has:@"formats"]) {
    id custom = c.args[@"formats"];
    if (![custom isKindOfClass:NSDictionary.class]) return [c fail:@"invalid_args" message:@"clipboard.write: formats must map types to base64 bytes"];
    for (NSString *name in custom) {
      id encoded = custom[name];
      if (!name.length || ![encoded isKindOfClass:NSString.class] || [encoded length] > clipboardLimit * 4 / 3 + 4)
        return [c fail:@"invalid_args" message:@"clipboard.write: invalid or oversized format"];
      NSString *type = formats()[name] ?: name;
      NSData *bytes = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
      if (!bytes || data[type]) return [c fail:@"invalid_args" message:@"clipboard.write: invalid base64 or duplicate representation"];
      data[type] = bytes;
    }
  }
  NSArray *paths = [c has:@"files"] ? c.args[@"files"] : @[];
  if (![paths isKindOfClass:NSArray.class]) return [c fail:@"invalid_args" message:@"clipboard.write: files must be absolute paths"];
  NSMutableArray<NSURL *> *urls = [NSMutableArray array];
  for (id path in paths) {
    if (![path isKindOfClass:NSString.class] || ![path isAbsolutePath]) return [c fail:@"invalid_args" message:@"clipboard.write: files must be absolute paths"];
    [urls addObject:[NSURL fileURLWithPath:path]];
  }
  if (urls.count && data[NSPasteboardTypeFileURL]) return [c fail:@"invalid_args" message:@"clipboard.write: duplicate file URL representation"];
  NSUInteger size = 0;
  for (NSData *bytes in data.allValues) size += bytes.length;
  for (NSURL *url in urls) size += [url.absoluteString lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  if (size > clipboardLimit || (!data.count && !urls.count)) return [c fail:@"invalid_args" message:@"clipboard.write: supply representations totaling at most 16 MiB"];

  NSPasteboardItem *item = [NSPasteboardItem new];
  for (NSString *type in data) if (![item setData:data[type] forType:type])
    return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"clipboard.write: invalid pasteboard UTI `%@`", type]];
  NSMutableArray<id<NSPasteboardWriting>> *objects = [NSMutableArray array];
  if (urls.count) [item setString:urls.firstObject.absoluteString forType:NSPasteboardTypeFileURL];
  [objects addObject:item];
  if (urls.count > 1) [objects addObjectsFromArray:[urls subarrayWithRange:NSMakeRange(1, urls.count - 1)]];
  // Prepare every item before claiming ownership. writeObjects publishes them together.
  [pasteboard clearContents];
  if (![pasteboard writeObjects:objects]) return [c fail:@"unavailable" message:@"clipboard.write: pasteboard rejected the write"];
  [c ok:@{@"changeCount": @(pasteboard.changeCount), @"previousChangeCount": @(previousChangeCount)}];
}

static void read_multi(PlatformCall *c) {
  id requested = c.args[@"formats"];
  double limit = [c number:@"maxBytes" or:clipboardLimit];
  if (![requested isKindOfClass:NSArray.class] || [requested count] > 128 ||
      ([c has:@"maxBytes"] && ![c.args[@"maxBytes"] isKindOfClass:NSNumber.class]) || !isfinite(limit) || limit < 1 || limit > clipboardLimit || floor(limit) != limit)
    return [c fail:@"invalid_args" message:@"clipboard.read: formats array and maxBytes between 1 and 16777216 required"];
  NSInteger changeCount = pb().changeCount;
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  NSUInteger size = 0;
  for (id name in requested) {
    if (![name isKindOfClass:NSString.class] || ![name length]) return [c fail:@"invalid_args" message:@"clipboard.read: formats must be nonempty strings"];
    if (out[name]) continue;
    NSData *bytes = [pb() dataForType:formats()[name] ?: name];
    if (bytes.length > (NSUInteger)limit - size) return [c fail:@"invalid_args" message:@"clipboard.read: result exceeds maxBytes"];
    size += bytes.length;
    out[name] = bytes ? [bytes base64EncodedStringWithOptions:0] : NSNull.null;
  }
  if (pb().changeCount != changeCount) return [c fail:@"unavailable" message:@"clipboard changed during read; retry"];
  [c ok:@{@"changeCount": @(changeCount), @"formats": out}];
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
  platform_register(@"clipboard", @"write", ^(PlatformCall *c) { write_multi(c); });
  platform_register(@"clipboard", @"read", ^(PlatformCall *c) { read_multi(c); });
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
    // Item types are canonical UTIs; the board's types can also contain legacy aliases.
    NSMutableSet *custom = [NSMutableSet set];
    for (NSPasteboardItem *item in pb().pasteboardItems) for (NSString *type in item.types)
      if (![formats().allValues containsObject:type]) [custom addObject:type];
    [out addObjectsFromArray:custom.allObjects];
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
