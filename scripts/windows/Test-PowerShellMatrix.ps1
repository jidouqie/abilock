#requires -Version 5.1
# Developer test only. Portable tools stay in the supplied test cache directory.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CacheDirectory,
    [Parameter(Mandatory = $true)][string]$HostExecutable
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
$cache = [IO.Path]::GetFullPath($CacheDirectory)
[IO.Directory]::CreateDirectory($cache) | Out-Null
$releases = @(
    @{ version = '7.4.21'; sha256 = 'b47ee814b9fe5fe6b713a26667998cadd6bbb74cb3889fadea56c775f11953a2' },
    @{ version = '7.5.12'; sha256 = 'd7717e274d9bcbbf60334b8a560e3ea20f9da887e9475a9b0e28036ede69b123' },
    @{ version = '7.6.7'; sha256 = 'd2f952ebdbf24386cb8923553aa58e41a846db35a6155ea04c58142a4b16dbb7' }
)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$engines = @((Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\WindowsPowerShell\v1.0\powershell.exe'))
foreach ($release in $releases) {
    $name = 'PowerShell-' + $release.version + '-win-x64.zip'
    $archive = Join-Path $cache $name
    if (-not (Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -Uri ('https://github.com/PowerShell/PowerShell/releases/download/v' + $release.version + '/' + $name) -OutFile $archive -UseBasicParsing -TimeoutSec 180
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $release.sha256) { throw 'A portable PowerShell download failed its pinned SHA-256 check.' }
    $folder = Join-Path $cache ('pwsh-' + $release.version)
    if (-not (Test-Path -LiteralPath $folder)) { Expand-Archive -LiteralPath $archive -DestinationPath $folder }
    $engines += (Join-Path $folder 'pwsh.exe')
}
$records = @()
foreach ($engine in $engines) {
    $name = if ($engine.EndsWith('powershell.exe')) { '5.1' } else { (Split-Path (Split-Path $engine -Parent) -Leaf).Substring(5) }
    $stdout = Join-Path $cache ('test-' + $name + '.stdout.txt')
    $stderr = Join-Path $cache ('test-' + $name + '.stderr.txt')
    $script = '$ErrorActionPreference=''Stop''; $ProgressPreference=''SilentlyContinue''; & ''' + (Join-Path $PSScriptRoot 'Test-Windows.ps1').Replace("'", "''") + ''' -HostExecutable ''' + $HostExecutable.Replace("'", "''") + ''''
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $process = Start-Process -FilePath $engine -ArgumentList ('-NoProfile -EncodedCommand ' + $encoded) -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $text = [IO.File]::ReadAllText($stdout)
    $record = @{ version = $name; exitCode = $process.ExitCode; stdout = $text.Trim(); stderr = [IO.File]::ReadAllText($stderr).Trim() }
    $records += $record
    if ($process.ExitCode -ne 0) { $records | ConvertTo-Json -Depth 6; throw ('PowerShell compatibility tests failed: ' + $name) }
}
$json = $records | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $cache 'matrix-results.json'), $json, (New-Object Text.UTF8Encoding($false)))
Write-Output $json
