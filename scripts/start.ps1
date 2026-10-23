param([ValidateSet('Auto','Local','Docker')][string]$Mode = 'Auto', [switch]$NoBrowser)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    Initialize-Platform
    if (Test-Platform) {
        $runningState = Invoke-RestMethod -Uri "$PlatformUrl/api/state?pageSize=1" -TimeoutSec 3
        $ready = $true
        if ($runningState.system.scheduler -eq '工作流调度') {
            try {
                $workflowId = & docker compose --project-directory $ProjectRoot --file (Join-Path $ProjectRoot 'compose.yaml') ps -q n8n 2>$null
                if ($LASTEXITCODE -ne 0 -or -not $workflowId) { throw '当前目录的工作流尚未运行。' }
                $workflowHealth = & docker inspect --format '{{.State.Health.Status}}' $workflowId 2>$null
                if ($LASTEXITCODE -ne 0 -or $workflowHealth -ne 'healthy') { throw '当前目录的工作流尚未就绪。' }
            }
            catch { $ready = $false; $Mode = 'Docker'; Write-Host '任务服务已运行，正在恢复定时工作流……' }
        }
        if ($ready) {
            Write-Host "平台已在运行：$PlatformUrl" -ForegroundColor Green
            if (-not $NoBrowser) { Start-Process $PlatformUrl }
            exit 0
        }
    }
    $dockerReady = if ($Mode -eq 'Local') { $false } else { Test-DockerEngine }
    if ($Mode -eq 'Auto') { if ($dockerReady) { $Mode = 'Docker' } else { $Mode = 'Local' } }
    if ($Mode -eq 'Docker') {
        if (-not $dockerReady) { throw 'Docker 引擎尚未运行。请启动 Docker Desktop 后重试，或用 -Mode Local 直接启动本地版。' }
        Write-Host '正在启动容器与工作流，首次下载镜像可能需要数分钟……'
        Invoke-Compose @('up','-d','--build','--wait','--wait-timeout','240')
        Write-Host '容器和定时工作流已启动。' -ForegroundColor Green
    } else {
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
        if ($values.MAX_STORED_BYTES) { $env:MAX_STORED_BYTES = $values.MAX_STORED_BYTES }
        $serverPath = Join-Path $ProjectRoot 'server.mjs'
        $running = Start-Process -FilePath $nodePath -ArgumentList @('--no-warnings',('"' + $serverPath + '"')) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $DataRoot 'logs\application.log') -RedirectStandardError (Join-Path $DataRoot 'logs\application-error.log')
        @{pid=$running.Id;server=$serverPath;instanceId=$InstanceId;startedAt=$running.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataRoot 'local-process.json') -Encoding UTF8
        for ($i=0; $i -lt 30; $i++) {
            if (Test-Platform) { break }
            $running.Refresh()
            if ($running.HasExited) { throw '服务未能启动，请查看 data\logs\application-error.log。' }
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not (Test-Platform)) { throw '服务健康检查未通过，请查看日志。' }
    Write-Host "平台已启动：$PlatformUrl" -ForegroundColor Green
    Write-Host '请保持电脑开机；关闭浏览器不影响后台任务。结束使用时双击“停止平台.cmd”。'
    if (-not $NoBrowser) { Start-Process $PlatformUrl }
} catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
