# 部署到远程服务器（只监听服务器的 127.0.0.1，用 SSH 隧道访问）。
# 用法：
#   .\deploy\deploy.ps1 -InspectOnly   只读检查服务器，不改任何东西
#   .\deploy\deploy.ps1                构建、打包、上传、安装、验证
#   .\deploy\deploy.ps1 -Uninstall     卸载（保留数据）
# 这台服务器每次 SSH 握手要十几秒，所以每个流程只用 1 次 scp 加 1 次 ssh。
param(
  [string]$Server = '8.133.179.238',
  [string]$User = 'admin',
  [string]$Key = "$env:USERPROFILE\.ssh\id_ed25519_devlane",
  [int]$Port = 7790,
  [switch]$InspectOnly,
  [switch]$Uninstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$sshOpts = @('-i', $Key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15')
$target = "$User@$Server"

function Send-Files([string[]]$files) {
  & scp @sshOpts @files "${target}:/tmp/"
  if ($LASTEXITCODE -ne 0) { throw "上传失败 (exit $LASTEXITCODE)" }
}

# 注意：Windows PowerShell 5.1 会吞掉传给 ssh 的命令里的双引号，所以命令里不要用引号
function Invoke-Remote([string]$cmd) {
  & ssh @sshOpts $target $cmd 2>&1 | ForEach-Object { Write-Host $_ }
  return $LASTEXITCODE
}

if ($InspectOnly) {
  Write-Host "== 只读检查 $target =="
  Send-Files @("$root\deploy\remote-inspect.sh")
  $rc = Invoke-Remote "sudo env DEVLANE_PORT=$Port sh /tmp/remote-inspect.sh; rc=`$?; rm -f /tmp/remote-inspect.sh; exit `$rc"
  exit $rc
}

if ($Uninstall) {
  Send-Files @("$root\deploy\remote-uninstall.sh")
  $rc = Invoke-Remote "sudo env DEVLANE_PORT=$Port sh /tmp/remote-uninstall.sh; rc=`$?; rm -f /tmp/remote-uninstall.sh; exit `$rc"
  exit $rc
}

if (-not $SkipBuild) {
  Write-Host '== 构建 =='
  npm run typecheck; if ($LASTEXITCODE -ne 0) { throw '类型检查失败' }
  npm test; if ($LASTEXITCODE -ne 0) { throw '测试失败' }
  npm run pack; if ($LASTEXITCODE -ne 0) { throw '打包失败' }
}
if (-not (Test-Path "$root\release\devlane.tgz")) { throw '缺少 release\devlane.tgz，请先 npm run pack' }

Write-Host "== 上传到 $target =="
Send-Files @("$root\release\devlane.tgz", "$root\deploy\remote-deploy.sh")

Write-Host '== 安装与验证 =='
$rc = Invoke-Remote "sudo env DEVLANE_PORT=$Port sh /tmp/remote-deploy.sh"

Write-Host ''
if ($rc -eq 0) {
  Write-Host '部署完成。用下面的命令建立隧道，然后在本机浏览器打开：' -ForegroundColor Green
  Write-Host "  .\deploy\tunnel.ps1" -ForegroundColor Green
  Write-Host "  http://127.0.0.1:$Port"
} else {
  Write-Host "部署未成功 (exit $rc)，见上方输出" -ForegroundColor Red
}
exit $rc
