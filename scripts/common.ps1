$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot 'data'
$PlatformPort = 3080
$WorkflowPort = 5680
if (Test-Path -LiteralPath (Join-Path $ProjectRoot '.env')) {
    foreach ($line in Get-Content -LiteralPath (Join-Path $ProjectRoot '.env')) { if ($line -match '^PORT=(\d+)$') { $PlatformPort = [int]$matches[1] }; if ($line -match '^N8N_EDITOR_PORT=(\d+)$') { $WorkflowPort = [int]$matches[1] } }
}
if ($env:PORT) { $PlatformPort = [int]$env:PORT }
if ($env:N8N_EDITOR_PORT) { $WorkflowPort = [int]$env:N8N_EDITOR_PORT }
if ($PlatformPort -lt 1 -or $PlatformPort -gt 65535) { throw 'PORT 必须是 1 至 65535 的端口。' }
if ($WorkflowPort -lt 1 -or $WorkflowPort -gt 65535) { throw 'N8N_EDITOR_PORT 必须是 1 至 65535 的端口。' }
$PlatformUrl = "http://127.0.0.1:$PlatformPort"
$sha = [Security.Cryptography.SHA256]::Create()
try { $InstanceId = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('office-platform-v1:' + $ProjectRoot.Replace('\','/').TrimEnd('/').ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') }) }
finally { $sha.Dispose() }
$env:PLATFORM_INSTANCE_ID = $InstanceId
$env:PLATFORM_PROJECT_NAME = 'office-' + $InstanceId.Substring(0,12)
# Start-Process on Windows rejects inherited environment keys differing only in case.
$taskEnvironment = [Environment]::GetEnvironmentVariables('Process')
foreach ($group in ($taskEnvironment.GetEnumerator() | Group-Object { $_.Key.ToUpperInvariant() } | Where-Object Count -gt 1)) {
    $taskValue = if ($group.Name -eq 'PATH') { ($group.Group | ForEach-Object { $_.Value }) -join ';' } else { [string]$group.Group[0].Value }
    foreach ($entry in $group.Group) { [Environment]::SetEnvironmentVariable([string]$entry.Key,$null,'Process') }
    $taskKey = if ($group.Name -eq 'PATH') { 'Path' } else { [string]$group.Group[0].Key }
    [Environment]::SetEnvironmentVariable($taskKey,$taskValue,'Process')
}

function Initialize-Platform {
    New-Item -ItemType Directory -Path $DataRoot,(Join-Path $DataRoot 'n8n'),(Join-Path $DataRoot 'logs'),(Join-Path $ProjectRoot 'backups') -Force | Out-Null
    $envPath = Join-Path $ProjectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) {
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $a = New-Object byte[] 32
            $b = New-Object byte[] 32
            $rng.GetBytes($a)
            $rng.GetBytes($b)
            $automation = -join ($a | ForEach-Object { $_.ToString('x2') })
            $encryption = -join ($b | ForEach-Object { $_.ToString('x2') })
            $lines = @("AUTOMATION_KEY=$automation", "N8N_ENCRYPTION_KEY=$encryption", 'SEED_DEMO=1')
            [IO.File]::WriteAllLines($envPath, $lines, (New-Object Text.UTF8Encoding($false)))
        } finally { $rng.Dispose() }
    }
    $envPath = Join-Path $ProjectRoot '.env'
    $configuration = @(Get-Content -LiteralPath $envPath | Where-Object { $_ -notmatch '^(PLATFORM_INSTANCE_ID|PLATFORM_PROJECT_NAME)=' })
    $configuration += @("PLATFORM_INSTANCE_ID=$InstanceId", "PLATFORM_PROJECT_NAME=$env:PLATFORM_PROJECT_NAME")
    [IO.File]::WriteAllLines($envPath, $configuration, (New-Object Text.UTF8Encoding($false)))
}

function Read-PlatformEnvironment {
    $values = @{}
    foreach ($line in (Get-Content -LiteralPath (Join-Path $ProjectRoot '.env'))) {
        if ($line -match '^([A-Z_][A-Z0-9_]*)=([A-Za-z0-9_-]+)$') { $values[$matches[1]] = $matches[2] }
    }
    if ($env:SERVERCHAN_SENDKEY) { $values.SERVERCHAN_SENDKEY = $env:SERVERCHAN_SENDKEY }
    if (-not $values.AUTOMATION_KEY -or -not $values.N8N_ENCRYPTION_KEY) { throw '本地 .env 缺少调度密钥，请检查文件；已有数据时请勿直接删除原密钥。' }
    return $values
}

function Test-Platform {
    try { $health = Invoke-RestMethod -Uri "$PlatformUrl/api/health" -TimeoutSec 2 } catch { return $false }
    if ($health.ok -ne $true -or $health.instanceId -ne $InstanceId) { throw "端口 $PlatformPort 已被其他目录或旧版平台占用。请先停止原平台，或在本项目 .env 设置独立 PORT；没有操作其他实例的数据。" }
    return $true
}

function Find-Node {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $candidates = @()
    $runtimeRoot = Join-Path $ProjectRoot '.runtime'
    if (Test-Path -LiteralPath $runtimeRoot) { $candidates += @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'node-v*-win-*' | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'node.exe' }) }
    if ($nodeCommand) { $candidates += $nodeCommand.Source }
    $candidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    $candidates += 'C:\Program Files\nodejs\node.exe'
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (Test-Path -LiteralPath $candidate) {
            $version = & $candidate --version
            $number = [version]$version.TrimStart('v')
            if (($number.Major -eq 24 -and $number -ge [version]'24.22.1') -or ($number.Major -eq 26 -and $number -ge [version]'26.12.1')) { return $candidate }
        }
    }
    throw '需要带安全补丁的 Node.js 24.22.1+（24.x）或 26.12.1+（26.x）。可将官方 Windows 便携版解压至本项目 .runtime，或使用已更新镜像的 Docker 模式。'
}

function Test-DockerEngine {
    $dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
    if (-not $dockerCommand) { return $false }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $dockerCommand.Source
    $startInfo.Arguments = 'info --format "{{.ServerVersion}}"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $probe = [Diagnostics.Process]::Start($startInfo)
    try {
        if (-not $probe.WaitForExit(5000)) { $probe.Kill(); return $false }
        return $probe.ExitCode -eq 0
    } finally { $probe.Dispose() }
}

function Invoke-Compose {
    param([string[]]$ComposeArguments)
    & docker compose --project-directory $ProjectRoot --file (Join-Path $ProjectRoot 'compose.yaml') @ComposeArguments
    if ($LASTEXITCODE -ne 0) { throw ('容器命令未完成，退出码：' + $LASTEXITCODE) }
}
