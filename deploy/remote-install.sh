#!/bin/sh
# 在服务器上安装或升级 DevLane。可重复执行。
# 约束：只写 /opt/devlane、/etc/devlane.env、/etc/systemd/system/devlane.service，
#       不碰 nginx、防火墙、docker，也不安装或升级系统软件包。
# 输入：环境变量 DEVLANE_PORT；/tmp/devlane.tgz；可选 /tmp/devlane-pw（首次安装时的登录口令）。
set -eu

APP=/opt/devlane
PORT="${DEVLANE_PORT:?缺少 DEVLANE_PORT}"
TS="$(date +%Y%m%d%H%M%S)"
NODE_VERSION="v22.19.0"

port_in_use() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$1\$"; }

# 端口被占用，且不是我们自己的服务时，直接退出，绝不抢占。
if port_in_use "$PORT" && ! systemctl is-active --quiet devlane 2>/dev/null; then
  echo "端口 $PORT 已被其他程序占用，请换一个端口" >&2
  exit 3
fi

id devlane >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin devlane
mkdir -p "$APP/releases" "$APP/data"

# 解压到新的版本目录，切换软链接前不影响正在运行的版本
REL="$APP/releases/$TS"
mkdir -p "$REL"
tar -xzf /tmp/devlane.tgz -C "$REL"

# Node：优先用系统已有的 >=20；否则装一份私有的到 /opt/devlane/node，不动系统环境
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//; s/\..*//')"
  [ "$major" -ge 20 ] && NODE_BIN="$(command -v node)"
fi
if [ -z "$NODE_BIN" ]; then
  if [ ! -x "$APP/node/bin/node" ]; then
    echo "安装私有 Node $NODE_VERSION 到 $APP/node"
    tmp="$(mktemp -d)"
    url="https://registry.npmmirror.com/-/binary/node/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz"
    curl -fsSL "$url" -o "$tmp/node.tgz"
    mkdir -p "$APP/node"
    tar -xzf "$tmp/node.tgz" -C "$APP/node" --strip-components=1
    rm -rf "$tmp"
  fi
  NODE_BIN="$APP/node/bin/node"
fi
echo "使用 Node: $NODE_BIN ($("$NODE_BIN" -v))"

# 环境文件：已存在时保留原口令，只更新端口
if [ ! -f /etc/devlane.env ]; then
  [ -f /tmp/devlane-pw ] || { echo "首次安装需要 /tmp/devlane-pw" >&2; exit 4; }
  pw="$(cat /tmp/devlane-pw)"
  umask 077
  {
    echo "PORT=$PORT"
    echo "HOST=0.0.0.0"
    echo "DEVLANE_PASSWORD=$pw"
    echo "DEVLANE_DATA_DIR=$APP/data"
  } > /etc/devlane.env
fi
rm -f /tmp/devlane-pw
sed -i "s/^PORT=.*/PORT=$PORT/" /etc/devlane.env
chown root:devlane /etc/devlane.env
chmod 640 /etc/devlane.env

chown -R devlane:devlane "$APP/data"
chown -R root:root "$REL"

cat > /etc/systemd/system/devlane.service <<EOF
[Unit]
Description=DevLane
After=network.target

[Service]
User=devlane
Group=devlane
WorkingDirectory=$APP
EnvironmentFile=/etc/devlane.env
ExecStart=$NODE_BIN --max-old-space-size=200 $APP/current/server.mjs
Restart=on-failure
RestartSec=3
# 限制资源，避免影响同机其他服务
Nice=10
MemoryMax=300M
CPUQuota=30%
TasksMax=128
# 最小权限
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP/data

[Install]
WantedBy=multi-user.target
EOF

# 记住上一个版本，健康检查失败时回退
PREV="$(readlink "$APP/current" 2>/dev/null || true)"
ln -sfn "releases/$TS" "$APP/current"

systemctl daemon-reload
systemctl enable devlane >/dev/null 2>&1
systemctl restart devlane

ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [ "$ok" -ne 1 ]; then
  echo "健康检查失败，最近日志：" >&2
  journalctl -u devlane -n 30 --no-pager >&2 || true
  if [ -n "$PREV" ]; then
    echo "回退到 $PREV" >&2
    ln -sfn "$PREV" "$APP/current"
    systemctl restart devlane || true
  else
    systemctl stop devlane || true
  fi
  exit 5
fi

# 只保留最近 3 个版本
ls -1dt "$APP"/releases/* 2>/dev/null | tail -n +4 | xargs -r rm -rf

echo "DevLane 已启动：监听 0.0.0.0:$PORT"
