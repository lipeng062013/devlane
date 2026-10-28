#!/bin/sh
# 在服务器上以 root 运行：记录已有服务 → 安装 → 再记录并对比 → 只读验证。
# 全部放在一个脚本里，是因为这台服务器每次 SSH 握手要十几秒，要尽量少连接。
set -u
PORT="${DEVLANE_PORT:?缺少 DEVLANE_PORT}"
T="$(mktemp -d)"
trap 'rm -rf "$T"; rm -f /tmp/remote-install.sh /tmp/remote-deploy.sh /tmp/devlane.tgz /tmp/devlane-pw' EXIT

# 登录口令从标准输入读取一行（不经过命令行参数，避免出现在进程列表里）。
# 没有提供时，沿用服务器上已有的口令。
IFS= read -r PW || PW=""
PW="$(printf %s "$PW" | tr -d '\r\n')"
if [ -n "$PW" ]; then
  case "$PW" in
    *[!A-Za-z0-9]*) echo "口令只能包含字母和数字" >&2; exit 4 ;;
  esac
  ( umask 077; printf %s "$PW" > /tmp/devlane-pw )
fi

snap() {
  ss -ltnH | awk '{print $4}' | sort -u > "$1.ports"
  systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1}' | sort -u > "$1.svc"
  if command -v docker >/dev/null 2>&1; then docker ps --format '{{.Names}}' | sort > "$1.ct"; else : > "$1.ct"; fi
}

snap "$T/before"
echo "== 部署前 =="
echo "监听端口 $(wc -l < "$T/before.ports") 个，运行服务 $(wc -l < "$T/before.svc") 个，容器 $(wc -l < "$T/before.ct") 个"

echo "== 安装 =="
sh /tmp/remote-install.sh
RC=$?

snap "$T/after"
echo "== 对比部署前后 =="
LOST=0
for kind in ports svc ct; do
  missing="$(comm -23 "$T/before.$kind" "$T/after.$kind")"
  if [ -n "$missing" ]; then
    LOST=1
    echo "警告：以下已有的 $kind 在部署后消失："
    echo "$missing"
  fi
done
if [ "$LOST" -eq 0 ]; then
  echo "已有的 $(wc -l < "$T/before.ports") 个端口、$(wc -l < "$T/before.svc") 个服务、$(wc -l < "$T/before.ct") 个容器全部仍在运行"
fi
echo "新增监听: $(comm -13 "$T/before.ports" "$T/after.ports" | tr '\n' ' ')"

if [ "$RC" -ne 0 ]; then
  echo "安装脚本失败 (exit $RC)" >&2
  exit "$RC"
fi
[ "$LOST" -eq 0 ] || exit 6

echo "== 服务器本机验证（只读） =="
B="http://127.0.0.1:$PORT"
curl -fsS "$B/api/health"; echo
echo "未登录访问接口: HTTP $(curl -s -o /dev/null -w '%{http_code}' "$B/api/snapshot") (期望 401)"
curl -fsS -o /dev/null -w '首页: HTTP %{http_code}\n' "$B/"
PW="$(grep '^DEVLANE_PASSWORD=' /etc/devlane.env | cut -d= -f2-)"
curl -fsS -c "$T/cj" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" "$B/api/login"; echo
curl -fsS -b "$T/cj" "$B/api/snapshot" | head -c 160; echo
echo "systemd: $(systemctl is-active devlane)"
