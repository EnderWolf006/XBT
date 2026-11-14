param([switch]$NoEditor)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'Server\config.yaml'

function New-Secret {
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    return [Convert]::ToBase64String($bytes)
}

if (-not (Test-Path -LiteralPath $configPath)) {
    $text = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.template.yaml') -Raw -Encoding UTF8
    $text = $text.Replace('CHANGE_ME_JWT_SECRET', (New-Secret))
    $text = $text.Replace('CHANGE_ME_CREDENTIAL_SECRET', (New-Secret))
    [IO.File]::WriteAllText($configPath, $text, [Text.UTF8Encoding]::new($false))
    Write-Host '已创建独立配置并生成随机密钥，未复制任何原部署账号或数据。' -ForegroundColor Green
} else {
    Write-Host '配置已存在，保留原密钥，不覆盖。'
}
Write-Host "请在 postgres_dsn 中填写自己的数据库密码；配置文件：$configPath"
Write-Host '首次部署请先阅读 DEPLOYMENT.md。不要把填写后的配置转发给别人。'
if (-not $NoEditor) {
    Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $configPath + '"') -Wait
}
