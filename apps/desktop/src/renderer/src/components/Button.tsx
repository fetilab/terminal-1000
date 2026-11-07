// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'default' | 'primary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'sm'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 左侧图标 */
  icon?: IconName
  /** 右侧图标（常用于下拉指示） */
  iconRight?: IconName
  block?: boolean
  loading?: boolean
}

/**
 * 通用按钮。
 * 无 children 时自动退化为方形图标按钮，避免再写一套尺寸。
 */
export function Button({
  variant = 'default',
  size = 'md',
  icon,
  iconRight,
  block = false,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = ['t-btn']
  if (variant !== 'default') classes.push(`t-btn--${variant}`)
  if (size === 'sm') classes.push('t-btn--sm')
  if (block) classes.push('t-btn--block')
  if (!children && icon && !iconRight) classes.push('t-btn--icon')
  if (className) classes.push(className)

  const hasChildren = children !== undefined && children !== null && children !== false

  return (
    <button
      {...rest}
      type={type}
      className={classes.join(' ')}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <span className="t-spinner" aria-hidden />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 14 : 15} />
      ) : null}
      {hasChildren ? <span className="t-btn__label">{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={13} /> : null}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  icon: IconName
  /** 必填：图标按钮没有文字，title 是唯一的可读标签 */
  label: string
  size?: number
  /** 视觉语气 */
  tone?: 'default' | 'accent' | 'danger' | 'on'
  /** 进行中：显示转圈并禁用点击 */
  loading?: boolean
}

/** 行内纯图标按钮（列表行操作、工具条等）。 */
export function IconButton({
  icon,
  label,
  size = 15,
  tone = 'default',
  loading = false,
  disabled,
  className,
  type = 'button',
  ...rest
}: IconButtonProps): React.JSX.Element {
  const classes = ['t-iconbtn']
  if (tone === 'accent') classes.push('t-iconbtn--accent')
  if (tone === 'danger') classes.push('t-iconbtn--danger')
  if (tone === 'on') classes.push('t-iconbtn--on')
  if (className) classes.push(className)

  return (
    <button
      {...rest}
      type={type}
      className={classes.join(' ')}
      title={label}
      aria-label={label}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="t-spinner" style={{ width: size, height: size }} aria-hidden /> : <Icon name={icon} size={size} />}
    </button>
  )
}

/** 一致的小圆点状态指示，供列表与卡片复用。 */
export function StatusDot({
  tone,
  pulse = false,
  label,
}: {
  tone: 'muted' | 'ok' | 'warn' | 'danger' | 'accent'
  pulse?: boolean
  label?: string
}): React.JSX.Element {
  const classes = ['t-dot']
  if (tone !== 'muted') classes.push(`t-dot--${tone}`)
  if (pulse) classes.push('t-dot--pulse')
  return <span className={classes.join(' ')} role="img" aria-label={label} title={label} />
}

/** 供卡片/表单分组使用的小标题条。 */
export function Section({
  children,
  right,
}: {
  children: ReactNode
  right?: ReactNode
}): React.JSX.Element {
  return (
    <div className="t-section">
      <span>{children}</span>
      {right}
    </div>
  )
}
