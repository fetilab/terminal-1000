// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 极简 Markdown → HTML（预览用）。
 *
 * 为什么自己写：
 * - 引 marked/markdown-it 会给首屏多背几十 KB，而笔记预览只需要最常用的语法；
 * - 更重要的是**安全**：预览会 innerHTML 渲染用户内容，
 *   自研可以保证在拼接前先 HTML 转义，只放行自己生成的白名单标签。
 *
 * 支持：标题 / 粗体 / 斜体 / 行内代码 / 代码块 / 链接 / 无序有序列表 / 引用 / 分隔线。
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 行内语法。在已经转义过的文本上处理，所以只需要插入标签。 */
function inline(text: string): string {
  return (
    text
      // 行内代码优先，避免代码里的 * 被当成强调
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      // 链接：只允许 http/https，杜绝 javascript: 这类伪协议
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  )
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let codeBuf: string[] = []
  let listKind: 'ul' | 'ol' | null = null

  const closeList = (): void => {
    if (listKind) {
      out.push(`</${listKind}>`)
      listKind = null
    }
  }

  for (const raw of lines) {
    // 代码块
    if (raw.trimStart().startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
        codeBuf = []
        inCode = false
      } else {
        closeList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuf.push(raw)
      continue
    }

    const line = raw.trimEnd()

    if (line.trim() === '') {
      closeList()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1]?.length ?? 1
      out.push(`<h${level}>${inline(escapeHtml(heading[2] ?? ''))}</h${level}>`)
      continue
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      closeList()
      out.push('<hr />')
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      closeList()
      out.push(`<blockquote>${inline(escapeHtml(quote[1] ?? ''))}</blockquote>`)
      continue
    }

    const ul = /^[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      if (listKind !== 'ul') {
        closeList()
        out.push('<ul>')
        listKind = 'ul'
      }
      out.push(`<li>${inline(escapeHtml(ul[1] ?? ''))}</li>`)
      continue
    }

    const ol = /^\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      if (listKind !== 'ol') {
        closeList()
        out.push('<ol>')
        listKind = 'ol'
      }
      out.push(`<li>${inline(escapeHtml(ol[1] ?? ''))}</li>`)
      continue
    }

    closeList()
    out.push(`<p>${inline(escapeHtml(line))}</p>`)
  }

  if (inCode && codeBuf.length > 0) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
  }
  closeList()
  return out.join('\n')
}

/** 从正文抽纯文本摘要（列表预览用） */
export function plainExcerpt(content: string, max = 90): string {
  const text = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}
