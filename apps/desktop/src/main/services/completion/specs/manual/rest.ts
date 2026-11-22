// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令手册：其余命令（紧凑三/四元组：`[用途, 语法, 安装方式?]`）。
 *
 * 要求：**目录里每一条命令都至少能搜到并显示用途与语法**（见 search.test.ts 的覆盖断言）。
 * 内容为本项目自撰；未从任何第三方语料取用。
 */

import { manualFromRow, type ManualEntry, type ManualRow } from '../types'

/** [命令名, 用途, 语法, 安装方式?] */
type Row = readonly [string, string, string, string?]

const ROWS: readonly Row[] = [
  // ── 文件与目录 ─────────────────────────────────────────────────────────────
  ['rmdir', '删除空目录（比 rm -r 更安全）', 'rmdir [选项]... 目录...', '系统自带（coreutils）'],
  ['stat', '显示文件/文件系统的详细状态', 'stat [选项]... 文件...', '系统自带（coreutils）'],
  ['file', '探测文件类型（不看扩展名）', 'file [选项]... 文件...', '系统自带（file）'],
  ['locate', '从预建数据库里按名字快速找文件', 'locate [选项] 模式', '需安装：apt install mlocate'],
  ['tree', '以树形展示目录结构', 'tree [选项]... [目录]', '需安装：apt install tree'],
  ['dd', '按块复制/转换数据（做镜像、测速）', 'dd if=输入 of=输出 [参数]', '系统自带（coreutils）'],
  ['gunzip', '解压 .gz（等价 gzip -d）', 'gunzip [选项]... 文件.gz', '系统自带（gzip）'],
  ['xz', 'xz 压缩/解压（比 gzip 更小更慢）', 'xz [选项]... [文件]...', '系统自带（xz-utils）'],
  ['zip', '创建 zip 压缩包（与 Windows 通用）', 'zip [选项] 包名.zip 文件...', '需安装：apt install zip'],
  ['unzip', '解压 zip 包', 'unzip [选项] 包名.zip [-d 目录]', '需安装：apt install unzip'],
  ['mount', '挂载文件系统/设备到目录', 'mount [选项] [-t 类型] 设备 目录', '系统自带（util-linux）'],
  ['umount', '卸载已挂载的文件系统', 'umount [选项] 设备|目录', '系统自带（util-linux）'],
  ['chown', '修改文件属主（可同时改属组）', 'chown [选项]... 用户[:组] 文件...', '系统自带（coreutils）'],
  ['chgrp', '修改文件属组', 'chgrp [选项]... 组 文件...', '系统自带（coreutils）'],
  ['realpath', '把路径规范化成绝对路径（解析 . 与 ..）', 'realpath [选项]... 文件...', '系统自带（coreutils）'],
  ['basename', '取路径的最后一段（文件名）', 'basename 路径 [后缀]', '系统自带（coreutils）'],
  ['dirname', '取路径的目录部分', 'dirname 路径...', '系统自带（coreutils）'],
  ['readlink', '显示软链指向的目标', 'readlink [选项]... 文件...', '系统自带（coreutils）'],
  ['mktemp', '安全地创建临时文件/目录', 'mktemp [选项]... [模板]', '系统自带（coreutils）'],
  ['shred', '反复覆写文件后再删除（防恢复）', 'shred [选项]... 文件...', '系统自带（coreutils）'],
  ['truncate', '把文件截断或扩展到指定大小', 'truncate [选项]... 文件...', '系统自带（coreutils）'],
  ['sync', '把内存中的脏页刷入磁盘', 'sync [选项]...', '系统自带（coreutils）'],

  // ── 文本处理 ───────────────────────────────────────────────────────────────
  ['tac', '按行倒序输出文件', 'tac [选项]... [文件]...', '系统自带（coreutils）'],
  ['rg', 'ripgrep：递归搜索，默认忽略 .gitignore、速度极快', 'rg [选项] 模式 [路径]', '需安装：apt install ripgrep'],
  ['patch', '按 diff 补丁修改文件', 'patch [选项] [原文件] [补丁]', '系统自带（patch）'],
  ['comm', '逐行比较两个**已排序**文件', 'comm [选项] 文件1 文件2', '系统自带（coreutils）'],
  ['join', '按公共字段连接两个已排序文件', 'join [选项] 文件1 文件2', '系统自带（coreutils）'],
  ['paste', '把多个文件按列合并', 'paste [选项]... [文件]...', '系统自带（coreutils）'],
  ['split', '把大文件按大小/行数拆分', 'split [选项] 文件 [前缀]', '系统自带（coreutils）'],
  ['nl', '带行号输出（可只给非空行编号）', 'nl [选项]... [文件]...', '系统自带（coreutils）'],
  ['fold', '按宽度折行', 'fold [选项]... [文件]...', '系统自带（coreutils）'],
  ['column', '把文本排成对齐的表格', 'column [选项] [文件]...', '系统自带（bsdmainutils / util-linux）'],
  ['rev', '逐行反转字符顺序', 'rev [文件]...', '系统自带（util-linux）'],
  ['strings', '从二进制里提取可打印字符串', 'strings [选项] 文件...', '系统自带（binutils）'],
  ['base64', 'base64 编码/解码', 'base64 [选项] [文件]', '系统自带（coreutils）'],
  ['md5sum', '计算/校验 MD5 摘要', 'md5sum [选项]... [文件]...', '系统自带（coreutils）'],
  ['sha256sum', '计算/校验 SHA-256 摘要（校验下载文件首选）', 'sha256sum [选项]... [文件]...', '系统自带（coreutils）'],
  ['iconv', '转换文本编码（如 GBK ↔ UTF-8）', 'iconv -f 源编码 -t 目标编码 [文件]', '系统自带（glibc）'],

  // ── 进程与资源 ─────────────────────────────────────────────────────────────
  ['killall', '按进程名结束所有同名进程', 'killall [选项] 名字...', '系统自带（psmisc）'],
  ['pkill', '按名字/命令行模式结束进程', 'pkill [选项] 模式', '系统自带（procps）'],
  ['pgrep', '按模式查找进程号（不杀，只查）', 'pgrep [选项] 模式', '系统自带（procps）'],
  ['nice', '以指定优先级启动新进程', 'nice [-n 调整值] 命令', '系统自带（coreutils）'],
  ['renice', '调整已运行进程的优先级', 'renice -n 值 -p PID...', '系统自带（util-linux）'],
  ['jobs', '查看当前 shell 的后台任务', 'jobs [选项] [作业号]', 'Shell 内置'],
  ['bg', '把挂起的任务放到后台继续跑', 'bg [%作业号]', 'Shell 内置'],
  ['fg', '把后台任务调回前台', 'fg [%作业号]', 'Shell 内置'],
  ['sleep', '延时指定时间（脚本里等待用）', 'sleep 时长[后缀s|m|h|d]', '系统自带（coreutils）'],
  ['strace', '跟踪进程的系统调用（排障利器）', 'strace [选项] 命令 | -p PID', '需安装：apt install strace'],
  ['pidof', '按程序名查进程号', 'pidof [选项] 程序名', '系统自带（sysvinit-utils）'],
  ['vmstat', '查看虚拟内存、CPU 与 IO 概览', 'vmstat [间隔 [次数]]', '系统自带（procps）'],
  ['iostat', '查看磁盘 IO 与 CPU 统计', 'iostat [选项] [间隔 [次数]]', '需安装：apt install sysstat'],
  ['uptime', '查看运行时长与平均负载', 'uptime [选项]', '系统自带（procps）'],
  ['at', '安排一次性的定时任务', 'at [选项] 时间', '需安装：apt install at'],

  // ── 网络 ───────────────────────────────────────────────────────────────────
  ['mtr', '把 ping 与 traceroute 合起来：持续看每跳丢包', 'mtr [选项] 主机', '需安装：apt install mtr-tiny'],
  ['nslookup', '交互式查询 DNS（简单直接）', 'nslookup [选项] 名字 [服务器]', '需安装：apt install dnsutils'],
  ['host', '简短 DNS 查询', 'host [选项] 名字 [服务器]', '需安装：apt install bind9-host'],
  ['sftp', '基于 SSH 的交互式文件传输', 'sftp [选项] [用户@]主机', '系统自带（openssh-client）'],
  ['ifconfig', '查看/配置网卡（旧工具，新系统用 ip）', 'ifconfig [网卡] [参数]', '需安装：apt install net-tools'],
  ['route', '查看/修改路由表（旧工具，新系统用 ip route）', 'route [选项] [add|del ...]', '需安装：apt install net-tools'],
  ['arp', '查看/修改 ARP 邻居缓存', 'arp [选项] [主机名]', '需安装：apt install net-tools'],
  ['nmap', '扫描主机与端口，识别服务', 'nmap [选项] 目标...', '需安装：apt install nmap'],
  ['iperf3', '测量两台机器之间的带宽', 'iperf3 -s | -c 主机 [选项]', '需安装：apt install iperf3'],
  ['whois', '查询域名/IP 的注册信息', 'whois [选项] 对象', '需安装：apt install whois'],
  ['ufw', 'Ubuntu 简化防火墙管理', 'ufw [子命令] [规则]', '系统自带或 apt install ufw'],
  ['iptables', '内核包过滤规则（底层防火墙）', 'iptables [-t 表] 链 规则', '系统自带（iptables）'],
  ['socat', '多功能数据流中继（调试网络协议很好用）', 'socat [选项] 地址1 地址2', '需安装：apt install socat'],

  // ── 系统与 Shell ───────────────────────────────────────────────────────────
  ['hostname', '显示或临时设置主机名', 'hostname [选项] [新名字]', '系统自带（hostname）'],
  ['hostnamectl', '查看/设置主机名与系统标识（systemd）', 'hostnamectl [子命令] [参数]', '系统自带（systemd）'],
  ['timedatectl', '查看/设置时间、时区与网络校时', 'timedatectl [子命令] [参数]', '系统自带（systemd）'],
  ['whoami', '显示当前有效用户名', 'whoami', '系统自带（coreutils）'],
  ['id', '显示当前用户的 UID/GID 与所属组', 'id [选项] [用户]', '系统自带（coreutils）'],
  ['groups', '显示某用户所属的组', 'groups [用户]...', '系统自带（coreutils）'],
  ['who', '显示当前登录的用户', 'who [选项]', '系统自带（coreutils）'],
  ['w', '显示登录用户及其正在做什么', 'w [选项] [用户]', '系统自带（procps）'],
  ['last', '查看登录历史（含重启记录）', 'last [选项] [用户]', '系统自带（util-linux）'],
  ['dmesg', '查看内核环形缓冲（硬件/驱动报错在这里）', 'dmesg [选项]', '系统自带（util-linux）'],
  ['service', 'SysV 风格的服务控制（转发到 systemctl）', 'service 服务名 {start|stop|restart|status}', '系统自带（init-system-helpers）'],
  ['shutdown', '关机或重启（可定时并广播）', 'shutdown [选项] 时间 [消息]', '系统自带（systemd）'],
  ['reboot', '重启系统', 'reboot [选项]', '系统自带（systemd）'],
  ['su', '切换到另一个用户（默认 root）', 'su [选项] [用户]', '系统自带（util-linux）'],
  ['env', '在自定义环境下运行命令，或打印环境变量', 'env [选项] [变量=值]... [命令]', '系统自带（coreutils）'],
  ['alias', '定义/查看命令别名', 'alias [名字[=值]]', 'Shell 内置'],
  ['history', '查看或操作命令历史', 'history [选项] [条数]', 'Shell 内置'],
  ['ulimit', '查看/设置当前 shell 的资源上限', 'ulimit [选项] [值]', 'Shell 内置'],
  ['sysctl', '读写内核运行参数（网络/内存调优）', 'sysctl [选项] 变量[=值]', '系统自带（procps）'],
  ['lsmod', '列出已加载的内核模块', 'lsmod', '系统自带（kmod）'],
  ['modprobe', '加载/卸载内核模块（含依赖）', 'modprobe [选项] 模块 [参数]', '系统自带（kmod）'],
  ['lspci', '列出 PCI 设备（认显卡/网卡型号）', 'lspci [选项]', '需安装：apt install pciutils'],
  ['lsusb', '列出 USB 设备', 'lsusb [选项]', '需安装：apt install usbutils'],
  ['blkid', '查看块设备的 UUID/类型/标签', 'blkid [选项] [设备]', '系统自带（util-linux）'],
  ['fdisk', '管理磁盘分区表（MBR/GPT）', 'fdisk [选项] 设备', '系统自带（util-linux）'],
  ['lscpu', '查看 CPU 架构、核数、缓存等信息', 'lscpu [选项]', '系统自带（util-linux）'],
  ['nproc', '打印可用 CPU 核心数（脚本里常用）', 'nproc [选项]', '系统自带（coreutils）'],
  ['clear', '清屏', 'clear [选项]', '系统自带（ncurses-bin）'],
  ['echo', '输出文本/变量', 'echo [选项]... [字符串]...', 'Shell 内置'],
  ['printf', '按格式输出（比 echo 可控）', 'printf 格式 [参数]...', 'Shell 内置'],
  ['read', '从标准输入读一行到变量', 'read [选项] 变量...', 'Shell 内置'],
  ['expr', '表达式求值（旧式算术/字符串判断）', 'expr 表达式', '系统自带（coreutils）'],
  ['bc', '任意精度计算器（可脚本化）', 'bc [选项] [文件]', '需安装：apt install bc'],
  ['seq', '生成数字序列', 'seq [选项] 末数 | 首数 末数 [步长]', '系统自带（coreutils）'],
  ['yes', '重复输出一个字符串（自动回答 y）', 'yes [字符串]', '系统自带（coreutils）'],
  ['test', '条件判断（if 用的就是它）', 'test 表达式 / [ 表达式 ]', 'Shell 内置'],
  ['which', '显示命令的完整路径', 'which [选项] 命令...', '系统自带（debianutils）'],
  ['whereis', '查找命令的二进制/手册/源码位置', 'whereis [选项] 名字...', '需安装：apt install util-linux'],
  ['type', '判断名字是内置命令、别名还是外部程序', 'type [选项] 名字...', 'Shell 内置'],
  ['tty', '显示当前终端设备名', 'tty [选项]', '系统自带（coreutils）'],

  // ── 包管理与构建 ───────────────────────────────────────────────────────────
  ['apt-get', 'apt 的稳定脚本接口（老系统/脚本里更常见）', 'apt-get [选项] 子命令 [包...]', '系统自带（Debian 系）'],
  ['dpkg', '底层 deb 包管理（装本地 .deb、查包内文件）', 'dpkg [选项] 动作 [包]', '系统自带（Debian 系）'],
  ['dnf', 'Fedora/RHEL8+ 包管理', 'dnf [选项] 子命令 [包...]', '系统自带（Fedora/RHEL）'],
  ['yum', 'RHEL/CentOS 7 及更早的包管理', 'yum [选项] 子命令 [包...]', '系统自带（RHEL/CentOS）'],
  ['rpm', '底层 rpm 包管理', 'rpm [选项] 动作 [包]', '系统自带（RHEL 系）'],
  ['pacman', 'Arch 系包管理', 'pacman [选项] 动作 [包...]', '系统自带（Arch）'],
  ['apk', 'Alpine 包管理', 'apk [选项] 子命令 [包...]', '系统自带（Alpine）'],
  ['snap', 'Snap 沙箱化包管理', 'snap [选项] 子命令 [包]', '需安装：apt install snapd'],
  ['yarn', 'Node 包管理（yarn）', 'yarn [子命令] [包...]', '需先装 Node.js'],
  ['pnpm', 'Node 包管理（pnpm，磁盘占用小）', 'pnpm [子命令] [包...]', '需先装 Node.js'],
  ['cargo', 'Rust 包管理与构建', 'cargo [子命令] [选项]', '需安装：Rust 工具链（rustup）'],
  ['go', 'Go 工具链：构建、测试、拉依赖', 'go [子命令] [参数]', '需安装：Go 官方包'],
  ['cmake', '跨平台构建配置：生成 Makefile/工程文件', 'cmake [选项] 源码目录', '需安装：apt install cmake'],
  ['g++', 'GNU C++ 编译器', 'g++ [选项] 源文件...', '需安装：apt install build-essential'],
  ['clang', 'LLVM 的 C/C++ 编译器（报错更友好）', 'clang [选项] 源文件...', '需安装：apt install clang'],
  ['nm', '列出目标文件/可执行文件里的符号', 'nm [选项] 文件...', '系统自带（binutils）'],
  ['objdump', '反汇编与查看目标文件结构', 'objdump [选项] 文件...', '系统自带（binutils）'],
  ['gdb', 'GNU 调试器：断点、单步、看栈', 'gdb [选项] [程序 [core|PID]]', '需安装：apt install gdb'],
  ['valgrind', '内存泄漏/越界检测（跑得慢但准）', 'valgrind [选项] 程序 [参数]', '需安装：apt install valgrind'],
  ['perf', 'Linux 性能分析：采样热点、看计数器', 'perf 子命令 [选项]', '需安装：apt install linux-tools-common'],

  // ── 容器与虚拟化 ───────────────────────────────────────────────────────────
  ['podman', '无守护进程的容器管理（兼容 docker 命令）', 'podman [选项] 子命令 [参数]', '需安装：apt install podman'],
  ['minikube', '在本机跑一个单节点 Kubernetes 集群', 'minikube [选项] 子命令', '需安装：minikube 官方二进制'],
  ['kind', '用 Docker 容器当节点跑 K8s 集群', 'kind [选项] 子命令', '需安装：kind 官方二进制'],
  ['ctr', 'containerd 的底层命令行', 'ctr [选项] 子命令 [参数]', '系统自带（containerd）'],
  ['lxc', '系统级容器（比 docker 更像轻量虚拟机）', 'lxc [子命令] [参数]', '需安装：apt install lxc'],
  ['virsh', '管理 libvirt/KVM 虚拟机', 'virsh [选项] 子命令 [域]', '需安装：apt install libvirt-clients'],

  // ── 版本控制 ───────────────────────────────────────────────────────────────
  ['svn', 'Subversion 集中式版本控制', 'svn 子命令 [参数]', '需安装：apt install subversion'],
  ['hg', 'Mercurial 分布式版本控制', 'hg 子命令 [参数]', '需安装：apt install mercurial'],

  // ── 安全与密钥 ─────────────────────────────────────────────────────────────
  ['ssh-add', '把私钥加入 ssh-agent（免重复输口令）', 'ssh-add [选项] [私钥...]', '系统自带（openssh-client）'],
  ['ssh-agent', 'SSH 密钥代理进程', 'ssh-agent [选项] / eval "$(ssh-agent -s)"', '系统自带（openssh-client）'],
  ['ssh-copy-id', '把本机公钥安装到远端 authorized_keys', 'ssh-copy-id [-i 公钥] [用户@]主机', '系统自带（openssh-client）'],
  ['ssh-keyscan', '收集远端主机公钥（预填 known_hosts）', 'ssh-keyscan [选项] 主机...', '系统自带（openssh-client）'],
  ['passwd', '修改账户口令', 'passwd [选项] [用户]', '系统自带（passwd）'],
  ['usermod', '修改用户账户属性（组、家目录、shell）', 'usermod [选项] 用户', '系统自带（passwd）'],
  ['useradd', '创建用户账户', 'useradd [选项] 用户', '系统自带（passwd）'],
]

/** 其余命令的手册条目（命令名 → 条目） */
export const MANUAL_REST: Record<string, ManualEntry> = Object.fromEntries(
  ROWS.map(([name, purpose, usage, install]) => [
    name,
    manualFromRow(
      (install === undefined ? [purpose, usage] : [purpose, usage, install]) as ManualRow,
    ),
  ]),
)
