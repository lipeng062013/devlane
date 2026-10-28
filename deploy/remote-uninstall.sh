#!/bin/sh
# 卸载 DevLane，并确认没有影响服务器上的其他服务。
# 默认保留 /opt/devlane/home（数据、claude 登录状态、克隆的仓库）；加 --purge 才全部删除。
set -u
PORT="${DEVLANE_PORT:-7790}"
T="$(mktemp -d)"
trap 'rm -rf "$T"; rm -f /tmp/remote-uninstall.sh' EXIT

snap() {
  ss -ltnH | awk '{print $4}' | sort -u > "$1.ports"
  systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1}' | sort -u > "$1.svc"
  if command -v docker >/dev/null 2>&1; then docker ps --format '{{.Names}}' | sort > "$1.ct"; else : > "$1.ct"; fi
}

snap "$T/before"
echo "== 卸载前 =="
echo "监听端口 $(wc -l < "$T/before.ports") 个，运行服务 $(wc -l < "$T/before.svc") 个，容器 $(wc -l < "$T/before.ct") 个"

systemctl stop devlane 2>/dev/null || true
systemctl disable devlane 2>/dev/null || true
rm -f /etc/systemd/system/devlane.service /etc/devlane.env
systemctl daemon-reload
systemctl reset-failed devlane 2>/dev/null || true

if [ "${1:-}" = "--purge" ]; then
  rm -rf /opt/devlane
  userdel devlane 2>/dev/null || true
  echo "已卸载并删除全部数据（包括 devlane 用户）"
else
  rm -rf /opt/devlane/releases /opt/devlane/current /opt/devlane/node /opt/devlane/tools
  echo "已卸载程序、Node 和 Claude Code；数据保留在 /opt/devlane"
fi

snap "$T/after"
echo "== 对比卸载前后 =="
BAD=0
# 预期只会少掉 DevLane 自己的监听端口和服务，其他任何一项消失都要报警
lost_ports="$(comm -23 "$T/before.ports" "$T/after.ports" | grep -v ":$PORT\$" || true)"
lost_svc="$(comm -23 "$T/before.svc" "$T/after.svc" | grep -v '^devlane' || true)"
lost_ct="$(comm -23 "$T/before.ct" "$T/after.ct" || true)"
for pair in "端口:$lost_ports" "服务:$lost_svc" "容器:$lost_ct"; do
  name="${pair%%:*}"; val="${pair#*:}"
  if [ -n "$val" ]; then BAD=1; echo "警告：以下已有的$name 消失了："; echo "$val"; fi
done
if [ "$BAD" -eq 0 ]; then
  echo "其他服务全部原样运行：$(grep -vc ":$PORT\$" "$T/after.ports") 个端口、$(wc -l < "$T/after.svc") 个服务、$(wc -l < "$T/after.ct") 个容器"
fi
echo "DevLane 端口 $PORT：$(ss -ltn | awk '{print $4}' | grep -q ":$PORT\$" && echo 仍在监听 || echo 已关闭)"
echo "DevLane 服务：$(systemctl is-active devlane 2>&1 | head -1)"
echo "== 残留 =="
du -sh /opt/devlane/* 2>/dev/null
exit "$BAD"
