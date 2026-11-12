# Desktop application

The desktop window and `abl` use the same stored connections and manuals. The window starts a temporary management session when opened; closing it ends only that session. Independent CLI calls continue normally and exit when their work finishes. There is no login item, background service, or hidden tray process.

## macOS

`Abilock.app` uses AppKit and the system WKWebView. Its only subprocess is the fixed protected `/usr/local/libexec/abilock/launch config` entry. The shell reads a bounded public readiness record and accepts only `http://127.0.0.1:PORT/` on a non-privileged port. It does not accept a URL or executable path from command-line arguments or environment variables.

Navigation stays on that exact origin. New windows, downloads, native script bridges, and persistent browser storage are disabled. The shell cannot read private configuration or the credential store. Credentials are entered in the existing authenticated management page.

The unified installer prepares the protected runtime before opening the app. A standalone app without that runtime stops and requests installation. Closing the app closes its own input pipe, then signals only its own launcher if graceful shutdown needs assistance. A crashed app also closes that pipe; the configuration worker exits on EOF.

Command-W, File > Close Window, and the red window button close the window immediately using the standard AppKit close action. No hold gesture or close hint is required. Closing the last window follows the owned-session shutdown path described above.

The page fills the whole window under a transparent title bar, so the sidebar reaches the top edge beside the window buttons. A native strip the height of the title bar stays above the page and keeps the standard drag and double-click behaviour; it draws nothing and exchanges nothing with the page. The shell appends `AbilockDesktop` to the WKWebView user agent, and the page uses that public marker only to leave room for the window buttons. It is not a bridge and grants nothing.

Build on macOS with `node scripts/build-desktop.mjs`. The output is a universal arm64/x86_64 app in `artifacts/desktop/Abilock.app`, supporting macOS 13 or later. The local build has an ad-hoc signature; public distribution still requires the publisher's Developer ID signing and notarization. Compilation and policy tests do not substitute for an interactive desktop acceptance run.

## Windows

The Windows window uses the system .NET Framework and Microsoft Edge WebView2 Evergreen runtime. It targets `net48`: x64 requires Framework 4.8, and native ARM64 requires Framework 4.8.1. It starts only `%ProgramFiles%\Abilock\Abilock.Host.exe client config` and follows the same bounded readiness and EOF lifecycle as macOS. It has no elevated execution level, credential parameters, native JavaScript bridge, or alternative browser fallback. Missing WebView2 stops the application with an English installation message.

Navigation and resource requests are restricted to the child's exact loopback origin. New windows, downloads, web messages, native host objects, autofill, password saving, and device permission requests are disabled. Each window uses an InPrivate profile in a unique app-owned directory. On close, it releases that profile and closes its own client's input pipe; the protected host owns worker cleanup. Other CLI clients are not enumerated or terminated.

Build on Windows using `native/desktop/windows/Build.ps1 -Runtime win-x64` or `-Runtime win-arm64`. The script uses PowerShell 5.1-compatible syntax, including PowerShell 7.6; its source and messages are ASCII English. The output is an `Abilock.exe` directory, intended for the unified installer under `%ProgramFiles%\Abilock\desktop`. It reuses the Framework already required by the protected host and does not bundle a second .NET runtime. WebView2 SDK `1.0.3800.47` and build-only Framework reference assemblies `1.0.3` are pinned to official NuGet packages. The .NET SDK is a development tool, not a user installation requirement.

`Build.ps1` reads the version from the root package metadata; outside the repository, pass `-Version` explicitly. Dependency restore uses the committed NuGet lockfile, covering both Windows architectures. The WinForms build removes the SDK's unused WPF reference. The complete Windows product targets Windows 10 x64 and Windows 11 x64/ARM64; PowerShell compatibility does not imply support for every historical Windows version.

The x64 app targets x64. The ARM64 package uses AnyCPU with `Prefer32Bit=false`, allowing Framework 4.8.1 to run it natively on ARM64; both entry points reject a 32-bit process. Per-monitor DPI awareness is enabled through the Framework configuration. Readiness parsing is bounded and rejects duplicate or extra properties. Process waiting and cancellation use Framework-compatible primitives, with tests for EOF, malformed responses, cancellation, and termination of only the owned client.

## Synthetic desktop verification

`node scripts/build-desktop-fixture.mjs` prepares a separate macOS app under `/private/tmp/abilock-desktop-mac-fixture`. It uses a normal-user mock process and loopback HTML. The window remains visible for 20 seconds and then writes `smoke-report.json` after closing its worker.

The Windows fixture uses the separately compiled `ABILOCK_DESKTOP_TEST_FIXTURE` build under a dedicated, marked temporary directory selected by `ABILOCK_FIXTURE_ROOT` (defaulting to `AbilockDesktopBuild-20261014` inside the system temporary directory). `windows-tests/Prepare-Net48.ps1` prepares its own `fixture-desktop-net48` and fake host directories without starting a GUI. Open `Run-WindowSmoke-Net48.cmd` from the Windows interactive desktop; `Run-WindowSmoke.cmd` is the current compatibility entry. WebView2 cannot reliably create its window in an SSH session. The `net48-results/smoke-report.json` records the framework, build, process architecture, DPI, fake page, worker exit, and this window's WebView2 browser exit. The fixtures use no real host, vault, credentials, or system installation. Production builds do not define the fixture symbol or accept test overrides.

Run the fixture from an interactive desktop and inspect its own bounded report before claiming window loading or cleanup succeeded. A synthetic window lifecycle does not validate real credential configuration, UAC installation, the dedicated-account isolation boundary, or every Windows version. Current platform acceptance limits are stated in the [README](../README.md).

References: [Microsoft WebView2 distribution](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution), [WebView2 InPrivate controller options](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.winforms.corewebview2creationproperties.isinprivatemodeenabled), [pinned SDK package](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3800.47).

The Windows installer registers the Start menu shortcut, CLI user PATH and Skills only for the original installation owner. Unknown same-name shortcuts or Skills stop before UAC; registration rechecks them under the ordinary owner token. No all-user shortcut or machine PATH entry is added.
