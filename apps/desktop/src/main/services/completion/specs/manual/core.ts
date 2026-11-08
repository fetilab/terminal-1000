// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 命令手册：**常用命令**（优先做扎实的一组，示例是"查用法"最有用的部分）。
 *
 * 全部为本项目自撰内容（用途/语法/安装方式/示例/快捷键），
 * 未从任何第三方语料或逆向提取物（如 withfig/tldr 提取物）取用。
 *
 * 语法行的写法约定：`[]` 表示可选、`...` 表示可重复、`<>` 表示占位符。
 */

import type { ManualEntry } from '../types'

export const MANUAL_CORE: Record<string, ManualEntry> = {
  // ── 文件与目录 ─────────────────────────────────────────────────────────────
  ls: {
    purpose: '列出目录内容：文件名、权限、大小、时间',
    usage: 'ls [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['ls -lh', '长格式 + 易读单位，日常最常用'],
      ['ls -la', '连以 . 开头的隐藏文件一起列'],
      ['ls -lt | head', '按修改时间倒序，看最近改过什么'],
    ],
  },
  cp: {
    purpose: '复制文件或目录',
    usage: 'cp [选项]... 源... 目标',
    install: '系统自带（coreutils）',
    examples: [
      ['cp -r src/ dst/', '递归复制整个目录'],
      ['cp -a src/ dst/', '归档复制：保留权限、属主、时间戳、软链'],
      ['cp -u *.log /backup/', '只复制比目标更新的文件'],
    ],
  },
  mv: {
    purpose: '移动文件/目录，或重命名',
    usage: 'mv [选项]... 源... 目标',
    install: '系统自带（coreutils）',
    examples: [
      ['mv old.txt new.txt', '重命名'],
      ['mv -i a.txt /tmp/', '覆盖前先询问'],
      ['mv *.jpg ~/Pictures/', '批量移动'],
    ],
  },
  rm: {
    purpose: '删除文件或目录（不可恢复，谨慎）',
    usage: 'rm [选项]... 文件...',
    install: '系统自带（coreutils）',
    examples: [
      ['rm file.txt', '删除文件'],
      ['rm -r dir/', '递归删除目录及其内容'],
      ['rm -rf dir/', '递归且不询问（危险：先确认路径）'],
    ],
  },
  mkdir: {
    purpose: '创建目录',
    usage: 'mkdir [选项]... 目录...',
    install: '系统自带（coreutils）',
    examples: [
      ['mkdir -p a/b/c', '一次性建多级目录（父目录不存在也能建）'],
      ['mkdir -m 700 private', '建目录并直接指定权限'],
    ],
  },
  find: {
    purpose: '按条件递归查找文件，可对结果执行命令',
    usage: 'find [路径...] [表达式]',
    install: '系统自带（findutils）',
    examples: [
      ['find . -name "*.log"', '按名字查找（区分大小写）'],
      ['find /var -type f -size +100M', '找大于 100MB 的普通文件'],
      ['find . -name "*.tmp" -delete', '查出并删除（先用 -print 确认）'],
      ['find . -mtime -1 -type f', '找最近 1 天修改过的文件'],
    ],
  },
  tar: {
    purpose: '打包/解包归档（常配合 gzip/xz 压缩）',
    usage: 'tar [选项]... [归档文件] [文件...]',
    install: '系统自带（tar）',
    examples: [
      ['tar -czf out.tar.gz dir/', '打包并用 gzip 压缩'],
      ['tar -xzf out.tar.gz -C /tmp/', '解压到指定目录'],
      ['tar -tzf out.tar.gz | head', '只看压缩包内容（不解压）'],
    ],
  },
  rsync: {
    purpose: '增量同步文件：只传差异，支持远端与断点续传',
    usage: 'rsync [选项]... 源... 目标',
    install: '系统自带（rsync，部分最小系统需 apt install rsync）',
    examples: [
      ['rsync -av src/ dst/', '归档同步并显示过程（注意 src/ 结尾斜杠的语义）'],
      ['rsync -avz -e ssh dir/ user@host:/data/', '经 SSH 同步并压缩传输'],
      ['rsync -av --delete src/ dst/', '让目标与源完全一致（会删掉目标多余文件）'],
      ['rsync -avn src/ dst/', '演练：只显示会做什么，不实际改动'],
    ],
  },
  chmod: {
    purpose: '修改文件权限（读/写/执行）',
    usage: 'chmod [选项]... 模式 文件...',
    install: '系统自带（coreutils）',
    examples: [
      ['chmod +x script.sh', '加执行权限'],
      ['chmod 644 file', '属主可读写，其他人只读'],
      ['chmod -R 755 dir/', '递归设置目录权限'],
    ],
  },
  du: {
    purpose: '统计目录/文件占用空间',
    usage: 'du [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['du -sh *', '每个条目只显示总计（找谁占地方）'],
      ['du -h --max-depth=1 /var', '只看 /var 下一层各目录大小'],
      ['du -ah dir | sort -h | tail', '按大小排序找最大的文件'],
    ],
  },
  df: {
    purpose: '查看各文件系统的容量与剩余空间',
    usage: 'df [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['df -h', '易读单位看各挂载点使用率'],
      ['df -hT', '同时显示文件系统类型'],
      ['df -i', '查看 inode 是否用尽（小文件很多时会遇到）'],
    ],
  },
  ln: {
    purpose: '创建硬链接或符号链接（软链）',
    usage: 'ln [选项]... 目标 链接名',
    install: '系统自带（coreutils）',
    examples: [
      ['ln -s /opt/app/v2 current', '建软链（最常用）'],
      ['ln -sfn /opt/app/v3 current', '原子替换已有软链'],
      ['ln file hardlink', '建硬链接（同分区、不能指向目录）'],
    ],
  },
  touch: {
    purpose: '创建空文件，或更新访问/修改时间',
    usage: 'touch [选项]... 文件...',
    install: '系统自带（coreutils）',
    examples: [
      ['touch new.txt', '文件不存在则建空文件'],
      ['touch -d "2026-01-01" file', '把时间戳改成指定值'],
      ['touch -r ref.txt target', '用参考文件的时间戳'],
    ],
  },
  gzip: {
    purpose: 'gzip 压缩/解压单个文件（会替换原文件）',
    usage: 'gzip [选项]... [文件]...',
    install: '系统自带（gzip）',
    examples: [
      ['gzip -k big.log', '压缩并保留原文件'],
      ['gzip -d big.log.gz', '解压（等价 gunzip）'],
      ['gzip -9 big.log', '最高压缩比（更慢）'],
    ],
  },

  // ── 文本处理 ───────────────────────────────────────────────────────────────
  grep: {
    purpose: '按模式搜索文本，可递归、可统计、可只看文件名',
    usage: 'grep [选项]... 模式 [文件]...',
    install: '系统自带（grep）',
    examples: [
      ['grep -rn "TODO" src/', '递归搜索并显示行号'],
      ['grep -i error app.log', '忽略大小写'],
      ['grep -v "^#" conf | grep .', '排除注释行与空行'],
      ['grep -C 3 panic syslog', '显示匹配行的上下文各 3 行'],
    ],
  },
  sed: {
    purpose: '流式文本编辑：替换、删除、按行号取行',
    usage: 'sed [选项]... 脚本 [文件]...',
    install: '系统自带（sed）',
    examples: [
      ['sed -i "s/old/new/g" file', '就地全局替换（-i 直接改文件）'],
      ['sed -n "10,20p" file', '只打印第 10-20 行'],
      ['sed "/^#/d" conf', '删除以 # 开头的行'],
    ],
  },
  awk: {
    purpose: '按列处理结构化文本：筛选、统计、汇总',
    usage: 'awk [选项] 模式 {动作} [文件]...',
    install: '系统自带（awk / gawk / mawk）',
    examples: [
      ['awk -F: "{print $1}" /etc/passwd', '按冒号分隔取第一列'],
      ['awk "{sum+=$1} END{print sum}" nums.txt', '求第一列之和'],
      ['awk "$9>0 {print $3, $9}" f.txt', '带条件筛选并打印指定列'],
    ],
  },
  cat: {
    purpose: '输出文件内容，或拼接多个文件',
    usage: 'cat [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['cat -n file', '带行号输出'],
      ['cat a.txt b.txt > all.txt', '拼接多个文件'],
      ['cat > note.txt <<EOF ... EOF', '配合 heredoc 写入多行内容'],
    ],
  },
  head: {
    purpose: '只输出文件开头（默认 10 行）',
    usage: 'head [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['head -n 50 app.log', '看前 50 行'],
      ['head -c 200 bin', '看前 200 字节'],
      ['zcat big.gz | head', '看压缩文件开头（不解压到磁盘）'],
    ],
  },
  tail: {
    purpose: '输出文件末尾，或实时跟踪新增日志',
    usage: 'tail [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['tail -n 100 app.log', '看最后 100 行'],
      ['tail -f app.log', '实时跟读（排障最常用）'],
      ['tail -F app.log', '跟读且日志轮转后自动重开'],
    ],
    shortcuts: [['Ctrl+C', '停止跟读并退出']],
  },
  less: {
    purpose: '分页浏览大文件（不会一次读入内存）',
    usage: 'less [选项]... [文件]...',
    install: '系统自带（less）',
    examples: [
      ['less +F app.log', '以跟读模式打开（类似 tail -f，Ctrl+C 退出跟读）'],
      ['less -N file', '显示行号'],
      ['ps aux | less', '翻阅长输出'],
    ],
    shortcuts: [
      ['空格 / b', '向下/向上一屏'],
      ['g / G', '跳到文件开头 / 结尾'],
      ['/ 与 ?', '向下 / 向上搜索'],
      ['n / N', '跳到下一个 / 上一个匹配'],
      ['q', '退出'],
    ],
  },
  sort: {
    purpose: '按行排序（可数值、可指定字段、可去重）',
    usage: 'sort [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['sort -h sizes.txt', '按易读大小排序'],
      ['sort -t: -k3 -n /etc/passwd', '按第 3 列数值排序'],
      ['sort -u names.txt', '排序并去重'],
    ],
  },
  uniq: {
    purpose: '去除**相邻**重复行，常与 sort 连用',
    usage: 'uniq [选项]... [输入文件] [输出文件]',
    install: '系统自带（coreutils）',
    examples: [
      ['sort names.txt | uniq', '先排序再整体去重'],
      ['sort log | uniq -c | sort -nr', '统计每行出现次数并倒序（Top N 神器）'],
      ['uniq -d file', '只看重复过的行'],
    ],
  },
  cut: {
    purpose: '按分隔符或位置切出指定列',
    usage: 'cut [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['cut -d: -f1,3 /etc/passwd', '按冒号取第 1、3 列'],
      ['cut -c1-8 file', '按字符位置取前 8 个字符'],
      ['ps aux | cut -c1-20', '截取输出的前 20 列'],
    ],
  },
  tr: {
    purpose: '字符级转换/删除（常用来处理大小写与空白）',
    usage: 'tr [选项]... 字符集1 [字符集2]',
    install: '系统自带（coreutils）',
    examples: [
      ['tr "a-z" "A-Z" < in > out', '转大写'],
      ['tr -d "\\r" < dos.txt > unix.txt', '删掉 Windows 换行里的 \\r'],
      ['tr -s " " < messy.txt', '把连续空格压成一个'],
    ],
  },
  wc: {
    purpose: '统计行数、词数、字节数',
    usage: 'wc [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['wc -l file', '只数行数'],
      ['grep -c "" file', '（参考）统计行数的另一种写法'],
      ['find . -name "*.ts" | wc -l', '统计文件个数'],
    ],
  },
  xargs: {
    purpose: '把标准输入转成命令行参数（配合 find/grep 批量执行）',
    usage: 'xargs [选项]... 命令 [初始参数]',
    install: '系统自带（findutils）',
    examples: [
      ['find . -name "*.tmp" | xargs rm -f', '批量删除（路径含空格时用 -0 配合）'],
      ['ls *.log | xargs -n1 -I{} gzip {}', '逐个压缩'],
      ['find . -type f -print0 | xargs -0 grep -l TODO', '处理含空格文件名'],
    ],
  },
  diff: {
    purpose: '比较两个文件/目录的差异',
    usage: 'diff [选项]... 文件1 文件2',
    install: '系统自带（diffutils）',
    examples: [
      ['diff -u old.conf new.conf', '统一格式输出（可直接喂给 patch）'],
      ['diff -rq dir1 dir2', '只报告目录里哪些文件不同'],
      ['diff <(sort a) <(sort b)', '比较两份排序后的内容'],
    ],
  },
  jq: {
    purpose: '解析与筛选 JSON（命令行里的 JSON 瑞士军刀）',
    usage: 'jq [选项]... 过滤器 [文件]...',
    install: '需安装：apt install jq',
    examples: [
      ['jq "." data.json', '美化输出'],
      ['jq -r ".items[].name" data.json', '取数组里每项的 name（原始文本）'],
      ['jq ".[] | select(.score > 60)" data.json', '按条件筛选对象'],
      ['curl -s api | jq ".data.id"', '与 curl 连用取字段'],
    ],
  },
  tee: {
    purpose: '把输出同时写到文件和屏幕（常用来边看边存日志）',
    usage: '命令 | tee [选项]... [文件]...',
    install: '系统自带（coreutils）',
    examples: [
      ['make 2>&1 | tee build.log', '编译输出同时存盘'],
      ['echo x | sudo tee /etc/conf.d/app', '以 root 权限写入受保护路径'],
      ['cmd | tee -a app.log', '追加而不是覆盖'],
    ],
  },

  // ── 进程与资源 ─────────────────────────────────────────────────────────────
  ps: {
    purpose: '查看进程快照（谁在跑、占多少 CPU/内存）',
    usage: 'ps [选项]...',
    install: '系统自带（procps）',
    examples: [
      ['ps aux', 'BSD 风格列出全部进程'],
      ['ps -eo pid,pcpu,pmem,args --sort=-pcpu | head', '按 CPU 占用倒序看前几名'],
      ['ps -ef | grep nginx', '找特定服务的进程'],
    ],
  },
  top: {
    purpose: '实时查看进程与系统负载（默认每 3 秒刷新）',
    usage: 'top [选项]...',
    install: '系统自带（procps）',
    examples: [
      ['top -o %CPU', '按 CPU 排序启动'],
      ['top -u www-data', '只看某个用户的进程'],
      ['top -b -n1 | head -20', '批处理输出一次（便于脚本采集）'],
    ],
    shortcuts: [
      ['q', '退出'],
      ['h', '帮助'],
      ['k', '按 PID 结束进程（会提示输入信号）'],
      ['M / P', '按内存 / CPU 排序'],
      ['1', '展开/收起每个 CPU 核心'],
    ],
  },
  htop: {
    purpose: '更友好的交互式进程查看器（树形、可鼠标、可搜索）',
    usage: 'htop [选项]...',
    install: '需安装：apt install htop',
    examples: [
      ['htop -u root', '只看 root 的进程'],
      ['htop -t', '以树形展示父子进程'],
    ],
    shortcuts: [
      ['F3 / F4', '搜索 / 过滤进程'],
      ['F5', '切换树形视图'],
      ['F6', '选择排序字段'],
      ['F9', '结束选中进程（可选信号）'],
      ['q', '退出'],
    ],
  },
  kill: {
    purpose: '给进程发信号（默认 SIGTERM 优雅结束）',
    usage: 'kill [-信号] PID...',
    install: '系统自带（coreutils）',
    examples: [
      ['kill 1234', '优雅结束（进程可自行清理）'],
      ['kill -9 1234', '强制杀死（不给清理机会）'],
      ['kill -HUP 1234', '让进程重载配置（很多服务支持）'],
      ['pkill -f "python worker.py"', '按命令行匹配（参考 pkill）'],
    ],
  },
  free: {
    purpose: '查看内存与 swap 使用情况',
    usage: 'free [选项]...',
    install: '系统自带（procps）',
    examples: [
      ['free -h', '易读单位'],
      ['free -m -s 2', '每 2 秒刷新一次（MB）'],
      ['free -h | awk "NR==2{print $7}"', '取 available 列（真正可用内存）'],
    ],
  },
  lsof: {
    purpose: '查看进程打开了哪些文件/端口（排查占用与句柄泄漏）',
    usage: 'lsof [选项]... [名字...]',
    install: '需安装：apt install lsof',
    examples: [
      ['lsof -i :8080', '谁占用了 8080 端口'],
      ['lsof -p 1234', '某进程打开了哪些文件'],
      ['lsof +D /data', '目录下哪些文件正被打开'],
      ['lsof -u www-data | wc -l', '统计该用户的文件句柄数'],
    ],
  },
  crontab: {
    purpose: '管理当前用户的定时任务（cron 表达式）',
    usage: 'crontab [-u 用户] [-l|-e|-r]',
    install: '系统自带（cron / cronie）',
    examples: [
      ['crontab -l', '列出当前任务'],
      ['crontab -e', '编辑任务（保存即生效）'],
      ['0 3 * * * /opt/backup.sh >> /var/log/backup.log 2>&1', '每天 3 点跑备份并记录日志'],
    ],
  },
  watch: {
    purpose: '周期性重复执行命令并全屏显示结果',
    usage: 'watch [选项]... 命令',
    install: '系统自带（procps）',
    examples: [
      ['watch -n 1 "df -h /"', '每秒看一次根分区剩余空间'],
      ['watch -d -n 2 "ss -s"', '高亮变化部分'],
      ['watch "ls -l /var/log | tail"', '盯目录变化'],
    ],
    shortcuts: [['Ctrl+C', '退出']],
  },
  nohup: {
    purpose: '让命令忽略挂断信号，退出终端后继续运行',
    usage: 'nohup 命令 [参数]... &',
    install: '系统自带（coreutils）',
    examples: [
      ['nohup ./server > server.log 2>&1 &', '后台常驻并把输出写日志'],
      ['nohup rsync -av big/ /backup/ &', '长任务挂后台'],
    ],
  },
  timeout: {
    purpose: '给命令设置最长运行时间，超时自动终止',
    usage: 'timeout [选项] 时长 命令 [参数]...',
    install: '系统自带（coreutils）',
    examples: [
      ['timeout 10 ping -c 100 host', '最多跑 10 秒'],
      ['timeout -s KILL 30 ./flaky.sh', '超时后强制杀死'],
      ['timeout 5 bash -c "cmd1 && cmd2"', '给整串命令设时限'],
    ],
  },

  // ── 网络 ───────────────────────────────────────────────────────────────────
  ssh: {
    purpose: '远程登录，或执行远端命令、做端口转发',
    usage: 'ssh [选项]... [用户@]主机 [命令]',
    install: '系统自带（openssh-client）',
    examples: [
      ['ssh user@host', '登录远程主机'],
      ['ssh -p 2222 user@host "uptime"', '指定端口并执行一条命令'],
      ['ssh -i ~/.ssh/id_ed25519 user@host', '用指定私钥登录'],
      ['ssh -L 8080:127.0.0.1:80 user@host', '本地端口转发到远端'],
      ['ssh -J jump@bastion user@host', '经跳板机连接'],
    ],
  },
  scp: {
    purpose: '基于 SSH 在本地与远端之间复制文件',
    usage: 'scp [选项]... 源... 目标',
    install: '系统自带（openssh-client）',
    examples: [
      ['scp file.txt user@host:/data/', '上传文件'],
      ['scp -r dir/ user@host:/data/', '上传整个目录'],
      ['scp -P 2222 user@host:/var/log/app.log .', '指定端口下载（注意 -P 大写）'],
    ],
  },
  curl: {
    purpose: '用 URL 传输数据：调接口、下载、看响应头',
    usage: 'curl [选项]... URL...',
    install: '系统自带（curl，部分最小系统需安装）',
    examples: [
      ['curl -i https://example.com', '连响应头一起看'],
      ['curl -X POST -H "Content-Type: application/json" -d "{\\"a\\":1}" url', '发 JSON POST'],
      ['curl -s url | jq .', '静默 + 解析 JSON'],
      ['curl -L -o file.tar.gz url', '跟随重定向下载'],
      ['curl -H "Authorization: Bearer $TOKEN" url', '带认证头'],
    ],
  },
  wget: {
    purpose: '下载文件，支持断点续传与递归抓取',
    usage: 'wget [选项]... URL...',
    install: '需安装：apt install wget',
    examples: [
      ['wget url', '下载到当前目录'],
      ['wget -c url', '断点续传'],
      ['wget -O name.tar.gz url', '指定保存文件名'],
      ['wget --limit-rate=200k url', '限速下载'],
    ],
  },
  ping: {
    purpose: '测试网络连通性与往返延迟',
    usage: 'ping [选项]... 主机',
    install: '系统自带（iputils-ping）',
    examples: [
      ['ping -c 4 host', '只发 4 个包（脚本里别用无限 ping）'],
      ['ping -i 0.2 -c 10 host', '间隔 0.2 秒发 10 个包'],
      ['ping -s 1400 -M do host', '探测 MTU（不分片）'],
    ],
    shortcuts: [['Ctrl+C', '停止并打印统计']],
  },
  netstat: {
    purpose: '查看网络连接、监听端口与统计（旧工具，新系统多用 ss）',
    usage: 'netstat [选项]...',
    install: '需安装：apt install net-tools',
    examples: [
      ['netstat -tulnp', '列出监听的 TCP/UDP 端口与进程'],
      ['netstat -an | grep ESTABLISHED | wc -l', '统计已建立连接数'],
      ['netstat -rn', '查看路由表'],
    ],
  },
  ss: {
    purpose: '查看套接字与监听端口（netstat 的现代替代，更快）',
    usage: 'ss [选项]... [过滤]',
    install: '系统自带（iproute2）',
    examples: [
      ['ss -tulnp', '监听端口 + 进程（排障首选）'],
      ['ss -tan state established', '只看已建立连接'],
      ['ss -s', '按协议汇总连接数'],
      ['ss -tnp dst :443', '看连到 443 的进程'],
    ],
  },
  dig: {
    purpose: '查询 DNS 记录（比 nslookup 更详细可控）',
    usage: 'dig [@DNS服务器] 名字 [类型]',
    install: '需安装：apt install dnsutils',
    examples: [
      ['dig example.com', '查 A 记录'],
      ['dig +short example.com', '只输出结果'],
      ['dig @8.8.8.8 example.com MX', '指定 DNS 服务器查 MX'],
      ['dig +trace example.com', '从根开始跟踪解析链路'],
    ],
  },
  ip: {
    purpose: '查看与配置网络接口、地址、路由（iproute2 套件）',
    usage: 'ip [选项] 对象 { 命令 }',
    install: '系统自带（iproute2）',
    examples: [
      ['ip -br a', '简洁列出所有网卡与地址'],
      ['ip route', '查看路由表'],
      ['ip link set eth0 up', '启用网卡（需 root）'],
      ['ip a add 192.168.1.10/24 dev eth0', '临时加地址'],
    ],
  },
  nc: {
    purpose: 'netcat：读写 TCP/UDP，做端口探测与简易传文件',
    usage: 'nc [选项] 主机 端口',
    install: '需安装：apt install netcat-openbsd',
    examples: [
      ['nc -zv host 22', '探测端口是否开放'],
      ['nc -l 9000', '本机监听 9000（另一端 nc host 9000 即可对话）'],
      ['nc -zv host 1-1000 2>&1 | grep succeeded', '扫描端口段'],
    ],
  },
  traceroute: {
    purpose: '跟踪数据包到目标经过的路由跳',
    usage: 'traceroute [选项] 主机',
    install: '需安装：apt install traceroute',
    examples: [
      ['traceroute example.com', '看路径（默认 UDP）'],
      ['traceroute -T -p 443 example.com', '用 TCP 443 探测（穿透常见过滤）'],
      ['traceroute -n example.com', '不解析域名，更快'],
    ],
  },
  tcpdump: {
    purpose: '抓取网络数据包并做协议分析',
    usage: 'tcpdump [选项] [表达式]',
    install: '需安装：apt install tcpdump',
    examples: [
      ['tcpdump -i any -nn port 80', '抓 80 端口流量（不解析名字）'],
      ['tcpdump -i eth0 -w cap.pcap', '存成 pcap 供 Wireshark 分析'],
      ['tcpdump -i any -A -s0 port 8080', '以 ASCII 显示载荷'],
    ],
    shortcuts: [['Ctrl+C', '停止抓包并打印统计']],
  },

  // ── 系统与 Shell ───────────────────────────────────────────────────────────
  systemctl: {
    purpose: '管理 systemd 服务与单元（systemd 系统的服务控制入口）',
    usage: 'systemctl [选项] 子命令 [单元...]',
    install: '系统自带（systemd）',
    examples: [
      ['systemctl status nginx', '看服务状态与最近日志'],
      ['sudo systemctl restart nginx', '重启服务'],
      ['sudo systemctl enable --now nginx', '设为开机自启并立刻启动'],
      ['systemctl list-units --failed', '列出启动失败的单元'],
      ['journalctl -u nginx -f', '跟读该服务日志（参考 journalctl）'],
    ],
  },
  journalctl: {
    purpose: '查询 systemd 日志（可按单元/时间/优先级过滤）',
    usage: 'journalctl [选项]...',
    install: '系统自带（systemd）',
    examples: [
      ['journalctl -u nginx -n 100', '看某服务最近 100 行'],
      ['journalctl -u nginx -f', '实时跟读'],
      ['journalctl --since "1 hour ago" -p err', '看最近一小时错误级日志'],
      ['journalctl -b -k', '本次启动的内核日志'],
    ],
    shortcuts: [
      ['q', '退出（分页器里）'],
      ['空格 / b', '翻页'],
      ['/ 与 n', '搜索与下一个匹配'],
    ],
  },
  date: {
    purpose: '显示或设置系统时间，也可做时间格式转换',
    usage: 'date [选项]... [+格式]',
    install: '系统自带（coreutils）',
    examples: [
      ['date +%F_%T', '格式化成 2026-01-01_12:00:00'],
      ['date -d "yesterday" +%F', '算昨天的日期'],
      ['date -d @1700000000', '把时间戳转成可读时间'],
      ['date -u', '以 UTC 显示'],
    ],
  },
  uname: {
    purpose: '显示内核与系统架构信息',
    usage: 'uname [选项]...',
    install: '系统自带（coreutils）',
    examples: [
      ['uname -a', '全部信息'],
      ['uname -r', '只看内核版本'],
      ['uname -m', '看架构（x86_64 / aarch64）'],
    ],
  },
  sudo: {
    purpose: '以其它身份（默认 root）执行命令',
    usage: 'sudo [选项] 命令',
    install: '系统自带（sudo）',
    examples: [
      ['sudo systemctl restart nginx', '以 root 执行'],
      ['sudo -u postgres psql', '以指定用户执行'],
      ['sudo -i', '切到 root 的登录 shell'],
      ['sudo visudo', '安全地编辑 sudoers（别直接用 vi 改）'],
    ],
  },
  man: {
    purpose: '查看命令手册（离线最权威的用法来源）',
    usage: 'man [章节] 命令',
    install: '系统自带（man-db）',
    examples: [
      ['man ls', '查看 ls 手册'],
      ['man 5 crontab', '查第 5 章（文件格式）'],
      ['man -k "copy files"', '按关键词搜索手册'],
      ['man -w ls', '只显示手册文件路径'],
    ],
    shortcuts: [
      ['空格 / b', '翻页'],
      ['/ 与 n', '搜索与下一个匹配'],
      ['g / G', '开头 / 结尾'],
      ['q', '退出'],
    ],
  },
  lsblk: {
    purpose: '树形列出块设备与分区（看盘和挂载关系）',
    usage: 'lsblk [选项]...',
    install: '系统自带（util-linux）',
    examples: [
      ['lsblk', '设备树'],
      ['lsblk -f', '带文件系统类型/UUID/挂载点'],
      ['lsblk -o NAME,SIZE,TYPE,MOUNTPOINT', '自定义列'],
      ['lsblk -J | jq .', 'JSON 输出便于解析'],
    ],
  },

  // ── 包管理与构建 ───────────────────────────────────────────────────────────
  apt: {
    purpose: 'Debian/Ubuntu 包管理：安装、升级、卸载、搜索',
    usage: 'apt [选项] 子命令 [包名...]',
    install: '系统自带（Debian 系）',
    examples: [
      ['sudo apt update', '刷新索引（装包前先做）'],
      ['sudo apt install htop', '安装'],
      ['apt search ripgrep', '搜索包'],
      ['sudo apt remove --purge pkg', '卸载并清配置'],
      ['apt list --upgradable', '看有哪些可升级'],
    ],
  },
  pip: {
    purpose: 'Python 包管理',
    usage: 'pip [选项] 子命令 [包...]',
    install: '系统自带（或 apt install python3-pip）',
    examples: [
      ['pip install requests', '安装'],
      ['pip install -r requirements.txt', '按清单安装'],
      ['pip install --user pkg', '装到用户目录（不用 sudo）'],
      ['pip list --outdated', '看可升级的包'],
    ],
  },
  npm: {
    purpose: 'Node.js 包管理与脚本运行',
    usage: 'npm [选项] 子命令 [包...]',
    install: '需安装 Node.js（nodejs.org 或 nvm）',
    examples: [
      ['npm install', '按 package.json 装依赖'],
      ['npm ci', '按 lock 文件干净安装（CI 推荐）'],
      ['npm run build', '执行 package.json 里的脚本'],
      ['npm install -g pnpm', '全局安装命令行工具'],
    ],
  },
  make: {
    purpose: '按 Makefile 执行构建目标',
    usage: 'make [选项]... [目标]...',
    install: '系统自带（make，部分系统需 apt install build-essential）',
    examples: [
      ['make -j$(nproc)', '并行编译（按核数）'],
      ['make -n install', '只打印将要执行的命令'],
      ['make clean && make', '先清理再构建'],
      ['make -C src', '在指定目录里构建'],
    ],
  },
  gcc: {
    purpose: 'GNU C 编译器',
    usage: 'gcc [选项] 源文件...',
    install: '需安装：apt install build-essential',
    examples: [
      ['gcc -Wall -O2 -o app main.c', '常用告警 + 二级优化编译'],
      ['gcc -c -g main.c', '只编译成带调试信息的 .o'],
      ['gcc -I/usr/local/include -L/usr/local/lib -lm main.c', '指定头文件/库路径并链接'],
    ],
  },

  // ── 容器与虚拟化 ───────────────────────────────────────────────────────────
  docker: {
    purpose: '容器管理：拉镜像、跑容器、看日志、进容器',
    usage: 'docker [选项] 子命令 [参数]',
    install: '需安装：见 docker.com 官方脚本或 apt install docker.io',
    examples: [
      ['docker ps -a', '列出容器（含已退出）'],
      ['docker run -d -p 8080:80 --name web nginx', '后台跑并映射端口'],
      ['docker exec -it web bash', '进容器开 shell'],
      ['docker logs -f web', '跟读容器日志'],
      ['docker system df', '看磁盘占用（清理前先看）'],
      ['docker stats', '实时资源占用'],
    ],
  },
  'docker-compose': {
    purpose: '用 compose 文件编排多个容器',
    usage: 'docker compose [选项] 子命令 [服务...]',
    install: '需安装：docker compose plugin 或 apt install docker-compose',
    examples: [
      ['docker compose up -d', '后台拉起整套服务'],
      ['docker compose logs -f web', '跟读某服务日志'],
      ['docker compose down', '停掉并删除容器/网络'],
      ['docker compose config', '校验并打印最终配置'],
    ],
  },
  kubectl: {
    purpose: 'Kubernetes 集群操作：查资源、看日志、进 Pod',
    usage: 'kubectl [选项] 子命令 [类型] [名字]',
    install: '需安装：kubectl 官方二进制（kubernetes.io）',
    examples: [
      ['kubectl get pods -A', '看所有命名空间的 Pod'],
      ['kubectl -n prod logs -f deploy/api', '跟读某 Deployment 的日志'],
      ['kubectl exec -it pod -- sh', '进容器'],
      ['kubectl describe pod name', '看事件与状态（排障首选）'],
      ['kubectl apply -f deploy.yaml', '按清单创建/更新'],
    ],
  },
  helm: {
    purpose: 'Kubernetes 的包管理（chart 安装与升级）',
    usage: 'helm [选项] 子命令 [参数]',
    install: '需安装：helm 官方脚本（helm.sh）',
    examples: [
      ['helm list -A', '列出所有 release'],
      ['helm install my-app ./chart -f values.yaml', '安装'],
      ['helm upgrade my-app ./chart --set image.tag=v2', '升级并覆盖单个值'],
      ['helm template ./chart', '本地渲染看最终 YAML'],
    ],
  },

  // ── 版本控制 ───────────────────────────────────────────────────────────────
  git: {
    purpose: '分布式版本控制：提交、分支、合并、与远端同步',
    usage: 'git [选项] 子命令 [参数]',
    install: '系统自带或 apt install git',
    examples: [
      ['git status -sb', '看改动与分支状态'],
      ['git add -A && git commit -m "msg"', '暂存全部并提交'],
      ['git switch -c feature/x', '建并切换分支'],
      ['git log --oneline --graph -20', '看最近 20 条提交图'],
      ['git diff --staged', '看已暂存但未提交的改动'],
      ['git pull --rebase', '拉取并用变基代替合并'],
    ],
  },
  gh: {
    purpose: 'GitHub 命令行：PR、Issue、Actions、发布',
    usage: 'gh [子命令] [参数]',
    install: '需安装：gh 官方包（cli.github.com）',
    examples: [
      ['gh pr list', '列出 PR'],
      ['gh pr create --fill', '用提交信息快速开 PR'],
      ['gh run list --limit 5', '看最近的工作流运行'],
      ['gh repo clone owner/repo', '克隆仓库'],
    ],
  },

  // ── 安全与密钥 ─────────────────────────────────────────────────────────────
  'ssh-keygen': {
    purpose: '生成与管理 SSH 密钥对',
    usage: 'ssh-keygen [选项]...',
    install: '系统自带（openssh-client）',
    examples: [
      ['ssh-keygen -t ed25519 -C "me@example.com"', '生成现代推荐算法密钥'],
      ['ssh-keygen -t rsa -b 4096', '生成 4096 位 RSA（兼容老系统）'],
      ['ssh-keygen -p -f ~/.ssh/id_ed25519', '修改已有私钥的口令'],
      ['ssh-keygen -R host', '从 known_hosts 移除某主机（换了指纹时）'],
    ],
  },
  openssl: {
    purpose: '加密工具箱：证书、摘要、加解密、连接测试',
    usage: 'openssl 子命令 [选项]...',
    install: '系统自带（openssl）',
    examples: [
      ['openssl req -x509 -newkey rsa:4096 -days 365 -nodes -keyout k.pem -out c.pem', '生成自签证书'],
      ['openssl x509 -in c.pem -noout -text', '查看证书内容'],
      ['openssl dgst -sha256 file', '计算摘要'],
      ['openssl s_client -connect host:443 -servername host', '检查 TLS 证书与握手'],
      ['openssl rand -hex 32', '生成 32 字节随机串'],
    ],
  },
  gpg: {
    purpose: 'GnuPG：加解密、签名、密钥管理',
    usage: 'gpg [选项]... [文件]...',
    install: '系统自带或 apt install gnupg',
    examples: [
      ['gpg --list-keys', '列出公钥'],
      ['gpg --gen-key', '生成密钥对（交互）'],
      ['gpg -e -r UID file', '用对方公钥加密'],
      ['gpg -d file.gpg', '解密'],
      ['gpg --verify file.sig file', '校验签名'],
    ],
  },
}
