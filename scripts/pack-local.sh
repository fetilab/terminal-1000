#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 terminal-1000 contributors
#
# 六格式全量打包（deb / AppImage / rpm / pacman / flatpak / Windows NSIS）。
#
# 这个脚本是给「本项目的开发容器」用的：那台机器有三个容器级限制
# （fs.copyFile 一律 EPERM、/tmp 只有 10MB、32 位 ELF 跑不起来），
# 加上 rpm/fpm 与 flatpak 各自的坑，直接调 electron-builder 必定失败。
# 每一条对策的来龙去脉写在 HANDOFF.md「已知陷阱」21/22/23/24/31/32，
# 这里只做复现：所有垫片都由脚本自己生成，不依赖 /tmp 里以前留下的东西。
#
# 用法：
#   scripts/pack-local.sh                 # 编译 + 六个格式全打
#   scripts/pack-local.sh deb rpm         # 只打指定 linux 目标
#   scripts/pack-local.sh --win           # 只打 Windows 安装器
#   SKIP_BUILD=1 scripts/pack-local.sh    # 复用已有 out/
#
# 环境变量：
#   PACK_WORK   垫片与暂存的存放目录（默认 <repo>/.pack-work）
#   SKIP_BUILD  非空则跳过 electron-vite build

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DESKTOP="$ROOT/apps/desktop"
WORK="${PACK_WORK:-$ROOT/.pack-work}"
RPM4="${RPM4_DIR:-$ROOT/../.pkg-tools/rpm4}"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m失败:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 参数 ────────────────────────────────────────────────────────────────
LINUX_TARGETS=()
WANT_WIN=0
for arg in "$@"; do
  case "$arg" in
    --win) WANT_WIN=1 ;;
    --help|-h) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "未知参数 $arg" ;;
    *) LINUX_TARGETS+=("$arg") ;;
  esac
done
if [ ${#LINUX_TARGETS[@]} -eq 0 ] && [ "$WANT_WIN" -eq 0 ]; then
  LINUX_TARGETS=(deb AppImage rpm pacman flatpak)
fi

[ -d "$DESKTOP" ] || die "找不到 $DESKTOP"
mkdir -p "$WORK" || die "无法创建 $WORK"

# ── 垫片 1：rpmbuild 钉在用户态 rpm 4.18 ────────────────────────────────
# fpm 1.9.3 与 rpm>=4.20 的 buildroot 布局不兼容（BUILDROOT 不被填充），
# 症状是所有文件报 "File not found: …/BUILDROOT/…"。
mkdir -p "$WORK/rpmwrap"
cat > "$WORK/rpmwrap/rpmbuild" <<EOF
#!/bin/bash
# fpm 1.9.3 只认 rpm 4.18 的 buildroot 布局
export LD_LIBRARY_PATH=$RPM4/usr/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}
exec $RPM4/usr/bin/rpmbuild "\$@"
EOF
chmod +x "$WORK/rpmwrap/rpmbuild"

# ── 垫片 2：flatpak-builder 的两个入场参数 ─────────────────────────────
# electron-builder 的 FlatpakTarget 不透传额外参数，只能用 PATH 垫片补：
#   --user                  /var/lib/flatpak 属未映射的 nobody，system 范围装不了运行时
#   --disable-rofiles-fuse  容器里没有 /dev/fuse
mkdir -p "$WORK/flatpakshim"
cat > "$WORK/flatpakshim/flatpak-builder" <<'EOF'
#!/bin/bash
exec /usr/bin/flatpak-builder --user --disable-rofiles-fuse "$@"
EOF
chmod +x "$WORK/flatpakshim/flatpak-builder"

# ── 垫片 3：fs.copyFile 的 EPERM 兜底 ──────────────────────────────────
cat > "$WORK/fix-copyfile.cjs" <<'EOF'
// 本机 fs.copyFile 一律 EPERM（copy_file_range/sendfile 被拦），普通 read/write 正常。
// electron-builder 复制原生模块与 Electron 发行版全靠它，于是必然失败。
const fs = require('fs')

function fallbackSync(src, dest, mode) {
  if (mode & fs.constants.COPYFILE_EXCL && fs.existsSync(dest)) {
    const err = new Error(`EEXIST: file already exists, copyfile '${src}' -> '${dest}'`)
    err.code = 'EEXIST'
    err.errno = -17
    throw err
  }
  fs.writeFileSync(dest, fs.readFileSync(src))
}

const origCopyFileSync = fs.copyFileSync
fs.copyFileSync = function copyFileSync(src, dest, mode = 0) {
  try {
    return origCopyFileSync.call(fs, src, dest, mode)
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'ENOSYS' && err.code !== 'EINVAL') throw err
    return fallbackSync(src, dest, mode)
  }
}

const origCopyFile = fs.copyFile
fs.copyFile = function copyFile(src, dest, mode, cb) {
  if (typeof mode === 'function') {
    cb = mode
    mode = 0
  }
  origCopyFile.call(fs, src, dest, mode, (err) => {
    if (!err) return cb(null)
    if (err.code !== 'EPERM' && err.code !== 'ENOSYS' && err.code !== 'EINVAL') return cb(err)
    try {
      fallbackSync(src, dest, mode)
      cb(null)
    } catch (e2) {
      cb(e2)
    }
  })
}

if (fs.promises && fs.promises.copyFile) {
  const origP = fs.promises.copyFile
  fs.promises.copyFile = async function copyFileP(src, dest, mode = 0) {
    try {
      return await origP.call(fs.promises, src, dest, mode)
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'ENOSYS' && err.code !== 'EINVAL') throw err
      return fallbackSync(src, dest, mode)
    }
  }
}
EOF

# ── 垫片 4：让 NSIS 目标不碰 wine ──────────────────────────────────────
# NSIS 安装器是 PE32，而本容器连 32 位 ELF 都跑不起来。
# app-builder-lib 里 isMacOsCatalina() 为真时走纯 JS 的卸载器解析分支，等价且不需要 wine。
cat > "$WORK/nsis-norpath.cjs" <<'EOF'
const path = require('path')
const ablOut = process.env.ABL_OUT
if (!ablOut) throw new Error('[nsis-norpath] 需要 ABL_OUT 指向 app-builder-lib/out')
const macosVersion = require(path.join(ablOut, 'util/macosVersion.js'))
macosVersion.isMacOsCatalina = () => true
EOF

# ── 垫片 5：futimens 空操作（flatpak/ostree 需要）───────────────────────
cat > "$WORK/tsfix.c" <<'EOF'
/* fd 形式的 utimensat 在本机返回 EPERM，ostree 写对象会报
 * "Writing content object: futimens: 不允许的操作"。时间戳只影响可复现性。 */
#define _GNU_SOURCE
#include <time.h>
#include <sys/time.h>
#include <utime.h>
int futimens(int fd, const struct timespec times[2]) { (void)fd; (void)times; return 0; }
int utimensat(int dirfd, const char *p, const struct timespec t[2], int f) { (void)dirfd; (void)p; (void)t; (void)f; return 0; }
int futimesat(int dirfd, const char *p, const struct timeval t[2]) { (void)dirfd; (void)p; (void)t; return 0; }
int utimes(const char *p, const struct timeval t[2]) { (void)p; (void)t; return 0; }
int utime(const char *p, const struct utimbuf *t) { (void)p; (void)t; return 0; }
EOF
gcc -shared -fPIC -O2 -o "$WORK/tsfix.so" "$WORK/tsfix.c" || die "编译 tsfix.so 失败（需要 gcc）"

# ── 前置检查 ────────────────────────────────────────────────────────────
[ -x "$RPM4/usr/bin/rpmbuild" ] || [ ${#LINUX_TARGETS[@]} -eq 0 ] || \
  case " ${LINUX_TARGETS[*]} " in
    *" rpm "*|*" pacman "*) die "缺少 rpm 4.18（$RPM4）。见 HANDOFF「rpm/pacman 构建环境」" ;;
  esac

# ── 编译应用产物 ────────────────────────────────────────────────────────
if [ -z "${SKIP_BUILD:-}" ]; then
  say "编译应用产物（electron-vite build）"
  ( cd "$DESKTOP" && ./node_modules/.bin/electron-vite build ) || die "electron-vite build 失败"
fi

# ── 公共环境 ────────────────────────────────────────────────────────────
# ⚠️ 必须 export 后再调 electron-builder：`VAR=x cmd` 这种前缀会被沙箱包装层丢掉 PATH，
# 结果是 rpm 垫片与 flatpak 垫片都不生效（现象：fpm 报 rpmbuild failed，日志里全是
# "File not found: …/BUILDROOT/…"；flatpak 报 "Failure spawning rofiles-fuse"）。
export PATH="$WORK/rpmwrap:$WORK/flatpakshim:${PATH}"
export TMPDIR="$WORK"                # /tmp 是 10MB tmpfs，fpm/rpmbuild 的暂存远超它
export NODE_OPTIONS="--require $WORK/fix-copyfile.cjs"
export LD_PRELOAD="$WORK/tsfix.so"

if [ ${#LINUX_TARGETS[@]} -gt 0 ]; then
  say "打包 linux: ${LINUX_TARGETS[*]}"
  ( cd "$DESKTOP" && ./node_modules/.bin/electron-builder --linux "${LINUX_TARGETS[@]}" ) || \
    say "（electron-builder 非 0 退出，注意陷阱 22：产物可能已经写出来了，先看 release/）"
fi

# ── Windows 安装器 ──────────────────────────────────────────────────────
if [ "$WANT_WIN" -eq 1 ]; then
  # makensis 暂存超过 ~10MB 就 SIGBUS，必须把 /tmp 换成大 tmpfs，
  # 且 mount 不能跨命令保留（每次调用是独立 mount namespace）。
  if [ "$(id -u)" -ne 0 ]; then
    say "跳过 Windows 包：挂 tmpfs 需要 root"
  else
    say "打包 Windows NSIS"
    # app-builder-lib 可能被提升到 workspace 根的 .pnpm 下（pnpm 的 hoist 行为随版本变），
    # 先在根找、再回落到 apps/desktop —— 只查一处会在依赖布局变化时直接失败。
    ABL=$(ls -d "$ROOT"/node_modules/.pnpm/app-builder-lib@*/node_modules/app-builder-lib/out 2>/dev/null | head -1)
    [ -n "$ABL" ] || ABL=$(ls -d "$DESKTOP"/node_modules/.pnpm/app-builder-lib@*/node_modules/app-builder-lib/out 2>/dev/null | head -1)
    [ -n "$ABL" ] || die "找不到 app-builder-lib/out"
    (
      mount -t tmpfs -o size=3g,mode=1777 tmpfs /tmp || die "挂载 /tmp 失败"
      export ABL_OUT="$ABL"
      export NODE_OPTIONS="--require $WORK/fix-copyfile.cjs --require $WORK/nsis-norpath.cjs"
      cd "$DESKTOP" && ./node_modules/.bin/electron-builder --win nsis
    ) || say "（Windows 包失败，检查 /tmp 是否真的挂上了）"
  fi
fi

# ── 结果 ────────────────────────────────────────────────────────────────
say "产物清单（release/）"
ls -lh "$DESKTOP/release" 2>/dev/null | grep -vE '^total|^d' | awk '{printf "  %-6s %s\n", $5, substr($0, index($0,$9))}'
