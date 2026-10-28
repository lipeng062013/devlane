#!/bin/sh
# 只读：查看 one-class 的位置与运行方式，以及内存余量。
echo "== /opt/one-class =="
ls -la /opt/one-class | head -30
echo "== docker ps -a =="
docker ps -a --format '{{.Names}}  {{.Status}}  {{.Image}}'
echo "== compose / Dockerfile / service / package.json =="
find /opt/one-class -maxdepth 2 \( -name 'docker-compose*' -o -name 'compose*.y*ml' -o -name 'Dockerfile' -o -name 'ecosystem*' -o -name '*.service' -o -name 'package.json' \) 2>/dev/null | head
echo "== systemd 单元里含 one =="
systemctl list-unit-files --no-pager | grep -i 'one' || echo "无"
echo "== cron =="
crontab -l 2>&1 | head -5
echo "== 内存前 10 的进程 =="
ps -eo pid,user,rss,etime,cmd --sort=-rss | head -11
echo "== 内存与交换 =="
free -m
swapon --show || true
echo "== 监听端口（含进程） =="
ss -ltnp | awk 'NR>1 {print $4, $6}' | sort -u | head -30
echo "== docker 容器资源 =="
docker stats --no-stream --format '{{.Name}}  CPU {{.CPUPerc}}  MEM {{.MemUsage}}' 2>&1 | head
echo "== 18090 是否空闲 =="
ss -ltn | awk '{print $4}' | grep -q ':18090$' && echo "已占用" || echo "空闲"
