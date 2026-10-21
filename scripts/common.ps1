$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -le 5) {
    $windowsModules = Join-Path $PSHOME 'Modules'
    if ($windowsModules -notin @($env:PSModulePath -split ';')) { $env:PSModulePath = $windowsModules + ';' + $env:PSModulePath }
}
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot 'data'
$PlatformPort = 3080
$PreferredMode = 'Auto'
$localConfigPath = Join-Path $ProjectRoot 'platform.local.json'
if (Test-Path -LiteralPath $localConfigPath) {
    $localConfig = Get-Content -LiteralPath $localConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($localConfig.port -isnot [int] -or $localConfig.port -lt 1024 -or $localConfig.port -gt 65535) { throw '本机启动配置中的端口必须为 1024 至 65535 的整数。' }
    if ($localConfig.mode -notin @('Local','Docker')) { throw '本机启动配置中的模式必须为 Local 或 Docker。' }
    if (-not ($localConfig.dataDirectory -is [string]) -or [string]::IsNullOrWhiteSpace($localConfig.dataDirectory)) { throw '本机启动配置缺少数据目录。' }
    $DataRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $localConfig.dataDirectory))
    if (-not $DataRoot.StartsWith($ProjectRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '本机数据目录必须位于项目文件夹内。' }
    $PlatformPort = $localConfig.port
    $PreferredMode = $localConfig.mode
    if ($PreferredMode -eq 'Docker' -and ($PlatformPort -ne 3080 -or $DataRoot -ne (Join-Path $ProjectRoot 'data'))) { throw 'Docker 模式目前使用 3080 端口和 data 目录，请勿混用本地模式的数据位置。' }
}
$PlatformUrl = "http://127.0.0.1:$PlatformPort"

function Get-PlatformCodeSignature {
    $files = @(Get-Item -LiteralPath (Join-Path $ProjectRoot 'server.mjs')) + @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'lib') -Filter '*.mjs' -File)
    $rows = foreach ($file in $files | Sort-Object FullName) { $file.FullName + ':' + (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($rows -join "`n")))).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Get-PlatformProcess {
    $pidPath = Join-Path $DataRoot 'local-process.json'
    if (-not (Test-Path -LiteralPath $pidPath)) { return $null }
    $record = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $serverPath = Join-Path $ProjectRoot 'server.mjs'
    if ($record.server -ne $serverPath) { throw '启动记录不属于当前项目，未操作任何进程。' }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$record.pid) -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $nativeProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    $recordedStart = if ($record.startedAt -is [DateTime]) { $record.startedAt.ToUniversalTime() } elseif ($record.startedAt -is [DateTimeOffset]) { $record.startedAt.UtcDateTime } else { [DateTimeOffset]::Parse($record.startedAt).UtcDateTime }
    if (-not $nativeProcess -or [Math]::Abs(($nativeProcess.StartTime.ToUniversalTime() - $recordedStart).TotalSeconds) -gt 1) { return $null }
    if (-not $process.CommandLine -or -not $process.CommandLine.Contains('"' + $serverPath + '"') -or [IO.Path]::GetFileName($process.ExecutablePath) -ne 'node.exe') { throw '启动记录与实际进程不一致，未操作任何进程。' }
    return @{ record = $record; process = $nativeProcess }
}

function Get-PlatformListener {
    return @(Get-NetTCPConnection -State Listen -LocalPort $PlatformPort -ErrorAction SilentlyContinue)
}

function Stop-PlatformProcess {
    param($Tracked)
    Stop-Process -Id $Tracked.process.Id -ErrorAction Stop
    if (-not $Tracked.process.WaitForExit(10000)) { throw '本地服务尚未退出，请稍后重试。' }
    Remove-Item -LiteralPath (Join-Path $DataRoot 'local-process.json') -ErrorAction SilentlyContinue
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
    try { return (Invoke-RestMethod -Uri "$PlatformUrl/api/health" -TimeoutSec 2).ok -eq $true } catch { return $false }
}

function Find-Node {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $candidates = @()
    if ($nodeCommand) { $candidates += $nodeCommand.Source }
    $candidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    $candidates += 'C:\Program Files\nodejs\node.exe'
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (Test-Path -LiteralPath $candidate) {
            $version = & $candidate --version
            if ([int]$version.TrimStart('v').Split('.')[0] -ge 24) { return $candidate }
        }
    }
    throw '需要 Node.js 24 或以上版本。请安装 Node.js 24 LTS，或先启动 Docker Desktop 后再运行。'
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
