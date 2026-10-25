#import <AppKit/AppKit.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

/* Only the root installer calls this protected executable. The password goes
   straight into an inherited anonymous pipe; stdout and argv never contain it. */
int main(int argc, char **argv) {
  (void)argv;
  struct stat channel;
  if (argc != 1 || getuid() != 0 || geteuid() != 0 ||
      fstat(3, &channel) != 0 || !S_ISFIFO(channel.st_mode) ||
      (fcntl(3, F_GETFL) & O_ACCMODE) != O_WRONLY) return 78;
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSAlert *alert = [[NSAlert alloc] init];
    [alert setMessageText:@"Abilock"];
    [alert setInformativeText:@"设置管理密码。以后在配置页输入这个密码。"];
    [alert addButtonWithTitle:@"保存"];
    [alert addButtonWithTitle:@"取消"];
    NSView *view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 300, 110)];
    NSTextField *label = [NSTextField labelWithString:@"密码"];
    [label setFrame:NSMakeRect(0, 85, 300, 18)];
    NSSecureTextField *password = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(0, 58, 300, 24)];
    NSTextField *confirmLabel = [NSTextField labelWithString:@"确认密码"];
    [confirmLabel setFrame:NSMakeRect(0, 29, 300, 18)];
    NSSecureTextField *confirmation = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(0, 2, 300, 24)];
    [view addSubview:label]; [view addSubview:password];
    [view addSubview:confirmLabel]; [view addSubview:confirmation];
    [alert setAccessoryView:view];
    [[alert window] setInitialFirstResponder:password];
    [NSApp activateIgnoringOtherApps:YES];
    while (true) {
      if ([alert runModal] != NSAlertFirstButtonReturn) return 130;
      NSString *value = [password stringValue];
      /* Match JavaScript [...value].length, including astral characters. */
      NSUInteger length = [value lengthOfBytesUsingEncoding:NSUTF32LittleEndianStringEncoding] / 4;
      if (length < 8 || length > 256 || ![value isEqualToString:[confirmation stringValue]]) {
        [alert setInformativeText:@"密码需为 8–256 个字符，两次输入须一致。"];
        continue;
      }
      NSData *payload = [NSJSONSerialization dataWithJSONObject:@{@"password":value}
                                                        options:0 error:nil];
      if (!payload) return 78;
      const unsigned char *bytes = [payload bytes];
      NSUInteger offset = 0;
      while (offset < [payload length]) {
        ssize_t written = write(3, bytes + offset, [payload length] - offset);
        if (written <= 0) return 78;
        offset += (NSUInteger)written;
      }
      if (write(3, "\n", 1) != 1) return 78;
      [password setStringValue:@""]; [confirmation setStringValue:@""];
      close(3);
      return 0;
    }
  }
}
