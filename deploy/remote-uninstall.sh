#!/bin/sh
# 卸载 DevLane。默认保留数据目录；加参数 --purge 才连数据一起删除。
set -eu
systemctl stop devlane 2>/dev/null || true
systemctl disable devlane 2>/dev/null || true
rm -f /etc/systemd/system/devlane.service /etc/devlane.env
systemctl daemon-reload
if [ "${1:-}" = "--purge" ]; then
  rm -rf /opt/devlane
  userdel devlane 2>/dev/null || true
  echo "已卸载并删除全部数据"
else
  rm -rf /opt/devlane/releases /opt/devlane/current /opt/devlane/node
  echo "已卸载，数据保留在 /opt/devlane/data"
fi
