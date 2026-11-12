param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$nodeCommand = Get-Command node -ErrorAction Stop
$nodeExecutable = (& $nodeCommand.Source -p 'process.execPath').Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nodeExecutable)) { throw 'Could not locate the Node.js runtime.' }
$runtimeDir = Join-Path $projectRoot '.local\runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$appUrl = 'http://localhost:4317'
$healthUrl = 'http://127.0.0.1:4317/api/health'
try {
    $health = Invoke-RestMethod $healthUrl -TimeoutSec 2
    if ($health.ok -and $health.version -eq '0.1.0') {
        Write-Host "Agent Family is already running at $appUrl"
        if (-not $NoBrowser) { Start-Process $appUrl }
        exit 0
    }
} catch { }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist-server\index.js'))) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}
$serverPath = Join-Path $projectRoot 'dist-server\index.js'
$serverProcess = Start-Process -FilePath $nodeExecutable -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'server.log') -RedirectStandardError (Join-Path $runtimeDir 'server-error.log') -PassThru
Set-Content -LiteralPath (Join-Path $runtimeDir 'server.pid') -Value $serverProcess.Id -Encoding ascii
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 400
    if ($serverProcess.HasExited) { throw "Agent Family stopped. See $runtimeDir\server-error.log" }
    try {
        $health = Invoke-RestMethod $healthUrl -TimeoutSec 2
        if ($health.ok) {
            Write-Host "Agent Family is ready at $appUrl"
            if (-not $NoBrowser) { Start-Process $appUrl }
            exit 0
        }
    } catch { }
}
throw "Agent Family did not become ready. See $runtimeDir\server-error.log"
