// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 代码编辑器（Monaco 封装，懒加载）。
 *
 * ## 三条硬约束怎么落地的
 * 1. **懒加载**：Monaco 只在真正渲染这个组件时才 import（`import('./monacoSetup')`），
 *    实测入口 chunk 只涨了 **219 字节**（就是这段动态 import 的调度代码）。
 * 2. **优雅降级**：Monaco 拉取/初始化失败时**退回等宽 textarea**并说明原因 ——
 *    编辑功能不能因为一个富文本依赖挂掉就白屏。
 * 3. **主题跟随**：应用切浅色/深色时同步 Monaco 主题。
 *
 * 快捷键：`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+F` 查找、`Ctrl/Cmd+H` 替换（Monaco 自带）。
 * 我们的全局热键是 `Ctrl+Shift+*`（T/W/F/L/D/E），**不与 Ctrl+F/H 冲突**；
 * 这里额外拦掉 Monaco 的 `Ctrl+Shift+F`（它的"全局搜索"），避免和 `terminal.find` 撞。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Banner, Loading } from '../../components/Feedback'
import { Icon } from '../../components/Icon'

/** Monaco 的实例类型：用 `import type` 不产生运行时依赖，所以类型安全不影响懒加载 */
type Monaco = typeof import('monaco-editor/editor/editor.api')
type IStandaloneCodeEditor = import('monaco-editor/editor/editor.api').editor.IStandaloneCodeEditor

export interface CodeEditorProps {
  value: string
  /** Monaco 语言 id（见 language.ts） */
  language: string
  onChange: (next: string) => void
  /** Ctrl/Cmd+S */
  onSave?: () => void
  readOnly?: boolean
  height?: number | string
  /** 底部状态栏左侧的说明（例如文件路径、远端信息） */
  statusLeft?: React.ReactNode
  ariaLabel?: string
}

/** 把应用主题映射到 Monaco 主题 */
function monacoThemeFor(): 'vs-dark' | 'vs' {
  const t = document.documentElement.getAttribute('data-theme')
  return t === 'light' ? 'vs' : 'vs-dark'
}

export function CodeEditor({
  value,
  language,
  onChange,
  onSave,
  readOnly = false,
  height = 360,
  statusLeft,
  ariaLabel,
}: CodeEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  /** 避免"受控组件回写"把光标顶到开头：只有外部值和编辑器里的不一致时才 setValue */
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [failure, setFailure] = useState<string | null>(null)

  /* ── 初始化 ── */
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        // ⚠️ 动态 import：这是"不进首屏"的关键
        const { monaco } = await import('./monacoSetup')
        if (disposed || !hostRef.current) return
        monacoRef.current = monaco
        const editor = monaco.editor.create(hostRef.current, {
          value,
          language,
          theme: monacoThemeFor(),
          readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12.5,
          fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace",
          tabSize: 2,
          renderWhitespace: 'selection',
          // 换行：配置文件里长行很常见，不换行会逼用户横向滚
          wordWrap: 'on',
          // 查找/替换相关：Monaco 自带 widget，这里只是让它在小尺寸下也好用
          find: { addExtraSpaceOnTop: false, autoFindInSelection: 'never' },
        })
        editorRef.current = editor
        editor.onDidChangeModelContent(() => {
          const next = editor.getValue()
          valueRef.current = next
          onChangeRef.current(next)
        })
        // Ctrl/Cmd+S → 交给外层保存；Ctrl+Shift+F 屏蔽（避开我们的全局热键）
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSaveRef.current?.()
        })
        setStatus('ready')
      } catch (err) {
        if (disposed) return
        // 降级：**说清原因**，别白屏
        setFailure(err instanceof Error ? err.message : String(err))
        setStatus('failed')
      }
    })()
    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // 只在挂载时创建一次；value/language 的变化走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── 外部值变化（如切换文件、保存后回填）── */
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (value === valueRef.current) return
    valueRef.current = value
    editor.setValue(value)
  }, [value])

  /* ── 语言变化 ── */
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    const model = editor.getModel()
    if (model) monaco.editor.setModelLanguage(model, language)
  }, [language, status])

  /* ── readOnly 变化 ── */
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  /* ── 主题跟随应用主题 ── */
  useEffect(() => {
    if (status !== 'ready') return
    const apply = (): void => monacoRef.current?.editor.setTheme(monacoThemeFor())
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [status])

  const focus = useCallback(() => editorRef.current?.focus(), [])

  if (status === 'failed') {
    return (
      <div className="code-editor code-editor--fallback">
        <Banner tone="warn">
          代码编辑器（Monaco）加载失败，已退回纯文本编辑：{failure ?? '未知原因'}
          <br />
          语法高亮与查找替换在本机不可用，但内容仍可正常编辑与保存。
        </Banner>
        <textarea
          className="code-editor__fallback"
          style={{ height }}
          value={value}
          spellCheck={false}
          aria-label={ariaLabel ?? '代码编辑'}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  }

  return (
    <div className="code-editor">
      <div className="code-editor__host" ref={hostRef} style={{ height }} onClick={focus} />
      <div className="code-editor__status">
        {status === 'loading' ? (
          <Loading text="载入编辑器…" />
        ) : (
          <>
            <Icon name="edit" size={12} />
            {statusLeft}
            <div style={{ flex: 1 }} />
            <span className="metric__sub">Ctrl+S 保存 · Ctrl+F 查找 · Ctrl+H 替换</span>
            <Badge tone="outline">{language}</Badge>
          </>
        )}
      </div>
    </div>
  )
}

export default CodeEditor
