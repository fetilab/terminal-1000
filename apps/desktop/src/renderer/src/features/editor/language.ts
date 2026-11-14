// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 按文件名推断 Monaco 的语言 id。
 *
 * spec 明确要求**支持无扩展名的配置文件**（`Dockerfile`、`Makefile`、`nginx.conf` 这类），
 * 所以这里是两级：
 * 1. **特殊文件名/前缀**优先（`Dockerfile.dev`、`Makefile.am` 也要认）
 * 2. 再看扩展名
 * 3. 都不认 → `plaintext`（不猜，猜错反而是误导：颜色对了但语义不对）
 *
 * 只覆盖 `monacoSetup.ts` 里**真的注册过**的语言 —— 返回一个没注册的 id 会让
 * Monaco 静默退回纯文本，那是最难查的一类"看起来没生效"。
 */

/** 无扩展名或特殊名字的文件 → 语言（键一律小写比较） */
const BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'plaintext',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.env': 'ini',
  'nginx.conf': 'ini',
  'httpd.conf': 'ini',
  'my.cnf': 'ini',
  '.gitignore': 'plaintext',
  'crontab': 'shell',
}

/** 前缀匹配（`Dockerfile.dev`、`Makefile.am` 这种） */
const BY_PREFIX: Array<[string, string]> = [
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['cmakelists', 'plaintext'],
]

/** 扩展名 → 语言 */
const BY_EXT: Record<string, string> = {
  // shell 与脚本
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  fish: 'shell',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  psm1: 'powershell',
  // 语言
  py: 'python',
  pyw: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  dart: 'dart',
  kt: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  clj: 'clojure',
  fs: 'fsharp',
  jl: 'julia',
  pas: 'pascal',
  // 配置与数据
  json: 'javascript', // 见文件尾说明：用 JS 的 tokenizer 覆盖 JSON 的着色
  jsonc: 'javascript',
  yaml: 'yaml',
  yml: 'yaml',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  cnf: 'ini',
  properties: 'ini',
  env: 'ini',
  service: 'ini',
  toml: 'ini',
  // 标记与文档
  md: 'markdown',
  markdown: 'markdown',
  // 前端
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  vue: 'html',
  // 查询与协议
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  hcl: 'hcl',
  tf: 'hcl',
  proto: 'plaintext',
  log: 'plaintext',
  txt: 'plaintext',
  csv: 'plaintext',
}

/**
 * 推断语言。
 *
 * ⚠️ `.json` 映射到 `javascript`：本版本 Monaco 的 JSON 支持是**语言服务**
 * （`vs/language/json`），引它会把 0.89MB 的 worker 一起打进产物；
 * 而 JSON 的语法着色用 JS 的 tokenizer 已经覆盖（字符串/数字/括号/键），
 * 所以我们不引那个服务 —— 拿到的是"足够好的着色"，代价是没有 JSON 校验/补全。
 */
export function languageForFile(filename: string): string {
  const base = (filename.split('/').pop() ?? filename).trim()
  if (!base) return 'plaintext'
  const lower = base.toLowerCase()

  const exact = BY_FILENAME[lower]
  if (exact) return exact
  for (const [prefix, lang] of BY_PREFIX) {
    if (lower.startsWith(prefix)) return lang
  }

  const dot = lower.lastIndexOf('.')
  if (dot < 0) return 'plaintext' // 没有扩展名且不在特殊名单里：不猜
  const ext = lower.slice(dot + 1)
  return BY_EXT[ext] ?? 'plaintext'
}

/** 给界面上显示用（Monaco 的 language id 对用户没意义） */
export const LANGUAGE_LABEL: Record<string, string> = {
  shell: 'Shell',
  python: 'Python',
  javascript: 'JavaScript（含 JSON）',
  typescript: 'TypeScript',
  yaml: 'YAML',
  ini: 'INI / 配置',
  markdown: 'Markdown',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  xml: 'XML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  html: 'HTML',
  sql: 'SQL',
  cpp: 'C / C++',
  csharp: 'C#',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  lua: 'Lua',
  powershell: 'PowerShell',
  bat: '批处理',
  php: 'PHP',
  ruby: 'Ruby',
  perl: 'Perl',
  r: 'R',
  dart: 'Dart',
  kotlin: 'Kotlin',
  swift: 'Swift',
  scala: 'Scala',
  clojure: 'Clojure',
  fsharp: 'F#',
  julia: 'Julia',
  pascal: 'Pascal',
  graphql: 'GraphQL',
  hcl: 'HCL / Terraform',
  plaintext: '纯文本',
}
