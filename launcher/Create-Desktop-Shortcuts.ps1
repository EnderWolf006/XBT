param([string]$Destination = [Environment]::GetFolderPath('Desktop'))

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) { throw '快捷方式目标文件夹不存在。' }
$shell = New-Object -ComObject WScript.Shell
$entries = @(
    @{ Name = '学不通-启动.lnk'; Script = 'Start-XBT.ps1' },
    @{ Name = '学不通-配置.lnk'; Script = 'Configure-XBT.ps1' }
)
foreach ($entry in $entries) {
    $path = Join-Path $Destination $entry.Name
    if (Test-Path -LiteralPath $path) { throw "已存在 $path。为避免覆盖，请先手动处理旧快捷方式。" }
}
foreach ($entry in $entries) {
    $link = $shell.CreateShortcut((Join-Path $Destination $entry.Name))
    $link.TargetPath = Join-Path $PSHOME 'powershell.exe'
    $link.Arguments = '-NoExit -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot $entry.Script) + '"'
    $link.WorkingDirectory = $root
    $link.Description = '使用当前解压目录，不连接原部署者的服务器或数据库。'
    $link.Save()
}
Write-Host "已创建启动和配置快捷方式：$Destination" -ForegroundColor Green
Write-Host '移动项目文件夹后，请删除这两个旧快捷方式，再重新运行本脚本。'
