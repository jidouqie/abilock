using System.Diagnostics;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Abilock.Desktop;

internal static class Program
{
    [STAThread]
    private static int Main(string[] arguments)
    {
        if (arguments.Length != 0 || !Environment.Is64BitProcess) return 78;
#if ABILOCK_DESKTOP_TEST_FIXTURE
        if (!DesktopFixtureVerification.Initialize()) return 78;
        const string mutexName = "Local\\Abilock.Desktop.Fixture";
#else
        const string mutexName = "Local\\Abilock.Desktop";
#endif
        // WebView2 otherwise accepts caller-supplied browser executables and
        // remote-debugging flags. The app only uses the installed runtime.
        foreach (var name in new[] { "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", "WEBVIEW2_USER_DATA_FOLDER",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
            "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER" })
            Environment.SetEnvironmentVariable(name, null);
        using var instance = new Mutex(true, mutexName, out var firstInstance);
        if (!firstInstance)
        {
            MessageBox.Show("Abilock is already open.", "Abilock", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new AbilockWindow());
        instance.ReleaseMutex();
#if ABILOCK_DESKTOP_TEST_FIXTURE
        DesktopFixtureVerification.WriteReport();
#endif
        return 0;
    }
}

internal sealed class AbilockWindow : Form
{
    private readonly CancellationTokenSource lifetime = new();
    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };
    private readonly Label loading = new() { Text = "Opening Abilock...", AutoSize = true, Location = new(24, 24) };
    private Process? configuration;
    private Uri? origin;
    private bool stopping;
    private bool stopped;
    private bool failureShown;
    private string? profileDirectory;

    internal AbilockWindow()
    {
        Text = "Abilock";
        ClientSize = new(1120, 760);
        MinimumSize = new(760, 540);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleDimensions = new System.Drawing.SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Controls.Add(loading);
        Shown += async (_, _) => await StartAsync();
        FormClosing += ClosingAsync;
    }

    private async Task StartAsync()
    {
        try
        {
            // WebView2 Evergreen is a system prerequisite. Missing WebView2
            // never opens a browser or changes the credential isolation mode.
            _ = CoreWebView2Environment.GetAvailableBrowserVersionString();
#if ABILOCK_DESKTOP_TEST_FIXTURE
            profileDirectory = Path.Combine(DesktopFixtureVerification.Directory, "profiles", Guid.NewGuid().ToString("N"));
#else
            profileDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Abilock", "WebView", Guid.NewGuid().ToString("N"));
#endif
            webView.CreationProperties = new CoreWebView2CreationProperties
            {
                UserDataFolder = profileDirectory,
                IsInPrivateModeEnabled = true,
                ProfileName = "Abilock"
            };
            Controls.Add(webView);
            webView.CreateControl();
            _ = webView.Handle;
            await webView.EnsureCoreWebView2Async();
            if (stopping) return;
            ConfigureWebView();

#if ABILOCK_DESKTOP_TEST_FIXTURE
            var executable = Path.Combine(DesktopFixtureVerification.Root, "fixture-net48", "Abilock.Host.exe");
#else
            var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Abilock", "Abilock.Host.exe");
#endif
            if (!File.Exists(executable))
                throw new InvalidOperationException("INSTALL_REQUIRED");
            var start = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = Path.GetDirectoryName(executable)!
            };
            start.Arguments = "client config";
            var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            start.EnvironmentVariables.Clear();
            start.EnvironmentVariables["SystemRoot"] = windows;
            start.EnvironmentVariables["SystemDrive"] = Path.GetPathRoot(windows)!.TrimEnd('\\');
            start.EnvironmentVariables["WINDIR"] = windows;
            start.EnvironmentVariables["PATH"] = Path.Combine(windows, "System32");
            start.EnvironmentVariables["TEMP"] = Path.GetTempPath();
            start.EnvironmentVariables["TMP"] = Path.GetTempPath();
#if ABILOCK_DESKTOP_TEST_FIXTURE
            start.EnvironmentVariables["ABILOCK_FIXTURE_ROOT"] = DesktopFixtureVerification.Root;
#endif
            configuration = Process.Start(start) ?? throw new InvalidOperationException("START_FAILED");
            _ = DiscardErrorsAsync(configuration.StandardError);
            _ = WatchConfigurationAsync(configuration);
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            startup.CancelAfter(TimeSpan.FromSeconds(30));
            var line = await DesktopProcess.ReadBoundedLineAsync(configuration.StandardOutput, startup.Token);
            origin = DesktopPolicy.Readiness(line) ?? throw new InvalidOperationException("INVALID_READY");
            if (stopping) return;
            loading.Visible = false;
            webView.BringToFront();
            webView.CoreWebView2.Navigate(origin.AbsoluteUri);
#if ABILOCK_DESKTOP_TEST_FIXTURE
            webView.CoreWebView2.NavigationCompleted += async (_, loaded) =>
            {
                File.WriteAllText(Path.Combine(DesktopFixtureVerification.Directory, "window-loaded.txt"),
                    loaded.IsSuccess ? "loaded" : "failed");
                await Task.Delay(20000);
                Close();
            };
#endif
        }
        catch (OperationCanceledException) when (stopping) { }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowFailure("Microsoft Edge WebView2 Runtime is required. Install it from Microsoft, then reopen Abilock.");
        }
        catch (Exception error)
        {
#if ABILOCK_DESKTOP_TEST_FIXTURE
            File.WriteAllText(Path.Combine(DesktopFixtureVerification.Directory, "window-exception.txt"),
                error.GetType().FullName + "\n" + error.HResult + "\n" + error.Message + "\n" + error.StackTrace);
#else
            _ = error;
#endif
            if (!stopping)
                ShowFailure("Abilock could not open its configuration session. Close and reopen Abilock.");
        }
    }

    private void ConfigureWebView()
    {
        var core = webView.CoreWebView2;
#if ABILOCK_DESKTOP_TEST_FIXTURE
        File.WriteAllText(Path.Combine(DesktopFixtureVerification.Directory, "window-dpi.txt"), DeviceDpi.ToString(System.Globalization.CultureInfo.InvariantCulture));
        File.WriteAllText(Path.Combine(DesktopFixtureVerification.Directory, "window-browser-pid.txt"),
            core.BrowserProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
#endif
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.NavigationStarting += (_, request) =>
            request.Cancel = stopping || origin is null || !DesktopPolicy.SameOrigin(request.Uri, origin);
        core.FrameNavigationStarting += (_, request) =>
            request.Cancel = stopping || origin is null || !DesktopPolicy.SameOrigin(request.Uri, origin);
        core.NewWindowRequested += (_, request) => request.Handled = true;
        core.DownloadStarting += (_, request) => request.Cancel = true;
        core.PermissionRequested += (_, request) => request.State = CoreWebView2PermissionState.Deny;
        core.ProcessFailed += (_, _) => ShowFailure("The window stopped responding. Close and reopen Abilock.");
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, request) =>
        {
            if (stopping || origin is null || !DesktopPolicy.SameOrigin(request.Request.Uri, origin))
                request.Response = core.Environment.CreateWebResourceResponse(Stream.Null, 403, "Forbidden", "Content-Type: text/plain");
        };
    }

    private static async Task DiscardErrorsAsync(StreamReader errors)
    {
        try
        {
            var buffer = new char[1024];
            while (await errors.ReadAsync(buffer, 0, buffer.Length) != 0) { }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    private async Task WatchConfigurationAsync(Process child)
    {
        try { await DesktopProcess.WaitForExitAsync(child, lifetime.Token); }
        catch (OperationCanceledException) { return; }
        catch (InvalidOperationException) { return; }
        if (!stopping) ShowFailure("The configuration session ended. Close and reopen Abilock.");
    }

    private void ShowFailure(string message)
    {
        if (stopping || failureShown) return;
        failureShown = true;
        // An error dialog must not leave its configuration worker waiting for
        // user acknowledgement. EOF starts the protected host's cleanup now.
        try { configuration?.StandardInput.Close(); }
        catch (InvalidOperationException) { }
        catch (IOException) { }
#if ABILOCK_DESKTOP_TEST_FIXTURE
        File.WriteAllText(Path.Combine(DesktopFixtureVerification.Directory, "window-failed.txt"), message);
#else
        MessageBox.Show(this, message, "Abilock", MessageBoxButtons.OK, MessageBoxIcon.Error);
#endif
        Close();
    }

    private async void ClosingAsync(object? sender, FormClosingEventArgs args)
    {
        if (stopped) return;
        args.Cancel = true;
        if (stopping) return;
        stopping = true;
        lifetime.Cancel();
        webView.Dispose();
        try
        {
            if (configuration is not null)
            {
                await DesktopProcess.StopOwnedAsync(configuration);
                configuration.Dispose();
            }
        }
        catch (InvalidOperationException) { }
        catch (IOException) { }
        catch (System.ComponentModel.Win32Exception) { }
        finally
        {
            // The in-private profile contains no persistent login. Remove only
            // this window's unique directory when WebView2 has released it.
            if (profileDirectory is not null)
                try { Directory.Delete(profileDirectory, recursive: true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            stopped = true;
            lifetime.Dispose();
            Close();
        }
    }
}
