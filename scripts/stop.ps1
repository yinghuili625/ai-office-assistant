. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $null = Test-Platform
    $pidPath = Join-Path $DataRoot 'local-process.json'
    if (Test-Path -LiteralPath $pidPath) {
        $record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
        if ($record.instanceId -ne $InstanceId) { throw '本地进程记录不属于当前目录，未停止任何进程。请检查启动目录和 data\local-process.json。' }
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$record.pid) -ErrorAction Stop
        if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -and $process.CommandLine.Contains([string]$record.server) -and [IO.Path]::GetFullPath([string]$record.server) -eq (Join-Path $ProjectRoot 'server.mjs') -and [Math]::Abs((([datetime]$process.CreationDate).ToUniversalTime() - [datetime]::Parse($record.startedAt).ToUniversalTime()).TotalSeconds) -lt 2) {
            $localProcess = [Diagnostics.Process]::GetProcessById([int]$record.pid)
            $localProcess.Kill()
            if (-not $localProcess.WaitForExit(5000)) { throw '本地进程尚未退出，请检查运行日志。' }
            Write-Host '本地服务已停止。'
        }
        elseif ($process) { throw '本地进程信息与启动记录不一致，未停止该进程；请核对启动方式后重试。' }
        Remove-Item -LiteralPath $pidPath
    }
    if (Test-DockerEngine) { Invoke-Compose @('stop') }
    Write-Host ("平台已停止，任务数据保留在：$DataRoot") -ForegroundColor Green
} catch {
    Write-Host ('停止失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
