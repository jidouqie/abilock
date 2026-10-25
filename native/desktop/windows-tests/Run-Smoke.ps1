#requires -Version 5.1
# Compatibility build entry. GUI verification is started from the interactive desktop.
[CmdletBinding()]
param([switch]$PrepareOnly, [string]$Version = '2.2.0')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($Version -cne '2.2.0') { throw 'This fixed synthetic fixture is for Abilock 2.2.0.' }
& (Join-Path $PSScriptRoot 'Prepare-Net48.ps1')
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'The synthetic Framework build did not complete.' }
Write-Output 'Open Run-WindowSmoke-Net48.cmd from the interactive Windows desktop. No GUI was started by this script.'
