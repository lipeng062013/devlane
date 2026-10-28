# 一键部署到远程服务器。
# 用法：
#   .\deploy\deploy.ps1 -InspectOnly      只读检查服务器，不改任何东西
#   .\deploy\deploy.ps1                   打包、上传、安装、验证
#   .\deploy\deploy.ps1 -Uninstall        卸载 DevLane（保留数据）
param(
  [string]$Server = '8.133.179.238',
  [string]$User = 'root',
  [string]$Key = "$env:USERPROFILE\.ssh\id_ed25519_devlane",
  [int]$Port = 18090,
  [switch]$InspectOnly,
  [switch]$Uninstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$sshOpts = @('-i', $Key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10')
$target = "$User@$Server"

function Invoke-Remote([string]$cmd) {
  $out = & ssh @sshOpts $target $cmd 2>&1
  if ($LASTEXITCODE -ne 0) { throw "远程命令失败 (exit $LASTEXITCODE): $cmd`n$out" }
  return $out
}

function Get-Footprint {
  # 监听端口和运行中的服务，用于部署前后对比，确认没有影响已有服务
  $ports = Invoke-Remote "ss -ltnH | awk '{print `$4}' | sort -u"
  $services = Invoke-Remote "systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print `$1}' | sort -u"
  $containers = Invoke-Remote "if command -v docker >/dev/null 2>&1; then docker ps --format '{{.Names}}' | sort; fi"
  return [pscustomobject]@{ Ports = @($ports); Services = @($services); Containers = @($containers) }
}

Write-Host "== 连接 $target =="
Invoke-Remote 'echo ok' | Out-Null

Write-Host "== 只读检查 =="
& scp @sshOpts "$root\deploy\remote-inspect.sh" "${target}:/tmp/devlane-inspect.sh" | Out-Null
Invoke-Remote 'sh /tmp/devlane-inspect.sh; rm -f /tmp/devlane-inspect.sh' | ForEach-Object { Write-Host $_ }
if ($InspectOnly) { return }

if ($Uninstall) {
  & scp @sshOpts "$root\deploy\remote-uninstall.sh" "${target}:/tmp/devlane-uninstall.sh" | Out-Null
  Invoke-Remote 'sh /tmp/devlane-uninstall.sh; rm -f /tmp/devlane-uninstall.sh' | ForEach-Object { Write-Host $_ }
  return
}

$before = Get-Footprint
Write-Host ("部署前：监听 {0} 个端口，运行 {1} 个服务，{2} 个容器" -f $before.Ports.Count, $before.Services.Count, $before.Containers.Count)

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
$pwTmp = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($pwTmp, $password)

Write-Host '== 上传 =='
& scp @sshOpts "$root\release\devlane.tgz" "${target}:/tmp/devlane.tgz" | Out-Null
& scp @sshOpts "$root\deploy\remote-install.sh" "${target}:/tmp/devlane-install.sh" | Out-Null
& scp @sshOpts $pwTmp "${target}:/tmp/devlane-pw" | Out-Null
Remove-Item $pwTmp -Force
Invoke-Remote 'chmod 600 /tmp/devlane-pw' | Out-Null

Write-Host '== 安装 =='
Invoke-Remote "DEVLANE_PORT=$Port sh /tmp/devlane-install.sh; rc=`$?; rm -f /tmp/devlane-install.sh /tmp/devlane.tgz; exit `$rc" | ForEach-Object { Write-Host $_ }

Write-Host '== 对比部署前后 =='
$after = Get-Footprint
$lostPorts = $before.Ports | Where-Object { $_ -notin $after.Ports }
$lostSvc = $before.Services | Where-Object { $_ -notin $after.Services }
$lostCt = $before.Containers | Where-Object { $_ -notin $after.Containers }
$newPorts = $after.Ports | Where-Object { $_ -notin $before.Ports }
if ($lostPorts -or $lostSvc -or $lostCt) {
  Write-Host '警告：以下已有项在部署后消失，请立即检查' -ForegroundColor Red
  $lostPorts | ForEach-Object { Write-Host "  端口 $_" -ForegroundColor Red }
  $lostSvc | ForEach-Object { Write-Host "  服务 $_" -ForegroundColor Red }
  $lostCt | ForEach-Object { Write-Host "  容器 $_" -ForegroundColor Red }
  exit 6
}
Write-Host ("已有的 {0} 个端口、{1} 个服务、{2} 个容器全部仍在运行" -f $before.Ports.Count, $before.Services.Count, $before.Containers.Count) -ForegroundColor Green
Write-Host ("新增监听：{0}" -f ($newPorts -join ', '))

Write-Host '== 服务器本机验证（只读） =='
$checks = @"
set -e
b=http://127.0.0.1:$Port
curl -fsS `$b/api/health; echo
code=`$(curl -s -o /dev/null -w '%{http_code}' `$b/api/snapshot); echo "未登录访问接口: HTTP `$code (期望 401)"
curl -fsS -o /dev/null -w '首页: HTTP %{http_code}\n' `$b/
curl -fsS -c /tmp/dl-cj -H 'Content-Type: application/json' -d "{\"password\":\"`$(grep ^DEVLANE_PASSWORD= /etc/devlane.env | cut -d= -f2-)\"}" `$b/api/login; echo
curl -fsS -b /tmp/dl-cj `$b/api/snapshot | head -c 120; echo
rm -f /tmp/dl-cj
systemctl is-active devlane
"@
Invoke-Remote $checks | ForEach-Object { Write-Host $_ }

Write-Host ''
Write-Host "访问地址: http://${Server}:$Port" -ForegroundColor Green
Write-Host "登录口令保存在: $secretFile"
Write-Host "注意：需要在阿里云控制台的防火墙/安全组放行 TCP $Port，浏览器才能从外网访问。"
