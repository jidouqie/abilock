#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-x64',
    [string]$OutputDirectory = '',
    [string]$DotnetPath = 'dotnet',
    [string]$Version = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:DOTNET_CLI_UI_LANGUAGE = 'en'
if ($env:OS -ne 'Windows_NT') {
    throw 'Build the Windows desktop application on Windows.'
}
$projectPath = Join-Path $PSScriptRoot 'Abilock.Desktop.csproj'
if ([string]::IsNullOrWhiteSpace($Version)) {
    $packagePath = Join-Path $PSScriptRoot '..\..\..\package.json'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'Specify the release Version when building outside the project tree.' }
    $Version = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot ('..\..\..\artifacts\desktop\' + $Runtime)
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$dotnetCommand = Get-Command $DotnetPath -CommandType Application -ErrorAction Stop
& $dotnetCommand.Source restore $projectPath --source 'https://api.nuget.org/v3/index.json' --locked-mode
if ($LASTEXITCODE -ne 0) { throw 'Restoring desktop build dependencies failed.' }
$platformTarget = if ($Runtime -eq 'win-x64') { 'x64' } else { 'AnyCPU' }
& $dotnetCommand.Source publish $projectPath --configuration Release --runtime $Runtime --self-contained false --no-restore --output $OutputDirectory ('-p:PlatformTarget=' + $platformTarget) ('-p:Version=' + $Version)
if ($LASTEXITCODE -ne 0) { throw 'Building the desktop application failed.' }
if (-not (Test-Path -LiteralPath (Join-Path $OutputDirectory 'Abilock.exe') -PathType Leaf)) {
    throw 'The desktop build did not produce Abilock.exe.'
}
Write-Output ('Built ' + (Join-Path $OutputDirectory 'Abilock.exe'))
