#requires -Version 5.1
# Deterministic tests only. No installation, accounts, tasks, registry or private data.
[CmdletBinding()]
param([string]$InstallerPath = (Join-Path $PSScriptRoot 'Install-Abilock.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($InstallerPath), [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The installer has parsing errors.' }
foreach ($name in @('Get-RecoveryAction','Assert-Initialized')) {
    $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($definitions.Count -ne 1) { throw 'The recovery function was not found exactly once.' }
    Invoke-Expression $definitions[0].Extent.Text
}
$OwnerSid = 'S-1-5-21-111-222-333-1001'
$serviceSid = 'S-1-5-21-111-222-333-2001'
function Journal([string]$Phase = 'prepared', [bool]$Existing = $false, [string]$Sid = '') {
    return [pscustomobject]@{ schema = 2; nonce = ('a' * 32); ownerSid = $OwnerSid; phase = $Phase; existing = $Existing; serviceSid = $Sid; bundleHash = ('b' * 64) }
}
$checks = 0
function Equal($Actual, $Expected) { if ($Actual -cne $Expected) { throw 'A recovery decision was incorrect.' }; $script:checks++ }
function Reject([scriptblock]$Action) { $failed = $false; try { & $Action } catch { $failed = $true }; if (-not $failed) { throw 'An invalid recovery state was accepted.' }; $script:checks++ }
Equal (Get-RecoveryAction (Journal) $false $false $false) 'resume-fresh'
Equal (Get-RecoveryAction (Journal 'prepared') $false $false $true) 'resume-fresh'
Equal (Get-RecoveryAction (Journal 'account-created' $false $serviceSid) $false $false $true) 'resume-fresh'
Equal (Get-RecoveryAction (Journal 'new-active' $false $serviceSid) $true $false $true) 'resume-fresh'
Equal (Get-RecoveryAction (Journal 'initialized' $false $serviceSid) $true $true $true) 'finish-fresh'
Equal (Get-RecoveryAction (Journal 'committed' $false $serviceSid) $true $true $true) 'finish-fresh'
foreach ($phase in @('prepared','old-moved','new-active','committed','rolled-back')) {
    Equal (Get-RecoveryAction (Journal $phase $true $serviceSid) $true $true $true) 'recover-upgrade'
}
Reject { Get-RecoveryAction (Journal 'account-created' $false $serviceSid) $false $false $false }
Reject { Get-RecoveryAction (Journal 'initialized' $false $serviceSid) $false $true $true }
Reject { Get-RecoveryAction (Journal 'initialized' $false $serviceSid) $true $true $false }
Reject { $bad = Journal; $bad.schema = 1; Get-RecoveryAction $bad $false $false $false }
Reject { $bad = Journal; $bad.nonce = '../unknown'; Get-RecoveryAction $bad $false $false $false }
Reject { $bad = Journal; $bad.phase = 'unknown'; Get-RecoveryAction $bad $false $false $false }
$receipt = [pscustomobject]@{ schema = 1; initialized = $true; ownerSid = $OwnerSid; serviceSid = $serviceSid }
Assert-Initialized $receipt $serviceSid; $checks++
Reject { Assert-Initialized $receipt 'S-1-5-21-111-222-333-9999' }
Reject { $bad = $receipt.PSObject.Copy(); $bad.ownerSid = 'S-1-5-21-111-222-333-9999'; Assert-Initialized $bad $serviceSid }
Reject { $bad = $receipt.PSObject.Copy(); $bad.initialized = $false; Assert-Initialized $bad $serviceSid }
foreach ($script in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File) {
    foreach ($value in [IO.File]::ReadAllBytes($script.FullName)) { if ($value -gt 127) { throw 'A Windows script contains non-ASCII bytes.' } }
    $scriptErrors = $null; $scriptTokens = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$scriptTokens, [ref]$scriptErrors)
    if ($scriptErrors.Count -ne 0) { throw 'A Windows script has parsing errors.' }
}
Write-Output ('ABILOCK_RECOVERY_TESTS_OK ' + $checks)
