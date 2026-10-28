# 建立到服务器的 SSH 隧道，之后在本机浏览器打开 http://127.0.0.1:<端口>
# DevLane 只监听服务器的 127.0.0.1，没有对外开放任何端口；隧道是唯一的访问方式。
param(
  [string]$Server = '8.133.179.238',
  [string]$User = 'admin',
  [string]$Key = "$env:USERPROFILE\.ssh\id_ed25519_devlane",
  [int]$Port = 7790
)

Write-Host "正在建立隧道（这台服务器的 SSH 握手较慢，请等十几秒）…" -ForegroundColor Cyan
Write-Host "连上后在浏览器打开： http://127.0.0.1:$Port    关闭隧道：Ctrl+C" -ForegroundColor Green
& ssh -i $Key -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -N -L "${Port}:127.0.0.1:${Port}" "$User@$Server"
