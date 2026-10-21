. (Join-Path $PSScriptRoot 'common.ps1')
try {
    if (-not (Test-Platform)) { throw '请先启动平台，再生成一致性数据库备份。' }
    $backupRoot = Join-Path $ProjectRoot 'backups'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $target = Join-Path $backupRoot ('办公平台-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.sqlite')
    Invoke-WebRequest -Uri "$PlatformUrl/api/backup" -UseBasicParsing -OutFile $target
    Write-Host ('业务数据库已备份：' + $target) -ForegroundColor Green
    Write-Host ('当前数据目录：' + $DataRoot)
    Write-Host '完整迁移时，请先停止平台，再同时复制当前数据目录、platform.local.json（如有）与 .env 文件。'
} catch {
    Write-Host ('备份失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
