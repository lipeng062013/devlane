#!/bin/sh
# 在服务器上以 root 运行：记录已有服务 → 安装 → 再记录并对比 → 只读验证。
# 约束：只写 /opt/devlane、/etc/devlane.env、/etc/systemd/system/devlane.service；
#       不碰 nginx、防火墙、docker，不安装或升级系统软件包；服务只监听 127.0.0.1。
set -u
PORT="${DEVLANE_PORT:-7790}"
APP=/opt/devlane
HOME_DIR=$APP/home
NODE_VERSION=v22.19.0
TS="$(date +%Y%m%d%H%M%S)"
T="$(mktemp -d)"
trap 'rm -rf "$T"; rm -f /tmp/remote-deploy.sh /tmp/devlane.tgz' EXIT

snap() {
  ss -ltnH | awk '{print $4}' | sort -u > "$1.ports"
  systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1}' | sort -u > "$1.svc"
  if command -v docker >/dev/null 2>&1; then docker ps --format '{{.Names}}' | sort > "$1.ct"; else : > "$1.ct"; fi
}

snap "$T/before"
echo "== 部署前 =="
echo "监听端口 $(wc -l < "$T/before.ports") 个，运行服务 $(wc -l < "$T/before.svc") 个，容器 $(wc -l < "$T/before.ct") 个"

# 端口被别的程序占用时直接退出，绝不抢占
if ss -ltn | awk '{print $4}' | grep -q ":$PORT\$" && ! systemctl is-active --quiet devlane 2>/dev/null; then
  echo "端口 $PORT 已被其他程序占用，请换一个端口" >&2
  exit 3
fi

echo "== 安装 =="
id devlane >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --shell /usr/sbin/nologin devlane
mkdir -p "$APP/releases" "$APP/tools" "$HOME_DIR/.devlane" "$HOME_DIR/repos"
chown -R devlane:devlane "$HOME_DIR" "$APP/tools"

# --- Node：装一份私有的，不动系统环境 ---
if [ ! -x "$APP/node/bin/node" ]; then
  echo "安装私有 Node $NODE_VERSION 到 $APP/node"
  base="https://registry.npmmirror.com/-/binary/node/$NODE_VERSION"
  file="node-$NODE_VERSION-linux-x64.tar.gz"
  curl -fsSL "$base/$file" -o "$T/$file" || { echo "下载 Node 失败" >&2; exit 4; }
  curl -fsSL "$base/SHASUMS256.txt" -o "$T/SHASUMS256.txt" || { echo "下载校验文件失败" >&2; exit 4; }
  ( cd "$T" && grep " $file\$" SHASUMS256.txt | sha256sum -c - ) || { echo "Node 校验失败，已中止" >&2; exit 4; }
  mkdir -p "$APP/node"
  tar -xzf "$T/$file" -C "$APP/node" --strip-components=1
fi
echo "Node: $("$APP/node/bin/node" -v)"

# --- Claude Code：装进 /opt/devlane/tools，用 devlane 用户安装 ---
CLAUDE="$APP/tools/bin/claude"
if [ ! -x "$CLAUDE" ]; then
  echo "安装 Claude Code 到 $APP/tools（可能需要一两分钟）"
  timeout 900 runuser -u devlane -- env HOME="$HOME_DIR" PATH="$APP/node/bin:/usr/bin:/bin" \
    "$APP/node/bin/npm" install -g @anthropic-ai/claude-code --prefix "$APP/tools" \
    --registry https://registry.npmmirror.com --no-audit --no-fund > "$T/npm.log" 2>&1 \
    || { echo "Claude Code 安装失败，最后几行日志：" >&2; tail -8 "$T/npm.log" >&2; }
fi
if [ -x "$CLAUDE" ]; then
  echo "Claude: $(runuser -u devlane -- env HOME="$HOME_DIR" PATH="$APP/node/bin:/usr/bin:/bin" "$CLAUDE" --version 2>&1 | head -1)"
else
  echo "警告：没有装上 claude，DevLane 能启动但无法运行任务" >&2
fi

# --- git 身份（只在没设置时给一个占位，之后可自行修改）---
if ! runuser -u devlane -- env HOME="$HOME_DIR" git config --global user.email >/dev/null 2>&1; then
  runuser -u devlane -- env HOME="$HOME_DIR" git config --global user.name "DevLane"
  runuser -u devlane -- env HOME="$HOME_DIR" git config --global user.email "devlane@localhost"
fi

# --- 程序 ---
REL="$APP/releases/$TS"
mkdir -p "$REL"
tar -xzf /tmp/devlane.tgz -C "$REL"
chown -R root:root "$REL"
PREV="$(readlink "$APP/current" 2>/dev/null || true)"
ln -sfn "releases/$TS" "$APP/current"

# --- 配置 ---
if [ ! -f /etc/devlane.env ]; then
  umask 077
  cat > /etc/devlane.env <<EOF
PORT=$PORT
DEVLANE_HOME=$HOME_DIR/.devlane
# 在下面配置 claude 的认证（按你的情况填写，取消注释即可），改完执行：sudo systemctl restart devlane
# ANTHROPIC_API_KEY=
# ANTHROPIC_BASE_URL=
# ANTHROPIC_AUTH_TOKEN=
EOF
fi
sed -i "s/^PORT=.*/PORT=$PORT/" /etc/devlane.env
chown root:devlane /etc/devlane.env
chmod 640 /etc/devlane.env

# 首次安装时给一份适合小内存服务器的初始设置（同时只跑 1 个任务）
STATE="$HOME_DIR/.devlane/state.json"
if [ ! -f "$STATE" ]; then
  printf '{"settings":{"maxConcurrent":1,"claudePath":"%s"}}\n' "$CLAUDE" > "$STATE"
  chown devlane:devlane "$STATE"
  chmod 600 "$STATE"
fi

cat > /etc/systemd/system/devlane.service <<EOF
[Unit]
Description=DevLane (personal AI task desk, localhost only)
After=network.target

[Service]
User=devlane
Group=devlane
WorkingDirectory=$HOME_DIR
Environment=HOME=$HOME_DIR
Environment=PATH=$APP/tools/bin:$APP/node/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/devlane.env
ExecStart=$APP/node/bin/node --max-old-space-size=150 $APP/current/server.mjs
Restart=on-failure
RestartSec=3
# 限制资源，避免影响同机其他服务
Nice=10
MemoryMax=600M
CPUQuota=80%
TasksMax=300
# 沙箱：只有 $HOME_DIR 可写，系统其余部分（包括 /opt/one-class）只读
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$HOME_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl reset-failed devlane 2>/dev/null || true
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
ls -1dt "$APP"/releases/* 2>/dev/null | tail -n +4 | xargs -r rm -rf

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
[ "$LOST" -eq 0 ] || exit 6

echo "== 验证（只读） =="
B="http://127.0.0.1:$PORT"
echo "健康检查: $(curl -fsS "$B/api/health")"
echo "首页: HTTP $(curl -s -o /dev/null -w '%{http_code}' "$B/")"
echo "伪造 Host 访问接口: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "$B/api/state") (期望 403)"
echo "没带请求头的写操作: HTTP $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$B/api/projects/inspect") (期望 403)"
LISTEN="$(ss -ltnH | awk '{print $4}' | grep ":$PORT\$" | tr '\n' ' ')"
echo "监听地址: $LISTEN"
case "$LISTEN" in
  "127.0.0.1:$PORT ") ;;
  *) echo "错误：服务没有只监听 127.0.0.1，立即停止" >&2; systemctl stop devlane; exit 7 ;;
esac
echo "环境: $(curl -fsS "$B/api/env")"
echo "systemd: $(systemctl is-active devlane)"
