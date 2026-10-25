#if ABILOCK_DESKTOP_TEST_FIXTURE
using System.Diagnostics;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;

namespace Abilock.Desktop;

internal static class DesktopFixtureVerification
{
    internal static readonly string Root = Path.GetFullPath(Environment.GetEnvironmentVariable("ABILOCK_FIXTURE_ROOT")
        ?? Path.Combine(Path.GetTempPath(), "AbilockDesktopBuild-20261014"));
    internal static readonly string Directory = Path.Combine(Root, "net48-results");
    [DllImport("kernel32.dll")] private static extern bool IsWow64Process2(IntPtr process, out ushort machine, out ushort native);

    internal static bool Initialize()
    {
        if (File.ReadAllText(Path.Combine(Root, "abilock-desktop-build.marker")) != "Abilock desktop build 20261014")
            return false;
        System.IO.Directory.CreateDirectory(Directory);
        foreach (var name in new[] { "window-failed.txt", "window-loaded.txt", "window-exception.txt", "window-browser-pid.txt", "window-dpi.txt",
            "fixture-started.json", "fixture-stopped.txt", "smoke-report.json" })
            File.Delete(Path.Combine(Directory, name));
        return true;
    }

    private static bool Exited(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return process.HasExited || process.WaitForExit(5000);
        }
        catch (ArgumentException) { return true; }
    }

    internal static void WriteReport()
    {
        bool loaded = File.Exists(Path.Combine(Directory, "window-loaded.txt")) &&
            File.ReadAllText(Path.Combine(Directory, "window-loaded.txt")) == "loaded";
        bool workerExited = false, browserExited = false;
        if (File.Exists(Path.Combine(Directory, "fixture-started.json")))
        {
            var document = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Directory, "fixture-started.json")));
            workerExited = File.Exists(Path.Combine(Directory, "fixture-stopped.txt")) &&
                Exited(Convert.ToInt32(document["processId"], System.Globalization.CultureInfo.InvariantCulture));
        }
        if (File.Exists(Path.Combine(Directory, "window-browser-pid.txt")))
            browserExited = Exited(int.Parse(File.ReadAllText(Path.Combine(Directory, "window-browser-pid.txt")),
                System.Globalization.CultureInfo.InvariantCulture));
        using var current = Process.GetCurrentProcess();
        if (!IsWow64Process2(current.Handle, out var processMachine, out var nativeMachine))
            throw new InvalidOperationException("Architecture query failed.");
        File.WriteAllText(Path.Combine(Directory, "smoke-report.json"), new JavaScriptSerializer().Serialize(new
        {
            framework = "net48",
            buildVersion = "2.2.0-net48",
            processBits = IntPtr.Size * 8,
            processMachine = processMachine == 0 ? nativeMachine : processMachine,
            nativeMachine,
            dpi = File.Exists(Path.Combine(Directory, "window-dpi.txt")) ? File.ReadAllText(Path.Combine(Directory, "window-dpi.txt")) : null,
            fixtureOnly = true,
            pageLoaded = loaded,
            workerExited,
            browserExited,
            passed = loaded && workerExited && browserExited,
            completedUtc = DateTime.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture)
        }));
    }
}
#endif
