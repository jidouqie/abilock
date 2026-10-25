#requires -Version 5.1
# ASCII-only installer. Compatible syntax: Windows PowerShell 5.1 and PowerShell 7.x.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BundlePath,
    [switch]$Check,
    [switch]$Elevated,
    [string]$OwnerSid,
    [string]$ManifestSha256,
    [string]$RepairFromBundle,
    [string]$RepairFromManifestSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
function Get-BootstrapFailureInfo([int]$Index) {
    $stages = @('environment','input','verify','initialize')
    $codes = @('CONFIG_REQUIRED','LOCAL_CONFIG_INVALID','CONFIG_BUSY','BOOTSTRAP_BUSY','PRIVATE_PATH_INVALID','LOCK_FAILED','ISOLATION_INVALID','BOOTSTRAP_FAILED')
    if ($Index -eq 33) { return [pscustomobject]@{ stage='response'; code='BOOTSTRAP_RESPONSE' } }
    if ($Index -lt 1 -or $Index -gt 32) { throw 'Unknown bootstrap failure index.' }
    return [pscustomobject]@{ stage=$stages[[int][Math]::Floor(($Index - 1) / 8)]; code=$codes[($Index - 1) % 8] }
}
function Get-BootstrapFailureIndex([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text) -or $Text.Length -gt 4096) { return 0 }
    $trimmed = $Text.Trim()
    if (-not $trimmed.StartsWith('{') -or -not $trimmed.EndsWith('}')) { return 0 }
    $keys = @([regex]::Matches($trimmed, '"(?<key>[^"\\]+)"\s*:') | ForEach-Object { $_.Groups['key'].Value } | Sort-Object)
    if (($keys -join ',') -cne 'code,event,ok,stage') { return 0 }
    try { $value = $Text | ConvertFrom-Json -ErrorAction Stop } catch { return 0 }
    if ($value -isnot [pscustomobject] -or (@($value.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'code,event,ok,stage' -or
        $value.ok -isnot [bool] -or $value.ok -or $value.event -isnot [string] -or $value.event -cne 'bootstrap-failed' -or $value.stage -isnot [string] -or $value.code -isnot [string]) { return 0 }
    for ($index = 1; $index -le 32; $index++) {
        $known = Get-BootstrapFailureInfo $index
        if ($value.stage -ceq $known.stage -and $value.code -ceq $known.code) { return $index }
    }
    return 0
}
function New-BootstrapFailure([int]$Index) {
    $null = Get-BootstrapFailureInfo $Index
    $failure = New-Object InvalidOperationException('The protected initialization response indicated failure.')
    $failure.Data['AbilockBootstrapFailure'] = $Index
    return $failure
}
function Get-InstallerFailureLine([int]$ExitCode) {
    if ($ExitCode -ge 200001 -and $ExitCode -le 265535) { return $ExitCode - 200000 }
    return 0
}
function Write-InstallerFailure([Management.Automation.ErrorRecord]$Failure) {
    $bootstrap = $Failure.Exception.Data['AbilockBootstrapFailure']
    if ($bootstrap -is [int] -and $bootstrap -ge 1 -and $bootstrap -le 33) {
        $known = Get-BootstrapFailureInfo $bootstrap
        [Console]::Error.WriteLine(('ABILOCK_BOOTSTRAP_FAILED stage={0} code={1}' -f $known.stage, $known.code))
        return 400000 + $bootstrap
    }
    $stage = $Failure.Exception.Data['AbilockNativeStage']
    if ($stage -is [int] -and $stage -ge 1 -and $stage -le 16) {
        [Console]::Error.WriteLine(('ABILOCK_INSTALL_FAILED native_stage={0}' -f $stage))
        return 300000 + $stage
    }
    $line = 0
    if ($Failure.InvocationInfo) { $line = [int]$Failure.InvocationInfo.ScriptLineNumber }
    if ($line -lt 1 -or $line -gt 65535) { $line = 0 }
    $exception = $Failure.Exception
    $type = $exception.GetType().FullName
    if ($type -notmatch '^[A-Za-z0-9_.+]{1,160}$') { $type = 'Exception' }
    [Console]::Error.WriteLine(('ABILOCK_INSTALL_FAILED line={0} type={1} hresult={2}' -f $line, $type, $exception.HResult))
    if ($line -gt 0) { return 200000 + $line }
    return 1
}
function Stop-InstallerChildFailure([int]$ExitCode) {
    if ($ExitCode -ge 400001 -and $ExitCode -le 400033) {
        $known = Get-BootstrapFailureInfo ($ExitCode - 400000)
        [Console]::Error.WriteLine(('ABILOCK_BOOTSTRAP_FAILED stage={0} code={1}. No private data was reset.' -f $known.stage, $known.code))
        exit $ExitCode
    }
    if ($ExitCode -ge 300001 -and $ExitCode -le 300016) {
        [Console]::Error.WriteLine(('ABILOCK_INSTALL_FAILED: The protected runtime stopped at stage {0}. No private data was reset.' -f ($ExitCode - 300000)))
        exit $ExitCode
    }
    $line = Get-InstallerFailureLine $ExitCode
    if ($line -gt 0) {
        [Console]::Error.WriteLine(('ABILOCK_INSTALL_FAILED: Installation stopped at line {0}. No private data was reset.' -f $line))
        exit $ExitCode
    }
    [Console]::Error.WriteLine('ABILOCK_INSTALL_FAILED: The installation process did not complete. No private data was reset.')
    exit 1
}
trap {
    # Do not serialize error messages, stack traces, requests or credentials.
    $failureExitCode = Write-InstallerFailure $_
    exit $failureExitCode
}
$utf8 = New-Object Text.UTF8Encoding($false)
$programParent = [Environment]::GetFolderPath('ProgramFiles')
$programRoot = Join-Path $programParent 'Abilock'
$dataParent = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Abilock'
$dataRoot = Join-Path $dataParent 'private'
$accountName = '_abilock'
$computerName = [Environment]::MachineName
$systemSid = 'S-1-5-18'
$administratorsSid = 'S-1-5-32-544'
$bundle = [IO.Path]::GetFullPath($BundlePath).TrimEnd('\')
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$administrator = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Assert-NoReparse([string]$Path) {
    $candidate = [IO.Path]::GetFullPath($Path)
    while ($candidate) {
        if (([IO.File]::GetAttributes($candidate) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not accepted.' }
        $parent = [IO.Path]::GetDirectoryName($candidate)
        if (-not $parent -or $parent -eq $candidate) { break }
        $candidate = $parent
    }
}
function Assert-DaclShape($Security) {
    $raw = if ($Security -is [Security.AccessControl.RawSecurityDescriptor]) { $Security } else { New-Object Security.AccessControl.RawSecurityDescriptor($Security.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) }
    if ($null -eq $raw.DiscretionaryAcl) { throw 'An unrestricted access-control list is not accepted.' }
    foreach ($ace in $raw.DiscretionaryAcl) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -notin @('AccessAllowed','AccessDenied')) { throw 'An unsupported access-control entry is not accepted.' }
    }
}
function Assert-ParentAcl([string]$Path) {
    $trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
    $allowed = @($systemSid, $administratorsSid, $trustedInstaller)
    $dangerous = [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor 0x50000000
    $candidate = [IO.Path]::GetFullPath($Path)
    while ($candidate) {
        Assert-NoReparse $candidate
        $acl = Get-Acl -LiteralPath $candidate
        Assert-DaclShape $acl
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'An installation parent has an unsafe owner.' }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
            if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $dangerous) -ne 0 -and $rule.IdentityReference.Value -notin $allowed) { throw 'An installation parent has unsafe delete or permission rights.' }
        }
        $parent = [IO.Path]::GetDirectoryName($candidate)
        if (-not $parent -or $parent -eq $candidate) { break }
        $candidate = $parent
    }
}
function Assert-Protected([string]$Path) {
    Assert-NoReparse $Path
    $acl = Get-Acl -LiteralPath $Path
    Assert-DaclShape $acl
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $systemSid -and $owner -ne $administratorsSid) { throw 'An existing installation is not administrator-owned.' }
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor 0x50000000
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writeMask) -ne 0 -and $rule.IdentityReference.Value -notin @($systemSid, $administratorsSid)) { throw 'An existing installation has unsafe write permissions.' }
    }
}
function Assert-Private([string]$Path, [string]$Sid) {
    Assert-NoReparse $Path
    $acl = Get-Acl -LiteralPath $Path
    Assert-DaclShape $acl
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($systemSid, $administratorsSid, $Sid)) { throw 'The private directory has an unexpected owner.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($systemSid, $administratorsSid, $Sid)) { throw 'The private directory has unsafe access permissions.' }
    }
}
function Set-ProtectedDirectory([string]$Path, [string[]]$Readers, [string]$Writer) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($administratorsSid)))
    foreach ($sid in @($systemSid, $administratorsSid)) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    foreach ($sid in $Readers) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    if ($Writer) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($Writer)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
    if (Test-Path -LiteralPath $Path) {
        Assert-Protected $Path
        Set-Acl -LiteralPath $Path -AclObject $acl
    } else {
        [AbilockInstallerSupport]::CreateProtectedDirectory($Path, $acl)
    }
    Assert-NoReparse $Path
}
function Write-Json([string]$Path, $Value) {
    # A fresh temporary name permits recovery after interruption. The native
    # helper creates its owner/DACL atomically before writing any bytes.
    [AbilockInstallerSupport]::WriteAtomicFile($Path, (($Value | ConvertTo-Json -Depth 12 -Compress) + "`n"))
}
function Write-PublicMetadata([string]$Path, $Value) {
    [AbilockInstallerSupport]::WritePublicMetadata($Path, (($Value | ConvertTo-Json -Depth 12 -Compress) + "`n"), $OwnerSid, $Value.serviceSid)
}
function Get-NativeWindowsPlatform {
    if (-not ('AbilockNativePlatform' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AbilockNativePlatform {
    [StructLayout(LayoutKind.Sequential)] private struct SystemInfo {
        public ushort Architecture, Reserved; public uint PageSize;
        public IntPtr MinimumAddress, MaximumAddress; public UIntPtr ProcessorMask;
        public uint ProcessorCount, ProcessorType, AllocationGranularity;
        public ushort ProcessorLevel, ProcessorRevision;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct VersionInfo {
        public uint Size, Major, Minor, Build, Platform;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string ServicePack;
    }
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
    [DllImport("kernel32.dll")] private static extern void GetNativeSystemInfo(out SystemInfo info);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int type, out IntPtr information, int length, out int returned);
    [DllImport("ntdll.dll", CharSet = CharSet.Unicode)] private static extern int RtlGetVersion(ref VersionInfo info);
    public static string Architecture() {
        try {
            ushort processMachine, nativeMachine;
            if (!IsWow64Process2(GetCurrentProcess(), out processMachine, out nativeMachine)) throw new Win32Exception();
            if (nativeMachine == 0x8664) return "x64";
            if (nativeMachine == 0xaa64) return "arm64";
            throw new InvalidOperationException("Unsupported Windows architecture.");
        } catch (EntryPointNotFoundException) {
            // Old x64 Windows only. ARM64 Windows provides IsWow64Process2;
            // GetNativeSystemInfo alone can report the emulated process type.
            SystemInfo info; GetNativeSystemInfo(out info);
            if (info.Architecture == 9) return "x64";
            if (info.Architecture == 12) return "arm64";
            throw new InvalidOperationException("Unsupported Windows architecture.");
        }
    }
    public static uint Build() {
        VersionInfo info = new VersionInfo(); info.Size = (uint)Marshal.SizeOf(typeof(VersionInfo));
        if (RtlGetVersion(ref info) != 0) throw new InvalidOperationException("Windows version detection failed.");
        return info.Build;
    }
    public static bool HasLimitedOwnerToken() {
        using (System.Security.Principal.WindowsIdentity current = System.Security.Principal.WindowsIdentity.GetCurrent()) {
            IntPtr token; int returned;
            if (!GetTokenInformation(current.Token, 19, out token, IntPtr.Size, out returned) || token == IntPtr.Zero) return false;
            try {
                using (System.Security.Principal.WindowsIdentity limited = new System.Security.Principal.WindowsIdentity(token))
                    return limited.User.Value == current.User.Value && !new System.Security.Principal.WindowsPrincipal(limited).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            } finally { CloseHandle(token); }
        }
    }
}
'@
    }
    return [pscustomobject]@{ architecture = [AbilockNativePlatform]::Architecture(); build = [AbilockNativePlatform]::Build() }
}
function Resolve-WindowsArchitecture([string]$Requested, [string]$Native, [int]$Build) {
    if ($Native -notin @('x64','arm64') -or $Build -lt 0) { throw 'The Windows system architecture could not be verified.' }
    if (-not $Requested -or $Requested -eq 'auto') { return $Native }
    if ($Requested -notin @('x64','arm64')) { throw 'The Windows bundle architecture is unsupported.' }
    if ($Requested -eq $Native) { return $Requested }
    if ($Requested -eq 'x64' -and $Native -eq 'arm64' -and $Build -ge 22000) { return $Requested }
    throw 'This bundle cannot run on this Windows architecture. Download the native x64 or arm64 bundle.'
}
function Get-FrameworkRelease {
    $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $key = $machine.OpenSubKey('SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', $false)
        if ($null -eq $key) { return 0 }
        try { $value = $key.GetValue('Release', 0); return [int]$value } finally { $key.Dispose() }
    } finally { $machine.Dispose() }
}
function Assert-WindowsPrerequisites([string]$Native, [int]$Build, [int]$FrameworkRelease) {
    if ($Native -eq 'arm64') {
        if ($Build -lt 22000) { throw 'Windows ARM64 requires Windows 11 or later.' }
        if ($FrameworkRelease -lt 533320) { throw 'Install Microsoft .NET Framework 4.8.1 before installing Abilock on Windows ARM64.' }
    } elseif ($Native -eq 'x64') {
        if ($Build -lt 10240) { throw 'Abilock requires Windows 10 or later.' }
        if ($FrameworkRelease -lt 528040) { throw 'Install Microsoft .NET Framework 4.8 before installing Abilock on Windows x64.' }
    } else { throw 'The Windows system architecture is unsupported.' }
}
function Assert-NonDowngrade([string]$Candidate, [string]$Installed) {
    $pattern = '^(\d+\.\d+\.\d+)(?:-([A-Za-z0-9.-]+))?(?:\+[A-Za-z0-9.-]+)?$'
    if ($Candidate -notmatch $pattern) { throw 'The candidate version is invalid.' }
    $candidateCore = [Version]$Matches[1]; $candidatePre = if ($Matches.ContainsKey(2)) { $Matches[2] } else { '' }
    if ($Installed -notmatch $pattern) { throw 'The installed version is invalid.' }
    $installedCore = [Version]$Matches[1]; $installedPre = if ($Matches.ContainsKey(2)) { $Matches[2] } else { '' }
    $order = $candidateCore.CompareTo($installedCore)
    if ($order -lt 0) { throw 'An older Abilock version cannot replace this installation.' }
    if ($order -gt 0 -or $candidatePre -ceq $installedPre -or -not $candidatePre) { return }
    if (-not $installedPre) { throw 'A prerelease cannot replace this stable installation.' }
    $left = $candidatePre.Split('.'); $right = $installedPre.Split('.')
    for ($index = 0; $index -lt [Math]::Min($left.Length, $right.Length); $index++) {
        if ($left[$index] -ceq $right[$index]) { continue }
        $aNumber = $left[$index] -match '^\d+$'; $bNumber = $right[$index] -match '^\d+$'
        if ($aNumber -and $bNumber) {
            $a = $left[$index].TrimStart('0'); $b = $right[$index].TrimStart('0')
            $order = $a.Length.CompareTo($b.Length); if ($order -eq 0) { $order = [string]::CompareOrdinal($a, $b) }
        } elseif ($aNumber) { $order = -1 } elseif ($bNumber) { $order = 1 } else { $order = [string]::CompareOrdinal($left[$index], $right[$index]) }
        if ($order -lt 0) { throw 'An older Abilock prerelease cannot replace this installation.' }; if ($order -gt 0) { return }
    }
    if ($left.Length -lt $right.Length) { throw 'An older Abilock prerelease cannot replace this installation.' }
}
function Test-DeferredRepairMetadata([Exception]$Exception, [bool]$Administrator, [bool]$Elevated, $Candidate, $Original) {
    if ($Administrator -or $Elevated -or -not $Original -or $Candidate.version -notin @('2.2.6','2.2.7') -or $Original.version -cne '2.2.3' -or $Candidate.architecture -cne $Original.architecture) { return $false }
    while ($Exception -is [Management.Automation.MethodInvocationException] -or $Exception -is [Reflection.TargetInvocationException]) {
        if (-not $Exception.InnerException) { return $false }
        $Exception = $Exception.InnerException
    }
    return $Exception -is [UnauthorizedAccessException] -and $Exception.HResult -eq -2147024891
}
function Get-BundleManifest([string]$Root, [string]$ExpectedHash, [switch]$SourceOnly) {
    Assert-NoReparse $Root
    $manifestPath = Join-Path $Root 'bundle-manifest.json'
    Assert-NoReparse $manifestPath
    if ((Get-Item -LiteralPath $manifestPath).Length -gt 20971520) { throw 'The bundle manifest is too large.' }
    $actualHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ExpectedHash -and $actualHash -cne $ExpectedHash) { throw 'The bundle changed after verification.' }
    $value = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($value.schema -ne 1 -or $value.platform -ne 'win32' -or $value.version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'The bundle manifest is invalid.' }
    if ($value.architecture -notin @('x64', 'arm64')) { throw 'The Windows bundle architecture is unsupported.' }
    $platform = Get-NativeWindowsPlatform
    $null = Resolve-WindowsArchitecture $value.architecture $platform.architecture $platform.build
    Assert-WindowsPrerequisites $platform.architecture $platform.build (Get-FrameworkRelease)
    $names = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $value.files) {
        if ($entry.path -isnot [string] -or [string]::IsNullOrWhiteSpace($entry.path) -or $entry.path -match '[\x00-\x1F<>:"\\|?*]' -or $entry.path.StartsWith('/') -or $entry.path.Contains('//') -or $entry.path -match '(^|/)\.\.?(/|$)' -or $entry.path -match '(^|/)(CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|/|$)' -or $entry.path -match '[ .](/|$)' -or -not $names.Add($entry.path) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'The bundle contains an unsafe path or hash.' }
        $file = Join-Path $Root $entry.path
        Assert-NoReparse $file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) { throw 'The bundle failed its integrity check.' }
    }
    $gitFlavor = if ($value.architecture -eq 'arm64') { 'clangarm64' } else { 'ucrt64' }
    foreach ($required in @('Abilock.Host.exe', 'Abilock.GitSsh.exe', 'node.exe', 'runtime/dist/src/windows-worker.js', 'runtime/bin/abl.mjs', 'runtime/bin/abl.cmd', 'runtime/package.json', 'runtime/request-limits.json', 'runtime/skills/abilock/SKILL.md', 'runtime/skills/abilock/assets/runtime-manifest.json', 'runtime/skills/abilock/assets/abilock-runtime.tgz', 'desktop/Abilock.exe', 'installer/InstallerSupport.cs', 'git/cmd/git.exe', 'git/usr/bin/sh.exe', ('git/' + $gitFlavor + '/bin/git-remote-http.exe'), ('git/' + $gitFlavor + '/libexec/git-core/git-sh-setup'))) {
        if (-not $names.Contains($required)) { throw 'The bundle is missing a required component.' }
    }
    $package = [IO.File]::ReadAllText((Join-Path $Root 'runtime\package.json')) | ConvertFrom-Json
    if ($package.version -cne $value.version) { throw 'The bundle version does not match the runtime.' }
    $skillPath = Join-Path $Root 'runtime\skills\abilock\SKILL.md'
    if ((Get-Item -LiteralPath $skillPath).Length -gt 65536) { throw 'The bundled skill is invalid.' }
    $skillText = [IO.File]::ReadAllText($skillPath)
    $front = [regex]::Match($skillText, '\A---\r?\n(?<header>[\s\S]*?)\r?\n---(?:\r?\n|\z)')
    if (-not $front.Success -or [regex]::Matches($front.Groups['header'].Value, '(?m)^name:[ \t]*(?:abilock|"abilock"|''abilock'')[ \t]*\r?$').Count -ne 1) { throw 'The bundled skill must declare name: abilock.' }
    $installedPath = Join-Path $programRoot 'windows-installation.json'
    if (-not $SourceOnly -and (Test-Path -LiteralPath $installedPath)) {
        try {
            Assert-Protected $installedPath
            if ((Get-Item -LiteralPath $installedPath).Length -gt 65536) { throw 'The installed version record is invalid.' }
            $installed = [IO.File]::ReadAllText($installedPath) | ConvertFrom-Json
            if ($installed.schema -ne 1 -or $installed.ownerSid -cne $OwnerSid -or $installed.account -cne $accountName) { throw 'The existing installation belongs to another user or is invalid.' }
            Assert-NonDowngrade $value.version $installed.version
        } catch {
            if (-not (Test-DeferredRepairMetadata $_.Exception $administrator $Elevated $value $repairManifest)) { throw }
            $script:metadataCheckDeferred = $true
        }
    }
    return $value
}
function Assert-Task($Task, [string]$Mode, [string]$Sid) {
    $definition = $Task.Definition
    $principal = $definition.Principal.UserId
    if ($principal -notmatch '^S-1-') { $principal = ([Security.Principal.NTAccount]$principal).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Path -ine (Join-Path $programRoot 'Abilock.Host.exe') -or $definition.Actions.Item(1).Arguments -cne ('worker ' + $Mode + ' $(Arg0)') -or $definition.Triggers.Count -ne 0 -or $principal -ine $Sid -or $definition.Principal.LogonType -ne 1 -or $definition.Settings.MultipleInstances -ne 0) { throw 'An existing scheduled task does not match the protected runtime.' }
    $security = New-Object Security.AccessControl.RawSecurityDescriptor($Task.GetSecurityDescriptor(7))
    Assert-DaclShape $security
    if ($security.Owner.Value -notin @($systemSid, $administratorsSid)) { throw 'An existing task has an unexpected owner.' }
    foreach ($ace in $security.DiscretionaryAcl) {
        if ($ace.AceType -ne 'AccessAllowed') { continue }
        if ($Mode -eq 'bootstrap' -and $ace.SecurityIdentifier.Value -notin @($systemSid, $administratorsSid)) { throw 'The initialization task is not private.' }
        if (($ace.AccessMask -band 0x500D0116) -ne 0 -and $ace.SecurityIdentifier.Value -notin @($systemSid, $administratorsSid)) { throw 'An existing task has unsafe write permissions.' }
    }
}
function Register-WorkerTask($Folder, [string]$Name, [string]$Mode, [string]$Sid, [string]$Password, [switch]$Private) {
    $definition = $script:scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = 'Abilock on-demand worker. No automatic triggers.'
    $definition.Principal.UserId = $Sid
    $definition.Principal.LogonType = 1
    $definition.Principal.RunLevel = 0
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.MultipleInstances = 0
    $definition.Settings.ExecutionTimeLimit = 'PT12H'
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.RunOnlyIfIdle = $false
    $definition.Settings.StartWhenAvailable = $false
    $action = $definition.Actions.Create(0)
    $action.Path = Join-Path $programRoot 'Abilock.Host.exe'
    $action.Arguments = 'worker ' + $Mode + ' $(Arg0)'
    $action.WorkingDirectory = Join-Path $programRoot 'runtime'
    $sddl = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'
    if (-not $Private) { $sddl += '(A;;GRGX;;;' + $OwnerSid + ')' }
    # TASK_CREATE | TASK_DONT_ADD_PRINCIPAL_ACE. A caller cannot alter the action.
    $registered = $Folder.RegisterTaskDefinition($Name, $definition, 18, $Sid, $Password, 1, $sddl)
    Assert-Task $registered $Mode $Sid
}
function Register-OwnerSkills {
    if ($currentSid -cne $OwnerSid) { throw 'Skill registration must run in the original user account.' }
    & (Join-Path $programRoot 'Abilock.Host.exe') register-skills
    if ($LASTEXITCODE -ne 0) { throw 'Abilock is installed, but user entry registration did not complete. Run the protected host register-skills command from a normal terminal in the original user account.' }
}
function Assert-OwnerRegistrationPaths([string]$Profile, [string]$Programs) {
    Assert-NoReparse $profile
    foreach ($tool in @('.codex', '.claude')) {
        $directory = Join-Path $profile $tool
        foreach ($part in @('', 'skills', 'skills\abilock', 'abilock-skill-backups')) {
            $candidate = if ($part) { Join-Path $directory $part } else { $directory }
            if (Test-Path -LiteralPath $candidate) {
                Assert-NoReparse $candidate
                if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { throw 'A user registration directory is occupied by an unknown file.' }
            }
        }
        $skill = Join-Path $directory 'skills\abilock'
        if (Test-Path -LiteralPath $skill) {
            $file = Join-Path $skill 'SKILL.md'; Assert-NoReparse $file
            if ((Get-Item -LiteralPath $file).Length -gt 65536) { throw 'An unrelated skill already uses the Abilock name.' }
            $front = [regex]::Match([IO.File]::ReadAllText($file), '\A---\r?\n(?<header>[\s\S]*?)\r?\n---(?:\r?\n|\z)')
            if (-not $front.Success -or [regex]::Matches($front.Groups['header'].Value, '(?m)^name:[ \t]*(?:abilock|"abilock"|''abilock'')[ \t]*\r?$').Count -ne 1) { throw 'An unrelated skill already uses the Abilock name.' }
        }
    }
    Assert-NoReparse $programs
    $shortcutPath = Join-Path $programs 'Abilock.lnk'
    if (Test-Path -LiteralPath $shortcutPath) {
        Assert-NoReparse $shortcutPath
        if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf) -or (Get-Item -LiteralPath $shortcutPath).Length -gt 65536) { throw 'An unknown Abilock shortcut already exists.' }
        $shell = $null; $shortcut = $null
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($shortcutPath)
            if ($shortcut.TargetPath -ine (Join-Path $programRoot 'desktop\Abilock.exe') -or $shortcut.Arguments -or $shortcut.WorkingDirectory -ine (Join-Path $programRoot 'desktop')) { throw 'An unknown Abilock shortcut already exists.' }
        } finally {
            foreach ($item in @($shortcut, $shell)) { if ($item -and [Runtime.InteropServices.Marshal]::IsComObject($item)) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($item) | Out-Null } }
        }
    }
}
function Assert-OwnerRegistration {
    # Inspect only the calling owner's public entries, before requesting UAC.
    # The elevated child leaves these entries to the original user process.
    if ($Elevated -or $currentSid -cne $OwnerSid) { return }
    if ($administrator -and -not [AbilockNativePlatform]::HasLimitedOwnerToken()) { throw 'Run installation from the original user desktop terminal; no ordinary user token is available in this session.' }
    Assert-OwnerRegistrationPaths ([Environment]::GetFolderPath('UserProfile')) ([Environment]::GetFolderPath('Programs'))
    $users = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::Users, [Microsoft.Win32.RegistryView]::Default)
    try {
        $environment = $users.OpenSubKey(($currentSid + '\Environment'), $false)
        if ($environment) {
            try {
                $path = $environment.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                if ($null -ne $path -and ($path -isnot [string] -or $environment.GetValueKind('Path') -notin @('String', 'ExpandString') -or $path.Length -gt 32700 -or $path.IndexOf([char]0) -ge 0)) { throw 'The user PATH value cannot be safely updated.' }
                if ($path) {
                    $bin = Join-Path $programRoot 'runtime\bin'
                    $present = @($path.Split(';') | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -ieq $bin }).Count -ne 0
                    if (-not $present -and $path.Length + 1 + $bin.Length -gt 32700) { throw 'The user PATH value is too long to extend.' }
                }
            } finally { $environment.Dispose() }
        }
    } finally { $users.Dispose() }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) { throw 'Abilock requires 64-bit Windows and 64-bit PowerShell.' }
if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'Use Windows PowerShell 5.1 or PowerShell 7.x.' }
if (-not $OwnerSid) { $OwnerSid = $currentSid }
if ($OwnerSid -notmatch '^S-1-5-21-[0-9-]+$') { throw 'The installation owner SID is invalid.' }
if (-not $Elevated -and $OwnerSid -cne $currentSid) { throw 'The installation owner must be the current user.' }
$repairBundle = $null; $repairManifest = $null; $metadataCheckDeferred = $false
if ([bool]$RepairFromBundle -ne [bool]$RepairFromManifestSha256) { throw 'Pending repair requires the original bundle and its exact manifest hash.' }
if ($RepairFromBundle) {
    if ($RepairFromManifestSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Pending repair requires the exact original manifest hash.' }
    $repairBundle = [IO.Path]::GetFullPath($RepairFromBundle).TrimEnd('\')
    $repairManifest = Get-BundleManifest $repairBundle $RepairFromManifestSha256 -SourceOnly
    if ($repairManifest.version -notin @('2.2.3','2.2.6')) { throw 'The pending repair source must be the original 2.2.3 or interrupted 2.2.6 bundle.' }
}
$manifest = Get-BundleManifest $bundle $ManifestSha256
$manifestHash = (Get-FileHash -LiteralPath (Join-Path $bundle 'bundle-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($repairManifest -and ($manifest.version -cne '2.2.7' -or $repairManifest.architecture -cne $manifest.architecture)) { throw 'This pending repair requires the verified 2.2.7 fix for the original architecture.' }
Assert-ParentAcl $programParent
Assert-ParentAcl ([IO.Path]::GetDirectoryName($dataParent))
if ($metadataCheckDeferred) { Write-Output 'Bundle verified. The legacy installation metadata requires administrator validation before repair. No system changes were made.' }
if ($Check) { if (-not $metadataCheckDeferred) { Write-Output 'Abilock Windows bundle verified. No system changes were made.' }; exit 0 }
Assert-OwnerRegistration
if (-not $administrator) {
    if ($Elevated) { throw 'Administrator authorization was not granted.' }
    # One UAC prompt. Always use the system Windows PowerShell host for elevation.
    $powershell = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
    foreach ($argument in @($PSCommandPath, $bundle, $repairBundle)) { if ($argument -and ($argument.Contains('"') -or $argument.Contains("`r") -or $argument.Contains("`n"))) { throw 'The installation path is invalid.' } }
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -BundlePath "' + $bundle + '" -OwnerSid ' + $OwnerSid + ' -ManifestSha256 ' + $manifestHash + ' -Elevated'
    if ($repairBundle) { $arguments += ' -RepairFromBundle "' + $repairBundle + '" -RepairFromManifestSha256 ' + $RepairFromManifestSha256 }
    $child = Start-Process -FilePath $powershell -ArgumentList $arguments -Verb RunAs -PassThru -Wait
    if ($child.ExitCode -ne 0) { Stop-InstallerChildFailure $child.ExitCode }
    Register-OwnerSkills
    Write-Output 'Abilock installation completed.'
    exit 0
}

# PowerShell 7.x accepts and preflights the same script. System mutations run
# under the in-box 5.1 host so WinForms and ADSI use their supported framework.
# An already-elevated caller does not receive another UAC prompt.
if ($PSVersionTable.PSEdition -ne 'Desktop') {
    $powershell = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
    foreach ($argument in @($PSCommandPath, $bundle, $repairBundle)) { if ($argument -and ($argument.Contains('"') -or $argument.Contains("`r") -or $argument.Contains("`n"))) { throw 'The installation path is invalid.' } }
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -BundlePath "' + $bundle + '" -OwnerSid ' + $OwnerSid + ' -ManifestSha256 ' + $manifestHash + ' -Elevated'
    if ($repairBundle) { $arguments += ' -RepairFromBundle "' + $repairBundle + '" -RepairFromManifestSha256 ' + $RepairFromManifestSha256 }
    $child = Start-Process -FilePath $powershell -ArgumentList $arguments -PassThru -Wait -NoNewWindow
    if ($child.ExitCode -ne 0) { Stop-InstallerChildFailure $child.ExitCode }
    if (-not $Elevated) { Register-OwnerSkills }
    exit 0
}

# Compile the exact bytes whose hash was approved, while the source handle
# denies writers/deletion. Add-Type -Path would reopen a mutable source path.
$supportSource = Join-Path $bundle 'installer\InstallerSupport.cs'
$supportEntry = @($manifest.files | Where-Object { $_.path -ceq 'installer/InstallerSupport.cs' })
if ($supportEntry.Count -ne 1) { throw 'The installer support manifest is invalid.' }
$sourceStream = New-Object IO.FileStream($supportSource, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    if ($sourceStream.Length -gt 1048576) { throw 'The installer support source is too large.' }
    $memory = New-Object IO.MemoryStream
    try { $sourceStream.CopyTo($memory); $sourceBytes = $memory.ToArray() } finally { $memory.Dispose() }
    $digest = [Security.Cryptography.SHA256]::Create()
    try { $sourceHash = ([BitConverter]::ToString($digest.ComputeHash($sourceBytes))).Replace('-', '').ToLowerInvariant() } finally { $digest.Dispose() }
    if ($sourceHash -cne $supportEntry[0].sha256) { throw 'The installer support source changed after verification.' }
    $sourceText = (New-Object Text.UTF8Encoding($false, $true)).GetString($sourceBytes)
    Add-Type -TypeDefinition $sourceText -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Security
} finally { $sourceStream.Dispose(); $sourceText = $null; $sourceBytes = $null }

function Read-PublicJson([string]$Path) {
    Assert-Protected $Path
    if ((Get-Item -LiteralPath $Path).Length -gt 65536) { throw 'Installation metadata is invalid.' }
    return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}
function Assert-Initialized($Record, [string]$Sid) {
    if ($Record.schema -ne 1 -or -not $Record.initialized -or $Record.ownerSid -cne $OwnerSid -or $Record.serviceSid -cne $Sid) { throw 'The initialization receipt is invalid.' }
}
function Get-DedicatedAccount {
    $computer = [ADSI]('WinNT://' + $computerName + ',computer')
    foreach ($entry in $computer.Children) { if ($entry.SchemaClassName -eq 'User' -and $entry.Name -eq $accountName) { return $entry } }
    return $null
}
function Assert-Account($Journal, $Account) {
    if (-not $Account -or [string]$Account.Description -cne ('Abilock dedicated account ' + $Journal.nonce)) { throw 'The reserved account does not belong to this transaction.' }
    $sid = ([Security.Principal.NTAccount]($computerName + '\' + $accountName)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($Journal.serviceSid -and $Journal.serviceSid -cne $sid) { throw 'The protected account identity changed.' }
    return $sid
}
function Get-RecoveryAction($Journal, [bool]$ProgramExists, [bool]$ReceiptExists, [bool]$AccountExists) {
    # Pure decision function; tests exercise each durable interruption boundary.
    if ($Journal.schema -ne 2 -or $Journal.nonce -notmatch '^[a-f0-9]{32}$' -or
        $Journal.phase -notin @('prepared','account-created','new-active','initialized','old-moved','committed','rolled-back')) { throw 'The installation journal is invalid.' }
    if ($Journal.existing) { return 'recover-upgrade' }
    if ($ReceiptExists -and (-not $ProgramExists -or -not $AccountExists)) { throw 'The completed installation identity is missing.' }
    if ($Journal.serviceSid -and -not $AccountExists) { throw 'The transaction account is missing.' }
    if ($ReceiptExists) { return 'finish-fresh' }
    return 'resume-fresh'
}
function Assert-PublicBundle([string]$Root) {
    Assert-PublicBundleManifest $Root $manifest
}
function Assert-PublicBundleManifest([string]$Root, $Expected) {
    Assert-Protected $Root
    foreach ($entry in $Expected.files) {
        $file = Join-Path $Root $entry.path
        Assert-Protected $file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) { throw 'An interrupted public program does not match its verified bundle.' }
    }
}
function Get-PendingRepairAction($Journal, [string]$OriginalHash, [string]$ReplacementHash, [bool]$ProgramExists, [bool]$BackupExists, [bool]$ReceiptExists) {
    if ($Journal.schema -ne 2 -or $Journal.existing -isnot [bool] -or $Journal.existing -or $Journal.ownerSid -cne $OwnerSid -or
        $Journal.nonce -cnotmatch '^[a-f0-9]{32}$' -or $Journal.serviceSid -cnotmatch '^S-1-5-21-[0-9-]+$' -or $Journal.serviceSid -ceq $OwnerSid -or
        $OriginalHash -cnotmatch '^[a-f0-9]{64}$' -or $ReplacementHash -cnotmatch '^[a-f0-9]{64}$' -or $OriginalHash -ceq $ReplacementHash) { throw 'The pending repair identity is invalid.' }
    if ($Journal.bundleHash -ceq $OriginalHash) {
        if ($Journal.phase -cne 'new-active' -or $ReceiptExists -or $ProgramExists -eq $BackupExists) { throw 'The original pending installation is not at the supported repair boundary.' }
        if ($ProgramExists) { return 'move-public' }
        return 'switch-journal'
    }
    if ($Journal.bundleHash -ceq $ReplacementHash) {
        $source = $Journal.PSObject.Properties['repairSourceBundleHash']
        if (-not $source -or $source.Value -cne $OriginalHash -or $Journal.phase -notin @('account-created','new-active','initialized','committed') -or
            ($ReceiptExists -and -not $ProgramExists) -or ($Journal.phase -in @('initialized','committed') -and -not $ReceiptExists) -or
            (-not $BackupExists -and ($Journal.phase -cne 'committed' -or -not $ReceiptExists))) { throw 'The replacement repair record is invalid.' }
        return 'resume-repaired'
    }
    throw 'The pending repair bundle does not match either verified release.'
}
function Get-ResumeInstallationPhase($Journal, [bool]$Initialized, [string]$Next) {
    if ($Initialized -and $Journal.phase -ceq 'committed') { return 'committed' }
    if ($Initialized -and $Journal.phase -ceq 'initialized' -and $Next -in @('account-created','new-active')) { return 'initialized' }
    return $Next
}
function Assert-RepairPublicTree([string]$Root, $Expected, $Journal) {
    Assert-PublicBundleManifest $Root $Expected
    $metadata = Read-PublicJson (Join-Path $Root 'windows-installation.json')
    $marker = Read-PublicJson (Join-Path $Root '.installation-transaction.json')
    if ($metadata.schema -ne 1 -or $metadata.version -cne $Expected.version -or $metadata.ownerSid -cne $Journal.ownerSid -or
        $metadata.serviceSid -cne $Journal.serviceSid -or $metadata.account -cne $accountName -or $marker.nonce -cne $Journal.nonce) { throw 'The public repair tree has an unexpected identity.' }
    $allowed = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $directories = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Expected.files) {
        [void]$allowed.Add($entry.path)
        $directory = [IO.Path]::GetDirectoryName($entry.path.Replace('/','\'))
        while ($directory) { [void]$directories.Add($directory.Replace('\','/')); $directory = [IO.Path]::GetDirectoryName($directory) }
    }
    foreach ($name in @('windows-installation.json','.installation-transaction.json','bundle-manifest.json')) { [void]$allowed.Add($name) }
    $pending = New-Object 'Collections.Generic.Stack[string]'; $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop(); Assert-Protected $directory
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
            Assert-Protected $entry.FullName
            if ($entry.PSIsContainer) {
                if (-not $directories.Contains($entry.FullName.Substring($Root.Length + 1).Replace('\','/'))) { throw 'The pending public tree contains an unknown directory. Nothing was replaced.' }
                $pending.Push($entry.FullName)
            }
            else {
                $relative = $entry.FullName.Substring($Root.Length + 1).Replace('\','/')
                # Only the verified backup can contain an interrupted atomic
                # write of this public source manifest; never inspect its bytes.
                $repairTemporary = ($Root -ieq (Join-Path $programParent ('Abilock.backup-' + $Journal.nonce)) -or $Root -ieq (Join-Path $programParent ('Abilock.repair-' + $Journal.nonce))) -and $relative -cmatch '^bundle-manifest\.json\.new-[a-f0-9]{32}$'
                if (-not $allowed.Contains($relative) -and -not $repairTemporary) { throw 'The pending public tree contains an unknown file. Nothing was replaced.' }
            }
        }
    }
}
function Get-ContinuationRepairAction($Journal, [string]$PreviousHash, [string]$ReplacementHash, [bool]$ProgramExists, [bool]$OriginalBackupExists, [bool]$PreviousBackupExists, [bool]$ReceiptExists) {
    $source = $Journal.PSObject.Properties['repairSourceBundleHash']
    $previous = $Journal.PSObject.Properties['repairPreviousBundleHash']
    if ($Journal.schema -ne 2 -or $Journal.existing -isnot [bool] -or $Journal.existing -or $Journal.ownerSid -cne $OwnerSid -or
        $Journal.nonce -cnotmatch '^[a-f0-9]{32}$' -or $Journal.serviceSid -cnotmatch '^S-1-5-21-[0-9-]+$' -or $Journal.serviceSid -ceq $OwnerSid -or
        -not $source -or $source.Value -cnotmatch '^[a-f0-9]{64}$' -or $PreviousHash -cnotmatch '^[a-f0-9]{64}$' -or $ReplacementHash -cnotmatch '^[a-f0-9]{64}$' -or
        $source.Value -ceq $PreviousHash -or $source.Value -ceq $ReplacementHash -or $PreviousHash -ceq $ReplacementHash) { throw 'The continued repair identity is invalid.' }
    if ($Journal.bundleHash -ceq $PreviousHash) {
        if ($previous -or $Journal.phase -cne 'new-active' -or $ReceiptExists -or -not $OriginalBackupExists -or $ProgramExists -eq $PreviousBackupExists) { throw 'The continued repair is not at the supported boundary.' }
        if ($ProgramExists) { return 'move-public' }
        return 'switch-journal'
    }
    if ($Journal.bundleHash -ceq $ReplacementHash) {
        if (-not $previous -or $previous.Value -cne $PreviousHash -or $Journal.phase -notin @('account-created','new-active','initialized','committed') -or
            (-not $ProgramExists -and ($Journal.phase -cne 'account-created' -or $ReceiptExists)) -or
            ($Journal.phase -in @('initialized','committed') -and -not $ReceiptExists) -or
            ((-not $OriginalBackupExists -or -not $PreviousBackupExists) -and ($Journal.phase -cne 'committed' -or -not $ReceiptExists -or -not $ProgramExists))) { throw 'The continued repair record is invalid.' }
        return 'resume-repaired'
    }
    throw 'The continued repair bundle does not match either verified release.'
}
function Assert-OriginalRepairBackup($Journal) {
    $oldBackup = Join-Path $programParent ('Abilock.backup-' + $Journal.nonce)
    Assert-Protected $oldBackup; Assert-Protected (Join-Path $oldBackup 'bundle-manifest.json')
    $original = Get-BundleManifest $oldBackup $Journal.repairSourceBundleHash -SourceOnly
    if ($original.version -cne '2.2.3' -or $original.architecture -cne $manifest.architecture) { throw 'The repair backup is not the original release.' }
    Assert-RepairPublicTree $oldBackup $original $Journal
}
function Assert-RepairCleanupTree([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $pending = New-Object 'Collections.Generic.Stack[string]'; $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop(); Assert-Protected $directory
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) { Assert-Protected $entry.FullName; if ($entry.PSIsContainer) { $pending.Push($entry.FullName) } }
    }
}
function Complete-ContinuationRepairTransition($Journal, [string]$Action, [string]$Backup) {
    Assert-OriginalRepairBackup $Journal
    $oldRoot = if ($Action -eq 'move-public') { $programRoot } elseif ($Action -eq 'switch-journal') { $Backup } else { throw 'Invalid continued repair transition.' }
    Assert-RepairPublicTree $oldRoot $repairManifest $Journal
    $existingManifest = Join-Path $oldRoot 'bundle-manifest.json'
    if (Test-Path -LiteralPath $existingManifest) {
        Assert-Protected $existingManifest
        if ((Get-FileHash -LiteralPath $existingManifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RepairFromManifestSha256) { throw 'The continued repair source manifest changed.' }
    }
    if ($Action -eq 'move-public') { [IO.Directory]::Move($programRoot, $Backup) }
    $savedManifest = Join-Path $Backup 'bundle-manifest.json'
    if (-not (Test-Path -LiteralPath $savedManifest)) { Write-RepairSourceManifest $savedManifest }
    else {
        Assert-Protected $savedManifest
        if ((Get-FileHash -LiteralPath $savedManifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RepairFromManifestSha256) { throw 'The saved continued repair manifest changed.' }
    }
    # Preserve the original rollback source. The additional field identifies
    # only the verified intermediate public tree; neither account nor data moves.
    $Journal | Add-Member -MemberType NoteProperty -Name repairPreviousBundleHash -Value $RepairFromManifestSha256 -Force
    $Journal.bundleHash = $manifestHash; $Journal.phase = 'account-created'
    Write-Json $journalPath $Journal
    return $Journal
}
function Assert-PendingRepairBackup($Journal) {
    $source = $Journal.PSObject.Properties['repairSourceBundleHash']
    if (-not $source) { return }
    if ($Journal.nonce -cnotmatch '^[a-f0-9]{32}$') { throw 'The repair backup identity is invalid.' }
    $oldBackup = Join-Path $programParent ('Abilock.backup-' + $Journal.nonce)
    $previous = $Journal.PSObject.Properties['repairPreviousBundleHash']
    $previousBackup = Join-Path $programParent ('Abilock.repair-' + $Journal.nonce)
    if ($previous) {
        if ($manifest.version -cne '2.2.7') { throw 'The continued repair requires the verified 2.2.7 release.' }
        $null = Get-ContinuationRepairAction $Journal $previous.Value $manifestHash (Test-Path -LiteralPath $programRoot) (Test-Path -LiteralPath $oldBackup) (Test-Path -LiteralPath $previousBackup) (Test-Path -LiteralPath $receiptPath)
    } else {
        $null = Get-PendingRepairAction $Journal $source.Value $manifestHash (Test-Path -LiteralPath $programRoot) (Test-Path -LiteralPath $oldBackup) (Test-Path -LiteralPath $receiptPath)
        if ($manifest.version -notin @('2.2.6','2.2.7')) { throw 'The pending repair must resume with its verified replacement release.' }
        if (Test-Path -LiteralPath $previousBackup) { throw 'An unknown intermediate public backup blocks recovery.' }
    }
    if ($Journal.phase -ceq 'committed') {
        Assert-Initialized (Read-PublicJson $receiptPath) $Journal.serviceSid
        Assert-RepairPublicTree $programRoot $manifest $Journal
        Assert-RepairCleanupTree $oldBackup
        if ($previous) { Assert-RepairCleanupTree $previousBackup }
        return
    }
    Assert-OriginalRepairBackup $Journal
    if ($previous) {
        Assert-Protected $previousBackup; Assert-Protected (Join-Path $previousBackup 'bundle-manifest.json')
        $intermediate = Get-BundleManifest $previousBackup $previous.Value -SourceOnly
        if ($intermediate.version -cne '2.2.6' -or $intermediate.architecture -cne $manifest.architecture) { throw 'The intermediate backup is not the verified 2.2.6 release.' }
        Assert-RepairPublicTree $previousBackup $intermediate $Journal
    }
}
function Write-RepairSourceManifest([string]$Destination) {
    $sourceStream = New-Object IO.FileStream((Join-Path $repairBundle 'bundle-manifest.json'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($sourceStream.Length -gt 20971520) { throw 'The repair source manifest is too large.' }
        $memory = New-Object IO.MemoryStream
        try { $sourceStream.CopyTo($memory); $sourceBytes = $memory.ToArray() } finally { $memory.Dispose() }
    } finally { $sourceStream.Dispose() }
    $digest = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($digest.ComputeHash($sourceBytes))).Replace('-','').ToLowerInvariant() } finally { $digest.Dispose() }
    if ($hash -cne $RepairFromManifestSha256) { throw 'The repair source manifest changed.' }
    $sourceText = (New-Object Text.UTF8Encoding($false,$true)).GetString($sourceBytes)
    [AbilockInstallerSupport]::WriteAtomicFile($Destination, $sourceText)
}
function Complete-PendingRepairTransition($Journal, [string]$Action, [string]$Backup) {
    $oldRoot = if ($Action -eq 'move-public') { $programRoot } elseif ($Action -eq 'switch-journal') { $Backup } else { throw 'Invalid public repair transition.' }
    Assert-RepairPublicTree $oldRoot $repairManifest $Journal
    $existingManifest = Join-Path $oldRoot 'bundle-manifest.json'
    if (Test-Path -LiteralPath $existingManifest) {
        Assert-Protected $existingManifest
        if ((Get-FileHash -LiteralPath $existingManifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RepairFromManifestSha256) { throw 'The saved repair manifest changed.' }
    }
    if ($Action -eq 'move-public') { [IO.Directory]::Move($programRoot, $Backup) }
    # Keep the source manifest in the protected backup so a normal subsequent
    # resume can verify it without relying on the original temporary bundle.
    $savedManifest = Join-Path $Backup 'bundle-manifest.json'
    if (Test-Path -LiteralPath $savedManifest) {
        Assert-Protected $savedManifest
        if ((Get-FileHash -LiteralPath $savedManifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RepairFromManifestSha256) { throw 'The saved repair manifest changed.' }
    } else { Write-RepairSourceManifest $savedManifest }
    $Journal | Add-Member -MemberType NoteProperty -Name repairSourceBundleHash -Value $RepairFromManifestSha256 -Force
    $Journal.bundleHash = $manifestHash; $Journal.phase = 'account-created'
    Write-Json $journalPath $Journal
    return $Journal
}
function Invoke-PendingPublicRepair($Journal) {
    if ($Journal.nonce -cnotmatch '^[a-f0-9]{32}$') { throw 'The pending repair identity is invalid.' }
    $oldBackup = Join-Path $programParent ('Abilock.backup-' + $Journal.nonce)
    $continuation = $repairManifest.version -ceq '2.2.6'
    $previousBackup = Join-Path $programParent ('Abilock.repair-' + $Journal.nonce)
    if ($continuation) {
        $action = Get-ContinuationRepairAction $Journal $RepairFromManifestSha256 $manifestHash (Test-Path -LiteralPath $programRoot) (Test-Path -LiteralPath $oldBackup) (Test-Path -LiteralPath $previousBackup) (Test-Path -LiteralPath $receiptPath)
        if ($action -ne 'resume-repaired') { Assert-OriginalRepairBackup $Journal }
    } else {
        if (Test-Path -LiteralPath $previousBackup) { throw 'An unknown intermediate public backup blocks repair.' }
        $action = Get-PendingRepairAction $Journal $RepairFromManifestSha256 $manifestHash (Test-Path -LiteralPath $programRoot) (Test-Path -LiteralPath $oldBackup) (Test-Path -LiteralPath $receiptPath)
    }
    if ($action -eq 'resume-repaired') { Assert-PendingRepairBackup $Journal; return $Journal }
    $account = Get-DedicatedAccount
    if ((Assert-Account $Journal $account) -cne $Journal.serviceSid) { throw 'The pending repair account identity changed.' }
    Assert-Private $dataRoot $Journal.serviceSid
    Assert-Private $transactionRoot ''
    if (Test-Path -LiteralPath (Join-Path $programParent ('Abilock.stage-' + $Journal.nonce))) { throw 'An unexpected stage directory blocks this repair.' }
    $repairFolder = $null
    try {
        $repairFolder = $scheduler.GetFolder('\Abilock')
        $security = New-Object Security.AccessControl.RawSecurityDescriptor($repairFolder.GetSecurityDescriptor(7)); Assert-DaclShape $security
        if ($security.Owner.Value -notin @($systemSid,$administratorsSid)) { throw 'The pending task folder has an unexpected owner.' }
        foreach ($ace in $security.DiscretionaryAcl) {
            if ($ace.AceType -eq 'AccessAllowed' -and ($ace.AccessMask -band 0x500D0116) -ne 0 -and $ace.SecurityIdentifier.Value -notin @($systemSid,$administratorsSid)) { throw 'The pending task folder has unsafe write permissions.' }
        }
        if ($repairFolder.GetTasks(1).Count -ne 3) { throw 'The pending repair task set is unexpected.' }
        foreach ($item in @(@('Execute','execute'),@('Config','config'),@('Bootstrap','bootstrap'))) {
            $task = Get-TaskIfPresent $repairFolder $item[0]
            if (-not $task) { throw 'A pending repair task is missing.' }
            Assert-Task $task $item[1] $Journal.serviceSid
            if ($task.GetInstances(0).Count -ne 0 -or ($item[0] -eq 'Bootstrap' -and -not $task.Enabled)) { throw 'The pending repair tasks must be idle and initialization enabled.' }
        }
        Stop-TaskStarts $repairFolder $Journal.serviceSid
        if ($continuation) { return (Complete-ContinuationRepairTransition $Journal $action $previousBackup) }
        return (Complete-PendingRepairTransition $Journal $action $oldBackup)
    } finally { if ($repairFolder -and [Runtime.InteropServices.Marshal]::IsComObject($repairFolder)) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($repairFolder) | Out-Null } }
}
function Test-MissingTaskObject([Exception]$Exception) {
    # The COM adapter maps missing scheduler objects to FileNotFoundException
    # on Windows PowerShell. Calls through other adapters can wrap that error.
    # Unwrap invocation wrappers only; never treat access or RPC failures as
    # absence, even when another exception happens to appear in their chain.
    while ($Exception -is [Management.Automation.MethodInvocationException] -or $Exception -is [Reflection.TargetInvocationException]) {
        if (-not $Exception.InnerException) { return $false }
        $Exception = $Exception.InnerException
    }
    return $Exception.HResult -eq -2147024894 -or $Exception.HResult -eq -2147024893
}
function Get-TaskFolderIfPresent($Scheduler, [string]$Name) {
    try { return $Scheduler.GetFolder($Name) }
    catch {
        if (Test-MissingTaskObject $_.Exception) { return $null }
        throw
    }
}
function Get-TaskIfPresent($Folder, [string]$Name) {
    try { return $Folder.GetTask($Name) }
    catch {
        if (Test-MissingTaskObject $_.Exception) { return $null }
        throw
    }
}
function Stop-TaskStarts($Folder, [string]$Sid) {
    foreach ($item in @(@('Execute','execute'), @('Config','config'))) {
        $task = Get-TaskIfPresent $Folder $item[0]
        if ($task) { Assert-Task $task $item[1] $Sid; $task.Enabled = $false; $script:disabled += $task }
    }
    foreach ($task in $script:disabled) { if ($task.GetInstances(0).Count -ne 0) { throw 'Close Abilock and wait for active calls to finish, then retry.' } }
}
function Wait-TaskExit($Task) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($Task.GetInstances(0).Count -ne 0) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'An initialization process is still running. Wait for it to exit and retry.' }
        Start-Sleep -Milliseconds 100
    }
}
function Ensure-WorkerTask($Folder, [string]$Name, [string]$Mode, [string]$Sid, [string]$Password, [switch]$Private) {
    $task = Get-TaskIfPresent $Folder $Name
    if ($task) {
        Assert-Task $task $Mode $Sid
        if ($Private) { Wait-TaskExit $task }
        return
    }
    if (-not $Password) { throw 'A completed installation is missing its protected task; no account password was reset.' }
    Register-WorkerTask $Folder $Name $Mode $Sid $Password -Private:$Private
}
function Get-NativeFailureStage([string]$Text) {
    $match = [regex]::Match($Text, '\AABILOCK_ISOLATION_FAILED stage=(?<stage>0|[1-9]|1[0-6]) hresult=(?<hresult>-?(?:0|[1-9][0-9]{0,9}))(?:\r?\n)?\z')
    $hresult = 0
    if (-not $match.Success -or -not [int]::TryParse($match.Groups['hresult'].Value, [ref]$hresult)) { return 0 }
    return [int]$match.Groups['stage'].Value
}
function Invoke-Bootstrap($Request) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $programRoot 'Abilock.Host.exe'; $start.Arguments = 'bootstrap-client'
    $start.UseShellExecute = $false; $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true; $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        # Write exact UTF-8 bytes; Framework StandardInput's default encoding
        # depends on the console code page and can corrupt a Unicode password.
        $inputBytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes(($Request | ConvertTo-Json -Compress))
        try { $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length); $process.StandardInput.BaseStream.Flush() }
        finally { [Array]::Clear($inputBytes, 0, $inputBytes.Length); $process.StandardInput.BaseStream.Close() }
        # Read asynchronously so the bounded wait also covers blocked output.
        $output = $process.StandardOutput.ReadToEndAsync(); $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) { try { $process.Kill() } catch { }; throw (New-BootstrapFailure 33) }
        if (-not $output.Wait(5000) -or -not $errors.Wait(5000)) { throw (New-BootstrapFailure 33) }
        $bootstrapFailure = Get-BootstrapFailureIndex $output.Result
        if ($bootstrapFailure -gt 0) { throw (New-BootstrapFailure $bootstrapFailure) }
        if ($process.ExitCode -ne 0) {
            $stage = if ($errors.Result.Length -le 128) { Get-NativeFailureStage $errors.Result } else { 0 }
            if ($stage -gt 0) {
                $failure = New-Object InvalidOperationException('The protected initialization process failed.')
                $failure.Data['AbilockNativeStage'] = [int]$stage
                throw $failure
            }
            throw (New-BootstrapFailure 33)
        }
        if ([string]::IsNullOrWhiteSpace($output.Result) -or $output.Result.Length -gt 4096) { throw (New-BootstrapFailure 33) }
        try { $result = $output.Result | ConvertFrom-Json } catch { throw (New-BootstrapFailure 33) }
        if ($result -isnot [pscustomobject] -or -not $result.PSObject.Properties['ok'] -or -not $result.PSObject.Properties['event'] -or
            $result.ok -isnot [bool] -or -not $result.ok -or $result.event -isnot [string] -or $result.event -cnotin @('initialized','setup-required')) { throw (New-BootstrapFailure 33) }
        return $result.event
    } finally { $process.Dispose() }
}

Assert-ParentAcl $programParent
Assert-ParentAcl ([IO.Path]::GetDirectoryName($dataParent))
if (Test-Path -LiteralPath $dataParent) { Assert-Protected $dataParent } else { Set-ProtectedDirectory $dataParent @($OwnerSid) '' }
$installLock = $null
try {
    $lockPath = Join-Path $dataParent 'install.lock'
    if (Test-Path -LiteralPath $lockPath) { Assert-Protected $lockPath }
    $installLock = [AbilockInstallerSupport]::OpenInstallLock($lockPath)
    Assert-Protected $lockPath
}
catch { throw }
$scheduler = $null; $folder = $null; $disabled = @(); $journal = $null; $stage = $null; $backup = $null; $installedNew = $false
$servicePassword = $null; $password = $null
$journalPath = Join-Path $dataParent 'install-journal.json'
$receiptPath = Join-Path $dataParent 'initialized.json'
$transactionRoot = Join-Path $dataParent 'install-transaction'
try {
    $scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect()
    $resumeFresh = $false
    if ($repairBundle -and -not (Test-Path -LiteralPath $journalPath)) { throw 'There is no pending installation to repair.' }
    if (Test-Path -LiteralPath $journalPath) {
        $previous = Read-PublicJson $journalPath
        if ($repairBundle) { $previous = Invoke-PendingPublicRepair $previous }
        if ($previous.ownerSid -cne $OwnerSid -or $previous.bundleHash -cne $manifestHash) { throw 'Resume with the same verified bundle and installation owner.' }
        Assert-PendingRepairBackup $previous
        $account = Get-DedicatedAccount
        $recovery = Get-RecoveryAction $previous (Test-Path -LiteralPath $programRoot) (Test-Path -LiteralPath $receiptPath) ([bool]$account)
        if ($recovery -eq 'recover-upgrade') {
            $oldStage = Join-Path $programParent ('Abilock.stage-' + $previous.nonce)
            $oldBackup = Join-Path $programParent ('Abilock.backup-' + $previous.nonce)
            $folder = $scheduler.GetFolder('\Abilock')
            Stop-TaskStarts $folder $previous.serviceSid
            if (Test-Path -LiteralPath $oldBackup) {
                Assert-Protected $oldBackup
                if (Test-Path -LiteralPath $programRoot) {
                    Assert-Protected $programRoot
                    $marker = Read-PublicJson (Join-Path $programRoot '.installation-transaction.json')
                    if ($marker.nonce -cne $previous.nonce -or (Test-Path -LiteralPath $oldStage)) { throw 'The interrupted upgrade has an unknown active directory.' }
                    [IO.Directory]::Move($programRoot, $oldStage)
                }
                [IO.Directory]::Move($oldBackup, $programRoot)
            }
            if (Test-Path -LiteralPath $oldStage) { Assert-Protected $oldStage; Remove-Item -LiteralPath $oldStage -Recurse -Force }
            Remove-Item -LiteralPath $journalPath -Force
        } else {
            $journal = $previous; $resumeFresh = $true
            if ($account) { $null = Assert-Account $journal $account }
            if (Test-Path -LiteralPath $programRoot) {
                $marker = Read-PublicJson (Join-Path $programRoot '.installation-transaction.json')
                if ($marker.nonce -cne $journal.nonce) { throw 'The public program does not belong to the interrupted installation.' }
            }
        }
    }
    $existing = (Test-Path -LiteralPath $programRoot) -and -not $resumeFresh
    $serviceSid = $null
    if ($existing) {
        $metadata = Read-PublicJson (Join-Path $programRoot 'windows-installation.json')
        Assert-NonDowngrade $manifest.version $metadata.version
        if ($metadata.schema -ne 1 -or $metadata.ownerSid -cne $OwnerSid -or $metadata.account -cne $accountName) { throw 'The existing installation belongs to another user or is invalid.' }
        $serviceSid = ([Security.Principal.NTAccount]($computerName + '\' + $accountName)).Translate([Security.Principal.SecurityIdentifier]).Value
        if ($serviceSid -cne $metadata.serviceSid) { throw 'The protected account identity changed.' }
        Assert-Initialized (Read-PublicJson $receiptPath) $serviceSid
        $folder = $scheduler.GetFolder('\Abilock'); Stop-TaskStarts $folder $serviceSid
        Assert-Private $dataRoot $serviceSid
    } elseif (-not $resumeFresh) {
        foreach ($entry in Get-ChildItem -LiteralPath $dataParent -Force) {
            if ($entry.Name -ne 'install.lock' -and $entry.Name -notmatch '^install-journal\.json\.new-[a-f0-9]{32}$') { throw 'The reserved data directory contains unknown files. Nothing was adopted or reset.' }
            Assert-Protected $entry.FullName
        }
        if ((Test-Path -LiteralPath $dataRoot) -or (Test-Path -LiteralPath $receiptPath) -or (Test-Path -LiteralPath $transactionRoot) -or (Get-DedicatedAccount)) { throw 'Unknown private data or a reserved account already exists. Nothing was adopted or reset.' }
        $unknownFolder = Get-TaskFolderIfPresent $scheduler '\Abilock'
        if ($unknownFolder) { throw 'The reserved task folder already exists.' }
    }
    if (-not $journal) {
        $journal = [ordered]@{ schema = 2; nonce = [Guid]::NewGuid().ToString('N'); ownerSid = $OwnerSid; phase = 'prepared'; existing = [bool]$existing; serviceSid = $serviceSid; bundleHash = $manifestHash }
        Write-Json $journalPath $journal
    }
    $nonce = $journal.nonce
    $stage = Join-Path $programParent ('Abilock.stage-' + $nonce)
    $backup = Join-Path $programParent ('Abilock.backup-' + $nonce)
    if (-not $existing) {
        $account = Get-DedicatedAccount
        $alreadyInitialized = Test-Path -LiteralPath $receiptPath
        if ($alreadyInitialized) {
            $serviceSid = Assert-Account $journal $account
            Assert-Initialized (Read-PublicJson $receiptPath) $serviceSid
        } else {
        # Random account credentials exist only in this administrator/System-only
        # directory, additionally encrypted by machine DPAPI, until commit.
        if (Test-Path -LiteralPath $transactionRoot) { Assert-Private $transactionRoot '' } else { Set-ProtectedDirectory $transactionRoot @() '' }
        $credentialPath = Join-Path $transactionRoot 'account.json'
        if (Test-Path -LiteralPath $credentialPath) {
            Assert-Private $credentialPath ''
            $credential = Read-PublicJson $credentialPath
            if ($credential.nonce -cne $nonce -or $credential.ownerSid -cne $OwnerSid) { throw 'The account recovery record is not from this installation.' }
            $servicePassword = [AbilockInstallerSupport]::UnprotectSetupPassword($credential.protectedPassword)
            if ($servicePassword -notmatch '^Aa1![A-Za-z0-9+/]{64}$') { throw 'The account recovery record is invalid.' }
        } else {
            if (Get-DedicatedAccount) { throw 'The owned account recovery credential is missing; no password was reset.' }
            $random = New-Object byte[] 48; $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($random) } finally { $rng.Dispose() }
            $servicePassword = 'Aa1!' + [Convert]::ToBase64String($random); [Array]::Clear($random, 0, $random.Length)
            Write-Json $credentialPath @{ nonce = $nonce; ownerSid = $OwnerSid; protectedPassword = [AbilockInstallerSupport]::ProtectSetupPassword($servicePassword) }
        }
        $account = Get-DedicatedAccount
        if (-not $account) { [AbilockInstallerSupport]::CreateDedicatedAccount($servicePassword, ('Abilock dedicated account ' + $nonce)); $account = Get-DedicatedAccount }
        $serviceSid = Assert-Account $journal $account
        }
        $journal.serviceSid = $serviceSid; $journal.phase = Get-ResumeInstallationPhase $journal $alreadyInitialized 'account-created'; Write-Json $journalPath $journal
        [AbilockInstallerSupport]::GrantRights($serviceSid)
        Set-ProtectedDirectory $dataParent @($OwnerSid, $serviceSid) ''
        if (Test-Path -LiteralPath $dataRoot) { Assert-Private $dataRoot $serviceSid } else { Set-ProtectedDirectory $dataRoot @() $serviceSid }
        $temporaryRoot = Join-Path $dataRoot 'tmp'
        if (Test-Path -LiteralPath $temporaryRoot) { Assert-Private $temporaryRoot $serviceSid } else { Set-ProtectedDirectory $temporaryRoot @() $serviceSid }
        $folder = Get-TaskFolderIfPresent $scheduler '\Abilock'
        if (-not $folder) {
            $folderSddl = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;' + $OwnerSid + ')'
            $folder = $scheduler.GetFolder('\').CreateFolder('Abilock', $folderSddl)
        }
        Stop-TaskStarts $folder $serviceSid
    }
    if ($resumeFresh -and (Test-Path -LiteralPath $programRoot)) {
        Assert-PublicBundle $programRoot
        $metadata = Read-PublicJson (Join-Path $programRoot 'windows-installation.json')
        if ($metadata.ownerSid -cne $OwnerSid -or $metadata.serviceSid -cne $serviceSid) { throw 'The interrupted program identity changed.' }
    } else {
        if (Test-Path -LiteralPath $stage) { Assert-Protected $stage; Remove-Item -LiteralPath $stage -Recurse -Force }
        Set-ProtectedDirectory $stage @($OwnerSid) ''
        foreach ($entry in $manifest.files) {
            $target = Join-Path $stage $entry.path
            [AbilockInstallerSupport]::CreateProtectedDirectories($stage, [IO.Path]::GetDirectoryName($target))
            [AbilockInstallerSupport]::CopyVerified($bundle, (Join-Path $bundle $entry.path), $target, $entry.sha256)
        }
        Write-Json (Join-Path $stage '.installation-transaction.json') @{ nonce = $nonce }
        Set-ProtectedDirectory $stage @($OwnerSid, $serviceSid) ''
        foreach ($child in Get-ChildItem -LiteralPath $stage -Recurse -Force) {
            $acl = Get-Acl -LiteralPath $child.FullName
            $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($administratorsSid)))
            $acl.SetAccessRuleProtection($false, $false)
            foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($rule) }
            Set-Acl -LiteralPath $child.FullName -AclObject $acl
        }
        Write-PublicMetadata (Join-Path $stage 'windows-installation.json') @{ schema = 1; version = $manifest.version; ownerSid = $OwnerSid; serviceSid = $serviceSid; account = $accountName }
        if ($existing) { [IO.Directory]::Move($programRoot, $backup); $journal.phase = 'old-moved'; Write-Json $journalPath $journal }
        [IO.Directory]::Move($stage, $programRoot); $installedNew = $true
    }
    $journal.phase = Get-ResumeInstallationPhase $journal (Test-Path -LiteralPath $receiptPath) 'new-active'; Write-Json $journalPath $journal
    if (-not $existing) {
        Ensure-WorkerTask $folder 'Execute' 'execute' $serviceSid $servicePassword
        Ensure-WorkerTask $folder 'Config' 'config' $serviceSid $servicePassword
        if (Test-Path -LiteralPath $receiptPath) { Assert-Initialized (Read-PublicJson $receiptPath) $serviceSid }
        else {
            Ensure-WorkerTask $folder 'Bootstrap' 'bootstrap' $serviceSid $servicePassword -Private
            $result = Invoke-Bootstrap @{ verify = $true }
            if ($result -eq 'setup-required') {
                $password = [AbilockInstallerSupport]::PromptPassword()
                try { $result = Invoke-Bootstrap @{ password = $password } } finally { $password = $null }
            }
            if ($result -cne 'initialized') { throw 'Initial configuration did not complete. No data was reset.' }
            Write-Json $receiptPath @{ schema = 1; initialized = $true; ownerSid = $OwnerSid; serviceSid = $serviceSid; nonce = $nonce }
        }
        $journal.phase = Get-ResumeInstallationPhase $journal $true 'initialized'; Write-Json $journalPath $journal
        $bootstrap = Get-TaskIfPresent $folder 'Bootstrap'
        if ($bootstrap) { Assert-Task $bootstrap 'bootstrap' $serviceSid; Wait-TaskExit $bootstrap; $folder.DeleteTask('Bootstrap', 0) }
    }
    & (Join-Path $programRoot 'Abilock.Host.exe') validate-installation | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Installed runtime verification failed.' }
    $journal.phase = 'committed'; Write-Json $journalPath $journal
    foreach ($task in $disabled) { $task.Enabled = $true }
    if ($journal.PSObject.Properties['repairPreviousBundleHash']) {
        Assert-PendingRepairBackup $journal
        $previousBackup = Join-Path $programParent ('Abilock.repair-' + $journal.nonce)
        if (Test-Path -LiteralPath $previousBackup) { Remove-Item -LiteralPath $previousBackup -Recurse -Force }
    }
    if (Test-Path -LiteralPath $backup) { Assert-Protected $backup; Remove-Item -LiteralPath $backup -Recurse -Force }
    if (Test-Path -LiteralPath $transactionRoot) { Assert-Private $transactionRoot ''; Remove-Item -LiteralPath $transactionRoot -Recurse -Force }
    Remove-Item -LiteralPath $journalPath -Force
    Write-Output 'Abilock installed. Calls run on demand and exit when finished. No background service was installed.'
    if (-not $Elevated) { Register-OwnerSkills }
} catch {
    $installationFailure = $_
    try {
        if ($journal -and $journal.existing -and $backup -and (Test-Path -LiteralPath $backup)) {
            if ($installedNew -and (Test-Path -LiteralPath $programRoot)) {
                if (Test-Path -LiteralPath $stage) { throw 'Upgrade rollback requires manual review. Private data was retained.' }
                [IO.Directory]::Move($programRoot, $stage)
            }
            if (-not (Test-Path -LiteralPath $programRoot)) { [IO.Directory]::Move($backup, $programRoot) }
            $journal.phase = 'rolled-back'; Write-Json $journalPath $journal
        }
    } catch {
        [Console]::Error.WriteLine('ABILOCK_INSTALL_ROLLBACK_FAILED: Recovery requires review. Private data was not reset.')
    }
    # Keep the original ErrorRecord for the bounded, non-secret outer trap.
    throw $installationFailure
} finally {
    $servicePassword = $null; $password = $null
    foreach ($task in $disabled) { try { $task.Enabled = $true } catch { } }
    if ($installLock) { $installLock.Dispose() }
    foreach ($value in @($folder, $scheduler)) { if ($value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($value) | Out-Null } }
}
