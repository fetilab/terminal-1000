// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 触摸键盘条：一排"物理键盘才有"的键。
 *
 * 为什么需要：平板的软键盘只有字母数字，没有 Esc / Tab / 方向键 / Ctrl。
 * 而终端里这些键是刚需 —— 没有 Esc 退不出 vim 的插入模式，没有 Ctrl 发不出
 * SIGINT，没有方向键翻不了历史。用户不会为此外接键盘。
 *
 * 两条设计约束：
 * 1. **不能抢焦点**。按下按钮必须让终端继续持有输入焦点，否则软键盘会收起、
 *    下一个字符打到别处。所以统一在 `pointerdown` 里 `preventDefault()`，
 *    再用 `onClick` 触发（`pointerdown` 被拦后 click 仍会来）。
 * 2. **修饰键是粘滞的**。点 Ctrl 再点 C 等价于 Ctrl+C；Ctrl 只影响下一次输入。
 *    粘滞位同时会传给引擎，让**软键盘上敲的字母**也能吃到（见 `setPendingMods`）。
 */

import { useCallback, useEffect, useState } from 'react'

/** 修饰位与 kitty 内核的编码约定一致：shift=1, alt=2, ctrl=4, meta=8 */
export const MOD_SHIFT = 1
export const MOD_ALT = 2
export const MOD_CTRL = 4

interface KeySpec {
  /** 按钮上显示的文本 */
  label: string
  /** 传给内核的键名（DOM KeyboardEvent.key 的写法） */
  key: string
  /** 除粘滞位以外，这个键自带的修饰位（如 Ctrl+C） */
  extraMods?: number
  /** 无障碍标签（显示文本是符号时用） */
  title: string
  /** 宽度档位：普通 / 窄（符号键） */
  narrow?: boolean
}

/**
 * 键位排布。顺序按"用得多 → 用得少"：
 * Esc 放在最左边（vim 用户盲按的位置），方向键与 Home/End/PgUp/PgDn 相邻成组，
 * 中断/EOF 两个组合键放最右 —— 它们是"危险键"，离手远一点更安全。
 */
const KEYS: readonly KeySpec[] = [
  { label: 'Esc', key: 'Escape', title: 'Esc：退出插入模式 / 中断序列' },
  { label: 'Tab', key: 'Tab', title: 'Tab：补全 / 切换焦点' },
  { label: '←', key: 'ArrowLeft', title: '左方向键', narrow: true },
  { label: '↑', key: 'ArrowUp', title: '上方向键（历史命令）', narrow: true },
  { label: '↓', key: 'ArrowDown', title: '下方向键（历史命令）', narrow: true },
  { label: '→', key: 'ArrowRight', title: '右方向键', narrow: true },
  { label: 'Home', key: 'Home', title: 'Home：行首' },
  { label: 'End', key: 'End', title: 'End：行尾' },
  { label: 'PgUp', key: 'PageUp', title: 'PageUp：上翻一页' },
  { label: 'PgDn', key: 'PageDown', title: 'PageDown：下翻一页' },
  { label: '⌫', key: 'Backspace', title: '退格', narrow: true },
  { label: '^C', key: 'c', extraMods: MOD_CTRL, title: 'Ctrl+C：中断当前命令', narrow: true },
  { label: '^D', key: 'd', extraMods: MOD_CTRL, title: 'Ctrl+D：结束输入（EOF）', narrow: true },
]

interface TouchKeyBarProps {
  /** 合成一次按键。mods 已含粘滞位与键自带的修饰位 */
  onKey: (key: string, mods: number) => void
  /** 粘滞位变化时通知外层，转发给引擎的 pendingMods */
  onStickyChange: (mods: number) => void
}

export function TouchKeyBar({ onKey, onStickyChange }: TouchKeyBarProps): React.JSX.Element {
  const [sticky, setSticky] = useState(0)

  useEffect(() => {
    onStickyChange(sticky)
  }, [sticky, onStickyChange])

  const toggle = useCallback((bit: number) => {
    setSticky((cur) => cur ^ bit)
  }, [])

  const press = useCallback(
    (spec: KeySpec) => {
      onKey(spec.key, sticky | (spec.extraMods ?? 0))
      // 粘滞键用完即清：绝不能让 Ctrl 残留到下一次输入
      setSticky(0)
    },
    [onKey, sticky],
  )

  return (
    <div className="touch-keys" role="toolbar" aria-label="终端辅助按键">
      <button
        type="button"
        className={`touch-keys__key touch-keys__key--mod${sticky & MOD_CTRL ? ' is-on' : ''}`}
        aria-pressed={Boolean(sticky & MOD_CTRL)}
        title="Ctrl（粘滞）：点亮后下一次输入生效"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => toggle(MOD_CTRL)}
      >
        Ctrl
      </button>
      <button
        type="button"
        className={`touch-keys__key touch-keys__key--mod${sticky & MOD_ALT ? ' is-on' : ''}`}
        aria-pressed={Boolean(sticky & MOD_ALT)}
        title="Alt（粘滞）：点亮后下一次输入生效"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => toggle(MOD_ALT)}
      >
        Alt
      </button>

      <span className="touch-keys__sep" aria-hidden />

      {KEYS.map((spec) => (
        <button
          key={spec.label}
          type="button"
          className={`touch-keys__key${spec.narrow ? ' touch-keys__key--narrow' : ''}`}
          title={spec.title}
          aria-label={spec.title}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => press(spec)}
        >
          {spec.label}
        </button>
      ))}

      {sticky ? (
        <span className="touch-keys__hint" role="status">
          {sticky & MOD_CTRL ? 'Ctrl' : ''}
          {sticky & MOD_CTRL && sticky & MOD_ALT ? '+' : ''}
          {sticky & MOD_ALT ? 'Alt' : ''} 待按
        </span>
      ) : null}
    </div>
  )
}
