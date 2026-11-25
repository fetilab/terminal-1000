#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 terminal-1000 contributors
#
# 把「Alpine rootfs + proot 运行时」装进 APK。
#
# 为什么需要这一层：
#  - Android 上不能 chroot（没有 root），内核也关掉了 user namespace，
#    所以"本地 Linux 环境"只能靠 proot（纯 ptrace 的系统调用翻译，不需要特权）。
#  - proot 用 Termux 的 bionic 构建，依赖 libtalloc 与 libandroid-shmem。
#    Android 10+ 禁止从可写目录 exec，这三个 ELF 必须放进 jniLibs，
#    由安装器解压到 nativeLibraryDir（只读 + 允许执行），并统一改名成 lib*.so
#    —— AGP 只打包 `.so` 后缀的文件（`libtalloc.so.2` 这种 soname 后缀会被丢掉）。
#  - proot 的 `loader` 是静态链接的（无依赖），同样以 `libproot-loader.so` 落地，
#    运行时用 `PROOT_LOADER` 指过去（proot 编译期写死的是 Termux 的前缀路径）。
#  - rootfs 用 Alpine 官方 minirootfs，以 tar.gz 放进 assets，
#    首次启动由 RootfsManager（纯 Kotlin 的 tar 解包器）解到私有目录。
#
# 所有外部输入都固定版本 + 校验 sha256：这套东西一旦被投毒，
# 等于在用户设备上给了一个任意代码执行环境，必须可复现。
#
# 用法：
#   scripts/build-rootfs.sh arm64-v8a     # 或 x86_64
# 产物：
#   app/src/main/assets/rootfs.tar.gz
#   app/src/main/jniLibs/<abi>/{libproot.so,libproot-loader.so,libtalloc.so,libandroid-shmem.so}

set -euo pipefail

ABI="${1:-arm64-v8a}"

case "$ABI" in
  arm64-v8a) ALPINE_ARCH=aarch64; TERMUX_ARCH=aarch64 ;;
  x86_64)    ALPINE_ARCH=x86_64;  TERMUX_ARCH=x86_64  ;;
  armeabi-v7a) ALPINE_ARCH=armhf; TERMUX_ARCH=arm ;;
  *)
    echo "不支持的 ABI: $ABI（可选 arm64-v8a / x86_64 / armeabi-v7a）" >&2
    exit 2
    ;;
esac

# ── 固定版本与校验和 ─────────────────────────────────────────────
ALPINE_VER="3.24.4"
PROOT_PKG="proot_5.1.107.102"
TALLOC_PKG="libtalloc_2.5.0"
SHMEM_PKG="libandroid-shmem_0.7"

alpine_sha() {
  case "$1" in
    aarch64) echo "4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de" ;;
    x86_64)  echo "cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012" ;;
    armhf)   echo "" ;;   # 未验证，用到再补
  esac
}

termux_sha() {
  # $1=包名 $2=架构
  case "$1:$2" in
    proot:aarch64)              echo "10a394b585c2fc2b2c8502544f4e5f1be581dc8bfff79e8ba62f16207423e030" ;;
    proot:x86_64)               echo "2497064226c15971be8131c7facead94a06c225347796326a383c832dca57758" ;;
    libtalloc:aarch64)          echo "556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7" ;;
    libtalloc:x86_64)           echo "b8c6d95f20075dc1f9ec6573575b2444e8d526e48e0d8d6d5cf4e071e6e06530" ;;
    libandroid-shmem:aarch64)   echo "0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6" ;;
    libandroid-shmem:x86_64)    echo "ffa9e4c87467b158b148d0ff92dda796aa038276c2075af3269cdcdb06f25797" ;;
    *) echo "" ;;
  esac
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/_cache"
ASSETS="$ROOT/app/src/main/assets"
JNILIBS="$ROOT/app/src/main/jniLibs/$ABI"

mkdir -p "$CACHE" "$ASSETS" "$JNILIBS"

# ── 依赖检查 ────────────────────────────────────────────────────
for tool in curl sha256sum tar ar patchelf; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "缺少工具 $tool" >&2
    case "$tool" in
      patchelf) echo "  Ubuntu: apt-get install patchelf" >&2 ;;
    esac
    exit 1
  fi
done

fetch() {
  # fetch <url> <目标文件> <期望 sha256>
  local url="$1" out="$2" want="$3"
  if [ -f "$out" ] && [ -n "$want" ] && echo "$want  $out" | sha256sum -c --status - 2>/dev/null; then
    echo "  已缓存 $(basename "$out")"
    return 0
  fi
  echo "  下载 $(basename "$out")"
  curl -fL --retry 3 --retry-delay 2 -o "$out.part" "$url"
  if [ -n "$want" ]; then
    local got
    got="$(sha256sum "$out.part" | awk '{print $1}')"
    if [ "$got" != "$want" ]; then
      echo "校验失败: $(basename "$out")" >&2
      echo "  期望 $want" >&2
      echo "  实际 $got" >&2
      rm -f "$out.part"
      exit 1
    fi
  fi
  mv "$out.part" "$out"
}

extract_deb() {
  # extract_deb <deb> <目标目录>：不依赖 dpkg，用 ar + tar
  #
  # `-m`（不恢复 mtime）是必需的：在受限环境（容器/CI 沙箱）里
  # 对已经落盘的 inode 调 utimensat 会 EPERM，tar 会以 2 退出，
  # 整套构建就断在这里。时间戳对最终产物毫无影响。
  local deb="$1" out="$2"
  rm -rf "$out"
  mkdir -p "$out"
  ( cd "$out" && ar x "$deb" && tar -xf data.tar.* -m --no-same-owner && rm -f data.tar.* debian-binary control.tar.* )
}

echo "==> ABI $ABI（Alpine $ALPINE_ARCH / Termux $TERMUX_ARCH）"

# ── 1. Alpine minirootfs ────────────────────────────────────────
echo "==> Alpine minirootfs $ALPINE_VER"
ALPINE_TGZ="$CACHE/alpine-minirootfs-$ALPINE_VER-$ALPINE_ARCH.tar.gz"
fetch \
  "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER%.*}/releases/$ALPINE_ARCH/alpine-minirootfs-$ALPINE_VER-$ALPINE_ARCH.tar.gz" \
  "$ALPINE_TGZ" \
  "$(alpine_sha "$ALPINE_ARCH")"

# 先验证能正常解开再往 assets 里放，避免把一个坏包发出去
if ! tar -tzf "$ALPINE_TGZ" >/dev/null; then
  echo "rootfs 归档损坏：$ALPINE_TGZ" >&2
  exit 1
fi
# 后缀必须是 .tgz，**不能是 .tar.gz**：
# aapt 对 `.gz` 结尾的 asset 有一套"自动解压"的遗留行为 —— 它会把包解开、
# 把名字改成去掉 .gz 的 rootfs.tar，于是 APK 里躺着一份 8.7MB 的未压缩 tar
# （白涨 5MB，且装机后还得再解一次）。.tgz 不在这个名单里，原样保留。
rm -f "$ASSETS/rootfs.tar.gz" "$ASSETS/rootfs.tar"
cp -f "$ALPINE_TGZ" "$ASSETS/rootfs.tgz"

# ── 2. proot + 依赖 ─────────────────────────────────────────────
echo "==> proot 运行时"
BASE="https://packages.termux.dev/apt/termux-main/pool/main"
fetch "$BASE/p/proot/${PROOT_PKG}_${TERMUX_ARCH}.deb" \
  "$CACHE/${PROOT_PKG}_${TERMUX_ARCH}.deb" "$(termux_sha proot "$TERMUX_ARCH")"
fetch "$BASE/libt/libtalloc/${TALLOC_PKG}_${TERMUX_ARCH}.deb" \
  "$CACHE/${TALLOC_PKG}_${TERMUX_ARCH}.deb" "$(termux_sha libtalloc "$TERMUX_ARCH")"
fetch "$BASE/liba/libandroid-shmem/${SHMEM_PKG}_${TERMUX_ARCH}.deb" \
  "$CACHE/${SHMEM_PKG}_${TERMUX_ARCH}.deb" "$(termux_sha libandroid-shmem "$TERMUX_ARCH")"

for pkg in "${PROOT_PKG}_${TERMUX_ARCH}" "${TALLOC_PKG}_${TERMUX_ARCH}" "${SHMEM_PKG}_${TERMUX_ARCH}"; do
  extract_deb "$CACHE/$pkg.deb" "$CACHE/x/$pkg"
done
PREFIX="$CACHE/x/${PROOT_PKG}_${TERMUX_ARCH}/data/data/com.termux/files/usr"
TPREFIX="$CACHE/x/${TALLOC_PKG}_${TERMUX_ARCH}/data/data/com.termux/files/usr"
SPREFIX="$CACHE/x/${SHMEM_PKG}_${TERMUX_ARCH}/data/data/com.termux/files/usr"

if [ ! -x "$PREFIX/bin/proot" ] && [ ! -f "$PREFIX/bin/proot" ]; then
  echo "proot 解包结果异常：$PREFIX/bin/proot 不存在" >&2
  exit 1
fi

cp -f "$PREFIX/bin/proot"                     "$JNILIBS/libproot.so"
cp -f "$PREFIX/libexec/proot/loader"          "$JNILIBS/libproot-loader.so"
cp -f "$TPREFIX/lib/libtalloc.so.2.5.0"       "$JNILIBS/libtalloc.so"
cp -f "$SPREFIX/lib/libandroid-shmem.so"      "$JNILIBS/libandroid-shmem.so"

# ── 3. 改 soname / NEEDED，让 Android 链接器按默认搜索路径找到它们 ──
# 链接器在 nativeLibraryDir 里是按 soname 找的：
#   proot 的 DT_NEEDED 写的是 libtalloc.so.2，而我们只能落一个 libtalloc.so，
#   所以两边都要改。顺带把 RPATH 换成 $ORIGIN（原来是 Termux 的前缀路径，
#   在这里不存在，靠默认搜索路径也能命中，但显式写死更稳）。
patchelf --set-soname libtalloc.so        "$JNILIBS/libtalloc.so"
patchelf --set-soname libandroid-shmem.so "$JNILIBS/libandroid-shmem.so"
patchelf --replace-needed libtalloc.so.2 libtalloc.so "$JNILIBS/libproot.so"
patchelf --set-rpath '$ORIGIN'            "$JNILIBS/libproot.so"

chmod 755 "$JNILIBS"/libproot.so "$JNILIBS"/libproot-loader.so

# ── 4. 自检 ─────────────────────────────────────────────────────
echo "==> 自检"
fail=0
for f in libproot.so libproot-loader.so libtalloc.so libandroid-shmem.so; do
  if [ ! -f "$JNILIBS/$f" ]; then
    echo "  缺少 $JNILIBS/$f" >&2; fail=1; continue
  fi
  printf '  %-22s %8s bytes  %s\n' "$f" "$(stat -c%s "$JNILIBS/$f")" \
    "$(readelf -h "$JNILIBS/$f" | awk '/Machine:/{print $2, $3, $4}')"
done
need="$(readelf -d "$JNILIBS/libproot.so" | awk '/NEEDED/{gsub(/[][]/,"");print $NF}' | tr '\n' ' ')"
echo "  proot NEEDED: $need"
case "$need" in
  *libtalloc.so\ *|*libtalloc.so) ;;
  *) echo "  proot 的 libtalloc 依赖没改成功" >&2; fail=1 ;;
esac
printf '  rootfs.tgz            %8s bytes\n' "$(stat -c%s "$ASSETS/rootfs.tgz")"

# 关键不变量：每个 PT_LOAD 的 p_offset 必须与 p_vaddr 对 p_align 同余。
#
# patchelf 修改 ELF 后，最后一个 LOAD 的偏移会落在 patchelf 新开的页边界上
# （此时仍然合法）。但后续任何"重写文件"的工具（AGP 打包时的 llvm-strip 就是）
# 只要删掉中间的填充却不修正 p_offset，同余关系就断，linker64 映射错位，
# 程序在 main() 之前 SIGSEGV 且没有任何输出 —— 极难从设备侧定位。
# 所以在这里提前把不变量验掉，而不是等装到设备上崩。
if ! python3 - "$JNILIBS" <<'PY'
import struct, sys, os
bad = 0
for name in ("libproot.so", "libproot-loader.so", "libtalloc.so", "libandroid-shmem.so"):
    path = os.path.join(sys.argv[1], name)
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"\x7fELF" or data[4] != 2:      # 只处理 ELF64
        continue
    e_phoff, = struct.unpack_from("<Q", data, 0x20)
    e_phentsize, e_phnum = struct.unpack_from("<HH", data, 0x36)
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type, = struct.unpack_from("<I", data, off)
        if p_type != 1:                              # PT_LOAD
            continue
        p_offset, p_vaddr = struct.unpack_from("<QQ", data, off + 0x08)
        p_align, = struct.unpack_from("<Q", data, off + 0x30)
        if p_align > 1 and (p_offset % p_align) != (p_vaddr % p_align):
            print(f"  {name}: LOAD off=0x{p_offset:x} vaddr=0x{p_vaddr:x} "
                  f"align=0x{p_align:x} —— 不同余，链接器会映射错位", file=sys.stderr)
            bad = 1
sys.exit(1 if bad else 0)
PY
then
  echo "  ELF 段同余校验失败（见上）" >&2
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1
echo "==> 完成"
