// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * ★ AI 执行护栏：命令风险分类 + 执行决策 + 三重上限 + 审计日志。
 *
 * 这是本模块的安全核心，设计原则是 **fail-closed（不确定就不放行）**：
 * - 命令先按 shell 语法**拆段**（`;` `&&` `||` `|` 换行），任一段危险则整条危险
 *   —— 否则 `ls && rm -rf /` 会因为开头是 `ls` 而被放行；
 * - 分类顺序：永久禁止 → 危险模式 → 危险命令 → 只读白名单 → 未知；
 * - **未知一律要求人工确认**，绝不因为"看起来无害"就默认执行；
 * - 未开启执行（allowExecution=false）或 chat 模式 → 只返回建议，不执行；
 * - 三重上限（轮数/命令数/目标数）任一触发立即抛错，由上层转成 AI_ERROR；
 * - 每次执行前后都写审计日志（谁/哪个会话/什么命令/结果）。
 *
 * 测试重点：只读放行、危险拦截、上限触发、未开启执行只给建议。
 */

import type { AiSettings } from '@t1000/shared'

/** AI 交互模式（对应 AiSettings.mode） */
export type AiMode = 'chat' | 'assistant' | 'confirm' | 'thinking'

/** 命令风险等级 */
export type CommandRisk = 'read-only' | 'unknown' | 'dangerous'

/** 一次命令评估的结果 */
export interface CommandEvaluation {
  /** 整条命令的风险（取所有分段的最高） */
  risk: CommandRisk
  /** 按 shell 控制符拆出的分段（已去空白） */
  segments: string[]
  /** 命中危险的具体原因，供 UI 展示"为什么被拦" */
  reasons: string[]
  /** 是否包含 sudo 提权 */
  sudo: boolean
  /** 是否命中"永不执行"（fork 炸弹、rm -rf / 等，即使用户放开黑名单也不放行） */
  alwaysDeny: boolean
  /** 是否包含写重定向 / 命令替换等无法静态定级的构造 */
  unsafeConstruct: boolean
}

/** 执行决策 */
export type ExecutionPlan =
  | { action: 'suggest'; risk: CommandRisk; reason: string }
  | { action: 'execute'; risk: CommandRisk; reason: string }
  | { action: 'confirm'; risk: CommandRisk; reason: string; alwaysDeny: boolean }
  | { action: 'deny'; risk: CommandRisk; reason: string; alwaysDeny: boolean }

/** 三重上限 */
export interface GuardLimits {
  /** 对话轮数上限 */
  maxRounds: number
  /** 累计执行命令数上限 */
  maxCommands: number
  /** 涉及主机数上限 */
  maxTargets: number
}

/** 合并 AiSettings 后实际生效的策略 */
export interface EffectivePolicy {
  allowExecution: boolean
  mode: AiMode
  /** 用户追加的只读白名单 */
  extraReadOnly: string[]
  /** 用户追加的危险黑名单（子串匹配） */
  extraDangerous: string[]
  /** sudo 是否需要人工确认 */
  confirmSudo: boolean
  /** 用户是否显式放开危险黑名单 */
  allowDangerous: boolean
  /** 用户是否允许 sudo */
  allowSudo: boolean
  limits: GuardLimits
}

export const DEFAULT_LIMITS: GuardLimits = {
  maxRounds: 20,
  maxCommands: 50,
  maxTargets: 5,
}

// ---------------------------------------------------------------------------
// 命令名单
// ---------------------------------------------------------------------------

/**
 * 只读命令前缀（多词前缀用空格分隔，按"整词前缀"匹配）。
 * 覆盖常见系统/网络/进程/存储/开发工具；列表本身的意图是"明确安全"，
 * 没进列表的命令会落到 unknown → 要求确认，而不是被误判为安全。
 */
export const READ_ONLY_PREFIXES: readonly string[] = [
  // 文件与目录（只读查看）
  'ls', 'dir', 'vdir', 'tree', 'stat', 'file', 'readlink', 'realpath', 'basename', 'dirname',
  'cat', 'tac', 'head', 'tail', 'nl', 'less', 'more', 'view', 'zcat', 'zless', 'bzcat', 'xzcat',
  'wc', 'sort', 'uniq', 'cut', 'paste', 'join', 'comm', 'tr', 'fold', 'fmt', 'pr', 'column',
  'cmp', 'diff', 'sdiff', 'vimdiff',
  'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'b2sum', 'xxd', 'hexdump', 'od',
  'strings', 'objdump', 'nm', 'readelf', 'ldd',
  'find', 'locate', 'mlocate', 'which', 'whereis', 'type', 'command -v', 'du', 'df', 'dutree',
  'lsattr', 'getfacl', 'getfattr', 'attr',
  // 文本检索/处理（不含写回）
  'grep', 'egrep', 'fgrep', 'rgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'mawk', 'perl',
  // 进程 / 系统
  'ps', 'pstree', 'pgrep', 'pidof', 'top -b', 'htop -b', 'free', 'vmstat', 'iostat', 'mpstat',
  'sar', 'uptime', 'w', 'who', 'whoami', 'id', 'groups', 'last', 'lastlog', 'users', 'finger',
  'nproc', 'arch', 'uname', 'hostname', 'hostnamectl status', 'timedatectl status',
  'locale', 'localectl status', 'date', 'cal', 'uptime',
  'lscpu', 'lsmem', 'lsblk', 'lspci', 'lsusb', 'lsmod', 'lshw', 'dmidecode', 'hwinfo',
  'dmesg', 'journalctl', 'sysctl -a', 'sysctl --all', 'ulimit -a', 'umask',
  'sensors', 'nvidia-smi', 'nvidia-smi -q', 'smartctl -a', 'smartctl -i', 'smartctl -H',
  'env', 'printenv', 'set -o', 'tty', 'stty -a', 'echo', 'printf', 'seq', 'expr', 'bc',
  'test', '[', 'true', 'false', 'sleep', 'jobs', 'history', 'alias', 'help',
  // 存储 / 挂载（只读查询）
  'mount', 'findmnt', 'blkid', 'lsblk -f', 'quota', 'lvs', 'vgs', 'pvs', 'pvdisplay', 'vgdisplay',
  'lvdisplay', 'lvm lvs', 'lvm vgs', 'lvm pvs', 'mdadm --detail',
  // 网络（只读查询）
  'ip addr', 'ip a', 'ip link', 'ip route', 'ip r', 'ip neigh', 'ip netns list', 'ip -s link',
  'ifconfig', 'route', 'arp', 'ss', 'netstat', 'lsof', 'fuser', 'netplan get',
  'ping', 'ping6', 'traceroute', 'tracepath', 'mtr', 'dig', 'nslookup', 'host', 'getent hosts',
  'curl -I', 'curl --head', 'wget --spider',
  // 服务与日志（只读子命令）
  'systemctl status', 'systemctl show', 'systemctl list-units', 'systemctl list-unit-files',
  'systemctl list-timers', 'systemctl is-active', 'systemctl is-enabled', 'systemctl cat',
  'service --status-all', 'systemd-analyze', 'systemd-analyze blame', 'systemd-cgls',
  'systemd-cgtop', 'loginctl list-sessions', 'loginctl show-session',
  // 包管理（只查询）
  'apt list', 'apt-cache', 'apt show', 'dpkg -l', 'dpkg --list', 'dpkg -s', 'dpkg -L',
  'rpm -q', 'rpm -qa', 'yum list', 'yum info', 'dnf list', 'dnf info', 'dnf repoquery',
  'pacman -Q', 'pacman -Qi', 'pacman -Ql', 'pacman -Ss', 'zypper search', 'zypper info',
  'snap list', 'flatpak list', 'pip list', 'pip show', 'pip freeze', 'pip3 list', 'pip3 show',
  'npm ls', 'npm list', 'npm view', 'npm outdated', 'yarn list', 'pnpm list', 'gem list',
  'composer show', 'cargo search', 'go list', 'go version', 'go env',
  // 开发工具（只查询/构建预演）
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote', 'git tag',
  'git describe', 'git rev-parse', 'git config --get', 'git config --list', 'git blame',
  'git shortlog', 'git reflog', 'git stash list', 'git ls-files', 'git ls-remote',
  'svn status', 'svn info', 'svn log', 'hg status', 'hg log',
  'python --version', 'python3 --version', 'python -V', 'python3 -V', 'node --version', 'node -v',
  'npm --version', 'pnpm --version', 'yarn --version', 'ruby --version', 'php --version',
  'java -version', 'javac -version', 'go version', 'rustc --version', 'cargo --version',
  'gcc --version', 'g++ --version', 'clang --version', 'make -n', 'make --dry-run',
  'cmake --version', 'cmake -LA', 'pkg-config --list-all', 'ldconfig -p',
  'docker ps', 'docker images', 'docker inspect', 'docker logs', 'docker version', 'docker info',
  'docker stats --no-stream', 'docker network ls', 'docker volume ls',
  'podman ps', 'podman images', 'podman inspect', 'podman logs',
  'kubectl get', 'kubectl describe', 'kubectl logs', 'kubectl version', 'kubectl cluster-info',
  'kubectl config view', 'kubectl api-resources', 'helm list', 'helm status', 'helm get',
  'terraform plan', 'terraform show', 'terraform output', 'terraform state list',
  'ansible --version', 'ansible-doc', 'ansible-inventory --list', 'ansible-playbook --check',
  'ansible-playbook --syntax-check', 'vault status', 'consul members', 'nomad status',
  // 容器/虚拟化只读
  'virsh list', 'virsh dominfo', 'virsh domstate', 'virsh net-list', 'virsh pool-list',
  'qemu-img info', 'vboxmanage list', 'vboxmanage showvminfo',
]

/** 命令名本身即危险（无安全子命令可谈） */
const DANGEROUS_COMMANDS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'shred', 'truncate', 'dd', 'mkfs', 'mke2fs', 'mkfs.ext2', 'mkfs.ext3',
  'mkfs.ext4', 'mkfs.xfs', 'mkfs.btrfs', 'mkfs.vfat', 'fdisk', 'sfdisk', 'cfdisk', 'parted',
  'gdisk', 'sgdisk', 'wipefs', 'blkdiscard', 'hdparm',
  'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'ebtables', 'arptables',
  'shutdown', 'reboot', 'poweroff', 'halt', 'init', 'telinit', 'kexec',
  'chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'setfattr', 'usermod', 'shadowconfig',
  'useradd', 'adduser', 'userdel', 'deluser', 'groupadd', 'groupdel', 'gpasswd', 'passwd',
  'chpasswd', 'chsh', 'chfn', 'vipw', 'vigr', 'visudo',
  'kill', 'killall', 'pkill', 'renice', 'systemd-run', 'systemctl daemon-reload',
  'mount', 'umount', 'swapon', 'swapoff', 'losetup', 'quotaon', 'quotaoff', 'tune2fs',
  'modprobe', 'insmod', 'rmmod', 'depmod', 'insmod', 'kmod',
  'crontab', 'at', 'batch', 'systemd-analyze security',
  'apt', 'apt-get', 'aptitude', 'dpkg', 'yum', 'dnf', 'rpm', 'pacman', 'zypper', 'snap',
  'pip', 'pip3', 'npm', 'yarn', 'pnpm', 'gem', 'composer', 'cargo install', 'go install',
  'docker', 'podman', 'nerdctl', 'kubectl', 'helm', 'terraform', 'ansible-playbook',
  'nc', 'netcat', 'ncat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'rdesktop',
  'eval', 'exec', 'source', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'csh', 'fish', 'python -c',
  'python3 -c', 'perl -e', 'ruby -e', 'node -e', 'lua -e', 'php -r',
  'setenforce', 'selinuxenabled', 'aa-disable', 'aa-complain', 'usermod -aG',
  'aclocal', 'nmap', 'masscan', 'hydra', 'john', 'aircrack-ng',
])

/** 有"只读子命令"但其它子命令危险：未列出的子命令按 unknown 处理 */
const SUBCOMMAND_RULES: Record<string, { dangerous: readonly string[] }> = {
  systemctl: {
    dangerous: [
      'start', 'stop', 'restart', 'reload', 'reload-or-restart', 'enable', 'disable', 'mask',
      'unmask', 'daemon-reload', 'kill', 'isolate', 'set-property', 'edit', 'reset-failed',
      'suspend', 'hibernate', 'poweroff', 'reboot', 'emergency', 'rescue',
    ],
  },
  service: { dangerous: ['start', 'stop', 'restart', 'reload', 'force-reload'] },
  sysctl: { dangerous: ['-w', '--write', '-p', '--load'] },
  mount: { dangerous: ['-o', '--options', '-a', '--all', '-t', '--types'] },
  'git': {
    dangerous: [
      'push', 'reset', 'clean', 'checkout', 'switch', 'restore', 'revert', 'rebase', 'merge',
      'commit', 'add', 'rm', 'mv', 'tag', 'branch -D', 'branch -d', 'stash drop', 'stash pop',
      'gc', 'filter-branch', 'update-ref', 'config', 'remote add', 'remote remove', 'init',
      'clone', 'fetch', 'pull', 'apply', 'am', 'cherry-pick',
    ],
  },
  kubectl: {
    dangerous: [
      'apply', 'delete', 'create', 'replace', 'patch', 'edit', 'scale', 'rollout', 'exec',
      'cp', 'drain', 'cordon', 'uncordon', 'taint', 'label', 'annotate', 'set', 'run',
      'expose', 'port-forward', 'attach', 'debug',
    ],
  },
  helm: { dangerous: ['install', 'upgrade', 'uninstall', 'delete', 'rollback', 'repo add', 'repo remove'] },
  terraform: { dangerous: ['apply', 'destroy', 'import', 'taint', 'untaint', 'state rm', 'state push', 'init'] },
  docker: {
    dangerous: [
      'run', 'exec', 'rm', 'rmi', 'stop', 'kill', 'restart', 'start', 'create', 'build', 'push',
      'pull', 'commit', 'tag', 'save', 'load', 'system prune', 'volume rm', 'network rm',
      'compose', 'swarm', 'service', 'stack', 'update', 'pause', 'unpause', 'attach', 'cp',
    ],
  },
  pacman: { dangerous: ['-S', '-R', '-U', '-Sy', '-Syu', '--sync', '--remove', '--upgrade'] },
  'apt': { dangerous: ['install', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'autoremove', 'update'] },
  'apt-get': { dangerous: ['install', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'autoremove', 'update'] },
  dnf: { dangerous: ['install', 'remove', 'erase', 'upgrade', 'update', 'autoremove'] },
  yum: { dangerous: ['install', 'remove', 'erase', 'update', 'upgrade'] },
  npm: { dangerous: ['install', 'i', 'uninstall', 'remove', 'rm', 'update', 'publish', 'link', 'run'] },
  pnpm: { dangerous: ['install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'publish', 'link', 'run'] },
  pip: { dangerous: ['install', 'uninstall', 'download'] },
  pip3: { dangerous: ['install', 'uninstall', 'download'] },
  gem: { dangerous: ['install', 'uninstall', 'update'] },
}

/** 危险构造（正则，对每个分段匹配） */
const DANGEROUS_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  // 递归/强制删除与递归改权限
  { re: /\brm\s+(-[A-Za-z]*[rR][A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*[rR]|-[rR]\b|--recursive|--force)/, reason: '递归/强制删除（rm -r / -f）' },
  { re: /\bchmod\s+(-[A-Za-z]*R|--recursive)/, reason: '递归改权限（chmod -R）' },
  { re: /\bchown\s+(-[A-Za-z]*R|--recursive)/, reason: '递归改属主（chown -R）' },
  { re: /\bchgrp\s+(-[A-Za-z]*R|--recursive)/, reason: '递归改属组（chgrp -R）' },
  // 就地写回
  { re: /\bsed\s+(-[A-Za-z]*i|--in-place)/, reason: 'sed 就地写回（-i）' },
  { re: /\bsort\s+(-o|--output)\b/, reason: 'sort 输出覆盖文件（-o）' },
  { re: /\bjournalctl\b.*--(vacuum|rotate|flush)/, reason: 'journalctl 清理/转储日志' },
  { re: /\bsmartctl\b.*\s-t\b/, reason: 'smartctl 自检会改动磁盘状态' },
  // 写入重定向 / 追加（只在分段里出现即可疑）
  // 只排除 `N>&M`（fd 复制，如 2>&1）；`1>file` 是真写文件，必须命中
  { re: />>?(?!&)/, reason: '输出重定向写入（> / >>）' },
  // find 本身只读，但 -delete/-exec 会写文件或执行任意命令
  { re: /\bfind\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls|fprint0)\b/, reason: 'find 带写入/执行动作（-delete / -exec）' },
  { re: /\btee\b/, reason: 'tee 写入文件' },
  { re: /\btruncate\b/, reason: 'truncate 截断文件' },
  // 下载后直接执行
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/, reason: '下载内容直接交给 shell 执行' },
  { re: /\b(curl|wget)\b.*\s(-o|--output|-O)\b/, reason: 'curl/wget 写出文件' },
  // 提权与任意执行
  { re: /(^|\s)sudo(\s|$)/, reason: 'sudo 提权' },
  { re: /\bsu\s+(-|root)\b/, reason: 'su 切换用户' },
  { re: /\bdoas\b/, reason: 'doas 提权' },
  // 危险系统操作
  { re: /\bkill\s+-(9|KILL)\b/, reason: '强制杀掉进程（kill -9）' },
  { re: /\b(poweroff|reboot|shutdown|halt)\b/, reason: '关机/重启' },
  { re: /\bsystemctl\s+(stop|restart|disable|mask|daemon-reload)\b/, reason: '停止/重启/禁用系统服务' },
  { re: /\bmv\s+.*\s\/(etc|boot|usr|var|bin|sbin|lib)\b/, reason: '移动系统关键目录内容' },
  { re: /\bcp\s+.*\s\/(etc|boot|usr|bin|sbin|lib)\b/, reason: '写入系统关键目录' },
  { re: /\bhistory\s+-c\b/, reason: '清空命令历史（破坏审计）' },
  { re: /\b(auditctl|ausearch)\b/, reason: '改动审计子系统' },
]

/**
 * 永不执行：即使 allowDangerous 显式放开也不放行。
 * 这些操作一旦执行，后果不可逆且几乎没有合法理由由 AI 触发。
 */
const ALWAYS_DENY_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, reason: 'fork 炸弹' },
  { re: /\brm\s+(-[A-Za-z]*\s+)*\/(\s|$)/, reason: '删除根目录' },
  { re: /\brm\s+(-[A-Za-z]*\s+)*\/\*(\s|$)/, reason: '删除根目录全部内容' },
  { re: /\bdd\b.*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: '直接写入块设备' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/, reason: '格式化文件系统' },
  { re: /\bwipefs\b|\bblkdiscard\b/, reason: '擦除设备签名' },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/, reason: '关机/重启' },
  { re: />\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: '重定向写入块设备' },
  { re: /\bmv\s+\/[^\s]*\s+\/dev\/null/, reason: '把系统路径移入 /dev/null' },
]

// ---------------------------------------------------------------------------
// shell 分段
// ---------------------------------------------------------------------------

interface ShellScan {
  segments: string[]
  hasRedirection: boolean
  hasSubstitution: boolean
  hasBackground: boolean
}

/**
 * 按 shell 控制符拆段，**尊重引号**（引号内的 `;`/`|` 不算分隔符）。
 * 不追求实现完整 shell 解析器，只要保证"不会因为引号把危险段藏起来"。
 */
export function scanShell(command: string): ShellScan {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  let hasRedirection = false
  let hasSubstitution = false
  let hasBackground = false

  const push = (): void => {
    const trimmed = current.trim()
    if (trimmed !== '') segments.push(trimmed)
    current = ''
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? ''

    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      current += ch
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }

    if (ch === '`') hasSubstitution = true
    if (ch === '$' && command[i + 1] === '(') hasSubstitution = true
    if (ch === '>' && command[i - 1] !== '>') hasRedirection = true

    if (ch === '\n' || ch === ';') {
      push()
      continue
    }
    if (ch === '|') {
      // `||` 与单 `|` 都是分隔符
      push()
      if (command[i + 1] === '|') i++
      continue
    }
    if (ch === '&') {
      hasBackground = true
      // `&&` 是分隔符；单个 `&` 是后台执行，也当分隔符
      push()
      if (command[i + 1] === '&') i++
      continue
    }
    current += ch
  }
  push()

  if (segments.length === 0 && command.trim() !== '') segments.push(command.trim())
  return { segments, hasRedirection, hasSubstitution, hasBackground }
}

/** 取分段里的命令名（跳过环境变量赋值与前缀 `command`/`builtin`） */
function commandNameOf(segment: string): { name: string; rest: string[]; sudo: boolean } {
  const tokens = segment.trim().split(/\s+/).filter((t) => t !== '')
  let i = 0
  let sudo = false
  while (i < tokens.length) {
    const t = tokens[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++
      continue
    }
    if (t === 'sudo' || t === 'doas') {
      sudo = true
      i++
      // 跳过 sudo 的选项与 -u user 之类
      while (i < tokens.length && (tokens[i] ?? '').startsWith('-')) {
        const opt = tokens[i] ?? ''
        i++
        if (opt === '-u' || opt === '--user' || opt === '-g' || opt === '-p') i++
      }
      continue
    }
    if (t === 'command' || t === 'builtin' || t === 'nohup' || t === 'time') {
      i++
      continue
    }
    break
  }
  const name = tokens[i] ?? ''
  return { name, rest: tokens.slice(i + 1), sudo }
}

// ---------------------------------------------------------------------------
// 策略合并与分类
// ---------------------------------------------------------------------------

/** 把 AiSettings 合并成实际生效策略（缺字段一律取最保守默认） */
export function effectivePolicyFrom(settings: AiSettings | undefined | null): EffectivePolicy {
  const ai = settings ?? undefined
  return {
    allowExecution: ai?.allowExecution ?? false,
    mode: (ai?.mode ?? 'chat') as AiMode,
    extraReadOnly: ai?.riskPolicy?.readOnlyAllowlist ?? [],
    extraDangerous: ai?.riskPolicy?.dangerousDenylist ?? [],
    confirmSudo: ai?.riskPolicy?.confirmSudo ?? true,
    // allowDangerous / allowSudo 不在 AiSettings 里：默认关闭，需上层显式注入
    allowDangerous: false,
    allowSudo: false,
    limits: {
      maxRounds: ai?.limits?.maxRounds ?? DEFAULT_LIMITS.maxRounds,
      maxCommands: ai?.limits?.maxCommands ?? DEFAULT_LIMITS.maxCommands,
      maxTargets: ai?.limits?.maxTargets ?? DEFAULT_LIMITS.maxTargets,
    },
  }
}

/** 单段分类 */
function classifySegment(segment: string, policy: EffectivePolicy): { risk: CommandRisk; reasons: string[]; sudo: boolean; alwaysDeny: boolean } {
  const reasons: string[] = []

  for (const { re, reason } of ALWAYS_DENY_PATTERNS) {
    if (re.test(segment)) {
      return { risk: 'dangerous', reasons: [reason], sudo: false, alwaysDeny: true }
    }
  }

  const { name, rest, sudo } = commandNameOf(segment)
  const normalized = segment.trim().replace(/\s+/g, ' ')

  // 用户自定义黑名单：子串命中即危险（比前缀匹配更严）
  for (const extra of policy.extraDangerous) {
    const e = extra.trim()
    if (e !== '' && normalized.includes(e)) {
      reasons.push(`命中用户黑名单: ${e}`)
    }
  }

  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(segment)) reasons.push(reason)
  }

  if (name === '') {
    return { risk: reasons.length > 0 ? 'dangerous' : 'read-only', reasons, sudo, alwaysDeny: false }
  }

  if (DANGEROUS_COMMANDS.has(name)) {
    reasons.push(`危险命令: ${name}`)
    return { risk: 'dangerous', reasons, sudo, alwaysDeny: false }
  }

  const sub = SUBCOMMAND_RULES[name]
  if (sub) {
    const subcommand = rest[0] ?? ''
    if (sub.dangerous.includes(subcommand)) {
      reasons.push(`危险子命令: ${name} ${subcommand}`)
      return { risk: 'dangerous', reasons, sudo, alwaysDeny: false }
    }
    // 子命令没被判定危险，但也没在只读白名单里 → 交给后面的白名单判定
  }

  if (reasons.length > 0) return { risk: 'dangerous', reasons, sudo, alwaysDeny: false }

  // 只读白名单：整词前缀匹配（用户追加项同样参与）
  const prefixes = [...policy.extraReadOnly, ...READ_ONLY_PREFIXES]
  for (const prefix of prefixes) {
    const p = prefix.trim()
    if (p === '') continue
    if (normalized === p || normalized.startsWith(`${p} `)) {
      return { risk: 'read-only', reasons: [], sudo, alwaysDeny: false }
    }
  }

  return { risk: 'unknown', reasons: [`未在白名单中的命令: ${name}`], sudo, alwaysDeny: false }
}

/**
 * 评估整条命令。任一分段危险 → 整条危险；含重定向/命令替换 → 至少 unknown。
 */
export function evaluateCommand(command: string, policy: EffectivePolicy): CommandEvaluation {
  const trimmed = command.trim()
  if (trimmed === '') {
    return { risk: 'unknown', segments: [], reasons: ['空命令'], sudo: false, alwaysDeny: false, unsafeConstruct: false }
  }

  const scan = scanShell(trimmed)
  const reasons: string[] = []
  let risk: CommandRisk = 'read-only'
  let sudo = false
  let alwaysDeny = false

  const rank: Record<CommandRisk, number> = { 'read-only': 0, unknown: 1, dangerous: 2 }
  const bump = (next: CommandRisk): void => {
    if (rank[next] > rank[risk]) risk = next
  }

  for (const segment of scan.segments) {
    const r = classifySegment(segment, policy)
    sudo = sudo || r.sudo || /(^|\s)sudo(\s|$)/.test(segment)
    alwaysDeny = alwaysDeny || r.alwaysDeny
    for (const reason of r.reasons) if (!reasons.includes(reason)) reasons.push(reason)
    bump(r.risk)
  }

  const unsafeConstruct = scan.hasRedirection || scan.hasSubstitution || scan.hasBackground
  if (unsafeConstruct) {
    // 写重定向已在危险模式里；命令替换/后台执行无法静态定级 → 至少 unknown
    if (scan.hasRedirection) bump('dangerous')
    else bump('unknown')
    if (scan.hasSubstitution) reasons.push('包含命令替换（$() 或反引号）')
    if (scan.hasBackground) reasons.push('包含后台执行（&）')
  }

  return { risk, segments: scan.segments, reasons, sudo, alwaysDeny, unsafeConstruct }
}

/**
 * 决定"这条命令该怎么办"。
 *
 * 不变量（护栏核心，别改）：
 * - 未开启执行 / chat 模式 → 永远 suggest，绝不执行；
 * - alwaysDeny → 永远 deny；
 * - dangerous → 默认 deny（要求人工确认），仅当用户显式 allowDangerous 才放行；
 * - unknown → 永远 confirm（不因模式是 assistant 就自动执行）；
 * - read-only → execute；
 * - sudo 还需 allowSudo，且 confirmSudo 时降级为 confirm。
 */
export function planCommandExecution(args: {
  command: string
  policy: EffectivePolicy
}): ExecutionPlan {
  const evaluation = evaluateCommand(args.command, args.policy)
  const { policy } = args

  if (!policy.allowExecution) {
    return { action: 'suggest', risk: evaluation.risk, reason: '未开启 AI 执行命令，仅返回建议' }
  }
  if (policy.mode === 'chat') {
    return { action: 'suggest', risk: evaluation.risk, reason: 'chat 模式只对话，不执行命令' }
  }
  if (evaluation.alwaysDeny) {
    return {
      action: 'deny',
      risk: evaluation.risk,
      reason: `永久禁止执行：${evaluation.reasons.join('、') || '高危操作'}`,
      alwaysDeny: true,
    }
  }

  // sudo 独立闸门：未允许则拒绝；允许但要求确认则降级为 confirm
  if (evaluation.sudo) {
    if (!policy.allowSudo) {
      return {
        action: 'deny',
        risk: 'dangerous',
        reason: 'sudo 未授权（需在设置与令牌中同时开启）',
        alwaysDeny: false,
      }
    }
    if (policy.confirmSudo || policy.mode === 'confirm') {
      return { action: 'confirm', risk: 'dangerous', reason: 'sudo 命令需要人工确认', alwaysDeny: false }
    }
  }

  switch (evaluation.risk) {
    case 'dangerous':
      if (policy.allowDangerous) {
        return policy.mode === 'confirm'
          ? { action: 'confirm', risk: 'dangerous', reason: '危险命令（已放开黑名单）仍需确认', alwaysDeny: false }
          : { action: 'execute', risk: 'dangerous', reason: '用户已显式放开危险黑名单', alwaysDeny: false }
      }
      return {
        action: 'deny',
        risk: 'dangerous',
        reason: `危险命令，已拒绝：${evaluation.reasons.join('、') || '命中黑名单'}`,
        alwaysDeny: false,
      }
    case 'unknown':
      // 不在白名单 = 需要人工判断，即使是 assistant 模式也不自动执行
      return {
        action: 'confirm',
        risk: 'unknown',
        reason: `命令不在只读白名单中，需要确认：${evaluation.reasons.join('、')}`,
        alwaysDeny: false,
      }
    case 'read-only':
      if (policy.mode === 'confirm') {
        return { action: 'confirm', risk: 'read-only', reason: 'confirm 模式：每步都确认', alwaysDeny: false }
      }
      return { action: 'execute', risk: 'read-only', reason: '只读命令，已放行', alwaysDeny: false }
  }
}

// ---------------------------------------------------------------------------
// 三重上限
// ---------------------------------------------------------------------------

export type LimitKind = 'rounds' | 'commands' | 'targets'

/** 上限触发错误：上层必须转成 AI_ERROR 并停止本轮 */
export class AiLimitError extends Error {
  constructor(
    readonly kind: LimitKind,
    message: string,
    readonly usage: GuardUsage,
    readonly limits: GuardLimits,
  ) {
    super(message)
    this.name = 'AiLimitError'
  }
}

export interface GuardUsage {
  rounds: number
  commands: number
  targets: number
}

/**
 * 一次 AI 会话的用量护栏。
 * 计数是**累计**的（跨轮），任一超限立即抛错，调用方必须停止执行。
 */
export class AiGuard {
  private rounds = 0
  private commands = 0
  private readonly targets = new Set<string>()

  constructor(private readonly limits: GuardLimits = DEFAULT_LIMITS) {}

  /** 开始新一轮：超过 maxRounds 抛错 */
  startRound(): void {
    this.rounds++
    if (this.rounds > this.limits.maxRounds) {
      throw new AiLimitError(
        'rounds',
        `已达对话轮数上限（${this.limits.maxRounds}），已停止`,
        this.usage(),
        this.limits,
      )
    }
  }

  /**
   * 记录一次命令执行前的用量。目标集合按 sessionId 去重（maxTargets = 涉及主机数）。
   * 超限抛错，且此时**不应**执行命令。
   */
  recordCommand(target: string): void {
    this.commands++
    if (this.commands > this.limits.maxCommands) {
      throw new AiLimitError(
        'commands',
        `已达累计命令数上限（${this.limits.maxCommands}），已停止`,
        this.usage(),
        this.limits,
      )
    }
    if (target !== '') this.targets.add(target)
    if (this.targets.size > this.limits.maxTargets) {
      throw new AiLimitError(
        'targets',
        `已达涉及主机数上限（${this.limits.maxTargets}），已停止`,
        this.usage(),
        this.limits,
      )
    }
  }

  usage(): GuardUsage {
    return { rounds: this.rounds, commands: this.commands, targets: this.targets.size }
  }

  targetIds(): string[] {
    return [...this.targets]
  }

  remaining(): GuardUsage {
    return {
      rounds: Math.max(0, this.limits.maxRounds - this.rounds),
      commands: Math.max(0, this.limits.maxCommands - this.commands),
      targets: Math.max(0, this.limits.maxTargets - this.targets.size),
    }
  }
}

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------

export type AuditPhase = 'before' | 'after'
export type AuditDecision = 'executed' | 'rejected' | 'suggested' | 'failed'

export interface AuditEntry {
  id: string
  timestamp: string
  phase: AuditPhase
  /** 触发者：'ai-assistant' 或 mcp 客户端名 */
  actor: string
  chatId?: string
  sessionId?: string
  /** 目标主机标识（host 或 sessionId） */
  target?: string
  command: string
  decision: AuditDecision
  risk: CommandRisk
  reason?: string
  /** 执行结果 */
  exitCode?: number
  durationMs?: number
  error?: string
}

/**
 * 有界审计日志：超出容量丢最旧的。
 * 接受可选 sink（写文件/数据库由上层注入），默认只留内存。
 */
export class AuditLog {
  private readonly entries: AuditEntry[] = []
  private seq = 0

  constructor(
    private readonly capacity = 1000,
    private readonly sink?: (entry: AuditEntry) => void,
  ) {}

  record(entry: Omit<AuditEntry, 'id' | 'timestamp'> & { timestamp?: string }): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      id: `audit-${++this.seq}`,
      timestamp: entry.timestamp ?? new Date().toISOString(),
    }
    this.entries.push(full)
    if (this.entries.length > this.capacity) this.entries.shift()
    try {
      this.sink?.(full)
    } catch {
      // 审计落盘失败不能影响主流程（但内存里仍保留）
    }
    return full
  }

  /** 最近的审计条目（新的在后） */
  list(limit = 100): AuditEntry[] {
    return limit >= this.entries.length ? [...this.entries] : this.entries.slice(-limit)
  }

  get size(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries.length = 0
  }
}

/** 供 UI 展示的一句话摘要（隐藏潜在机密：只给命令 + 决策） */
export function summarizeAudit(entry: AuditEntry): string {
  return `[${entry.timestamp}] ${entry.actor} ${entry.decision} risk=${entry.risk} cmd=${entry.command}`
}
