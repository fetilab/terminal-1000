#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 terminal-1000 contributors
"""
原地改写 ELF 动态字符串：给 .so 去掉版本后缀，且**不改变文件布局**。

为什么不用 patchelf：
`patchelf --replace-needed a b` 会重排/追加段来放下新字符串，实测把 51MB 的
libnode.so 撑到 62MB，并且在 Android 上直接段错误（linker 对段对齐很敏感）。
而且它默认不改 `DT_VERNEED`，改名后 linker 会报
`cannot find "libcrypto.so.3" from verneed[1] in DT_NEEDED list`。

这里的做法是：新名字一定**更短**（`libssl.so.3` → `libssl.so`），
所以直接在 .dynstr 原位置覆写并用 NUL 补齐即可 —— 段表、偏移、大小全不变，
只是若干字节的内容变了。同时改写三处引用，保证一致性：

- `DT_NEEDED`：依赖名
- `DT_VERNEED` 的 `vn_file`：符号版本记录里指向的库名（漏改就会报上面那个错）
- `DT_SONAME`：库自己的名字（避免同一库被映射两份）

用法：
  patch-elf-strings.py <file> --rename-versioned [--soname-from-name]
                              [--runpath '$ORIGIN']
"""

import os
import re
import struct
import sys

ELF_MAGIC = b"\x7fELF"

DT_NEEDED = 1
DT_SONAME = 14
DT_RPATH = 15
DT_RUNPATH = 29
DT_VERNEED = 0x6FFFFFFE

SHT_DYNAMIC = 6
SHT_DYNSTR = 3
SHT_GNU_VERNEED = 0x6FFFFFFE

# libssl.so.3 / libz.so.1 / libicudata.so.79 -> libssl.so / libz.so / libicudata.so
VERSIONED = re.compile(r"^(lib.+)\.so(\.\d+)+$")


def strip_version(name: str) -> str:
    m = VERSIONED.match(name)
    return m.group(1) + ".so" if m else name


class Elf:
    """够用的 ELF64 小端解析器（只要节表 + 动态段）。"""

    def __init__(self, path: str):
        self.path = path
        with open(path, "rb") as f:
            self.data = bytearray(f.read())
        if self.data[:4] != ELF_MAGIC:
            raise SystemExit(f"{path}: 不是 ELF 文件")
        if self.data[4] != 2:
            raise SystemExit(f"{path}: 只支持 ELF64")
        if self.data[5] != 1:
            raise SystemExit(f"{path}: 只支持小端")

        e_shoff = self.u64(0x28)
        e_shentsize = self.u16(0x3A)
        e_shnum = self.u16(0x3C)
        self.sections = []
        for i in range(e_shnum):
            off = e_shoff + i * e_shentsize
            (
                name,
                sh_type,
                _flags,
                sh_addr,
                sh_offset,
                sh_size,
                sh_link,
                _info,
                _align,
                sh_entsize,
            ) = struct.unpack_from("<IIQQQQIIQQ", self.data, off)
            self.sections.append(
                {
                    "name": name,
                    "type": sh_type,
                    "addr": sh_addr,
                    "offset": sh_offset,
                    "size": sh_size,
                    "link": sh_link,
                    "entsize": sh_entsize,
                }
            )

    # ── 基础读取 ──
    def u16(self, off: int) -> int:
        return struct.unpack_from("<H", self.data, off)[0]

    def u32(self, off: int) -> int:
        return struct.unpack_from("<I", self.data, off)[0]

    def u64(self, off: int) -> int:
        return struct.unpack_from("<Q", self.data, off)[0]

    def w64(self, off: int, val: int) -> None:
        struct.pack_into("<Q", self.data, off, val)

    def find(self, sh_type: int):
        for s in self.sections:
            if s["type"] == sh_type:
                return s
        return None

    def dynstr(self):
        dyn = self.find(SHT_DYNAMIC)
        if dyn is None:
            raise SystemExit(f"{self.path}: 没有 .dynamic")
        strtab = self.sections[dyn["link"]]
        return strtab

    def read_str(self, base: int, offset: int) -> str:
        end = self.data.index(b"\0", base + offset)
        return self.data[base + offset : end].decode("utf-8", "replace")

    def write_str(self, base: int, offset: int, new: str) -> bool:
        """在原位置覆写（新串必须不更长为前提），用 NUL 补齐。"""
        old_end = self.data.index(b"\0", base + offset)
        old_len = old_end - (base + offset)
        raw = new.encode()
        if len(raw) > old_len:
            return False
        self.data[base + offset : base + offset + old_len] = raw + b"\0" * (old_len - len(raw))
        return True

    def dynamic_entries(self):
        dyn = self.find(SHT_DYNAMIC)
        if dyn is None:
            return
        entsize = dyn["entsize"] or 16
        count = dyn["size"] // entsize
        for i in range(count):
            off = dyn["offset"] + i * entsize
            tag = self.u64(off)
            val = self.u64(off + 8)
            yield tag, val, off

    def vaddr_to_offset(self, vaddr: int) -> int:
        # 用节表映射：只对落在某个节地址区间内的值有效（.dynstr/.gnu.version_r 都满足）
        for s in self.sections:
            if s["addr"] and s["addr"] <= vaddr < s["addr"] + s["size"]:
                return s["offset"] + (vaddr - s["addr"])
        raise SystemExit(f"{self.path}: 无法映射地址 0x{vaddr:x}")


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    path = argv[1]
    rename_versioned = "--rename-versioned" in argv
    soname_from_name = "--soname-from-name" in argv
    runpath = None
    if "--runpath" in argv:
        runpath = argv[argv.index("--runpath") + 1]

    elf = Elf(path)
    strtab = elf.dynstr()
    sbase = strtab["offset"]

    changed = []

    # 1) DT_NEEDED + DT_VERNEED 一起改：两处必须一致，否则 linker 认为
    #    "verneed 里引用的库不在 NEEDED 列表里"而拒绝加载
    if rename_versioned:
        for tag, val, _off in elf.dynamic_entries():
            if tag != DT_NEEDED:
                continue
            name = elf.read_str(sbase, val)
            new = strip_version(name)
            if new != name and elf.write_str(sbase, val, new):
                changed.append(f"NEEDED {name} -> {new}")

        verneed = elf.find(SHT_GNU_VERNEED)
        if verneed is not None:
            off = verneed["offset"]
            end = off + verneed["size"]
            while off < end:
                vn_cnt = elf.u16(off + 2)
                vn_file_off = elf.u32(off + 4)  # 相对 .dynstr
                vn_next = elf.u32(off + 12)
                name = elf.read_str(sbase, vn_file_off)
                new = strip_version(name)
                if new != name and elf.write_str(sbase, vn_file_off, new):
                    changed.append(f"VERNEED {name} -> {new}")
                # 顺带走到 aux 之后的下一项
                if vn_next == 0:
                    break
                off += vn_next
                _ = vn_cnt

    # 2) SONAME：改成文件名，避免同名不同名的库被加载两份
    if soname_from_name:
        want = os.path.basename(path)
        for tag, val, off in elf.dynamic_entries():
            if tag != DT_SONAME:
                continue
            cur = elf.read_str(sbase, val)
            if cur != want and elf.write_str(sbase, val, want):
                changed.append(f"SONAME {cur} -> {want}")

    # 3) RUNPATH：换成 $ORIGIN，让依赖从 libnode.so 同目录解析
    if runpath is not None:
        for tag, val, off in elf.dynamic_entries():
            if tag not in (DT_RUNPATH, DT_RPATH):
                continue
            cur = elf.read_str(sbase, val)
            if cur != runpath and elf.write_str(sbase, val, runpath):
                changed.append(f"RUNPATH {cur} -> {runpath}")

    if changed:
        with open(path, "wb") as f:
            f.write(elf.data)
    for c in changed:
        print(f"    {os.path.basename(path)}: {c}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
