#requires -Version 5.1
# Build only inside the previously authorized, marked temporary directory.
[CmdletBinding()]
param([string]$BuildRoot = $env:ABILOCK_FIXTURE_ROOT)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
if ([string]::IsNullOrWhiteSpace($BuildRoot)) { $BuildRoot = Join-Path ([IO.Path]::GetTempPath()) 'AbilockDesktopBuild-20261014' }
$buildRoot = [IO.Path]::GetFullPath($BuildRoot)
$env:ABILOCK_FIXTURE_ROOT = $buildRoot
if ([IO.File]::ReadAllText((Join-Path $buildRoot 'abilock-desktop-build.marker')) -ne 'Abilock desktop build 20261014') { throw 'Invalid fixture marker.' }
$env:DOTNET_CLI_HOME = Join-Path $buildRoot 'dotnet-home'
$env:NUGET_PACKAGES = Join-Path $buildRoot 'nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_CLI_UI_LANGUAGE = 'en'
$env:DOTNET_NOLOGO = '1'
$source = Join-Path $buildRoot 'source-net48'
Expand-Archive -LiteralPath (Join-Path $buildRoot 'windows-net48-source.zip') -DestinationPath $source -Force
$dotnet = Join-Path $buildRoot 'dotnet\dotnet.exe'
$project = Join-Path $source 'windows\Abilock.Desktop.csproj'
& $dotnet restore $project --source 'https://api.nuget.org/v3/index.json' --force-evaluate
if ($LASTEXITCODE -ne 0) { throw 'The Framework candidate dependencies did not restore.' }
foreach ($runtime in @('win-arm64','win-x64')) {
    & (Join-Path $source 'windows\Build.ps1') -Runtime $runtime -OutputDirectory (Join-Path $buildRoot ('release-net48\' + $runtime)) -DotnetPath $dotnet -Version '2.2.0'
    if ($LASTEXITCODE -ne 0) { throw 'The Framework desktop did not build.' }
}
& $dotnet build (Join-Path $source 'windows-tests\PolicyTests.csproj') --configuration Release
if ($LASTEXITCODE -ne 0) { throw 'The Framework policy tests did not build.' }
& (Join-Path $source 'windows-tests\bin\Release\net48\PolicyTests.exe')
if ($LASTEXITCODE -ne 0) { throw 'The Framework policy and lifecycle tests did not pass.' }
& $dotnet publish (Join-Path $source 'windows-fixture\Abilock.Fixture.csproj') --configuration Release --self-contained false --output (Join-Path $buildRoot 'fixture-net48') --source 'https://api.nuget.org/v3/index.json'
if ($LASTEXITCODE -ne 0) { throw 'The Framework fake host did not build.' }
& $dotnet publish $project --configuration Release --runtime win-arm64 --self-contained false --no-restore --output (Join-Path $buildRoot 'fixture-desktop-net48') '-p:DefineConstants=ABILOCK_DESKTOP_TEST_FIXTURE' '-p:AssemblyName=Abilock.Desktop.Fixture' '-p:PlatformTarget=AnyCPU' '-p:Version=2.2.0'
if ($LASTEXITCODE -ne 0) { throw 'The Framework fake desktop did not build.' }
Write-Output 'Framework desktop and synthetic fixtures built. No GUI was started.'
