#import "desktop-policy.h"

void ABLObserveReadiness(NSFileHandle *handle, void (^receive)(NSData *)) {
  handle.readabilityHandler = ^(NSFileHandle *reader) {
    NSData *chunk = [reader availableData];
    /* EOF remains readable; unregister before queuing the last delivery. */
    if (chunk.length == 0) reader.readabilityHandler = nil;
    dispatch_async(dispatch_get_main_queue(), ^{ receive(chunk); });
  };
}

NSURL *ABLConfigurationURL(id value) {
  if (![value isKindOfClass:[NSString class]] || [value length] > 128) return nil;
  NSString *text = value;
  NSRegularExpression *format = [NSRegularExpression
    regularExpressionWithPattern:@"^http://127\\.0\\.0\\.1:([1-9][0-9]{0,4})/?$"
    options:0 error:NULL];
  NSTextCheckingResult *match = [format firstMatchInString:text options:0
    range:NSMakeRange(0, [text length])];
  if (!match || [match range].length != [text length]) return nil;
  NSInteger port = [[text substringWithRange:[match rangeAtIndex:1]] integerValue];
  if (port < 1024 || port > 65535) return nil;
  NSURLComponents *parts = [NSURLComponents componentsWithString:text];
  if (!parts || ![parts.scheme isEqualToString:@"http"] ||
      ![parts.host isEqualToString:@"127.0.0.1"] || parts.user || parts.password ||
      parts.query || parts.fragment || parts.port.integerValue != port ||
      (parts.path.length && ![parts.path isEqualToString:@"/"])) return nil;
  parts.path = @"/";
  return parts.URL;
}

NSURL *ABLReadyURL(NSData *line) {
  if (line.length == 0 || line.length > 4096) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
  if (![value isKindOfClass:[NSDictionary class]] || [value count] != 2 ||
      ![value[@"type"] isEqual:@"configuration-ready"]) return nil;
  return ABLConfigurationURL(value[@"url"]);
}

BOOL ABLSameOrigin(NSURL *candidate, NSURL *origin) {
  if (!candidate || !origin) return NO;
  NSURLComponents *parts = [NSURLComponents componentsWithURL:candidate resolvingAgainstBaseURL:NO];
  NSURLComponents *base = [NSURLComponents componentsWithURL:origin resolvingAgainstBaseURL:NO];
  return parts && base && !parts.user && !parts.password &&
    [parts.scheme isEqualToString:base.scheme] &&
    [parts.host isEqualToString:base.host] && [parts.port isEqualToNumber:base.port];
}
