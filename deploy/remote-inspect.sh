#!/bin/sh
# 只读检查：不修改服务器上的任何东西。
echo "== 系统 =="
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release 2>/dev/null
uname -m
echo "== 资源 =="
free -m 2>/dev/null | head -2
df -h / 2>/dev/null | tail -1
echo "cpu: $(nproc 2>/dev/null)"
echo "== Node =="
if command -v node >/dev/null 2>&1; then echo "$(command -v node) $(node -v)"; else echo "未安装"; fi
echo "== 监听端口 =="
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | head -40
echo "== 运行中的服务 =="
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -50
echo "== 容器与进程管理器 =="
if command -v docker >/dev/null 2>&1; then docker ps --format '{{.Names}}  {{.Ports}}' 2>&1 | head -20; else echo "docker: 无"; fi
if command -v pm2 >/dev/null 2>&1; then pm2 list 2>&1 | head -20; else echo "pm2: 无"; fi
echo "== 反向代理 =="
command -v nginx >/dev/null 2>&1 && echo "nginx: $(command -v nginx)" || echo "nginx: 无"
echo "== one-class 相关 =="
ps -eo pid,user,etime,cmd 2>/dev/null | grep -i 'one-class\|one_class\|oneclass' | grep -v grep | head -10
ls -d /opt/one-class /srv/one-class /var/www/one-class /home/*/one-class /root/one-class 2>/dev/null
echo "== 防火墙 =="
(firewall-cmd --state 2>&1; ufw status 2>&1) | head -5
echo "== 已有 devlane =="
systemctl is-active devlane 2>/dev/null || echo "未安装"
