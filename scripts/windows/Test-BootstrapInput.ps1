#requires -Version 5.1
# Compile a synthetic stdin receiver in a temporary directory. No installation.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-Abilock.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The installer did not parse.' }
foreach ($name in @('Get-BootstrapFailureInfo','Get-BootstrapFailureIndex','New-BootstrapFailure','Get-NativeFailureStage','Invoke-Bootstrap')) {
    $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
    if ($definitions.Count -ne 1) { throw 'A production bootstrap function was not found.' }
    Invoke-Expression $definitions[0].Extent.Text
}
$programRoot = Join-Path ([IO.Path]::GetTempPath()) ('abilock-bootstrap-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($programRoot) | Out-Null
try {
    $source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
internal static class Receiver {
    private static int Main(string[] args) {
        if (args.Length != 1 || args[0] != "bootstrap-client") return 2;
        string input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)).ReadToEnd();
        Dictionary<string, object> request = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(input);
        if (request.Count == 1 && request.ContainsKey("mode")) {
            string mode = (string)request["mode"];
            if (mode == "empty") return 3;
            if (mode == "malformed") { Console.WriteLine("FAKE_SECRET_MUST_NOT_ESCAPE"); return 3; }
            if (mode == "known") { Console.WriteLine("{\"ok\":false,\"event\":\"bootstrap-failed\",\"stage\":\"initialize\",\"code\":\"CONFIG_REQUIRED\"}"); return 3; }
            if (mode == "extra") { Console.WriteLine("{\"ok\":false,\"event\":\"bootstrap-failed\",\"stage\":\"initialize\",\"code\":\"CONFIG_REQUIRED\",\"message\":\"FAKE_SECRET_MUST_NOT_ESCAPE\"}"); return 3; }
            if (mode == "success-array") { Console.WriteLine("{\"ok\":true,\"event\":[\"initialized\"]}"); return 0; }
            return 3;
        }
        if (request.Count != 1 || !request.ContainsKey("password") || (string)request["password"] != "Test-\u4e2d\u6587\ud83d\ude00") return 3;
        Console.WriteLine("{\"ok\":true,\"event\":\"initialized\"}"); return 0;
    }
}
'@
    $sourcePath = Join-Path $programRoot 'Receiver.cs'
    [IO.File]::WriteAllText($sourcePath, $source, (New-Object Text.UTF8Encoding($false)))
    $compiler = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:exe /r:System.Web.Extensions.dll (('/out:' + (Join-Path $programRoot 'Abilock.Host.exe'))) $sourcePath
    if ($LASTEXITCODE -ne 0) { throw 'The synthetic receiver did not compile.' }
    $fake = 'Test-' + [char]0x4e2d + [char]0x6587 + [char]::ConvertFromUtf32(0x1f600)
    $result = Invoke-Bootstrap @{ password = $fake }
    if ($result -cne 'initialized') { throw 'The production bootstrap sender did not preserve UTF-8 input.' }
    $checks = 1
    foreach ($mode in @('empty','malformed','known','extra','success-array')) {
        $caught = $null
        try { Invoke-Bootstrap @{ mode = $mode } | Out-Null } catch { $caught = $_.Exception }
        $expected = if ($mode -eq 'known') { 25 } else { 33 }
        if (-not $caught -or $caught.Data['AbilockBootstrapFailure'] -ne $expected -or $caught.Message.Contains('FAKE_SECRET_MUST_NOT_ESCAPE')) { throw 'A bootstrap response escaped the fixed diagnostic boundary.' }
        $checks++
    }
    Write-Output ('ABILOCK_BOOTSTRAP_UTF8_TESTS_OK ' + $checks)
} finally { Remove-Item -LiteralPath $programRoot -Recurse -Force }
