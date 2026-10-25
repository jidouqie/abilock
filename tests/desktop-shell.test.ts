import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("desktop accepts only its exact numeric loopback readiness and origin", { skip: process.platform !== "darwin" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-desktop-policy-"));
  try {
    const harness = `
#import <Foundation/Foundation.h>
#import ${JSON.stringify(path.resolve("native/desktop/desktop-policy.h"))}
#include <assert.h>
int main(void) { @autoreleasepool {
  NSURL *origin = ABLConfigurationURL(@"http://127.0.0.1:4317");
  assert([origin.absoluteString isEqualToString:@"http://127.0.0.1:4317/"]);
  assert(ABLConfigurationURL(@"http://127.0.0.1:65535/") != nil);
  for (id invalid in @[@"https://127.0.0.1:4317", @"http://localhost:4317", @"http://[::1]:4317",
    @"http://127.0.0.1:443", @"http://127.0.0.1:65536", @"http://127.0.0.1:04317", @"http://127.1:4317",
    @"http://127.0.0.1:4317/?token=secret", @"http://127.0.0.1:4317/#secret", @"http://user@127.0.0.1:4317",
    @"http://127.0.0.1:4317/admin", @"http://example.com:4317", @"file:///tmp/a", @"javascript:1",
    @"http://127.0.0.1:4317\\n", @" http://127.0.0.1:4317", @123, [NSNull null]])
    assert(ABLConfigurationURL(invalid) == nil);
  for (NSString *valid in @[@"http://127.0.0.1:4317/", @"http://127.0.0.1:4317/admin", @"http://127.0.0.1:4317/#manuals"])
    assert(ABLSameOrigin([NSURL URLWithString:valid], origin));
  for (NSString *invalid in @[@"http://127.0.0.1:4318/", @"https://127.0.0.1:4317/", @"http://evil.test:4317/",
    @"http://user:secret@127.0.0.1:4317/", @"file:///tmp/a", @"javascript:1"])
    assert(!ABLSameOrigin([NSURL URLWithString:invalid], origin));
  NSData *valid = [NSJSONSerialization dataWithJSONObject:@{@"type":@"configuration-ready", @"url":origin.absoluteString} options:0 error:NULL];
  assert(ABLReadyURL(valid) != nil);
  for (id record in @[@{}, @[], @{@"type":@"configuration-ready", @"url":@"http://evil.test:4317"},
    @{@"type":@"configuration-ready", @"url":origin.absoluteString, @"token":@"secret"},
    @{@"type":@"execute", @"url":origin.absoluteString}]) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:record options:0 error:NULL];
    assert(ABLReadyURL(data) == nil);
  }
  assert(ABLReadyURL([@"invalid" dataUsingEncoding:NSUTF8StringEncoding]) == nil);
  assert(ABLReadyURL([NSMutableData dataWithLength:4097]) == nil);
} return 0; }
`;
    const source = path.join(directory, "harness.m");
    await fs.writeFile(source, harness);
    const executable = path.join(directory, "policy");
    execFileSync("/usr/bin/cc", ["-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-framework", "Foundation",
      source, path.resolve("native/desktop/desktop-policy.m"), "-o", executable]);
    execFileSync(executable);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("desktop has no arbitrary native bridge, URL argument, private-file read, or broad process shutdown", async () => {
  const source = await fs.readFile("native/desktop/Abilock.m", "utf8");
  assert.match(source, /@"\/usr\/local\/libexec\/abilock\/launch"/);
  assert.match(source, /self\.configuration\.arguments = @\[@"config"\]/);
  assert.match(source, /nonPersistentDataStore/);
  assert.match(source, /argc != 1/);
  assert.match(source, /fileHandleForWriting closeFile/);
  assert.match(source, /self\.configuration terminate/);
  assert.doesNotMatch(source, /addScriptMessageHandler|evaluateJavaScript|\/private\/var\/db|service\.env|vault\.json|killall|pkill|system\(|popen\(/);
});

test("desktop readiness pipe delivers EOF once without starving its main queue", { skip: process.platform !== "darwin" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abilock-desktop-eof-"));
  try {
    const harness = `
#import <Foundation/Foundation.h>
#import ${JSON.stringify(path.resolve("native/desktop/desktop-policy.h"))}
#include <assert.h>
int main(void) { @autoreleasepool {
  NSPipe *pipe = [NSPipe pipe];
  __block NSUInteger deliveries = 0, endOfStream = 0;
  __block NSMutableData *received = [NSMutableData data];
  NSData *expected = [@"synthetic readiness\\n" dataUsingEncoding:NSUTF8StringEncoding];
  ABLObserveReadiness(pipe.fileHandleForReading, ^(NSData *chunk) {
    ++deliveries;
    assert(deliveries <= 2);
    if (chunk.length == 0) ++endOfStream;
    else [received appendData:chunk];
  });
  [pipe.fileHandleForWriting writeData:expected];
  [pipe.fileHandleForWriting closeFile];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    assert(deliveries == 2 && endOfStream == 1);
    assert([received isEqualToData:expected]);
    assert(pipe.fileHandleForReading.readabilityHandler == nil);
    exit(0);
  });
  dispatch_main();
} }
`;
    const source = path.join(directory, "eof.m");
    const executable = path.join(directory, "eof");
    await fs.writeFile(source, harness);
    execFileSync("/usr/bin/cc", ["-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-framework", "Foundation",
      source, path.resolve("native/desktop/desktop-policy.m"), "-o", executable]);
    execFileSync(executable, { timeout: 3000 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Windows desktop uses the fixed protected client and English PowerShell build entry", async () => {
  const source = await fs.readFile("native/desktop/windows/Program.cs", "utf8");
  const build = await fs.readFile("native/desktop/windows/Build.ps1", "utf8");
  const project = await fs.readFile("native/desktop/windows/Abilock.Desktop.csproj", "utf8");
  assert.match(source, /Environment\.SpecialFolder\.ProgramFiles/);
  assert.match(source, /"Abilock", "Abilock\.Host\.exe"/);
  assert.match(source, /Arguments = "client config"/);
  const lifecycle = await fs.readFile("native/desktop/windows/DesktopProcess.cs", "utf8");
  assert.match(lifecycle, /StandardInput\.Close\(\)/);
  assert.match(lifecycle, /process\.Kill\(\)/);
  assert.match(source, /IsInPrivateModeEnabled = true/);
  assert.match(source, /AreHostObjectsAllowed = false/);
  assert.match(source, /IsWebMessageEnabled = false/);
  assert.doesNotMatch(source, /GetProcesses|Process\.GetProcessById|ExecuteScript|AddHostObject|service\.env|vault\.json/);
  assert.match(build, /^#requires -Version 5\.1/m);
  assert([...build].every((character) => character.charCodeAt(0) <= 0x7f));
  assert.match(build, /https:\/\/api\.nuget\.org\/v3\/index\.json/);
  assert.match(project, /Microsoft\.Web\.WebView2" Version="\[1\.0\.3800\.47\]"/);
  assert.match(project, /<TargetFramework>net48<\/TargetFramework>/);
  assert.match(project, /<SelfContained>false<\/SelfContained>/);
  assert.match(project, /<Prefer32Bit>false<\/Prefer32Bit>/);
  assert.match(source, /!Environment\.Is64BitProcess/);
  assert.match(await fs.readFile("native/desktop/windows/App.config", "utf8"), /DpiAwareness" value="PerMonitorV2"/);
  const policy = await fs.readFile("native/desktop/windows/DesktopPolicy.cs", "utf8");
  assert.match(policy, /JavaScriptSerializer/);
  assert.doesNotMatch(policy, /System\.Text\.Json|GeneratedRegex/);
});
