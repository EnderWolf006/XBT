param(
    [switch]$CheckOnly,
    [switch]$SmokeTest,
    [ValidateRange(1024, 65535)][int]$ApiPort = 3030,
    [ValidateRange(1024, 65535)][int]$WebPort = 5173
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $root 'Server'
$webDir = Join-Path $root 'Web'
$serverExe = Join-Path $serverDir 'xbt-server.exe'
$configPath = Join-Path $serverDir 'config.yaml'
$vite = Join-Path $webDir 'node_modules\vite\bin\vite.js'
$api = $null
$web = $null
$oldApiTarget = $env:XBT_API_TARGET

function Assert-FreePort([int]$Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch [Net.Sockets.SocketException] { throw "端口 $Port 已被占用。请先关闭对应程序；启动器不会停止其他进程。" }
    finally { $listener.Stop() }
}

function Wait-Health([string]$Url, [Diagnostics.Process]$Process) {
    for ($i = 0; $i -lt 40; $i++) {
        if ($Process.HasExited) { throw "程序提前退出（退出码 $($Process.ExitCode)），请查看本窗口中的错误。" }
        $response = $null
        try { $response = Invoke-RestMethod -Uri $Url -TimeoutSec 2 }
        catch [Net.WebException] { Start-Sleep -Milliseconds 500; continue }
        if ($response.code -eq 0 -and $response.data.service -eq 'xbt2-server') { return }
        throw "健康检查返回了非预期内容：$Url"
    }
    throw "服务启动超时：$Url。请检查数据库是否运行、账号密码是否正确。"
}

try {
    if ($ApiPort -eq $WebPort) { throw '后端与网页端口不能相同。' }
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw '尚未配置。请先双击 Configure-XBT.cmd，按 DEPLOYMENT.md 配置自己的 PostgreSQL 数据库。'
    }
    $configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    if ($configText -match 'CHANGE_ME_|You_can_write_anything_here_but_change_me|host=example\.com') {
        throw '配置仍包含占位符。请修改 Server\config.yaml 中的数据库密码或密钥。'
    }
    if ($configText -notmatch ('(?m)^http_addr:\s*["'']?127\.0\.0\.1:' + $ApiPort + '["'']?\s*$')) {
        throw "配置中的 http_addr 必须设为 127.0.0.1:$ApiPort，与启动参数一致。"
    }
    if (-not (Test-Path -LiteralPath $serverExe)) { throw '缺少 Server\xbt-server.exe，请完整解压部署包。' }
    if (-not (Test-Path -LiteralPath (Join-Path $webDir 'dist\index.html'))) {
        throw '缺少 Web\dist\index.html，请按 DEPLOYMENT.md 重新构建前端。'
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $node -or $null -eq $npm) { throw '请先安装 Node.js 24 LTS（包含 npm），然后重新打开启动器。' }
    $versionText = & $node.Source --version
    if ($LASTEXITCODE -ne 0) { throw '无法读取 Node.js 版本。' }
    $version = [version]$versionText.Trim().TrimStart('v')
    if ($version -lt [version]'22.12.0') { throw "Node.js 版本过低：$version，请使用 Node.js 24 LTS。" }
    Assert-FreePort $ApiPort
    Assert-FreePort $WebPort
    if (-not (Test-Path -LiteralPath $vite)) {
        if ($CheckOnly) { throw '缺少前端依赖，请先在 Web 目录运行 npm ci，或直接使用正常启动入口自动安装。' }
        Write-Host '首次启动正在安装锁定版本的前端依赖，需要联网；失败时不会启动服务。'
        Push-Location $webDir
        try {
            & $npm.Source ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败，请检查网络和上面的错误信息后重试。' }
        } finally { Pop-Location }
    }
    if ($CheckOnly) { Write-Host '配置占位符、依赖和端口检查通过；尚未连接数据库或启动服务。'; return }

    Write-Host '启动本地后端。仅监听本机；关闭此窗口会停止本次启动的后端和网页服务。'
    $api = Start-Process -FilePath $serverExe -WorkingDirectory $serverDir -NoNewWindow -PassThru
    Wait-Health "http://127.0.0.1:$ApiPort/api/health" $api
    $env:XBT_API_TARGET = "http://127.0.0.1:$ApiPort"
    $web = Start-Process -FilePath $node.Source -WorkingDirectory $webDir -NoNewWindow -PassThru `
        -ArgumentList @(('"' + $vite + '"'), 'preview', '--host', '127.0.0.1', '--port', $WebPort, '--strictPort')
    Wait-Health "http://127.0.0.1:$WebPort/api/health" $web
    $page = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$WebPort/" -TimeoutSec 5
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<div id="root">') {
        throw '网页入口检查失败。'
    }
    Write-Host "启动成功：http://127.0.0.1:$WebPort/；按 Ctrl+C 退出。不停止数据库服务。" -ForegroundColor Green
    if ($SmokeTest) { Write-Host '启动检查完成：后端、前端和 API 代理可访问，正在停止本次进程。'; return }
    Start-Process "http://127.0.0.1:$WebPort/"
    while (-not $api.HasExited -and -not $web.HasExited) { Start-Sleep -Seconds 1 }
    throw '后端或网页服务已退出，请检查本窗口日志。'
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    $env:XBT_API_TARGET = $oldApiTarget
    foreach ($process in @($web, $api)) {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction Continue
        }
    }
}
