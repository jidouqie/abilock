#requires -Version 5.1
# In-memory ACL and version decisions only. No filesystem ACL or task changes.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The installer did not parse.' }
foreach ($name in @('Assert-DaclShape','Assert-Protected','Assert-Private','Assert-ParentAcl','Assert-Task','Assert-NonDowngrade')) {
    $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($definitions.Count -ne 1) { throw 'A policy function was not found.' }
    Invoke-Expression $definitions[0].Extent.Text
}
$systemSid = 'S-1-5-18'; $administratorsSid = 'S-1-5-32-544'
$OwnerSid = 'S-1-5-21-111-222-333-1001'; $serviceSid = 'S-1-5-21-111-222-333-2001'
$programRoot = 'C:\SyntheticAbilock'
function Assert-NoReparse([string]$Path) { }
function Get-Acl([string]$LiteralPath) { return $script:fixtureAcl }
function Set-FixtureAcl([string]$Sddl) {
    $script:fixtureSddl = $Sddl
    $script:fixtureAcl = New-Object Security.AccessControl.DirectorySecurity
    $script:fixtureAcl.SetSecurityDescriptorSddlForm($Sddl)
}
$checks = 0
function Accept([scriptblock]$Action) { & $Action; $script:checks++ }
function Reject([scriptblock]$Action) { $failed = $false; try { & $Action } catch { $failed = $true }; if (-not $failed) { throw 'An unsafe policy fixture was accepted.' }; $script:checks++ }
$actions = [pscustomobject]@{ Count = 1; Value = [pscustomobject]@{ Path = 'C:\SyntheticAbilock\Abilock.Host.exe'; Arguments = 'worker execute $(Arg0)' } }
$actions | Add-Member -MemberType ScriptMethod -Name Item -Value { param($index) return $this.Value }
$task = [pscustomobject]@{ Definition = [pscustomobject]@{ Actions = $actions; Principal = [pscustomobject]@{ UserId = $serviceSid; LogonType = 1 }; Triggers = [pscustomobject]@{ Count = 0 }; Settings = [pscustomobject]@{ MultipleInstances = 0 } } }
$task | Add-Member -MemberType ScriptMethod -Name GetSecurityDescriptor -Value { param($flags) return $script:fixtureSddl }
Set-FixtureAcl ('O:BAG:BAD:P(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;' + $OwnerSid + ')')
Accept { Assert-Protected 'C:\Synthetic' }; Accept { Assert-Task $task 'execute' $serviceSid }
foreach ($rights in @('GW','GA')) {
    Set-FixtureAcl ('O:BAG:BAD:P(A;;FA;;;BA)(A;;' + $rights + ';;;' + $OwnerSid + ')')
    Reject { Assert-Protected 'C:\Synthetic' }; Reject { Assert-ParentAcl 'C:\' }; Reject { Assert-Task $task 'execute' $serviceSid }
}
Set-FixtureAcl 'O:BAG:BAD:NO_ACCESS_CONTROL'
Reject { Assert-Protected 'C:\Synthetic' }; Reject { Assert-Private 'C:\Synthetic' $serviceSid }; Reject { Assert-ParentAcl 'C:\' }; Reject { Assert-Task $task 'execute' $serviceSid }
$objectAce = New-Object Security.AccessControl.RawSecurityDescriptor('O:BAG:BAD:P(OA;;GW;00112233-4455-6677-8899-aabbccddeeff;;AU)')
Reject { Assert-DaclShape $objectAce }
Set-FixtureAcl 'O:BAG:BAD:P(A;;FA;;;BA)(A;;FA;;;SY)(A;;0x4;;;AU)(A;OICIIO;FA;;;CO)'
Accept { Assert-ParentAcl 'C:\' }
Accept { Assert-NonDowngrade '2.2.0' '2.2.0' }; Accept { Assert-NonDowngrade '2.3.0' '2.2.9' }
Accept { Assert-NonDowngrade '2.2.0' '2.2.0-rc.1' }; Accept { Assert-NonDowngrade '2.2.0-rc.10' '2.2.0-rc.2' }
Reject { Assert-NonDowngrade '2.1.9' '2.2.0' }; Reject { Assert-NonDowngrade '2.2.0-rc.2' '2.2.0-rc.10' }
Reject { Assert-NonDowngrade '2.2.0-rc.1' '2.2.0' }; Reject { Assert-NonDowngrade 'invalid' '2.2.0' }
Write-Output ('ABILOCK_ACL_POLICY_TESTS_OK ' + $checks)
