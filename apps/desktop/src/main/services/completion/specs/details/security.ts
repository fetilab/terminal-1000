// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 「安全与密钥」分类的选项明细（本分类命中时才被加载）。自撰语料。
 */

import type { SpecRows } from '../types'

export const SECURITY_SPECS: Record<string, SpecRows> = {
  'ssh-keygen': {
    opts: [
      ['-t', '密钥类型', 'TYPE'],
      ['-b', '密钥位数', 'BITS'],
      ['-C', '注释（通常是邮箱）', 'COMMENT'],
      ['-f', '输出文件', 'FILE'],
      ['-N', '新口令（空串表示无口令）', 'PASSPHRASE'],
      ['-p', '修改已有私钥的口令'],
      ['-R', '从 known_hosts 移除主机', 'HOST'],
      ['-y', '从私钥推导公钥'],
    ],
    example: "ssh-keygen -t ed25519 -C 'me@example.com'",
  },
  'ssh-add': {
    opts: [
      ['-l', '列出已加载的密钥指纹'],
      ['-L', '列出已加载的公钥'],
      ['-D', '删除全部密钥'],
      ['-d', '删除指定密钥', 'FILE'],
      ['-t', '密钥有效期秒数', 'SEC'],
      ['-K', '把密钥存入钥匙串'],
    ],
  },
  'ssh-agent': {
    opts: [
      ['-s', '输出 sh 风格的环境变量'],
      ['-c', '输出 csh 风格的环境变量'],
      ['-k', '结束当前 agent'],
      ['-t', '默认密钥有效期', 'SEC'],
      ['-a', '绑定到指定 socket', 'PATH'],
    ],
  },
  'ssh-copy-id': {
    opts: [
      ['-i', '指定要安装的公钥', 'FILE'],
      ['-p', '远程端口', 'PORT'],
      ['-o', '透传 ssh 选项', 'OPTION'],
      ['-f', '不检查是否已存在'],
      ['-n', '只演练不实际安装'],
    ],
  },
  'ssh-keyscan': {
    opts: [
      ['-t', '指定密钥类型', 'TYPE'],
      ['-p', '远程端口', 'PORT'],
      ['-H', '输出哈希后的主机名'],
      ['-f', '从文件读取主机列表', 'FILE'],
      ['-T', '连接超时秒', 'SEC'],
    ],
  },
  gpg: {
    opts: [
      ['--list-keys', '列出公钥'],
      ['--list-secret-keys', '列出私钥'],
      ['--gen-key', '生成密钥对'],
      ['--export', '导出公钥'],
      ['--import', '导入密钥'],
      ['--encrypt', '加密'],
      ['--decrypt', '解密'],
      ['--sign', '签名'],
      ['--verify', '校验签名'],
      ['-a', 'ASCII 装甲输出'],
      ['-r', '指定接收者', 'UID'],
      ['-o', '输出文件', 'FILE'],
    ],
  },
  openssl: {
    subs: [
      ['req', '生成证书请求与自签证书'],
      ['x509', '处理 X.509 证书'],
      ['genrsa', '生成 RSA 私钥'],
      ['genpkey', '生成私钥（通用）'],
      ['rsa', '处理 RSA 密钥'],
      ['dgst', '计算摘要与签名'],
      ['enc', '对称加解密'],
      ['s_client', 'TLS 客户端调试'],
      ['s_server', 'TLS 服务端调试'],
      ['verify', '校验证书链'],
      ['pkcs12', '处理 PKCS#12 容器'],
      ['rand', '生成随机数据'],
      ['passwd', '生成口令哈希'],
    ],
    opts: [
      ['-in', '输入文件', 'FILE'],
      ['-out', '输出文件', 'FILE'],
      ['-days', '有效天数', 'N'],
      ['-nodes', '私钥不加密'],
      ['-text', '以文本形式打印'],
      ['-sha256', '使用 SHA-256'],
    ],
    example: 'openssl req -x509 -newkey rsa:4096 -days 365 -nodes -keyout key.pem -out cert.pem',
  },
  passwd: {
    opts: [
      ['-l', '锁定账户'],
      ['-u', '解锁账户'],
      ['-d', '删除密码'],
      ['-e', '强制下次登录改密码'],
      ['-S', '查看密码状态'],
    ],
  },
  usermod: {
    opts: [
      ['-aG', '追加到附加组', 'GROUP'],
      ['-g', '修改主组', 'GROUP'],
      ['-d', '修改家目录', 'DIR'],
      ['-m', '移动家目录内容'],
      ['-s', '修改登录 shell', 'SHELL'],
      ['-l', '修改用户名', 'NAME'],
      ['-L', '锁定账户'],
      ['-U', '解锁账户'],
    ],
  },
  useradd: {
    opts: [
      ['-m', '创建家目录'],
      ['-d', '指定家目录', 'DIR'],
      ['-s', '指定登录 shell', 'SHELL'],
      ['-G', '加入附加组', 'GROUPS'],
      ['-u', '指定用户 ID', 'UID'],
      ['-r', '创建系统账户'],
      ['-c', '备注信息', 'COMMENT'],
    ],
  },
}
