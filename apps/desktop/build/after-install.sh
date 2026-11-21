#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# 安装/升级后刷新桌面图标与 desktop 数据库。
#
# 为什么必须有这一步：升级时 dpkg 会删掉旧包里、新包不再提供的图标文件
# （例如旧版装在 512x512/apps/，新版改到 1024x1024/apps/），但桌面环境的
# 图标缓存仍然指向被删掉的那条路径 —— 用户看到的就是「图标还是旧的」，
# 甚至变成空白方块。刷新一次缓存才会重新按名字解析到新文件。
#
# 全部失败也不阻断安装：没有桌面环境（服务器、容器）时这些命令本来就不存在。
set +e

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications 2>/dev/null
fi

# KDE 侧（存在才做）
if command -v kbuildsycoca5 >/dev/null 2>&1; then
  kbuildsycoca5 --noincremental >/dev/null 2>&1
elif command -v kbuildsycoca6 >/dev/null 2>&1; then
  kbuildsycoca6 --noincremental >/dev/null 2>&1
fi

exit 0
