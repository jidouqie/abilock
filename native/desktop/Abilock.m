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

static const NSTimeInterval ABLCloseHoldDuration = 1.0;

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
@property(strong) NSView *closeHint;
@property(strong) NSTimer *closeHintTimer;
@property(strong) NSTimer *closeKeyTimer;
@property(strong) id closeKeyMonitor;
@property(strong) id focusObserver;
@property unsigned short closeKeyCode;
@property BOOL closeKeyDown;
@property BOOL closeAuthorized;
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
  // The menu and shortcut both address this window and its owned session.
  NSMenuItem *closeItem = [file addItemWithTitle:@"Close Window" action:@selector(requestWindowClose:) keyEquivalent:@"w"];
  closeItem.target = self;
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
      NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
    backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Abilock";
  self.window.minSize = NSMakeSize(760, 540);
  self.window.delegate = self;
  self.window.releasedWhenClosed = NO;
  [self.window center];
  NSTextField *loading = [NSTextField labelWithString:@"Opening Abilock..."];
  loading.frame = NSMakeRect(24, 24, 600, 24);
  [self.window.contentView addSubview:loading];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  __weak AbilockApplication *weakSelf = self;
  self.closeKeyMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:
    NSEventMaskKeyDown | NSEventMaskKeyUp | NSEventMaskFlagsChanged handler:^NSEvent *(NSEvent *event) {
    return [weakSelf handleCloseKey:event];
  }];
  self.focusObserver = [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowDidResignKeyNotification
    object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *notice) {
    AbilockApplication *app = weakSelf;
    if (notice.object == app.window) { [app cancelCloseHold]; [app hideClosePrompt]; }
  }];
  [self startConfiguration];
}

- (void)cancelCloseHold {
  [self.closeKeyTimer invalidate];
  self.closeKeyTimer = nil;
  self.closeKeyDown = NO;
}

- (void)applicationDidResignActive:(NSNotification *)notification {
  (void)notification;
  [self cancelCloseHold];
  [self hideClosePrompt];
}

- (NSEvent *)handleCloseKey:(NSEvent *)event {
  if (self.stopping) return event;
  NSEventModifierFlags modifiers = event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl |
    NSEventModifierFlagOption | NSEventModifierFlagShift);
  if (event.type == NSEventTypeFlagsChanged && self.closeKeyDown && modifiers != NSEventModifierFlagCommand) {
    [self cancelCloseHold];
    [self showClosePrompt];
    return event;
  }
  if (event.type == NSEventTypeKeyUp && self.closeKeyDown && event.keyCode == self.closeKeyCode) {
    [self cancelCloseHold];
    [self showClosePrompt];
    return nil;
  }
  if (event.window != self.window) return event;
  if (event.type != NSEventTypeKeyDown || modifiers != NSEventModifierFlagCommand ||
      ![event.charactersIgnoringModifiers.lowercaseString isEqualToString:@"w"]) return event;
  if (!self.closeKeyDown && !event.isARepeat) {
    [self showClosePrompt];
    self.closeKeyDown = YES;
    self.closeKeyCode = event.keyCode;
    __weak AbilockApplication *weakSelf = self;
    self.closeKeyTimer = [NSTimer timerWithTimeInterval:ABLCloseHoldDuration repeats:NO block:^(NSTimer *timer) {
      (void)timer;
      AbilockApplication *app = weakSelf;
      if (app.closeKeyDown && NSApp.active) [app confirmWindowClose:nil];
    }];
    [[NSRunLoop mainRunLoop] addTimer:self.closeKeyTimer forMode:NSRunLoopCommonModes];
  }
  return nil;
}

- (void)requestWindowClose:(id)sender {
  (void)sender;
  [self.window performClose:nil];
}

- (void)hideClosePrompt {
  [self.closeHintTimer invalidate];
  self.closeHintTimer = nil;
  [self.closeHint removeFromSuperview];
  self.closeHint = nil;
}

- (void)showClosePrompt {
  if (self.stopping || self.failed || self.window.attachedSheet) return;
  [self hideClosePrompt];
  NSView *content = self.window.contentView;
  NSView *hint = [[NSView alloc] initWithFrame:NSZeroRect];
  hint.translatesAutoresizingMaskIntoConstraints = NO;
  hint.wantsLayer = YES;
  hint.layer.backgroundColor = [NSColor colorWithWhite:0.16 alpha:0.92].CGColor;
  hint.layer.cornerRadius = 12;
  NSTextField *label = [NSTextField labelWithString:@"按住 ⌘W 键即可关闭"];
  label.frame = NSMakeRect(12, 15, 276, 24);
  label.font = [NSFont boldSystemFontOfSize:18];
  label.textColor = NSColor.whiteColor;
  label.alignment = NSTextAlignmentCenter;
  [hint addSubview:label];
  [content addSubview:hint];
  [NSLayoutConstraint activateConstraints:@[
    [hint.centerXAnchor constraintEqualToAnchor:content.centerXAnchor],
    [hint.topAnchor constraintEqualToAnchor:content.topAnchor constant:24],
    [hint.widthAnchor constraintEqualToConstant:300],
    [hint.heightAnchor constraintEqualToConstant:54],
  ]];
  self.closeHint = hint;
  __weak AbilockApplication *weakSelf = self;
  self.closeHintTimer = [NSTimer timerWithTimeInterval:2.0 repeats:NO block:^(NSTimer *timer) {
    (void)timer;
    [weakSelf hideClosePrompt];
  }];
  [[NSRunLoop mainRunLoop] addTimer:self.closeHintTimer forMode:NSRunLoopCommonModes];
}

- (void)confirmWindowClose:(id)sender {
  (void)sender;
  [self cancelCloseHold];
  self.closeAuthorized = YES;
  [self hideClosePrompt];
  [self.window performClose:nil];
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
  (void)sender;
  if (self.closeAuthorized || self.stopping || self.failed) return YES;
  [self showClosePrompt];
  return NO;
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
  /* There is deliberately no script message handler or native execution bridge. */
  self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:settings];
  self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  self.webView.navigationDelegate = self;
  self.webView.UIDelegate = self;
  self.webView.allowsBackForwardNavigationGestures = NO;
  self.window.contentView = self.webView;
  if (self.closeHint) [self showClosePrompt];
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
    @"pageLoaded":@(loaded), @"workerExited":@(workerExited), @"closeAuthorized":@(self.closeAuthorized),
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
  [self cancelCloseHold];
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
