// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令索引（**首屏唯一加载的语料数据**）。
 *
 * 这里刻意只放「命令名 + 一句简述 + 分类 + 是否有子命令」：
 * 体积小（见 performance.test.ts 的体积断言），选项明细全部在 `details/` 里惰性加载。
 *
 * 合规说明：全部为本项目自撰的通用 CLI 命令说明，**未**从任何第三方语料提取。
 *
 * 扩充方式：加一行 `[命令名, 简述, 分类, 是否有子命令?]`，再到对应
 * `details/<分类>.ts` 里补该命令的选项；`catalog.test.ts` 会校验两边一致。
 */

import type { CommandCategory, CommandIndexEntry } from './types'

/** [命令名, 简述, 分类, 是否有子命令?] */
type CatalogRow = readonly [string, string, CommandCategory, true?]

const ROWS: readonly CatalogRow[] = [
  // ── 文件与目录 ────────────────────────────────────────────────────────────
  ['ls', '列出目录内容', 'files'],
  ['cp', '复制文件或目录', 'files'],
  ['mv', '移动或重命名文件', 'files'],
  ['rm', '删除文件或目录', 'files'],
  ['mkdir', '创建目录', 'files'],
  ['rmdir', '删除空目录', 'files'],
  ['ln', '创建硬链接或符号链接', 'files'],
  ['touch', '创建空文件或更新时间戳', 'files'],
  ['stat', '显示文件详细状态', 'files'],
  ['file', '探测文件类型', 'files'],
  ['find', '按条件查找文件', 'files'],
  ['locate', '从数据库快速查找文件', 'files'],
  ['tree', '以树形展示目录', 'files'],
  ['du', '统计目录占用空间', 'files'],
  ['df', '查看文件系统使用情况', 'files'],
  ['dd', '按块复制与转换数据', 'files'],
  ['rsync', '增量同步文件', 'files'],
  ['tar', '打包与解包归档', 'files'],
  ['gzip', 'gzip 压缩', 'files'],
  ['gunzip', '解压 gzip 文件', 'files'],
  ['xz', 'xz 压缩与解压', 'files'],
  ['zip', '创建 zip 压缩包', 'files'],
  ['unzip', '解压 zip 压缩包', 'files'],
  ['mount', '挂载文件系统', 'files'],
  ['umount', '卸载文件系统', 'files'],
  ['chmod', '修改文件权限', 'files'],
  ['chown', '修改文件属主', 'files'],
  ['chgrp', '修改文件属组', 'files'],
  ['realpath', '规范化绝对路径', 'files'],
  ['basename', '取路径的文件名部分', 'files'],
  ['dirname', '取路径的目录部分', 'files'],
  ['readlink', '显示符号链接目标', 'files'],
  ['mktemp', '创建临时文件或目录', 'files'],
  ['shred', '安全擦除文件内容', 'files'],
  ['truncate', '调整文件大小', 'files'],
  ['sync', '把缓存刷入磁盘', 'files'],

  // ── 文本处理 ──────────────────────────────────────────────────────────────
  ['cat', '拼接并输出文件内容', 'text'],
  ['tac', '反向输出文件内容', 'text'],
  ['head', '输出文件开头部分', 'text'],
  ['tail', '输出文件末尾或跟踪增长', 'text'],
  ['less', '分页浏览文件', 'text'],
  ['grep', '按模式搜索文本', 'text'],
  ['rg', 'ripgrep 递归快速搜索', 'text'],
  ['sed', '流式文本替换与编辑', 'text'],
  ['awk', '按列处理结构化文本', 'text'],
  ['cut', '按分隔符截取列', 'text'],
  ['sort', '排序文本行', 'text'],
  ['uniq', '去除相邻重复行', 'text'],
  ['tr', '转换或删除字符', 'text'],
  ['wc', '统计行数词数字节', 'text'],
  ['tee', '同时写文件与标准输出', 'text'],
  ['xargs', '把标准输入转成命令参数', 'text'],
  ['diff', '比较两个文件的差异', 'text'],
  ['patch', '按补丁文件修改内容', 'text'],
  ['comm', '比较两个已排序文件', 'text'],
  ['join', '按公共字段连接两个文件', 'text'],
  ['paste', '按列合并文件', 'text'],
  ['split', '拆分大文件', 'text'],
  ['nl', '带行号输出文本', 'text'],
  ['fold', '按宽度折行', 'text'],
  ['column', '把文本排成对齐的列', 'text'],
  ['rev', '逐行反转字符顺序', 'text'],
  ['strings', '提取二进制中的可打印串', 'text'],
  ['base64', 'base64 编解码', 'text'],
  ['md5sum', '计算 MD5 校验值', 'text'],
  ['sha256sum', '计算 SHA-256 校验值', 'text'],
  ['iconv', '转换字符编码', 'text'],
  ['jq', '处理 JSON 数据', 'text'],

  // ── 进程与资源 ────────────────────────────────────────────────────────────
  ['ps', '查看进程快照', 'process'],
  ['top', '实时查看进程与负载', 'process'],
  ['htop', '交互式进程查看器', 'process'],
  ['kill', '向进程发送信号', 'process'],
  ['killall', '按名字结束进程', 'process'],
  ['pkill', '按模式结束进程', 'process'],
  ['pgrep', '按模式查找进程号', 'process'],
  ['nice', '以指定优先级启动进程', 'process'],
  ['renice', '调整运行中进程的优先级', 'process'],
  ['nohup', '忽略挂断信号运行命令', 'process'],
  ['jobs', '查看当前 shell 的后台任务', 'process'],
  ['bg', '把任务放到后台运行', 'process'],
  ['fg', '把任务调到前台运行', 'process'],
  ['sleep', '延时指定时间', 'process'],
  ['timeout', '限时运行命令', 'process'],
  ['watch', '周期性重复执行命令', 'process'],
  ['strace', '跟踪系统调用', 'process'],
  ['lsof', '列出打开的文件与端口', 'process'],
  ['pidof', '按程序名查进程号', 'process'],
  ['free', '查看内存与交换分区', 'process'],
  ['vmstat', '查看虚拟内存与 IO 统计', 'process'],
  ['iostat', '查看磁盘 IO 统计', 'process'],
  ['uptime', '查看运行时长与平均负载', 'process'],
  ['crontab', '管理定时任务', 'process'],
  ['at', '安排一次性定时任务', 'process'],

  // ── 网络 ──────────────────────────────────────────────────────────────────
  ['ping', '测试网络连通性', 'network'],
  ['traceroute', '跟踪数据包路由路径', 'network'],
  ['mtr', '路由跟踪与丢包统计', 'network'],
  ['dig', '查询 DNS 记录', 'network'],
  ['nslookup', '交互式查询 DNS', 'network'],
  ['host', '简单 DNS 查询', 'network'],
  ['curl', '用 URL 传输数据', 'network'],
  ['wget', '下载文件', 'network'],
  ['nc', 'netcat 读写 TCP/UDP', 'network'],
  ['ssh', '远程登录执行命令', 'network'],
  ['scp', '基于 SSH 复制文件', 'network'],
  ['sftp', '基于 SSH 的文件传输', 'network'],
  ['ip', '查看与配置网络接口', 'network', true],
  ['ifconfig', '查看与配置网卡', 'network'],
  ['route', '查看与修改路由表', 'network'],
  ['ss', '查看套接字与监听端口', 'network'],
  ['netstat', '查看网络连接与统计', 'network'],
  ['arp', '查看 ARP 缓存', 'network'],
  ['tcpdump', '抓取网络数据包', 'network'],
  ['nmap', '扫描主机与端口', 'network'],
  ['iperf3', '测量网络带宽', 'network'],
  ['whois', '查询域名注册信息', 'network'],
  ['ufw', 'Ubuntu 防火墙管理', 'network', true],
  ['iptables', '配置内核包过滤规则', 'network', true],
  ['socat', '多功能数据流中继', 'network'],

  // ── 系统与 Shell ──────────────────────────────────────────────────────────
  ['uname', '显示内核与系统信息', 'system'],
  ['hostname', '显示或设置主机名', 'system'],
  ['hostnamectl', '管理主机名与系统标识', 'system'],
  ['date', '显示或设置系统时间', 'system'],
  ['timedatectl', '管理时间与时区', 'system'],
  ['whoami', '显示当前用户名', 'system'],
  ['id', '显示用户与组标识', 'system'],
  ['groups', '显示用户所属组', 'system'],
  ['who', '显示当前登录用户', 'system'],
  ['w', '显示登录用户及活动', 'system'],
  ['last', '显示登录历史', 'system'],
  ['dmesg', '查看内核环形缓冲日志', 'system'],
  ['journalctl', '查询 systemd 日志', 'system'],
  ['systemctl', '管理系统服务与单元', 'system', true],
  ['service', '以 SysV 方式管理服务', 'system'],
  ['shutdown', '关机或重启', 'system'],
  ['reboot', '重启系统', 'system'],
  ['su', '切换用户身份', 'system'],
  ['sudo', '以其它身份执行命令', 'system'],
  ['env', '查看或在自定义环境中运行', 'system'],
  ['alias', '定义命令别名', 'system'],
  ['history', '查看命令历史', 'system'],
  ['ulimit', '查看或设置资源上限', 'system'],
  ['sysctl', '读写内核运行参数', 'system'],
  ['lsmod', '列出已加载内核模块', 'system'],
  ['modprobe', '加载或卸载内核模块', 'system'],
  ['lspci', '列出 PCI 设备', 'system'],
  ['lsusb', '列出 USB 设备', 'system'],
  ['lsblk', '列出块设备与分区', 'system'],
  ['blkid', '查看块设备属性', 'system'],
  ['fdisk', '管理磁盘分区表', 'system'],
  ['lscpu', '显示 CPU 架构信息', 'system'],
  ['nproc', '显示可用 CPU 核心数', 'system'],
  ['clear', '清屏', 'system'],
  ['echo', '输出文本', 'system'],
  ['printf', '按格式输出文本', 'system'],
  ['read', '从标准输入读入一行', 'system'],
  ['expr', '计算表达式', 'system'],
  ['bc', '任意精度计算器', 'system'],
  ['seq', '生成数字序列', 'system'],
  ['yes', '重复输出一个字符串', 'system'],
  ['test', '判断表达式真假', 'system'],
  ['which', '定位命令的完整路径', 'system'],
  ['whereis', '查找命令与手册位置', 'system'],
  ['type', '判断名字是命令还是别名', 'system'],
  ['man', '查看命令手册', 'system'],
  ['tty', '显示当前终端设备', 'system'],

  // ── 包管理与构建 ──────────────────────────────────────────────────────────
  ['apt', 'Debian 系包管理', 'package', true],
  ['apt-get', 'Debian 系包管理（稳定接口）', 'package', true],
  ['dpkg', '底层 deb 包管理', 'package'],
  ['dnf', 'Fedora 系包管理', 'package', true],
  ['yum', 'RHEL 系包管理', 'package', true],
  ['rpm', '底层 rpm 包管理', 'package'],
  ['pacman', 'Arch 系包管理', 'package', true],
  ['apk', 'Alpine 包管理', 'package', true],
  ['snap', 'Snap 包管理', 'package', true],
  ['pip', 'Python 包管理', 'package', true],
  ['npm', 'Node 包管理', 'package', true],
  ['yarn', 'Node 包管理（yarn）', 'package', true],
  ['pnpm', 'Node 包管理（pnpm）', 'package', true],
  ['cargo', 'Rust 包管理与构建', 'package', true],
  ['go', 'Go 工具链', 'package', true],
  ['make', '按 Makefile 构建', 'package'],
  ['cmake', '跨平台构建配置', 'package'],
  ['gcc', 'GNU C 编译器', 'package'],
  ['g++', 'GNU C++ 编译器', 'package'],
  ['clang', 'LLVM C/C++ 编译器', 'package'],
  ['nm', '列出目标文件符号', 'package'],
  ['objdump', '反汇编目标文件', 'package'],
  ['gdb', 'GNU 调试器', 'package'],
  ['valgrind', '内存与性能分析', 'package'],
  ['perf', 'Linux 性能分析工具', 'package', true],

  // ── 容器与虚拟化 ──────────────────────────────────────────────────────────
  ['docker', '容器管理', 'container', true],
  ['docker-compose', '编排多个容器', 'container', true],
  ['kubectl', 'Kubernetes 集群操作', 'container', true],
  ['podman', '无守护进程容器管理', 'container', true],
  ['helm', 'Kubernetes 包管理', 'container', true],
  ['minikube', '本地 Kubernetes 集群', 'container', true],
  ['kind', '用容器跑 K8s 集群', 'container', true],
  ['ctr', 'containerd 命令行', 'container', true],
  ['lxc', '系统容器管理', 'container', true],
  ['virsh', '管理 libvirt 虚拟机', 'container', true],

  // ── 版本控制 ──────────────────────────────────────────────────────────────
  ['git', '分布式版本控制', 'vcs', true],
  ['gh', 'GitHub 命令行', 'vcs', true],
  ['svn', 'Subversion 版本控制', 'vcs', true],
  ['hg', 'Mercurial 版本控制', 'vcs', true],

  // ── 安全与密钥 ────────────────────────────────────────────────────────────
  ['ssh-keygen', '生成与管理 SSH 密钥', 'security'],
  ['ssh-add', '把私钥加入 agent', 'security'],
  ['ssh-agent', 'SSH 密钥代理', 'security'],
  ['ssh-copy-id', '把公钥安装到远端', 'security'],
  ['ssh-keyscan', '收集远端主机公钥', 'security'],
  // gpg 的操作是长选项而非子命令（--list-keys 等），因此不标 hasSubcommands
  ['gpg', 'GnuPG 加解密与签名', 'security'],
  ['openssl', '加密工具箱', 'security', true],
  ['passwd', '修改账户密码', 'security'],
  ['usermod', '修改用户账户属性', 'security'],
  ['useradd', '创建用户账户', 'security'],
]

/** 索引条目（由紧凑行展开；首屏只加载这一个数组） */
export const CATALOG: readonly CommandIndexEntry[] = ROWS.map(([name, brief, category, hasSubs]) => {
  const entry: CommandIndexEntry = { name, brief, category }
  if (hasSubs === true) entry.hasSubcommands = true
  return entry
})

/** 命令名 → 索引条目 */
export const CATALOG_BY_NAME: ReadonlyMap<string, CommandIndexEntry> = new Map(
  CATALOG.map((entry) => [entry.name, entry]),
)

/** 语料规模（测试与汇报用） */
export const CATALOG_SIZE = CATALOG.length
