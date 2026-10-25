@echo off
setlocal
if not defined ABILOCK_FIXTURE_ROOT set "ABILOCK_FIXTURE_ROOT=%TEMP%\AbilockDesktopBuild-20261014"
if not exist "%ABILOCK_FIXTURE_ROOT%\abilock-desktop-build.marker" exit /b 78
start "" /wait "%ABILOCK_FIXTURE_ROOT%\fixture-desktop-net48\Abilock.Desktop.Fixture.exe"
if not exist "%ABILOCK_FIXTURE_ROOT%\net48-results\smoke-report.json" exit /b 1
type "%ABILOCK_FIXTURE_ROOT%\net48-results\smoke-report.json"
endlocal
