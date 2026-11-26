#!/usr/bin/env python3
"""
校验 APK / jniLibs 里每个 .so 的 PT_LOAD 段是否可被 Android linker 映射。

## 为什么需要这个脚本

Android 的 `linker64` 在 `load_segments()` 里对**每个** PT_LOAD 都要求

    (p_vaddr - p_offset) % page_size == 0

（page_size 取设备实际页大小：老设备 4096，Android 15+ 的新机型越来越多是 16384）。
不满足就直接 `dlopen failed`，so 根本映射不进来。

而 AGP 的 `MergeNativeLibs` 任务默认会对 jniLibs 跑 `llvm-strip`。strip 会删掉
段与段之间的填充页，**却不修正 `p_offset`**，于是偏移与地址失去同余。症状极其
隐蔽：

- 编译器/patchelf 的原始产物是好的（所以本地手工 push 到 /data/local/tmp 能跑）；
- 只有装进 APK 的那一份坏（所以"源码没问题啊"）；
- 4K 页设备上有时恰好还能对齐 —— 于是 x86_64 模拟器全绿，arm64 真机直接起不来。

2026-11 的 v0.3.0 arm64 包就是这样：jniLibs 源文件 16/16 全 OK，APK 里
libcrypto / libssl / libicuuc / libicui18n / libsqlite3 的 4K 同余全坏，
libnode 的 16K 同余坏。Waydroid 是 x86_64 4K，测不出来；群友的 arm64 手机
点开就闪退。

## 用法

    # 查 jniLibs 目录
    scripts/verify-elf-alignment.py apps/android/app/src/main/jniLibs/arm64-v8a

    # 查已打好的 APK（自动识别 lib/<abi>/*.so）
    scripts/verify-elf-alignment.py apps/desktop/release/terminal-1000-0.3.0-arm64-v8a.apk

    # 只要求 4K（给明确知道自己在干什么的老设备分支用）
    scripts/verify-elf-alignment.py <path> --page 4096

退出码 0 = 全部可加载；1 = 有问题（逐条打印原因）。
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import zipfile

PT_LOAD = 1
PT_DYNAMIC = 2
PT_INTERP = 3
DT_NULL = 0
DT_NEEDED = 1
DT_HASH = 4
DT_STRTAB = 5
DT_SONAME = 14
DT_RPATH = 15
DT_TEXTREL = 22
DT_GNU_HASH = 0x6FFFFEF5
DT_RUNPATH = 29

# Android 15 起官方要求 16 KB 对齐，Play 上架也按这个卡。
# 一份 16 KB 对齐的 so 在 4 KB 设备上同样合法（16 是 4 的倍数），
# 所以默认直接用最严的那档，不用分设备。
DEFAULT_PAGE = 16384


class Elf:
    """只解析校验需要的部分，不依赖 pyelftools。"""

    def __init__(self, data: bytes):
        if len(data) < 64 or data[:4] != b"\x7fELF":
            raise ValueError("不是 ELF 文件")
        if data[4] != 2:
            raise ValueError("不是 64 位 ELF（Android jniLibs 只收 64 位）")
        self.data = data
        self.end = "<" if data[5] == 1 else ">"
        (self.e_type, self.e_machine, _ver, self.e_entry, self.e_phoff, _shoff,
         _flags, _ehsize, self.e_phentsize, self.e_phnum) = struct.unpack_from(
            self.end + "HHIQQQIHHH", data, 16)

        self.loads: list[tuple[int, int, int, int, int, int]] = []
        self.interp: str | None = None
        for i in range(self.e_phnum):
            off = self.e_phoff + i * self.e_phentsize
            (p_type, p_flags, p_offset, p_vaddr, _paddr, p_filesz, p_memsz,
             p_align) = struct.unpack_from(self.end + "IIQQQQQQ", data, off)
            if p_type == PT_LOAD:
                self.loads.append((p_offset, p_vaddr, p_filesz, p_memsz, p_align, p_flags))
            elif p_type == PT_INTERP:
                raw = data[p_offset:p_offset + p_filesz]
                self.interp = raw.rstrip(b"\x00").decode("latin1", "replace")

        self.needed: list[str] = []
        self.soname: str | None = None
        self.runpath: str | None = None
        self.has_hash = False
        self.has_gnu_hash = False
        self.textrel = False
        self._read_dynamic()

    def _read_dynamic(self) -> None:
        strtab_off = strtab_size = None
        for i in range(self.e_phnum):
            off = self.e_phoff + i * self.e_phentsize
            (p_type, _f, p_offset, _va, _pa, p_filesz, _msz, _al) = struct.unpack_from(
                self.end + "IIQQQQQQ", self.data, off)
            if p_type != PT_DYNAMIC:
                continue
            entries = []
            for j in range(0, p_filesz, 16):
                tag, val = struct.unpack_from(self.end + "qQ", self.data, p_offset + j)
                if tag == DT_NULL:
                    break
                entries.append((tag, val))
            for tag, val in entries:
                if tag == DT_HASH:
                    self.has_hash = True
                elif tag == DT_GNU_HASH:
                    self.has_gnu_hash = True
                elif tag == DT_TEXTREL:
                    self.textrel = True
            for tag, val in entries:
                if tag == DT_STRTAB:
                    strtab_off = val
            # DT_STRTAB 是**虚拟地址**，程序头里没有它到文件偏移的直接映射，
            # 得走 PT_LOAD 反查。dynstr 一般就在第一个 LOAD 里。
            if strtab_off is not None:
                strtab_off = self._vaddr_to_offset(strtab_off)
            for tag, val in entries:
                if tag in (DT_NEEDED, DT_SONAME, DT_RUNPATH, DT_RPATH) and strtab_off:
                    s = self._read_str(strtab_off, val)
                    if tag == DT_NEEDED:
                        self.needed.append(s)
                    elif tag == DT_SONAME:
                        self.soname = s
                    elif tag in (DT_RUNPATH, DT_RPATH):
                        self.runpath = s
            return

    def _vaddr_to_offset(self, vaddr: int) -> int | None:
        for p_offset, p_vaddr, p_filesz, _m, _a, _fl in self.loads:
            if p_vaddr <= vaddr < p_vaddr + p_filesz:
                return vaddr - p_vaddr + p_offset
        return None

    def _read_str(self, base: int, off: int) -> str:
        start = base + off
        end = self.data.find(b"\x00", start)
        if end < 0:
            end = len(self.data)
        return self.data[start:end].decode("latin1", "replace")

    @property
    def machine(self) -> str:
        return {0xB7: "aarch64", 0x3E: "x86_64", 0x28: "arm"}.get(
            self.e_machine, f"0x{self.e_machine:x}")

    def congruence_problem(self, page: int) -> tuple[int, int, int] | None:
        """返回第一个不同余的 (p_offset, p_vaddr, 差值%)；全合法返回 None。"""
        for p_offset, p_vaddr, _fs, _ms, _al, _fl in self.loads:
            if (p_vaddr - p_offset) % page != 0:
                return (p_offset, p_vaddr, (p_vaddr - p_offset) % page)
        return None

    def overlapping(self) -> str | None:
        """映射区间重叠 / 文件尾巴不够长，也会让 linker 拒绝或读到垃圾。"""
        spans = sorted((o, o + f) for o, _v, f, _m, _a, _fl in self.loads if f > 0)
        for (a_start, a_end), (b_start, b_end) in zip(spans, spans[1:]):
            if b_start < a_end:
                return f"文件区间重叠：{a_start:#x}-{a_end:#x} 与 {b_start:#x}-{b_end:#x}"
        last = max((o + f) for o, _v, f, _m, _a, _fl in self.loads if f > 0)
        if last > len(self.data):
            return f"最后一个 LOAD 越过文件尾：需要 {last:#x}，实际 {len(self.data):#x}"
        return None


def collect(target: str) -> list[tuple[str, bytes]]:
    """支持目录与 APK 两种输入。"""
    out: list[tuple[str, bytes]] = []
    if zipfile.is_zipfile(target):
        with zipfile.ZipFile(target) as z:
            for info in z.infolist():
                n = info.filename
                if n.startswith("lib/") and n.endswith(".so") and "/" in n[4:]:
                    out.append((n, z.read(n)))
        return out
    for root, _dirs, files in os.walk(target):
        for f in sorted(files):
            if f.endswith(".so"):
                p = os.path.join(root, f)
                rel = os.path.relpath(p, target)
                with open(p, "rb") as fh:
                    out.append((rel, fh.read()))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="校验 Android so 的 PT_LOAD 页对齐（linker 可加载性）")
    ap.add_argument("target", help="jniLibs 目录，或已打好的 .apk")
    ap.add_argument("--page", type=int, default=DEFAULT_PAGE,
                    help=f"页大小，默认 {DEFAULT_PAGE}（16K）；老设备可用 4096")
    ap.add_argument("-q", "--quiet", action="store_true", help="只输出失败项")
    args = ap.parse_args()

    if not os.path.exists(args.target):
        print(f"路径不存在：{args.target}", file=sys.stderr)
        return 2

    items = collect(args.target)
    if not items:
        print(f"没有找到任何 .so：{args.target}", file=sys.stderr)
        return 2

    bad = 0
    sonames: dict[str, str] = {}
    for name, blob in items:
        try:
            elf = Elf(blob)
        except ValueError as e:
            print(f"✗ {name}: {e}")
            bad += 1
            continue

        problems: list[str] = []
        prob = elf.congruence_problem(args.page)
        if prob:
            off, vaddr, rem = prob
            problems.append(
                f"PT_LOAD 不同余：p_offset={off:#x} p_vaddr={vaddr:#x} "
                f"(p_vaddr-p_offset) % {args.page} = {rem}（应为 0）")
        ov = elf.overlapping()
        if ov:
            problems.append(ov)
        if not elf.loads:
            problems.append("没有 PT_LOAD 段")

        # 符号查找表：linker 靠它解析导出符号。两个都没有时 dlopen 会直接
        # 报 `empty/missing DT_HASH/DT_GNU_HASH` —— 与页对齐无关的另一种死法。
        #
        # 只对**动态链接**的目标要求：判据是「有 PT_INTERP（PIE 可执行）或者
        # 有 DT_NEEDED（依赖别的库）」。静态 PIE（比如 proot 的 loader，
        # 必须在 chroot 之前就能跑，所以静态链）既没有 interp 也没有 needed，
        # 由内核直接 exec，不经过 ld.so，没有哈希表是完全正常的。
        dynamic_linked = elf.interp is not None or len(elf.needed) > 0
        if dynamic_linked and not elf.has_hash and not elf.has_gnu_hash:
            problems.append("既没有 DT_HASH 也没有 DT_GNU_HASH（dlopen 会报 empty/missing DT_HASH）")

        # 文本段重定位：Android 6 起 linker 显式拒绝带 DT_TEXTREL 的 so
        # （需要 mprotect 写代码段，与 W^X 冲突）。
        if elf.textrel:
            problems.append("带 DT_TEXTREL 文本重定位（Android 6+ 的 linker 会拒绝加载）")

        if problems:
            bad += 1
            print(f"✗ {name}  [{elf.machine}, {len(blob)} bytes]")
            for p in problems:
                print(f"    {p}")
            if prob:
                # 这个提示要能直接把 Reader 引到修法上，否则下次还得重新推一遍
                print("    → 该 so 在设备上会 dlopen 失败。若它来自 jniLibs，"
                      "基本是 AGP 的 llvm-strip 删了填充页却没修 p_offset；"
                      "请确认 packaging.jniLibs.keepDebugSymbols 覆盖了它。")
        elif not args.quiet:
            print(f"✓ {name}  [{elf.machine}, {len(blob)} bytes, "
                  f"{len(elf.loads)} 个 LOAD, {args.page // 1024}K 对齐]")

        if elf.soname:
            sonames[elf.soname] = name

    # 依赖闭包检查：libnode.so 的 DT_NEEDED 必须都能在同一目录找到，
    # 否则 dlopen 会在 linker 阶段报 "cannot locate symbol" / "library not found"。
    missing: dict[str, list[str]] = {}
    for name, blob in items:
        try:
            elf = Elf(blob)
        except ValueError:
            continue
        for dep in elf.needed:
            if dep.startswith("libc.so") or dep.startswith("libm.so") or \
               dep.startswith("libdl.so") or dep.startswith("liblog.so") or \
               dep.startswith("ld-android.so") or dep.startswith("libstdc++.so"):
                continue  # 系统库，由 linker 从 /system/lib64 提供
            if dep not in sonames and not any(
                    os.path.basename(n) == dep for n, _ in items):
                missing.setdefault(name, []).append(dep)

    if missing:
        print("\n⚠ 依赖缺失（DT_NEEDED 指向的 so 不在同一目录）：")
        for name, deps in missing.items():
            print(f"  {name} → {', '.join(deps)}")
        print("  这些依赖会由 linker 从系统目录找；Termux 的库不在系统路径里，"
              "所以必须在 jniLibs 同目录提供。")

    total = len(items)
    print(f"\n{total} 个 so，{total - bad} 个可加载，{bad} 个不可加载"
          f"（页大小 {args.page}）")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
