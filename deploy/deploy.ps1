# 一键部署到远程服务器。
# 用法：
#   .\deploy\deploy.ps1 -InspectOnly      只读检查服务器，不改任何东西
#   .\deploy\deploy.ps1                   测试、打包、上传、安装、验证
#   .\deploy\deploy.ps1 -Uninstall        卸载 DevLane（保留数据）
# 这台服务器每次 SSH 握手要十几秒，所以整个流程只用 1 次 scp 加 1 次 ssh。
param(
  [string]$Server = '8.133.179.238',
  [string]$User = 'admin',
  [string]$Key = "$env:USERPROFILE\.ssh\id_ed25519_devlane",
  [int]$Port = 18090,
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

function Invoke-Remote([string]$cmd, [string]$stdin = $null) {
  if ($null -ne $stdin) { $stdin | & ssh @sshOpts $target $cmd 2>&1 | ForEach-Object { Write-Host $_ } }
  else { & ssh @sshOpts $target $cmd 2>&1 | ForEach-Object { Write-Host $_ } }
  return $LASTEXITCODE
}

if ($InspectOnly) {
  Write-Host "== 只读检查 $target =="
  Send-Files @("$root\deploy\remote-inspect.sh")
  $rc = Invoke-Remote 'sudo sh /tmp/remote-inspect.sh; rc=$?; rm -f /tmp/remote-inspect.sh; exit $rc'
  exit $rc
}

if ($Uninstall) {
  Send-Files @("$root\deploy\remote-uninstall.sh")
  $rc = Invoke-Remote 'sudo sh /tmp/remote-uninstall.sh; rc=$?; rm -f /tmp/remote-uninstall.sh; exit $rc'
  exit $rc
}

if (-not $SkipBuild) {
  Write-Host '== 构建 =='
  npm run typecheck; if ($LASTEXITCODE -ne 0) { throw '类型检查失败' }
  npm test; if ($LASTEXITCODE -ne 0) { throw '测试失败' }
  npm run release; if ($LASTEXITCODE -ne 0) { throw '打包失败' }
}
if (-not (Test-Path "$root\release\devlane.tgz")) { throw '缺少 release\devlane.tgz' }

# 登录口令：首次生成并保存在本机（已被 .gitignore 忽略），之后复用
$secretFile = "$root\deploy\.devlane-secret.txt"
if (-not (Test-Path $secretFile)) {
  $bytes = New-Object byte[] 12
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $pw = [Convert]::ToBase64String($bytes).Replace('+', 'x').Replace('/', 'y').TrimEnd('=')
  [IO.File]::WriteAllText($secretFile, $pw)
}
$password = [IO.File]::ReadAllText($secretFile).Trim()
if ($password -notmatch '^[A-Za-z0-9]+$') { throw '口令文件内容异常，只允许字母和数字' }

Write-Host "== 上传到 $target =="
Send-Files @(
  "$root\release\devlane.tgz",
  "$root\deploy\remote-install.sh",
  "$root\deploy\remote-deploy.sh"
)

Write-Host '== 安装与验证 =='
# 口令走 ssh 标准输入，由服务器上的 remote-deploy.sh 读取；命令里不能带引号（PowerShell 5.1 会吞掉）
$remote = 'sudo env DEVLANE_PORT=' + $Port + ' sh /tmp/remote-deploy.sh'
$rc = Invoke-Remote $remote $password

Write-Host ''
if ($rc -eq 0) {
  Write-Host "访问地址: http://${Server}:$Port" -ForegroundColor Green
  Write-Host "登录口令保存在: $secretFile"
  Write-Host "注意：需要在阿里云控制台的防火墙放行 TCP $Port，浏览器才能从外网访问。"
} else {
  Write-Host "部署未成功 (exit $rc)，见上方输出" -ForegroundColor Red
}
exit $rc
