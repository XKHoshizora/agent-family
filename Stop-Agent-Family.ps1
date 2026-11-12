$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$pidFile = Join-Path $projectRoot '.local\runtime\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No managed Agent Family process found.'; exit 0 }
$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"
$expectedPath = Join-Path $projectRoot 'dist-server\index.js'
if ($serverProcess -and $serverProcess.CommandLine -like ('*' + $expectedPath + '*')) {
    Stop-Process -Id $serverPid
    Remove-Item -LiteralPath $pidFile
    Write-Host 'Agent Family stopped. Chat history is preserved.'
} elseif ($serverProcess) { throw 'The recorded process is not this Agent Family server. It was not stopped.' }
else { Remove-Item -LiteralPath $pidFile; Write-Host 'Agent Family is already stopped.' }
