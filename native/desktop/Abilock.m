#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "desktop-policy.h"
#include <sys/stat.h>
#include <unistd.h>

#if defined(ABILOCK_DESKTOP_TEST_FIXTURE)
static NSString *const ABLLauncher = @"/private/tmp/abilock-desktop-mac-fixture/launch";
#else
static NSString *const ABLLauncher = @"/usr/local/libexec/abilock/launch";
#endif

/* The page fills the window under a transparent title bar. This strip keeps
   the title bar's own behaviour above the page: drag to move the window and
   double-click for the user's chosen title-bar action. It draws nothing and
   exchanges nothing with the page. */
@interface ABLTitlebarStrip : NSView
@end

@implementation ABLTitlebarStrip
- (void)mouseDown:(NSEvent *)event {
  if (event.clickCount == 2) {
    NSString *action = [[NSUserDefaults standardUserDefaults] stringForKey:@"AppleActionOnDoubleClick"];
    if ([action isEqualToString:@"Minimize"]) [self.window performMiniaturize:nil];
    else if (![action isEqualToString:@"None"]) [self.window performZoom:nil];
    return;
  }
  [self.window performWindowDragWithEvent:event];
}
@end

@interface AbilockApplication : NSObject <NSApplicationDelegate, NSWindowDelegate,
  WKNavigationDelegate, WKUIDelegate>
@property(strong) NSWindow *window;
@property(strong) WKWebView *webView;
@property(strong) NSTask *configuration;
@property(strong) NSPipe *input;
@property(strong) NSPipe *output;
@property(strong) NSMutableData *readiness;
@property(strong) NSURL *origin;
@property BOOL stopping;
@property BOOL failed;
@end

@implementation AbilockApplication
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  NSMenu *menu = [[NSMenu alloc] init];
  NSMenuItem *applicationItem = [[NSMenuItem alloc] init];
  [menu addItem:applicationItem];
  NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:@"Abilock"];
  [applicationMenu addItemWithTitle:@"Quit Abilock" action:@selector(terminate:) keyEquivalent:@"q"];
  applicationItem.submenu = applicationMenu;
  NSMenuItem *fileItem = [[NSMenuItem alloc] init];
  [menu addItem:fileItem];
  NSMenu *file = [[NSMenu alloc] initWithTitle:@"File"];
  [file addItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w"];
  fileItem.submenu = file;
  NSMenuItem *editItem = [[NSMenuItem alloc] init];
  [menu addItem:editItem];
  NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
  [edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
  [edit addItem:[NSMenuItem separatorItem]];
  [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
  [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  editItem.submenu = edit;
  NSApp.mainMenu = menu;

  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1120, 760)
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
      NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
      NSWindowStyleMaskFullSizeContentView
    backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Abilock";
  // The title stays for the Window menu and Mission Control; the bar itself
  // is clear so the page's sidebar runs to the top edge.
  self.window.titlebarAppearsTransparent = YES;
  self.window.titleVisibility = NSWindowTitleHidden;
  self.window.minSize = NSMakeSize(760, 540);
  self.window.delegate = self;
  self.window.releasedWhenClosed = NO;
  [self.window center];
  NSProgressIndicator *spinner = [[NSProgressIndicator alloc] init];
  spinner.style = NSProgressIndicatorStyleSpinning;
  spinner.controlSize = NSControlSizeSmall;
  [spinner startAnimation:nil];
  NSTextField *label = [NSTextField labelWithString:@"Opening Abilock..."];
  label.textColor = NSColor.secondaryLabelColor;
  NSStackView *loading = [NSStackView stackViewWithViews:@[spinner, label]];
  loading.spacing = 8;
  loading.translatesAutoresizingMaskIntoConstraints = NO;
  NSView *content = self.window.contentView;
  [content addSubview:loading];
  [NSLayoutConstraint activateConstraints:@[
    [loading.centerXAnchor constraintEqualToAnchor:content.centerXAnchor],
    [loading.centerYAnchor constraintEqualToAnchor:content.centerYAnchor],
  ]];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [self startConfiguration];
}

- (void)installPage:(NSView *)page {
  NSView *content = [[NSView alloc] initWithFrame:self.window.contentView.bounds];
  page.frame = content.bounds;
  page.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [content addSubview:page];
  CGFloat height = NSHeight(self.window.frame) - NSHeight(self.window.contentLayoutRect);
  if (height < 22 || height > 60) height = 28;
  ABLTitlebarStrip *strip = [[ABLTitlebarStrip alloc] initWithFrame:
    NSMakeRect(0, NSHeight(content.bounds) - height, NSWidth(content.bounds), height)];
  strip.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
  [content addSubview:strip positioned:NSWindowAbove relativeTo:page];
  self.window.contentView = content;
}

- (void)showFailure:(NSString *)message {
  if (self.failed || self.stopping) return;
  self.failed = YES;
  [self closeConfigurationInput];
  if (self.configuration.running) [self.configuration terminate];
#if defined(ABILOCK_DESKTOP_TEST_FIXTURE)
  [message writeToFile:@"/private/tmp/abilock-desktop-mac-fixture/window-failed.txt" atomically:YES encoding:NSUTF8StringEncoding error:NULL];
  [NSApp terminate:nil];
  return;
#endif
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"Abilock";
  alert.informativeText = message;
  [alert addButtonWithTitle:@"Close"];
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
    (void)result;
    [NSApp terminate:nil];
  }];
}

- (void)startConfiguration {
  /* This is a public, fixed executable. Only the existing protected launcher
     can load private configuration or adopt the isolated execution identity. */
  struct stat metadata;
#if defined(ABILOCK_DESKTOP_TEST_FIXTURE)
  uid_t launcherOwner = getuid();
#else
  uid_t launcherOwner = 0;
#endif
  if (lstat(ABLLauncher.fileSystemRepresentation, &metadata) != 0 ||
      !S_ISREG(metadata.st_mode) || metadata.st_uid != launcherOwner ||
      metadata.st_nlink != 1 || (metadata.st_mode & 0022) ||
#if !defined(ABILOCK_DESKTOP_TEST_FIXTURE)
      !(metadata.st_mode & S_ISUID) ||
#endif
      !(metadata.st_mode & S_IXUSR)) {
    [self showFailure:@"Install Abilock using its installer, then open this app."];
    return;
  }
  self.configuration = [[NSTask alloc] init];
  self.configuration.executableURL = [NSURL fileURLWithPath:ABLLauncher];
  self.configuration.arguments = @[@"config"];
  self.configuration.environment = @{@"PATH":@"/usr/bin:/bin:/usr/sbin:/sbin",
    @"LANG":@"en_US.UTF-8", @"LC_ALL":@"en_US.UTF-8"};
  self.configuration.currentDirectoryURL = [NSURL fileURLWithPath:@"/"];
  self.input = [NSPipe pipe];
  self.output = [NSPipe pipe];
  self.readiness = [NSMutableData data];
  self.configuration.standardInput = self.input;
  self.configuration.standardOutput = self.output;
  /* Untrusted exception strings are never exposed in the app or log. */
  self.configuration.standardError = [NSFileHandle fileHandleWithNullDevice];
  __weak AbilockApplication *weakSelf = self;
  ABLObserveReadiness(self.output.fileHandleForReading, ^(NSData *chunk) {
    [weakSelf consumeReadiness:chunk];
  });
  self.configuration.terminationHandler = ^(NSTask *task) {
    (void)task;
    dispatch_async(dispatch_get_main_queue(), ^{
      AbilockApplication *app = weakSelf;
      if (!app) return;
      app.output.fileHandleForReading.readabilityHandler = nil;
      if (app.stopping) [NSApp terminate:nil];
      else [app showFailure:@"The configuration session ended. Close any other configuration window and reopen Abilock."];
    });
  };
  NSError *error = nil;
  if (![self.configuration launchAndReturnError:&error]) {
    self.output.fileHandleForReading.readabilityHandler = nil;
    [self showFailure:@"Abilock could not open its configuration session. Reinstall Abilock and try again."];
    return;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    AbilockApplication *app = weakSelf;
    if (app && !app.origin && !app.stopping)
      [app showFailure:@"Opening Abilock timed out. Close any other configuration window and try again."];
  });
}

- (void)consumeReadiness:(NSData *)chunk {
  if (self.stopping || self.failed || self.origin) return;
  if (chunk.length == 0 || self.readiness.length + chunk.length > 4096) {
    [self showFailure:@"Abilock returned an invalid configuration address."];
    return;
  }
  [self.readiness appendData:chunk];
  const unsigned char *bytes = self.readiness.bytes;
  NSUInteger newline = NSNotFound;
  for (NSUInteger index = 0; index < self.readiness.length; ++index)
    if (bytes[index] == '\n') { newline = index; break; }
  if (newline == NSNotFound) return;
  if (newline != self.readiness.length - 1) {
    [self showFailure:@"Abilock returned an invalid configuration address."];
    return;
  }
  NSURL *url = ABLReadyURL([self.readiness subdataWithRange:NSMakeRange(0, newline)]);
  if (!url) {
    [self showFailure:@"Abilock returned an invalid configuration address."];
    return;
  }
  self.origin = url;
  self.readiness = nil;
  WKWebViewConfiguration *settings = [[WKWebViewConfiguration alloc] init];
  settings.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
  settings.preferences.javaScriptCanOpenWindowsAutomatically = NO;
  /* A public layout hint only: the page leaves room for the window buttons. */
  settings.applicationNameForUserAgent = @"AbilockDesktop";
  /* There is deliberately no script message handler or native execution bridge. */
  self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:settings];
  self.webView.navigationDelegate = self;
  self.webView.UIDelegate = self;
  self.webView.allowsBackForwardNavigationGestures = NO;
  [self installPage:self.webView];
  [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
  decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  (void)webView;
  decisionHandler(!self.stopping && action.targetFrame && !action.shouldPerformDownload &&
    ABLSameOrigin(action.request.URL, self.origin) ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationResponse:(WKNavigationResponse *)response
  decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
  (void)webView;
  decisionHandler(response.canShowMIMEType && ABLSameOrigin(response.response.URL, self.origin)
    ? WKNavigationResponsePolicyAllow : WKNavigationResponsePolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
  forNavigationAction:(WKNavigationAction *)navigationAction windowFeatures:(WKWindowFeatures *)windowFeatures {
  (void)webView; (void)configuration; (void)navigationAction; (void)windowFeatures;
  return nil;
}

- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
  initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completionHandler {
  (void)webView;
  if (self.stopping || !frame.mainFrame || !ABLSameOrigin(frame.request.URL, self.origin)) {
    completionHandler(nil);
    return;
  }
  /* Standard user file selection feeds the existing HTML input. The native
     shell neither reads the selected file nor prints its path or contents. */
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.canChooseFiles = YES;
  panel.canChooseDirectories = NO;
  panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
    completionHandler(result == NSModalResponseOK ? panel.URLs : nil);
  }];
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
  initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
  (void)webView;
  if (self.stopping || !frame.mainFrame || !ABLSameOrigin(frame.request.URL, self.origin) || message.length > 512) {
    completionHandler(NO);
    return;
  }
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"Abilock";
  alert.informativeText = message;
  [alert addButtonWithTitle:@"OK"];
  [alert addButtonWithTitle:@"Cancel"];
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
    completionHandler(result == NSAlertFirstButtonReturn);
  }];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  (void)webView;
  [self showFailure:@"The window stopped responding. Close and reopen Abilock."];
}

#if defined(ABILOCK_DESKTOP_TEST_FIXTURE)
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  (void)navigation;
  if (!ABLSameOrigin(webView.URL, self.origin)) return;
  [@"loaded" writeToFile:@"/private/tmp/abilock-desktop-mac-fixture/window-loaded.txt" atomically:YES encoding:NSUTF8StringEncoding error:NULL];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    [NSApp terminate:nil];
  });
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  (void)notification;
  BOOL loaded = [[NSString stringWithContentsOfFile:@"/private/tmp/abilock-desktop-mac-fixture/window-loaded.txt" encoding:NSUTF8StringEncoding error:NULL] isEqualToString:@"loaded"];
  BOOL workerExited = !self.configuration.running && [[NSFileManager defaultManager] fileExistsAtPath:@"/private/tmp/abilock-desktop-mac-fixture/fixture-stopped.txt"];
  NSData *report = [NSJSONSerialization dataWithJSONObject:@{@"fixtureOnly":@YES,
    @"pageLoaded":@(loaded), @"workerExited":@(workerExited),
    @"passed":@((BOOL)(loaded && workerExited))} options:NSJSONWritingPrettyPrinted error:NULL];
  [report writeToFile:@"/private/tmp/abilock-desktop-mac-fixture/smoke-report.json" atomically:YES];
}
#endif

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation
  withError:(NSError *)error {
  (void)webView; (void)navigation;
  if (error.code != NSURLErrorCancelled)
    [self showFailure:@"The configuration page could not load. Close and reopen Abilock."];
}

- (void)closeConfigurationInput {
  if (self.input) {
    [self.input.fileHandleForWriting closeFile];
    self.input = nil;
  }
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  (void)sender;
  if (self.stopping) return self.configuration.running ? NSTerminateCancel : NSTerminateNow;
  self.stopping = YES;
  self.output.fileHandleForReading.readabilityHandler = nil;
  [self.webView stopLoading];
  [self closeConfigurationInput];
  if (!self.configuration.running) return NSTerminateNow;
  /* EOF is the normal close signal. Only our own NSTask is escalated; the
     native supervisor gives its worker five seconds before forced shutdown. */
  __weak AbilockApplication *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    AbilockApplication *app = weakSelf;
    if (app.configuration.running) [app.configuration terminate];
  });
  // Keep the normal event loop active while the owned worker closes. Once its
  // termination handler runs, a second terminate request returns Now above.
  return NSTerminateCancel;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  (void)sender;
  return YES;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {
  (void)sender;
  if (!visible && !self.stopping) [self.window makeKeyAndOrderFront:nil];
  return YES;
}
@end

int main(int argc, const char *argv[]) {
  (void)argv;
  if (argc != 1 || getuid() == 0 || geteuid() != getuid()) return 78;
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSApp.activationPolicy = NSApplicationActivationPolicyRegular;
    AbilockApplication *application = [[AbilockApplication alloc] init];
    NSApp.delegate = application;
    [NSApp run];
    return 0;
  }
}
