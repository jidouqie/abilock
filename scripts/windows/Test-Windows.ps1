#requires -Version 5.1
# Safe tests only: temporary public files, parser checks, no accounts or tasks.
[CmdletBinding()]
param([string]$HostExecutable)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$engine = (Get-Process -Id $PID).Path
$utf8 = New-Object Text.UTF8Encoding($false)
$fixtureVersion = '0.0.0'
# Production preflight refuses downgrades. An existing public installation
# record supplies only the version for these synthetic package fixtures.
$installedRecord = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Abilock\windows-installation.json'
if (Test-Path -LiteralPath $installedRecord -PathType Leaf) {
    $installed = [IO.File]::ReadAllText($installedRecord) | ConvertFrom-Json
    if ($installed.version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'The public installed version is invalid.' }
    $fixtureVersion = $installed.version
}
$passed = 0
foreach ($script in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
    $bytes = [IO.File]::ReadAllBytes($script.FullName)
    if (@($bytes | Where-Object { $_ -gt 127 }).Count -ne 0) { throw 'Installation scripts must contain ASCII English text only.' }
    $tokens = $null; $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw ('PowerShell parser rejected: ' + $script.Name) }
    $passed++
}
if ($HostExecutable) {
    & $HostExecutable self-test
    if ($LASTEXITCODE -ne 0) { throw 'Native host policy self-test failed.' }
    $passed++
}
$architecture = & (Join-Path $PSScriptRoot 'Test-Architecture.ps1')
if ($architecture -notmatch '^ABILOCK_ARCHITECTURE_TESTS_OK ([0-9]+)$') { throw 'The architecture boundary tests did not complete.' }
$passed += [int]$Matches[1]
$ownerRegistration = & (Join-Path $PSScriptRoot 'Test-OwnerRegistration.ps1')
if ($ownerRegistration -notmatch '^ABILOCK_OWNER_REGISTRATION_TESTS_OK ([0-9]+)$') { throw 'The user entry preflight tests did not complete.' }
$passed += [int]$Matches[1]
$metadataAccess = & (Join-Path $PSScriptRoot 'Test-MetadataAccess.ps1')
if ($metadataAccess -notmatch '^ABILOCK_METADATA_ACCESS_TESTS_OK ([0-9]+)$') { throw 'The legacy metadata access tests did not complete.' }
$passed += [int]$Matches[1]
$taskLookup = & (Join-Path $PSScriptRoot 'Test-TaskLookup.ps1')
if ($taskLookup -notmatch '^ABILOCK_TASK_LOOKUP_TESTS_OK ([0-9]+)$') { throw 'The read-only scheduler lookup tests did not complete.' }
$passed += [int]$Matches[1]
$diagnostics = & (Join-Path $PSScriptRoot 'Test-InstallerDiagnostics.ps1')
if ($diagnostics -notmatch '^ABILOCK_INSTALLER_DIAGNOSTICS_TESTS_OK ([0-9]+)$') { throw 'The non-secret installer diagnostics tests did not complete.' }
$passed += [int]$Matches[1]
$acl = & (Join-Path $PSScriptRoot 'Test-AclPolicy.ps1')
if ($acl -notmatch '^ABILOCK_ACL_POLICY_TESTS_OK ([0-9]+)$') { throw 'The ACL and version policy tests did not complete.' }
$passed += [int]$Matches[1]
$recovery = & (Join-Path $PSScriptRoot 'Test-Recovery.ps1')
if ($recovery -notmatch '^ABILOCK_RECOVERY_TESTS_OK ([0-9]+)$') { throw 'The recovery boundary tests did not complete.' }
$passed += [int]$Matches[1]
$pendingRepair = & (Join-Path $PSScriptRoot 'Test-PendingRepair.ps1')
if ($pendingRepair -notmatch '^ABILOCK_PENDING_REPAIR_TESTS_OK ([0-9]+)$') { throw 'The pending public repair tests did not complete.' }
$passed += [int]$Matches[1]
$continuationRepair = & (Join-Path $PSScriptRoot 'Test-ContinuationRepair.ps1')
if ($continuationRepair -notmatch '^ABILOCK_CONTINUATION_REPAIR_TESTS_OK ([0-9]+)$') { throw 'The continued repair and bootstrap response tests did not complete.' }
$passed += [int]$Matches[1]
$bootstrap = & (Join-Path $PSScriptRoot 'Test-BootstrapInput.ps1')
if ($bootstrap -notmatch '^ABILOCK_BOOTSTRAP_UTF8_TESTS_OK ([0-9]+)$') { throw 'The bootstrap UTF-8 input test did not complete.' }
$passed += [int]$Matches[1]
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('abilock-windows-tests-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
    $files = @('Abilock.Host.exe', 'node.exe', 'runtime/dist/src/windows-worker.js', 'runtime/bin/abl.mjs', 'runtime/bin/abl.cmd', 'runtime/package.json', 'runtime/request-limits.json', 'runtime/skills/abilock/SKILL.md', 'runtime/skills/abilock/assets/runtime-manifest.json', 'runtime/skills/abilock/assets/abilock-runtime.tgz', 'desktop/Abilock.exe', 'installer/InstallerSupport.cs', 'Abilock.GitSsh.exe', 'git/cmd/git.exe', 'git/usr/bin/sh.exe', 'git/ucrt64/bin/git-remote-http.exe', 'git/ucrt64/libexec/git-core/git-sh-setup')
    foreach ($relative in $files) {
        $file = Join-Path $temporary $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
        $content = if ($relative -eq 'runtime/package.json') { ConvertTo-Json -Compress @{ version = $fixtureVersion } } elseif ($relative -eq 'runtime/skills/abilock/SKILL.md') { "---`nname: abilock`n---`nSynthetic skill`n" } else { 'public synthetic fixture' }
        [IO.File]::WriteAllText($file, $content, $utf8)
    }
    $baseFiles = @()
    foreach ($relative in $files) { $baseFiles += @{ path = $relative; sha256 = (Get-FileHash -LiteralPath (Join-Path $temporary $relative)).Hash.ToLowerInvariant() } }
    function Invoke-Preflight($Entries, [bool]$ExpectedSuccess) {
        $manifest = @{ schema = 1; platform = 'win32'; architecture = 'x64'; version = $fixtureVersion; files = $Entries }
        [IO.File]::WriteAllText((Join-Path $temporary 'bundle-manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
        $stdout = Join-Path $temporary 'test-stdout.txt'; $stderr = Join-Path $temporary 'test-stderr.txt'
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'Install-Abilock.ps1') + '" -BundlePath "' + $temporary + '" -Check'
        $process = Start-Process -FilePath $engine -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        if (($process.ExitCode -eq 0) -ne $ExpectedSuccess) { throw 'Bundle preflight did not reject an invalid input or rejected a valid fixture.' }
        $script:passed++
    }
    Invoke-Preflight $baseFiles $true
    foreach ($invalid in @('../outside', '/absolute', 'runtime/file:stream', 'runtime/CON.txt', 'runtime/CONIN$', 'runtime/CONOUT$', 'runtime//empty', 'runtime/nested/../file', 'runtime/trailing.')) {
        Invoke-Preflight ($baseFiles + @(@{ path = $invalid; sha256 = ('0' * 64) })) $false
    }
    Invoke-Preflight ($baseFiles + @(@{ path = 'NODE.EXE'; sha256 = $baseFiles[1].sha256 })) $false
    Invoke-Preflight ($baseFiles | Where-Object { $_.path -ne 'runtime/bin/abl.cmd' }) $false
    Invoke-Preflight ($baseFiles | Where-Object { $_.path -ne 'Abilock.GitSsh.exe' }) $false
    Invoke-Preflight ($baseFiles | Where-Object { $_.path -ne 'runtime/skills/abilock/SKILL.md' }) $false
    $unicodeName = 'docs/' + [char]0x4e2d + [char]0x6587 + '.md'
    [IO.Directory]::CreateDirectory((Join-Path $temporary 'docs')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $temporary $unicodeName), 'public Unicode filename fixture', $utf8)
    Invoke-Preflight ($baseFiles + @(@{ path = $unicodeName; sha256 = (Get-FileHash -LiteralPath (Join-Path $temporary $unicodeName)).Hash.ToLowerInvariant() })) $true
    [IO.File]::AppendAllText((Join-Path $temporary 'node.exe'), 'changed', $utf8)
    Invoke-Preflight $baseFiles $false
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; powershell = $PSVersionTable.PSVersion.ToString(); passed = $passed; systemChanges = $false })
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
