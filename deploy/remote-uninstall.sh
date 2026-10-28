#!/bin/sh
# 卸载 DevLane。默认保留 /opt/devlane/home（数据、claude 登录状态、克隆的仓库）；加 --purge 才全部删除。
set -eu
systemctl stop devlane 2>/dev/null || true
systemctl disable devlane 2>/dev/null || true
rm -f /etc/systemd/system/devlane.service /etc/devlane.env
systemctl daemon-reload
systemctl reset-failed devlane 2>/dev/null || true
if [ "${1:-}" = "--purge" ]; then
  rm -rf /opt/devlane
  userdel devlane 2>/dev/null || true
  echo "已卸载并删除全部数据"
else
  rm -rf /opt/devlane/releases /opt/devlane/current /opt/devlane/node /opt/devlane/tools
  echo "已卸载，数据保留在 /opt/devlane/home"
fi
