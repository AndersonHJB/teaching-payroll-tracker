#!/bin/bash
# Mac 上双击本文件即可启动本地服务（首次需在「访达」右键→打开 以通过安全提示）
cd "$(dirname "$0")"
echo "正在启动课时工资记录本地服务…"
exec python3 server.py
