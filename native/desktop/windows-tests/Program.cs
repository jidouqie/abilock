using Abilock.Desktop;
using System.Diagnostics;
using System.Text;

var fixtureRoot = Path.GetFullPath(Environment.GetEnvironmentVariable("ABILOCK_FIXTURE_ROOT")
    ?? Path.Combine(Path.GetTempPath(), "AbilockDesktopBuild-20261014"));
var failurePath = Path.Combine(fixtureRoot, "net48-test-failure.txt");

AppDomain.CurrentDomain.UnhandledException += (_, eventArgs) =>
{
    if (eventArgs.ExceptionObject is Exception error)
        File.WriteAllText(failurePath,
            error.GetType().FullName + "\n" + error.HResult + "\n" + error.Message);
};

if (args.SequenceEqual(new[] { "--child-eof" }))
{
    Console.WriteLine("ready");
    await Console.In.ReadToEndAsync();
    return;
}
if (args.SequenceEqual(new[] { "--child-stall" }))
{
    await Task.Delay(30000);
    return;
}

static void Check(bool condition, string name)
{
    if (!condition) throw new InvalidOperationException(name);
}

Console.WriteLine("Desktop net48 tests started; bits=" + (IntPtr.Size * 8));
using (var current = Process.GetCurrentProcess())
{
    Check(NativeArchitecture.IsWow64Process2(current.Handle, out var machine, out var native), "architecture query");
    Check(IntPtr.Size == 8, "64-bit Framework process");
    Check(native != 0xaa64 || machine == 0, "native ARM64 Framework process");
    Console.WriteLine("Framework process machine=" + (machine == 0 ? native : machine).ToString("x") + "; native=" + native.ToString("x"));
}
File.Delete(failurePath);

var origin = DesktopPolicy.ConfigurationUrl("http://127.0.0.1:4317");
Check(origin?.AbsoluteUri == "http://127.0.0.1:4317/", "canonical root");
Check(DesktopPolicy.ConfigurationUrl("http://127.0.0.1:65535/") is not null, "upper port");
foreach (var invalid in new string?[]
{
    null, "", "https://127.0.0.1:4317", "http://localhost:4317", "http://[::1]:4317",
    "http://127.0.0.1:443", "http://127.0.0.1:65536", "http://127.0.0.1:04317", "http://127.1:4317",
    "http://127.0.0.1:4317/?token=secret", "http://127.0.0.1:4317/#secret", "http://user@127.0.0.1:4317",
    "http://127.0.0.1:4317/admin", "http://example.com:4317", "file:///tmp/a", "javascript:1",
    "http://127.0.0.1:4317\n", " http://127.0.0.1:4317"
}) Check(DesktopPolicy.ConfigurationUrl(invalid) is null, "reject unsafe address");
foreach (var valid in new[] { "http://127.0.0.1:4317/", "http://127.0.0.1:4317/admin", "http://127.0.0.1:4317/#manuals" })
    Check(DesktopPolicy.SameOrigin(valid, origin!), "same origin");
foreach (var invalid in new[] { "http://127.0.0.1:4318/", "https://127.0.0.1:4317/", "http://evil.test:4317/",
    "http://user:secret@127.0.0.1:4317/", "file:///tmp/a", "javascript:1" })
    Check(!DesktopPolicy.SameOrigin(invalid, origin!), "cross origin");
Check(DesktopPolicy.Readiness("{\"type\":\"configuration-ready\",\"url\":\"http://127.0.0.1:4317\"}") is not null,
    "valid readiness");
foreach (var invalid in new[] { "{}", "[]", "null", "invalid", new string('x', 4097),
    "{\"type\":\"configuration-ready\",\"url\":\"http://evil.test:4317\"}",
    "{\"type\":\"configuration-ready\",\"url\":\"http://127.0.0.1:4317\",\"token\":\"secret\"}",
    "{\"type\":\"execute\",\"url\":\"http://127.0.0.1:4317\"}",
    "{\"type\":\"configuration-ready\",\"url\":3}",
    "{\"type\":\"configuration-ready\",\"url\":\"http://127.0.0.1:4317\",\"url\":\"http://evil.test:4317\"}"
}) Check(DesktopPolicy.Readiness(invalid) is null, "reject malformed readiness");
Check(DesktopPolicy.Readiness("{\"url\":\"http://127.0.0.1:4317\",\"type\":\"configuration-ready\"}") is not null, "alternate key order");
Check(DesktopPolicy.Readiness("{\"u\\u0072l\":\"http://127.0.0.1:4317\",\"type\":\"configuration-ready\"}") is not null, "JSON string decoding");
Check(DesktopPolicy.Readiness("{\"url\":\"http://127.0.0.1:4317\",\"url\":\"http://127.0.0.1:4317\"}") is null, "duplicate keys");
Console.WriteLine("Desktop URL and readiness policy tests passed.");

static Process Child(string mode)
{
    var start = new ProcessStartInfo(Process.GetCurrentProcess().MainModule!.FileName)
    {
        Arguments = mode, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
    };
    return Process.Start(start)!;
}

using (var child = Child("--child-eof"))
{
    Check(await DesktopProcess.ReadBoundedLineAsync(child.StandardOutput, CancellationToken.None) == "ready", "ready line");
    await DesktopProcess.StopOwnedAsync(child, 3000);
    Check(child.HasExited && child.ExitCode == 0, "EOF exits owned child");
    await DesktopProcess.WaitForExitAsync(child, CancellationToken.None);
}
using (var child = Child("--child-stall"))
{
    var watch = Stopwatch.StartNew();
    using (var cancel = new CancellationTokenSource(100))
    {
        var cancelled = false;
        try { await DesktopProcess.ReadBoundedLineAsync(child.StandardOutput, cancel.Token); }
        catch (OperationCanceledException) { cancelled = true; }
        Check(cancelled && watch.ElapsedMilliseconds < 5000, "pending read cancellation is bounded");
    }
    await DesktopProcess.StopOwnedAsync(child, 100);
    Check(child.HasExited, "stalled owned child terminated");
}
foreach (var input in new[] { "incomplete", new string('x', 4096) })
{
    using var reader = new StreamReader(new MemoryStream(Encoding.UTF8.GetBytes(input)));
    var rejected = false;
    try { await DesktopProcess.ReadBoundedLineAsync(reader, CancellationToken.None); }
    catch (InvalidOperationException) { rejected = true; }
    Check(rejected, "EOF and oversized frame reject");
}
Console.WriteLine("Desktop net48 policy and process lifecycle tests passed.");

internal static class NativeArchitecture
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    internal static extern bool IsWow64Process2(IntPtr process, out ushort machine, out ushort native);
}
