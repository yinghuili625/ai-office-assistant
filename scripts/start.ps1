param([ValidateSet('Auto','Local','Docker')][string]$Mode = 'Auto', [switch]$NoBrowser)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    Initialize-Platform
    if ($Mode -eq 'Auto' -and $PreferredMode -ne 'Auto') { $Mode = $PreferredMode }
    if ($Mode -eq 'Docker' -and ($PlatformPort -ne 3080 -or $DataRoot -ne (Join-Path $ProjectRoot 'data'))) { throw '当前数据使用本地模式，请直接双击启动平台，或使用 -Mode Local。' }
    $signature = Get-PlatformCodeSignature
    $tracked = Get-PlatformProcess
    if ($tracked) {
        if ($Mode -eq 'Docker') { throw '当前本地服务仍在运行，请先停止平台后再切换 Docker 模式。' }
        $Mode = 'Local'
        $listeners = @(Get-PlatformListener)
        if (@($listeners | Where-Object { $_.OwningProcess -ne $tracked.process.Id }).Count -gt 0) { throw '平台端口被其他进程占用，未自动打开或停止其他程序。' }
        if ($tracked.record.codeSignature -eq $signature -and $tracked.record.port -eq $PlatformPort -and $tracked.record.dataDirectory -eq $DataRoot -and (Test-Platform)) {
            Write-Host "平台已在运行：$PlatformUrl" -ForegroundColor Green
            if (-not $NoBrowser) { Start-Process $PlatformUrl }
            exit 0
        }
        Write-Host '正在更新本地后台服务，已有任务和模型配置会保留……'
        Stop-PlatformProcess $tracked
    }
    $dockerReady = Test-DockerEngine
    if ($Mode -eq 'Auto') { if ($dockerReady) { $Mode = 'Docker' } else { $Mode = 'Local' } }
    if ($Mode -eq 'Docker') {
        if (-not $dockerReady) { throw 'Docker 引擎尚未运行。请启动 Docker Desktop 后重试，或用 -Mode Local 直接启动本地版。' }
        Write-Host '正在启动容器与工作流，首次下载镜像可能需要数分钟……'
        Invoke-Compose @('up','-d','--build','--wait','--wait-timeout','240')
        Write-Host '容器和定时工作流已启动。' -ForegroundColor Green
    } else {
        if (@(Get-PlatformListener).Count -gt 0) { throw "端口 $PlatformPort 已有未登记的服务运行，未自动打开错误页面。请先停止该服务后重试。" }
        Write-Host '正在使用本地模式，内置定时器每分钟检查固定任务与提醒。'
        $nodePath = Find-Node
        $values = Read-PlatformEnvironment
        $env:AUTOMATION_KEY = $values.AUTOMATION_KEY
        $env:PORT = [string]$PlatformPort
        $env:HOST = '127.0.0.1'
        $env:DATA_DIR = $DataRoot
        $env:SCHEDULER = 'internal'
        $env:TZ = 'Asia/Shanghai'
        $env:SEED_DEMO = $values.SEED_DEMO
        $env:SERVERCHAN_SENDKEY = $values.SERVERCHAN_SENDKEY
        $serverPath = Join-Path $ProjectRoot 'server.mjs'
        $running = Start-Process -FilePath $nodePath -ArgumentList @('--no-warnings',('"' + $serverPath + '"')) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $DataRoot 'logs\application.log') -RedirectStandardError (Join-Path $DataRoot 'logs\application-error.log')
        @{pid=$running.Id;server=$serverPath;startedAt=$running.StartTime.ToUniversalTime().ToString('o');port=$PlatformPort;dataDirectory=$DataRoot;codeSignature=$signature} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataRoot 'local-process.json') -Encoding UTF8
        for ($i=0; $i -lt 30; $i++) {
            $running.Refresh()
            if ($running.HasExited) { throw ('服务未能启动，请查看 ' + (Join-Path $DataRoot 'logs\application-error.log')) }
            if ((Test-Platform) -and @((Get-PlatformListener) | Where-Object { $_.OwningProcess -eq $running.Id }).Count -gt 0) { break }
            Start-Sleep -Milliseconds 500
        }
        if (@((Get-PlatformListener) | Where-Object { $_.OwningProcess -eq $running.Id }).Count -eq 0) { throw '当前端口与本次启动的服务不一致，未打开页面。' }
    }
    if (-not (Test-Platform)) { throw '服务健康检查未通过，请查看日志。' }
    Write-Host "平台已启动：$PlatformUrl" -ForegroundColor Green
    Write-Host '请保持电脑开机；关闭浏览器不影响后台任务。结束使用时双击“停止平台.cmd”。'
    if (-not $NoBrowser) { Start-Process $PlatformUrl }
} catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
