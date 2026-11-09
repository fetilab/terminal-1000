#!/usr/bin/env bash
# 只结束**我自己启动的** terminal-1000 测试实例。
#
# ⚠️ 绝不要用 `pkill -x electron` / `pkill -f electron`：
# 本机（以及任何装了 Electron 应用的机器）上，**别的 Electron 应用进程名也叫 `electron`**
# —— 例如 B 站客户端 `/opt/apps/.../bilibili/files/bin/electron/electron` 的 comm 就是 "electron"。
# `pkill -x electron` 会把用户的其它 Electron 应用一起杀掉（我踩过：反复杀掉用户的 B 站客户端）。
#
# 正确做法：按**我传入的专属标记**匹配 —— 我用 `--user-data-dir=/tmp/t1000-*` 起实例。
# ⚠️ **调用方的命令行里也不要出现这个字符串** —— 否则 pkill 会匹配到调用它的那条命令本身
#    （我踩过第五次：在 echo 里写了这个路径做提示，结果把自己的 shell 杀了）。
# 用 `[u]ser-...` 字符类写法，避免 pgrep/pkill 匹配到**执行它的这条命令行自身**（同样是踩过的坑）。
set -u
pkill -f '[u]ser-data-dir=/tmp/t1000-' 2>/dev/null
exit 0
