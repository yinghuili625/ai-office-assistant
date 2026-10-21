. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $pidPath = Join-Path $DataRoot 'local-process.json'
    if (Test-Path -LiteralPath $pidPath) {
        $tracked = Get-PlatformProcess
        if ($tracked) {
            Stop-PlatformProcess $tracked
            Write-Host '本地服务已停止。'
        }
        if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath }
    }
    if ($PreferredMode -ne 'Local' -and (Test-DockerEngine)) { Invoke-Compose @('stop') }
    Write-Host '平台已停止，任务数据完整保留在 E 盘。' -ForegroundColor Green
} catch {
    Write-Host ('停止失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
