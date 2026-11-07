// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * AI 助手面板。
 *
 * 三条设计要点：
 * 1. **流式不进全局 store**：delta 只累积在 features/ai/aiStore 里，只有本面板订阅。
 * 2. **工具调用可视化**：模型请求执行了什么命令、结果如何、护栏拦截的原因，
 *    都要在消息里显式呈现 —— 这是安全敏感功能，不能让"它到底干了什么"变成黑盒。
 * 3. **apiKey 不出主进程**：只展示"是否已配置"。
 */

import { useEffect, useRef, useState } from 'react'
import { Button, IconButton } from '../../components/Button'
import { Badge, Banner, EmptyState, Loading } from '../../components/Feedback'
import { Field, Select, TextArea } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { actions, useStoreShallow } from '../../lib/store'
import { formatRelativeTime } from '../../lib/format'
import {
  cancelSend,
  deleteChat,
  loadChats,
  loadProviders,
  openChat,
  sendMessage,
  setProvider,
  startNewChat,
  useAi,
  wireAiEvents,
  type ToolTrace,
} from './aiStore'
import './ai.css'

const MODE_LABEL: Record<string, string> = {
  chat: '只聊天',
  assistant: '自动协助',
  confirm: '每步确认',
  thinking: '扩展思考',
}

function ToolTraceCard({ trace }: { trace: ToolTrace }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const args = trace.args === undefined ? '' : JSON.stringify(trace.args, null, 2)
  const result =
    trace.result === undefined
      ? ''
      : typeof trace.result === 'string'
        ? trace.result
        : JSON.stringify(trace.result, null, 2)

  return (
    <div className={`ai-tool${trace.isError ? ' ai-tool--error' : ''}`}>
      <button type="button" className="ai-tool__head" onClick={() => setOpen((v) => !v)}>
        <Icon name={trace.isError ? 'alert-triangle' : 'sliders'} size={13} />
        <span className="ai-tool__name">{trace.tool}</span>
        {trace.done ? (
          <Badge tone={trace.isError ? 'danger' : 'ok'}>{trace.isError ? '被拒绝/失败' : '已执行'}</Badge>
        ) : (
          <Badge tone="accent">执行中…</Badge>
        )}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {open ? (
        <div className="ai-tool__body">
          {args ? (
            <>
              <div className="ai-tool__label">请求参数</div>
              <pre className="ai-tool__pre">{args}</pre>
            </>
          ) : null}
          {result ? (
            <>
              <div className="ai-tool__label">{trace.isError ? '拒绝原因' : '执行结果'}</div>
              <pre className="ai-tool__pre">{result}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function AiSidebar(): React.JSX.Element {
  const { chats, activeChatId, providers, activeProviderId } = useAi((s) => ({
    chats: s.chats,
    activeChatId: s.activeChatId,
    providers: s.providers,
    activeProviderId: s.activeProviderId,
  }))

  useEffect(() => {
    void loadChats()
    void loadProviders()
  }, [])

  return (
    <aside className="panel" aria-label="AI 会话">
      <header className="panel-header">
        <span className="panel-title">AI 助手</span>
        <IconButton icon="refresh" label="刷新会话列表" onClick={() => void loadChats()} />
      </header>

      <div className="panel-body">
        {providers.length === 0 ? (
          <div style={{ padding: 10 }}>
            <Banner tone="warn">
              还没有配置 AI 供应商。密钥只存本机（BYO-key，不经任何中转）。
            </Banner>
          </div>
        ) : (
          <div style={{ padding: '8px 8px 0' }}>
            <Field label="当前供应商">
              <Select
                value={activeProviderId ?? providers.find((p) => p.id)?.id ?? ''}
                options={providers.map((p) => ({
                  value: p.id,
                  label: `${p.name} · ${p.model}${p.hasApiKey ? '' : '（缺密钥）'}`,
                }))}
                onChange={(e) => void setProvider(e.target.value)}
              />
            </Field>
          </div>
        )}

        <nav className="sessions">
          <button
            type="button"
            className={`session-item${activeChatId === null ? ' session-item--active' : ''}`}
            onClick={() => startNewChat()}
          >
            <Icon name="plus" size={14} />
            <span className="session-item__body">
              <span className="session-item__title">新对话</span>
            </span>
          </button>
          {chats.map((c) => (
            <div
              key={c.id}
              className={`session-item ai-chat-item${c.id === activeChatId ? ' session-item--active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => void openChat(c.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void openChat(c.id)
              }}
            >
              <Icon name="activity" size={14} />
              <span className="session-item__body">
                <span className="session-item__title">{c.title || '未命名对话'}</span>
                <span className="session-item__meta">{formatRelativeTime(c.updatedAt)}</span>
              </span>
              <IconButton
                icon="trash"
                label="删除对话"
                size={12}
                onClick={(e) => {
                  e.stopPropagation()
                  void deleteChat(c.id)
                }}
              />
            </div>
          ))}
        </nav>
      </div>

      <div className="panel-footer">
        <Button size="sm" variant="outline" icon="plus" style={{ flex: 1 }} onClick={() => startNewChat()}>
          新对话
        </Button>
      </div>
    </aside>
  )
}

export default function AiView(): React.JSX.Element {
  const { messages, providers, streamingId, streamingText, toolTraces, sending, error, activeChatId } =
    useAi((s) => ({
      messages: s.messages,
      providers: s.providers,
      streamingId: s.streamingId,
      streamingText: s.streamingText,
      toolTraces: s.toolTraces,
      sending: s.sending,
      error: s.error,
      activeChatId: s.activeChatId,
    }))

  const aiMode = useStoreShallow((s) => ({ mode: s.aiMode })).mode
  const [input, setInput] = useState('')
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    wireAiEvents()
  }, [])

  // 自动滚到底：新消息与流式增量都要跟随
  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, streamingText])

  const submit = (): void => {
    const text = input
    if (!text.trim()) return
    if (providers.length === 0) {
      toast.warn('请先在设置 → AI 助手里配置供应商与密钥')
      return
    }
    setInput('')
    void sendMessage(text)
  }

  const noProvider = providers.length === 0

  return (
    <main className="content" aria-label="AI 助手">
      <div className="t-toolbar">
        <Icon name="activity" size={15} />
        <span className="panel-title">AI 助手</span>
        <Badge tone="outline">{MODE_LABEL[aiMode] ?? aiMode}</Badge>
        {sending ? <Badge tone="accent">生成中</Badge> : null}
        <div className="t-toolbar__spacer" />
        <span className="term-toolbar__meta">密钥只存本机 · 直连供应商</span>
      </div>

      {error ? (
        <div style={{ padding: '10px 12px 0' }}>
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}

      <div className="ai-messages" ref={scrollerRef}>
        {messages.length === 0 ? (
          <div className="conn-empty">
            <EmptyState
              icon="activity"
              title={noProvider ? '先配置一个供应商' : '开始一段对话'}
              text={
                noProvider
                  ? 'AI 助手使用你自己的 API key 直连供应商，不经过任何中转。到「设置 → AI 助手」填写 endpoint、模型与密钥。'
                  : '可以问命令怎么用、让它解释报错，或在开启执行权限后让它协助排查。执行类操作受风险黑白名单与三重上限约束。'
              }
              actions={
                noProvider ? (
                  <Button variant="primary" icon="settings" onClick={() => actions.setView('settings')}>
                    去配置
                  </Button>
                ) : null
              }
            />
          </div>
        ) : (
          messages.map((m) => {
            if (m.role === 'system' || m.role === 'tool') return null
            const traces = toolTraces[m.id] ?? []
            return (
              <div key={m.id} className={`ai-msg ai-msg--${m.role}`}>
                <div className="ai-msg__role">
                  <Icon name={m.role === 'user' ? 'user' : 'activity'} size={12} />
                  {m.role === 'user' ? '你' : '助手'}
                </div>
                <div className="ai-msg__body">
                  {m.content ? <div className="ai-msg__text">{m.content}</div> : null}
                  {traces.map((t) => (
                    <ToolTraceCard key={t.id} trace={t} />
                  ))}
                </div>
              </div>
            )
          })
        )}

        {streamingId ? (
          <div className="ai-msg ai-msg--assistant">
            <div className="ai-msg__role">
              <Icon name="activity" size={12} />
              助手
              <span className="ai-caret" aria-hidden />
            </div>
            <div className="ai-msg__body">
              <div className="ai-msg__text">{streamingText || '…'}</div>
              {(toolTraces[streamingId] ?? []).map((t) => (
                <ToolTraceCard key={t.id} trace={t} />
              ))}
            </div>
          </div>
        ) : null}

        {sending && !streamingId ? <Loading text="思考中…" /> : null}
      </div>

      <div className="ai-composer">
        <TextArea
          className="ai-composer__input"
          value={input}
          rows={3}
          placeholder={
            noProvider ? '先配置供应商…' : '输入问题（Enter 发送，Shift+Enter 换行）'
          }
          disabled={noProvider}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="ai-composer__actions">
          <span className="t-field__hint">
            {activeChatId ? '继续当前对话' : '将创建新对话'}
            {aiMode === 'chat' ? ' · 只聊天模式不会执行命令' : ''}
          </span>
          <div className="t-toolbar__spacer" />
          {sending ? (
            <Button variant="outline" icon="close" onClick={() => void cancelSend()}>
              停止
            </Button>
          ) : null}
          <Button variant="primary" icon="zap" disabled={noProvider || !input.trim()} onClick={submit}>
            发送
          </Button>
        </div>
      </div>
    </main>
  )
}
