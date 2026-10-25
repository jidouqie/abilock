#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\native\windows\prebuilt')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This build must run on Windows.' }
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) { throw 'Use a 64-bit PowerShell process.' }
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\native\windows\Abilock.Host.cs'))
$compiler = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw '.NET Framework 4.8 compiler was not found.' }
$destination = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null
$output = Join-Path $destination 'Abilock.Host.exe'
& $compiler /nologo /target:exe /platform:anycpu /optimize+ /warnaserror+ /r:System.Core.dll /r:System.Web.Extensions.dll /r:Microsoft.CSharp.dll "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw 'The Windows host did not compile.' }
& $output self-test
if ($LASTEXITCODE -ne 0) { throw 'The Windows host self-test failed.' }
$gitSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\native\windows\Abilock.GitSsh.cs'))
$gitOutput = Join-Path $destination 'Abilock.GitSsh.exe'
& $compiler /nologo /target:exe /platform:anycpu /optimize+ /warnaserror+ /r:System.Core.dll /r:System.Web.Extensions.dll "/out:$gitOutput" $gitSource
if ($LASTEXITCODE -ne 0) { throw 'The Windows Git bridge did not compile.' }
$manifest = [ordered]@{ schema = 1; target = 'windows-net48'; sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant(); sha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant(); gitSourceSha256 = (Get-FileHash -LiteralPath $gitSource -Algorithm SHA256).Hash.ToLowerInvariant(); gitSha256 = (Get-FileHash -LiteralPath $gitOutput -Algorithm SHA256).Hash.ToLowerInvariant() }
[IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), (($manifest | ConvertTo-Json) + "`n"), (New-Object Text.UTF8Encoding($false)))
Write-Output 'Abilock Windows host built successfully.'
