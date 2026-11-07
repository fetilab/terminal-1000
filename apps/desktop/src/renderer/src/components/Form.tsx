// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Icon } from './Icon'

/* ──────────────────────────────────────────────────── 字段容器 */

export interface FieldProps {
  label?: ReactNode
  /** 必填标记 */
  required?: boolean
  hint?: ReactNode
  error?: ReactNode
  /** 右侧插槽（如「测试」按钮、字符计数） */
  aside?: ReactNode
  className?: string
  children: ReactNode
  htmlFor?: string
}

/**
 * 字段包裹：标签 / 提示 / 错误三件套。
 * 所有表单控件都套这一层，保证纵向节奏一致。
 */
export function Field({
  label,
  required,
  hint,
  error,
  aside,
  className,
  children,
  htmlFor,
}: FieldProps): React.JSX.Element {
  const classes = ['t-field']
  if (className) classes.push(className)
  return (
    <div className={classes.join(' ')}>
      {label ? (
        <div className="t-field__label">
          <label htmlFor={htmlFor}>{label}</label>
          {required ? (
            <span className="t-field__req" aria-hidden>
              *
            </span>
          ) : null}
          {aside ? <span style={{ marginLeft: 'auto' }}>{aside}</span> : null}
        </div>
      ) : null}
      {children}
      {error ? (
        <div className="t-field__error" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="t-field__hint">{hint}</div>
      ) : null}
    </div>
  )
}

/* ──────────────────────────────────────────────────── 文本输入 */

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  mono?: boolean
}

/** forwardRef：笔记编辑器等场景需要直接操作 DOM（光标位置、Tab 缩进） */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid = false, mono = false, className, type = 'text', ...rest },
  ref,
) {
  const classes = ['t-input']
  if (invalid) classes.push('t-input--invalid')
  if (mono) classes.push('t-input--mono')
  if (className) classes.push(className)
  return <input {...rest} ref={ref} type={type} className={classes.join(' ')} />
})

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  mono?: boolean
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { invalid = false, mono = false, className, rows = 4, ...rest },
  ref,
) {
  const classes = ['t-textarea']
  if (invalid) classes.push('t-textarea--invalid')
  if (mono) classes.push('t-textarea--mono')
  if (className) classes.push(className)
  return <textarea {...rest} ref={ref} rows={rows} className={classes.join(' ')} />
})

/* ──────────────────────────────────────────────────── 下拉 */

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: readonly SelectOption[]
  invalid?: boolean
}

export function Select({
  options,
  invalid = false,
  className,
  ...rest
}: SelectProps): React.JSX.Element {
  const classes = ['t-select']
  if (invalid) classes.push('t-select--invalid')
  if (className) classes.push(className)
  return (
    <select {...rest} className={classes.join(' ')}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/* ──────────────────────────────────────────────────── 开关 */

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  /** 隐藏文字只留开关（此时 label 变成 aria-label） */
  bare?: boolean
  className?: string
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  bare = false,
  className,
}: SwitchProps): React.JSX.Element {
  const id = useId()
  const classes = ['t-switch']
  if (disabled) classes.push('t-switch--disabled')
  if (className) classes.push(className)
  return (
    <label className={classes.join(' ')} htmlFor={id} title={bare && typeof label === 'string' ? label : undefined}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={bare && typeof label === 'string' ? label : undefined}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="t-switch__track" aria-hidden />
      {bare ? null : <span className="t-switch__text">{label}</span>}
    </label>
  )
}

/* ──────────────────────────────────────────────────── 勾选 */

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  indeterminate?: boolean
  /** 只渲染方块本身，外层负责布局与点击区域 */
  bare?: boolean
  className?: string
  ariaLabel?: string
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  indeterminate = false,
  bare = false,
  className,
  ariaLabel,
}: CheckboxProps): React.JSX.Element {
  const classes = ['t-check']
  if (checked) classes.push('t-check--on')
  else if (indeterminate) classes.push('t-check--indeterminate')
  if (className) classes.push(className)

  const box = (
    <span className={classes.join(' ')} aria-hidden>
      {checked ? (
        <Icon name="check" size={11} />
      ) : indeterminate ? (
        <span style={{ display: 'block', width: 8, height: 2, background: 'currentColor' }} />
      ) : null}
    </span>
  )

  if (bare) {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? 'mixed' : checked}
        aria-label={ariaLabel}
        disabled={disabled}
        style={{ display: 'inline-grid', padding: 0, border: 'none', background: 'none', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
        onClick={(e) => {
          e.stopPropagation()
          onChange(!checked)
        }}
      >
        {box}
      </button>
    )
  }

  return (
    <label className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      {box}
      {label ? <span>{label}</span> : null}
    </label>
  )
}
