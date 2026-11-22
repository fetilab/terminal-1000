// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快捷键编辑器。
 *
 * 采用「录制」而不是让用户手写 accelerator 字符串：
 * 手写容易拼错（`Ctrl+Shift+T` vs `ctrl-shift-t`），录制则一定能得到规范的组合。
 * 录制期间全局截获 keydown 并阻止默认行为，避免一边录一边触发应用内快捷键。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HotkeyBinding } from '@t1000/shared'
import { Button, IconButton } from '../../components/Button'
import { Badge } from '../../components/Feedback'
import { Switch } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { COMMAND_LABELS } from '../../lib/commands'

/**
 * 键盘事件 → Electron accelerator 字符串。
 * 只接受至少一个修饰键的组合：单键绑定会把正常输入吃掉。
 */
function toAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')

  const key = e.key
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null
  if (mods.length === 0) return null

  let main: string
  if (key === ' ') main = 'Space'
  else if (key.length === 1) main = key.toUpperCase()
  else if (key.startsWith('Arrow')) main = key.slice(5)
  else main = key

  return [...mods, main].join('+')
}

/** 展示成键帽更好看：Ctrl+Shift+T → [Ctrl][Shift][T] */
function Keycaps({ accelerator }: { accelerator: string | undefined }): React.JSX.Element {
  if (!accelerator) return <span className="t-field__hint">未绑定</span>
  return (
    <span className="hk-caps">
      {accelerator.split('+').map((part) => (
        <kbd className="t-kbd" key={part}>
          {part}
        </kbd>
      ))}
    </span>
  )
}

export interface HotkeysEditorProps {
  bindings: HotkeyBinding[]
  onChange: (bindings: HotkeyBinding[]) => void
}

export function HotkeysEditor({ bindings, onChange }: HotkeysEditorProps): React.JSX.Element {
  const [recording, setRecording] = useState<string | null>(null)
  const recordingRef = useRef<string | null>(null)
  recordingRef.current = recording

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const acc = toAccelerator(e)
      if (!acc) {
        toast.warn('需要至少一个修饰键（Ctrl / Alt / Shift / Super）')
        return
      }
      const target = recordingRef.current
      setRecording(null)
      onChange(bindings.map((b) => (b.id === target ? { ...b, accelerator: acc } : b)))
      toast.ok(`已绑定 ${acc}`)
    }
    // 捕获阶段截获，确保不会漏给终端/应用其他快捷键处理
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, bindings, onChange])

  /** 找出与给定 accelerator 冲突的其它命令 */
  const conflictsOf = useCallback(
    (binding: HotkeyBinding): HotkeyBinding[] =>
      binding.accelerator
        ? bindings.filter(
            (b) => b.id !== binding.id && b.accelerator === binding.accelerator && b.enabled,
          )
        : [],
    [bindings],
  )

  return (
    <>
      <div className="hk-list">
        {bindings.map((b) => {
          const conflicts = conflictsOf(b)
          return (
            <div className="hk-row" key={b.id}>
              <Switch
                checked={b.enabled}
                bare
                label={`启用 ${COMMAND_LABELS[b.command] ?? b.command}`}
                onChange={(v) =>
                  onChange(bindings.map((x) => (x.id === b.id ? { ...x, enabled: v } : x)))
                }
              />
              <div className="hk-row__body">
                <div className="hk-row__name">{COMMAND_LABELS[b.command] ?? b.command}</div>
                <div className="hk-row__cmd mono">{b.command}</div>
              </div>
              <Keycaps accelerator={b.accelerator} />
              {conflicts.length > 0 ? (
                <Badge tone="danger" title={`与 ${conflicts.map((c) => COMMAND_LABELS[c.command] ?? c.command).join('、')} 冲突`}>
                  冲突
                </Badge>
              ) : null}
              <label className="hk-row__global" title="全局快捷键：应用未聚焦时也生效">
                <input
                  type="checkbox"
                  checked={b.global}
                  onChange={(e) =>
                    onChange(bindings.map((x) => (x.id === b.id ? { ...x, global: e.target.checked } : x)))
                  }
                />
                全局
              </label>
              <Button
                size="sm"
                variant={recording === b.id ? 'primary' : 'outline'}
                icon={recording === b.id ? 'clock' : 'edit'}
                onClick={() => setRecording(recording === b.id ? null : b.id)}
              >
                {recording === b.id ? '按下组合键…' : '录制'}
              </Button>
              <IconButton
                icon="close"
                label={`清除 ${COMMAND_LABELS[b.command] ?? b.command} 的绑定`}
                disabled={!b.accelerator}
                onClick={() =>
                  onChange(bindings.map((x) => (x.id === b.id ? { ...x, accelerator: undefined } : x)))
                }
              />
            </div>
          )
        })}
      </div>

      <p className="t-field__hint" style={{ marginTop: 12 }}>
        <Icon name="info" size={12} /> 应用内快捷键在主进程捕获（before-input-event），
        全局快捷键走系统级注册；两者改动即时生效。注意：占用的键不会再送进终端 ——
        如果某个程序需要这个键（如 Ctrl+K 是 shell 的 kill-line），把对应绑定关掉即可。
      </p>
    </>
  )
}

export default HotkeysEditor
