#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 terminal-1000 contributors
#
# 编译远端监控代理的**多架构静态二进制**，产物放进 build/agent/。
#
# 为什么要交叉编译多份放进安装包：
#   服务器可能是 x86_64、ARM64（云厂商的 Ampere/Graviton、鲲鹏）、
#   或者 32 位 ARM（树莓派）。桌面端在连接时跑 `uname -m` 判断架构，
#   选对应的二进制上传 —— 用户不需要在服务器上装 Go、装 python、装任何东西。
#
# 为什么是 .gz：
#   未压缩每个约 5.4 MiB，四份就把安装包撑大 20 MiB。gzip 后约 2 MiB/份，
#   桌面端在上传前用 zlib 解压（服务器上**不需要** gunzip），
#   既省体积又不多一个远端依赖。
#
# 用法：bash build.sh          全部架构
#       bash build.sh amd64    只编一个
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../build/agent"
GO=${GO:-$(command -v go || true)}
if [ -z "$GO" ] && [ -x "$HOME/_tools/go/bin/go" ]; then GO="$HOME/_tools/go/bin/go"; fi
if [ -z "$GO" ]; then
  echo "找不到 go：请把 Go 放进 PATH，或用 GO=/path/to/go 指定" >&2
  exit 1
fi

# 架构表：GOARCH/GOARM  →  远端 uname -m 可能给出的写法
#   x86_64 / amd64            → amd64
#   aarch64 / arm64           → arm64
#   armv7l / armv6l / armhf   → arm (GOARM=7 的产物在 v6 上也能跑常见指令)
#   i686 / i386               → 386
TARGETS=${*:-amd64 arm64 arm}

mkdir -p "$OUT"
export CGO_ENABLED=0
export GOFLAGS=-trimpath
# Go 的构建临时目录默认在 /tmp；本机 /tmp 只有 10MB，必须指到工作区
export TMPDIR=${TMPDIR:-"$HERE/../../.build-tmp"}
mkdir -p "$TMPDIR"

for arch in $TARGETS; do
  case "$arch" in
    amd64|arm64|386) goarm="" ;;
    arm)             goarm=7 ;;
    *) echo "未知架构: $arch" >&2; exit 1 ;;
  esac

  raw="$TMPDIR/t1000-agent-$arch"
  echo "编译 linux/$arch${goarm:+ (GOARM=$goarm)}"
  GOOS=linux GOARCH="$arch" GOARM="$goarm" \
    "$GO" build -ldflags "-s -w" -o "$raw" "$HERE"

  # -n：不写文件名与时间戳，同样的输入得到同样的压缩字节（可复现）
  gzip -9 -n -c "$raw" > "$OUT/t1000-agent-linux-$arch.gz"
  rm -f "$raw"
  printf '  %-10s %s\n' "$arch" "$(du -h "$OUT/t1000-agent-linux-$arch.gz" | cut -f1)"
done

echo "产物目录: $OUT"
ls -la "$OUT"
