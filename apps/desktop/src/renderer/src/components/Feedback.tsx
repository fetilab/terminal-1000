// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  const classes = ['t-spinner']
  if (className) classes.push(className)
  return <span className={classes.join(' ')} role="progressbar" aria-label="加载中" />
}

/** 局部加载占位。 */
export function Loading({ text = '加载中…' }: { text?: string }): React.JSX.Element {
  return (
    <div className="t-loading">
      <Spinner />
      <span>{text}</span>
    </div>
  )
}

export interface EmptyStateProps {
  icon?: IconName
  title: ReactNode
  text?: ReactNode
  actions?: ReactNode
}

export function EmptyState({ icon = 'info', title, text, actions }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="t-empty">
      <div className="t-empty__art">
        <Icon name={icon} size={26} />
      </div>
      <div className="t-empty__title">{title}</div>
      {text ? <div className="t-empty__text">{text}</div> : null}
      {actions ? <div className="t-empty__actions">{actions}</div> : null}
    </div>
  )
}

export type BadgeTone = 'default' | 'accent' | 'ok' | 'warn' | 'danger' | 'outline'

export function Badge({
  children,
  tone = 'default',
  title,
}: {
  children: ReactNode
  tone?: BadgeTone
  title?: string
}): React.JSX.Element {
  const classes = ['t-badge']
  if (tone !== 'default') classes.push(`t-badge--${tone}`)
  return (
    <span className={classes.join(' ')} title={title}>
      {children}
    </span>
  )
}

export type BannerTone = 'info' | 'warn' | 'error'

/** 页面内的持久提示条（区别于会自动消失的 toast）。 */
export function Banner({
  tone = 'info',
  children,
  actions,
}: {
  tone?: BannerTone
  children: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  const icon: IconName = tone === 'error' ? 'alert-circle' : tone === 'warn' ? 'alert-triangle' : 'info'
  const classes = ['t-banner']
  if (tone !== 'info') classes.push(`t-banner--${tone}`)
  return (
    <div className={classes.join(' ')} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} size={15} />
      <div className="t-banner__body">{children}</div>
      {actions}
    </div>
  )
}
