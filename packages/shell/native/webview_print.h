// Print options are validated before AppKit creates a job or displays a panel.
static BOOL print_number(id value, double min, double max) {
  return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()
      && isfinite([value doubleValue]) && [value doubleValue] >= min && [value doubleValue] <= max;
}
static NSPrintInfo *print_info(NSDictionary *options, BOOL pdf, NSString **error) {
  NSPrintInfo *info = [NSPrintInfo.sharedPrintInfo copy];
  info.horizontalPagination = NSPrintingPaginationModeFit;
  info.verticalPagination = NSPrintingPaginationModeAutomatic;
  info.verticallyCentered = NO;
  if (id printer = options[@"printer"]) {
    if (![printer isKindOfClass:NSString.class] || ![NSPrinter.printerNames containsObject:printer]) {
      *error = @"printer must name an installed printer"; return nil;
    }
    info.printer = [NSPrinter printerWithName:printer];
  }
  if (id copies = options[@"copies"]) {
    if (!print_number(copies, 1, 9999) || [copies doubleValue] != [copies integerValue]) { *error = @"copies must be an integer from 1 to 9999"; return nil; }
    info.dictionary[NSPrintCopies] = copies;
  }
  if (id paper = options[@"paperSize"]) {
    if (![paper isKindOfClass:NSDictionary.class] || !print_number(paper[@"width"], 1, 14400) || !print_number(paper[@"height"], 1, 14400)) {
      *error = @"paperSize needs positive width and height in points (maximum 14400)"; return nil;
    }
    info.paperSize = NSMakeSize([paper[@"width"] doubleValue], [paper[@"height"] doubleValue]);
  }
  if (id orientation = options[@"orientation"]) {
    if (![@[@"portrait", @"landscape"] containsObject:orientation]) { *error = @"orientation must be portrait or landscape"; return nil; }
    info.orientation = [orientation isEqual:@"landscape"] ? NSPaperOrientationLandscape : NSPaperOrientationPortrait;
  }
  if (id margins = options[@"margins"]) {
    if (![margins isKindOfClass:NSDictionary.class]) { *error = @"margins must contain top, right, bottom and left in points"; return nil; }
    for (NSString *key in @[@"top", @"right", @"bottom", @"left"]) {
      if (!print_number(margins[key], 0, 14400)) { *error = @"all margins must be nonnegative points"; return nil; }
    }
    info.topMargin = [margins[@"top"] doubleValue]; info.rightMargin = [margins[@"right"] doubleValue];
    info.bottomMargin = [margins[@"bottom"] doubleValue]; info.leftMargin = [margins[@"left"] doubleValue];
  }
  if (info.leftMargin + info.rightMargin >= info.paperSize.width || info.topMargin + info.bottomMargin >= info.paperSize.height) {
    *error = @"margins leave no printable area"; return nil;
  }
  if (id ranges = options[@"pageRanges"]) {
    if (![ranges isKindOfClass:NSArray.class] || ![ranges count]) { *error = @"pageRanges must be a nonempty array"; return nil; }
    NSInteger previous = 0;
    for (id range in ranges) {
      if (![range isKindOfClass:NSDictionary.class] || !print_number(range[@"from"], 1, INT_MAX) || !print_number(range[@"to"], 1, INT_MAX) ||
          [range[@"from"] doubleValue] != [range[@"from"] integerValue] || [range[@"to"] doubleValue] != [range[@"to"] integerValue] ||
          [range[@"from"] integerValue] <= previous || [range[@"to"] integerValue] < [range[@"from"] integerValue]) {
        *error = @"pageRanges must be ascending, nonoverlapping, one-based inclusive integer ranges"; return nil;
      }
      previous = [range[@"to"] integerValue];
    }
    if (!pdf) {
      if ([ranges count] != 1) { *error = @"physical printing accepts one contiguous page range"; return nil; }
      info.dictionary[NSPrintAllPages] = @NO;
      info.dictionary[NSPrintFirstPage] = ranges[0][@"from"];
      info.dictionary[NSPrintLastPage] = ranges[0][@"to"];
    }
  }
  // PDF ranges are applied after pagination, because WebKit/AppKit can ignore page selection on save jobs.
  if (pdf) info.dictionary[NSPrintAllPages] = @YES;
  return info;
}
static BOOL select_pdf_pages(NSString *path, NSArray *ranges) {
  if (!ranges) return YES;
  PDFDocument *document = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:path]];
  if (!document) return NO;
  NSUInteger count = document.pageCount;
  if ([ranges.lastObject[@"to"] unsignedIntegerValue] > count) return NO;
  for (NSInteger i = (NSInteger)count - 1; i >= 0; i--) {
    BOOL keep = NO;
    for (NSDictionary *range in ranges)
      if (i + 1 >= [range[@"from"] integerValue] && i + 1 <= [range[@"to"] integerValue]) { keep = YES; break; }
    if (!keep) [document removePageAtIndex:(NSUInteger)i];
  }
  return [document writeToURL:[NSURL fileURLWithPath:path]];
}
