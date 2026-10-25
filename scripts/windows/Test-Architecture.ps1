#requires -Version 5.1
# Read-only native OS query and deterministic synthetic architecture decisions.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The installer has parsing errors.' }
foreach ($name in @('Get-NativeWindowsPlatform','Resolve-WindowsArchitecture','Get-FrameworkRelease','Assert-WindowsPrerequisites')) {
    $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($definitions.Count -ne 1) { throw 'The architecture function was not found exactly once.' }
    Invoke-Expression $definitions[0].Extent.Text
}
$checks = 0
function Equal($Actual, $Expected) { if ($Actual -cne $Expected) { throw 'An architecture decision was incorrect.' }; $script:checks++ }
function Reject([scriptblock]$Action) { $failed = $false; try { & $Action } catch { $failed = $true }; if (-not $failed) { throw 'An incompatible architecture was accepted.' }; $script:checks++ }
Equal (Resolve-WindowsArchitecture 'auto' 'x64' 22631) 'x64'
Equal (Resolve-WindowsArchitecture 'auto' 'arm64' 22631) 'arm64'
Equal (Resolve-WindowsArchitecture '' 'arm64' 22631) 'arm64'
Equal (Resolve-WindowsArchitecture 'x64' 'x64' 19045) 'x64'
Equal (Resolve-WindowsArchitecture 'arm64' 'arm64' 22631) 'arm64'
Equal (Resolve-WindowsArchitecture 'x64' 'arm64' 22000) 'x64'
Equal (Resolve-WindowsArchitecture 'x64' 'arm64' 22631) 'x64'
Reject { Resolve-WindowsArchitecture 'arm64' 'x64' 22631 }
Reject { Resolve-WindowsArchitecture 'arm64' 'x64' 99999 }
Reject { Resolve-WindowsArchitecture 'x64' 'arm64' 21999 }
Reject { Resolve-WindowsArchitecture 'x64' 'x86' 22631 }
Reject { Resolve-WindowsArchitecture 'unknown' 'arm64' 22631 }
Reject { Resolve-WindowsArchitecture 'x64' 'x64' -1 }
$actual = Get-NativeWindowsPlatform
if ($actual.architecture -notin @('x64','arm64') -or $actual.build -lt 1) { throw 'The read-only native Windows platform query failed.' }
$checks++
Equal (Resolve-WindowsArchitecture 'auto' $actual.architecture $actual.build) $actual.architecture
# A bundle check must reject its incompatible architecture before any UAC branch.
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Install-Abilock.ps1'))
if ($source.IndexOf('$manifest = Get-BundleManifest') -ge $source.IndexOf('-Verb RunAs')) { throw 'Architecture preflight no longer precedes UAC.' }
$checks++
foreach ($entry in @(@('x64',19045,528040), @('x64',22631,533320), @('arm64',22000,533320), @('arm64',26100,533509))) {
    Assert-WindowsPrerequisites $entry[0] $entry[1] $entry[2]; $checks++
}
Reject { Assert-WindowsPrerequisites 'arm64' 19045 533320 }
Reject { Assert-WindowsPrerequisites 'arm64' 22631 528040 }
Reject { Assert-WindowsPrerequisites 'x64' 19045 528039 }
Reject { Assert-WindowsPrerequisites 'x64' 9600 528040 }
Reject { Assert-WindowsPrerequisites 'unknown' 22631 533320 }
Assert-WindowsPrerequisites $actual.architecture $actual.build (Get-FrameworkRelease); $checks++
Write-Output ('ABILOCK_ARCHITECTURE_TESTS_OK ' + $checks)
