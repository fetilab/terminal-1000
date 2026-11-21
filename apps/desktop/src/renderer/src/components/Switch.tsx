// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 开关（switch）。
 *
 * 与 Segmented 的分工：Segmented 是「选一个」（两个以上互斥选项，带文字），
 * Switch 是「开/关一个状态」。二者不互相替代 —— 用开关表达「显示隐藏文件」
 * 这类布尔设置，比勾选框更接近系统设置的语感。
 *
 * 语义用 role="switch" + aria-checked：读屏器会念「开关，已打开」，
 * 而不是「复选框」。（键盘：Space/Enter 均可切换。）
 */

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** 必填：开关本身没有文字，这是唯一的可读标签 */
  label: string
  disabled?: boolean
  size?: 'sm' | 'md'
  id?: string
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  size = 'md',
  id,
}: SwitchProps): React.JSX.Element {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`t-toggle t-toggle--${size}${checked ? ' t-toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="t-toggle__thumb" aria-hidden />
    </button>
  )
}
