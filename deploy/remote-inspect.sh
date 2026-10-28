#!/bin/sh
# 只读：不修改服务器上的任何东西。
PORT="${DEVLANE_PORT:-7790}"
echo "== 系统 =="
grep -E '^(PRETTY_NAME)=' /etc/os-release 2>/dev/null
uname -m
echo "== 资源 =="
free -m | head -3
df -h / | tail -1
echo "cpu: $(nproc)"
echo "== 工具 =="
for c in node npm git gh claude curl tar; do
  if command -v "$c" >/dev/null 2>&1; then echo "$c: $(command -v "$c")"; else echo "$c: 无"; fi
done
command -v node >/dev/null 2>&1 && echo "node 版本: $(node -v)"
command -v git >/dev/null 2>&1 && echo "git 版本: $(git --version)"
echo "== 监听端口 =="
ss -ltnH | awk '{print $4}' | sort -u
echo "== 目标端口 $PORT =="
ss -ltn | awk '{print $4}' | grep -q ":$PORT\$" && echo "已被占用" || echo "空闲"
echo "== 容器 =="
docker ps -a --format '{{.Names}}  {{.Status}}' 2>&1 | head -20
echo "== 已有 devlane =="
id devlane 2>&1 | head -1
systemctl is-active devlane 2>&1 | head -1
ls -la /opt/devlane 2>&1 | head -8
echo "== one-class 目录权限（只看，不改） =="
ls -ld /opt/one-class 2>&1
ls -l /opt/one-class/.env 2>&1
echo "== sshd 是否允许端口转发 =="
sshd -T 2>/dev/null | grep -i '^allowtcpforwarding' || echo "(需要 root 才能查看，默认允许)"
