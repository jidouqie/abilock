#requires -Version 5.1
# In-memory error classification only; no protected-file access or installation.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count -ne 0) { throw 'The installer has parsing errors.' }
$found=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-DeferredRepairMetadata'},$false))
if ($found.Count -ne 1) { throw 'The metadata access classifier was not found.' }
Invoke-Expression $found[0].Extent.Text
$candidate=[pscustomobject]@{version='2.2.6';architecture='arm64'}
$original=[pscustomobject]@{version='2.2.3';architecture='arm64'}
$denied=New-Object UnauthorizedAccessException('Synthetic access denial')
$checks=0
function Equal($Value,[bool]$Expected) { if ($Value -ne $Expected) { throw 'An unsafe metadata deferral was accepted or a valid paired repair was rejected.' }; $script:checks++ }
Equal (Test-DeferredRepairMetadata $denied $false $false $candidate $original) $true
Equal (Test-DeferredRepairMetadata $denied $false $false ([pscustomobject]@{version='2.2.7';architecture='arm64'}) $original) $true
Equal (Test-DeferredRepairMetadata $denied $false $false ([pscustomobject]@{version='2.2.7';architecture='arm64'}) ([pscustomobject]@{version='2.2.6';architecture='arm64'})) $false
Equal (Test-DeferredRepairMetadata $denied $true $false $candidate $original) $false
Equal (Test-DeferredRepairMetadata $denied $false $true $candidate $original) $false
Equal (Test-DeferredRepairMetadata $denied $false $false $candidate $null) $false
Equal (Test-DeferredRepairMetadata $denied $false $false ([pscustomobject]@{version='2.2.4';architecture='arm64'}) $original) $false
Equal (Test-DeferredRepairMetadata $denied $false $false $candidate ([pscustomobject]@{version='2.2.4';architecture='arm64'})) $false
Equal (Test-DeferredRepairMetadata $denied $false $false $candidate ([pscustomobject]@{version='2.2.3';architecture='x64'})) $false
foreach ($failureCase in @((New-Object IO.FileNotFoundException('missing')),(New-Object IO.IOException('io')),(New-Object InvalidOperationException('invalid')),(New-Object Runtime.InteropServices.COMException('com',-2147024891)))) {
    Equal (Test-DeferredRepairMetadata $failureCase $false $false $candidate $original) $false
}
$wrapped=New-Object Reflection.TargetInvocationException($denied)
Equal (Test-DeferredRepairMetadata $wrapped $false $false $candidate $original) $true
$misleading=New-Object InvalidOperationException('unrelated',$denied)
Equal (Test-DeferredRepairMetadata $misleading $false $false $candidate $original) $false
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Install-Abilock.ps1'))
Equal ($source.IndexOf('$repairManifest = Get-BundleManifest') -lt $source.IndexOf('$manifest = Get-BundleManifest')) $true
Write-Output ('ABILOCK_METADATA_ACCESS_TESTS_OK '+$checks)
