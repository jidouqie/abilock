#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
    [Parameter(Mandatory = $true)][string]$DesktopDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateSet('auto', 'x64', 'arm64')][string]$Architecture = 'auto'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$utf8 = New-Object Text.UTF8Encoding($false)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtime = [IO.Path]::GetFullPath($RuntimeDirectory)
$desktop = [IO.Path]::GetFullPath($DesktopDirectory)
$destination = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw 'Choose a new, empty output directory.' }
# Reuse only the read-only architecture definitions; never invoke installation.
$tokens = $null; $parseErrors = $null
$installerAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The installer source has parsing errors.' }
foreach ($name in @('Get-NativeWindowsPlatform','Resolve-WindowsArchitecture')) {
    $definition = @($installerAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($definition.Count -ne 1) { throw 'The shared architecture definition is invalid.' }
    Invoke-Expression $definition[0].Extent.Text
}
$nativePlatform = Get-NativeWindowsPlatform
$Architecture = Resolve-WindowsArchitecture $Architecture $nativePlatform.architecture $nativePlatform.build

function Copy-PublicTree([string]$Source, [string]$Target) {
    $info = Get-Item -LiteralPath $Source -Force
    if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Public package inputs must not contain reparse points.' }
    if ($info.PSIsContainer) {
        [IO.Directory]::CreateDirectory($Target) | Out-Null
        foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
            if ($entry.Name -eq '.bin') { continue }
            Copy-PublicTree $entry.FullName (Join-Path $Target $entry.Name)
        }
    } else { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Target)) | Out-Null; [IO.File]::Copy($Source, $Target, $false) }
}
[IO.Directory]::CreateDirectory($destination) | Out-Null
try {
    $package = [IO.File]::ReadAllText((Join-Path $runtime 'package.json')) | ConvertFrom-Json
    foreach ($name in @('package.json', 'npm-shrinkwrap.json', 'request-limits.json', 'LICENSE', 'README.md', 'bin', 'dist', 'docs', 'node_modules', 'skills/abilock')) {
        Copy-PublicTree (Join-Path $runtime $name) (Join-Path $destination ('runtime\' + $name))
    }
    Copy-PublicTree $desktop (Join-Path $destination 'desktop')
    $prebuilt = Join-Path $root 'native\windows\prebuilt'
    $nativeManifest = [IO.File]::ReadAllText((Join-Path $prebuilt 'manifest.json')) | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath (Join-Path $prebuilt 'Abilock.Host.exe')).Hash.ToLowerInvariant() -cne $nativeManifest.sha256 -or (Get-FileHash -LiteralPath (Join-Path $root 'native\windows\Abilock.Host.cs')).Hash.ToLowerInvariant() -cne $nativeManifest.sourceSha256) { throw 'Rebuild the Windows host from the current source before packaging.' }
    Copy-PublicTree (Join-Path $prebuilt 'Abilock.Host.exe') (Join-Path $destination 'Abilock.Host.exe')
    if ((Get-FileHash -LiteralPath (Join-Path $prebuilt 'Abilock.GitSsh.exe')).Hash.ToLowerInvariant() -cne $nativeManifest.gitSha256 -or (Get-FileHash -LiteralPath (Join-Path $root 'native\windows\Abilock.GitSsh.cs')).Hash.ToLowerInvariant() -cne $nativeManifest.gitSourceSha256) { throw 'Rebuild the fixed Windows Git bridge before packaging.' }
    Copy-PublicTree (Join-Path $prebuilt 'Abilock.GitSsh.exe') (Join-Path $destination 'Abilock.GitSsh.exe')
    Copy-PublicTree (Join-Path $root 'native\windows\abl.cmd') (Join-Path $destination 'runtime\bin\abl.cmd')
    Copy-PublicTree (Join-Path $root 'native\windows\InstallerSupport.cs') (Join-Path $destination 'installer\InstallerSupport.cs')
    Copy-PublicTree (Join-Path $PSScriptRoot 'Install-Abilock.ps1') (Join-Path $destination 'Install-Abilock.ps1')
    # Official Node standalone files. SHA-256 values were checked against
    # https://nodejs.org/dist/v24.21.0/SHASUMS256.txt on 2026-10-14.
    $nodeHashes = @{ x64 = 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32'; arm64 = 'dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri ('https://nodejs.org/dist/v24.21.0/win-' + $Architecture + '/node.exe') -OutFile (Join-Path $destination 'node.exe') -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 120
    if ((Get-FileHash -LiteralPath (Join-Path $destination 'node.exe')).Hash.ToLowerInvariant() -cne $nodeHashes[$Architecture]) { throw 'The official Node download failed its pinned integrity check.' }
    $version = & (Join-Path $destination 'node.exe') --version
    if ($LASTEXITCODE -ne 0 -or $version -cne 'v24.21.0') { throw 'The bundled Node runtime could not be verified.' }
    $gitMetadata = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'git-runtime.json')) | ConvertFrom-Json
    $gitRelease = $gitMetadata.$Architecture
    $gitArchive = Join-Path $destination 'mingit-download.zip'
    Invoke-WebRequest -Uri ('https://github.com/git-for-windows/git/releases/download/v' + $gitMetadata.version + '/' + $gitRelease.archive) -OutFile $gitArchive -UseBasicParsing -TimeoutSec 180
    if ((Get-FileHash -LiteralPath $gitArchive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $gitRelease.sha256) { throw 'The official MinGit archive failed its pinned integrity check.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($gitArchive)
    try {
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName -match '(^|/)\.\.(/|$)|^[\\/]|[\\:]' -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'The MinGit archive contains an unsafe member.' }
        }
    } finally { $archive.Dispose() }
    Expand-Archive -LiteralPath $gitArchive -DestinationPath (Join-Path $destination 'git')
    Remove-Item -LiteralPath $gitArchive -Force
    $gitVersion = & (Join-Path $destination 'git\cmd\git.exe') --version
    if ($LASTEXITCODE -ne 0 -or $gitVersion -cne ('git version ' + $gitMetadata.version)) { throw 'The bundled Git runtime did not match its pinned release.' }
    foreach ($required in @('cmd/git.exe', ($gitRelease.flavor + '/bin/git-remote-http.exe'), ($gitRelease.flavor + '/libexec/git-core'), 'usr/bin/sh.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $destination ('git/' + $required)))) { throw 'The bundled Git layout is incomplete.' }
    }
    $files = @()
    foreach ($file in Get-ChildItem -LiteralPath $destination -Recurse -File | Sort-Object FullName) {
        $relative = $file.FullName.Substring($destination.Length + 1).Replace('\', '/')
        $files += [ordered]@{ path = $relative; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $manifest = [ordered]@{ schema = 1; platform = 'win32'; architecture = $Architecture; version = $package.version; nodeVersion = 'v24.21.0'; files = $files }
    [IO.File]::WriteAllText((Join-Path $destination 'bundle-manifest.json'), (($manifest | ConvertTo-Json -Depth 6) + "`n"), $utf8)
    & (Join-Path $destination 'Install-Abilock.ps1') -BundlePath $destination -Check
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'The completed bundle did not pass preflight.' }
    Write-Output ('Abilock Windows bundle ready: ' + $destination)
} catch {
    # This directory was created by this invocation and contains public build files only.
    Remove-Item -LiteralPath $destination -Recurse -Force
    throw
}
