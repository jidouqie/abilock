#requires -Version 5.1
# Temporary public shortcuts and skill folders only. No user entry registration.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The installer has parsing errors.' }
foreach ($name in @('Assert-NoReparse', 'Assert-OwnerRegistrationPaths')) {
    $found = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($found.Count -ne 1) { throw 'The registration preflight function was not found exactly once.' }
    Invoke-Expression $found[0].Extent.Text
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('abilock-owner-tests-' + [Guid]::NewGuid().ToString('N'))
$profile = Join-Path $temporary 'profile'
$programs = Join-Path $temporary 'programs'
$programRoot = Join-Path $temporary 'public-program'
$shortcutPath = Join-Path $programs 'Abilock.lnk'
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.Directory]::CreateDirectory($profile) | Out-Null
[IO.Directory]::CreateDirectory($programs) | Out-Null
$checks = 0
function Expect-Result([bool]$Expected) {
    $accepted = $true
    try { Assert-OwnerRegistrationPaths $profile $programs } catch { $accepted = $false }
    if ($accepted -ne $Expected) { throw 'The user entry preflight accepted an unknown collision or rejected an owned entry.' }
    $script:checks++
}
function Save-FixtureShortcut([string]$Target, [string]$Arguments) {
    $shell = $null; $link = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($shortcutPath)
        $link.TargetPath = $Target; $link.Arguments = $Arguments
        $link.WorkingDirectory = Join-Path $programRoot 'desktop'
        $link.Save()
    } finally {
        foreach ($value in @($link, $shell)) { if ($value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($value) | Out-Null } }
    }
}
try {
    Expect-Result $true
    Save-FixtureShortcut (Join-Path $programRoot 'desktop\Abilock.exe') ''
    $ownedHash = (Get-FileHash -LiteralPath $shortcutPath).Hash
    Expect-Result $true
    if ((Get-FileHash -LiteralPath $shortcutPath).Hash -cne $ownedHash) { throw 'The read-only preflight changed an owned shortcut.' }; $checks++
    Save-FixtureShortcut (Join-Path $programRoot 'unrelated.exe') ''
    $unknownHash = (Get-FileHash -LiteralPath $shortcutPath).Hash
    Expect-Result $false
    if ((Get-FileHash -LiteralPath $shortcutPath).Hash -cne $unknownHash) { throw 'An unrelated shortcut was overwritten.' }; $checks++
    Save-FixtureShortcut (Join-Path $programRoot 'desktop\Abilock.exe') '--unknown'
    Expect-Result $false
    [IO.File]::Delete($shortcutPath)
    [IO.Directory]::CreateDirectory($shortcutPath) | Out-Null
    Expect-Result $false
    [IO.Directory]::Delete($shortcutPath)
    $skill = Join-Path $profile '.codex\skills\abilock'
    [IO.Directory]::CreateDirectory($skill) | Out-Null
    [IO.File]::WriteAllText((Join-Path $skill 'SKILL.md'), "---`nname: unrelated`n---`nKeep this skill`n", $utf8)
    Expect-Result $false
    [IO.File]::WriteAllText((Join-Path $skill 'SKILL.md'), "---`nname: abilock`n---`nSynthetic skill`n", $utf8)
    Expect-Result $true
    [IO.File]::WriteAllText((Join-Path $profile '.codex\abilock-skill-backups'), 'Keep this unknown file', $utf8)
    Expect-Result $false
    [IO.File]::Delete((Join-Path $profile '.codex\abilock-skill-backups'))
    [IO.File]::WriteAllText((Join-Path $profile '.claude'), 'Keep this unknown file', $utf8)
    Expect-Result $false
    Write-Output ('ABILOCK_OWNER_REGISTRATION_TESTS_OK ' + $checks)
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
