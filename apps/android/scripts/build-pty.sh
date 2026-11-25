#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# 编译 pty 原生库（libt1000pty.so）。
#
# 为什么不走 CMake/Gradle 的 externalNativeBuild：
# 这个库只有**一个** C 文件、零第三方依赖，用 NDK 的 clang 直接编出 .so
# 放进 jniLibs 就够了。走 AGP 的 native 构建要额外钉住 cmake 版本、
# 多一层 ninja 生成，收益为零 —— 而脚本方式在 CI 与本地完全一致，
# 也方便单独重编（改了 C 只要 2 秒）。
#
# 用法：bash apps/android/scripts/build-pty.sh [abi...]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
SRC="$APP_DIR/app/src/main/cpp/t1000_pty.c"
JNI_DIR="$APP_DIR/app/src/main/jniLibs"

: "${ANDROID_HOME:=/home/mosfet/android-sdk}"
NDK="${ANDROID_NDK_HOME:-}"
if [ -z "$NDK" ]; then
  NDK="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$NDK" ] || [ ! -d "$NDK" ]; then
  echo "!! 找不到 NDK（ANDROID_NDK_HOME 或 \$ANDROID_HOME/ndk/<ver>）" >&2
  exit 1
fi

HOST_TAG=linux-x86_64
BIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin"
[ -d "$BIN" ] || { echo "!! NDK 工具链缺失：$BIN" >&2; exit 1; }

# minSdk = 26：使用带 26 后缀的 clang 包装器，保证链接到 API 26 的符号集
API=26

ABIS=("$@")
[ ${#ABIS[@]} -eq 0 ] && ABIS=(arm64-v8a x86_64)

for ABI in "${ABIS[@]}"; do
  case "$ABI" in
    arm64-v8a) TRIPLE=aarch64-linux-android ;;
    x86_64)    TRIPLE=x86_64-linux-android ;;
    armeabi-v7a) TRIPLE=armv7a-linux-androideabi ;;
    *) echo "!! 不支持的 ABI：$ABI" >&2; exit 1 ;;
  esac

  CC="$BIN/${TRIPLE}${API}-clang"
  STRIP="$BIN/llvm-strip"
  [ -x "$CC" ] || { echo "!! 编译器不存在：$CC" >&2; exit 1; }

  OUT_DIR="$JNI_DIR/$ABI"
  mkdir -p "$OUT_DIR"
  OUT="$OUT_DIR/libt1000pty.so"

  echo "==> $ABI ($TRIPLE, API $API)"
  "$CC" -shared -fPIC -O2 -Wall -Wextra \
    -Wl,-z,max-page-size=16384 \
    -Wl,-soname,libt1000pty.so \
    -o "$OUT" "$SRC"

  "$STRIP" --strip-unneeded "$OUT"
  echo "    $(basename "$OUT")  $(du -h "$OUT" | cut -f1)"
done

echo "==> 完成"
