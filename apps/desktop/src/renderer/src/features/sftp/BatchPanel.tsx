// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 批量操作的**逐项结果面板**。
 *
 * 存在的唯一理由：批量里部分失败是常态，只显示"完成"等于骗用户。
 * 这里把每一项的状态与**失败原因**都摆出来，失败项默认排在最前面。
 */

import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/Button'
import { batchCounts, formatBatchSummary, hasFailures, type BatchItem, type BatchReport } from './batchOps'

const STATUS_LABEL: Record<BatchItem['status'], string> = {
  pending: '待处理',
  running: '进行中',
  submitted: '已提交',
  ok: '成功',
  failed: '失败',
}

function statusIcon(status: BatchItem['status']): { name: Parameters<typeof Icon>[0]['name']; className: string } {
  switch (status) {
    case 'ok':
      return { name: 'check', className: 'sftp-batch__icon sftp-batch__icon--ok' }
    case 'failed':
      return { name: 'close', className: 'sftp-batch__icon sftp-batch__icon--failed' }
    case 'running':
      return { name: 'refresh', className: 'sftp-batch__icon sftp-batch__icon--busy' }
    default:
      return { name: 'clock', className: 'sftp-batch__icon sftp-batch__icon--idle' }
  }
}

export function BatchPanel({
  report,
  onClose,
}: {
  report: BatchReport
  onClose: () => void
}): React.JSX.Element {
  const counts = batchCounts(report)
  const failed = hasFailures(report)

  // 失败项排前面：用户最需要先看到"哪些没成"
  const ordered = [...report.items].sort((a, b) => {
    const rank = (i: BatchItem): number => (i.status === 'failed' ? 0 : i.status === 'ok' ? 2 : 1)
    return rank(a) - rank(b)
  })

  return (
    <section
      className={`sftp-batch${failed ? ' sftp-batch--has-failure' : ''}`}
      data-testid="batch-panel"
      data-batch-kind={report.kind}
      data-batch-total={counts.total}
      data-batch-ok={counts.ok}
      data-batch-failed={counts.failed}
      aria-label="批量操作结果"
    >
      <header className="sftp-batch__head">
        <Icon name={failed ? 'info' : 'check'} size={13} />
        <span className="sftp-batch__title" data-testid="batch-summary">
          {formatBatchSummary(report)}
        </span>
        {failed ? (
          <span className="sftp-batch__warn" data-testid="batch-failed-count">
            有 {counts.failed} 项未成功
          </span>
        ) : null}
        <div className="t-toolbar__spacer" />
        <IconButton icon="close" label="关闭批量结果" size={12} onClick={onClose} />
      </header>

      {report.note ? <p className="sftp-batch__note">{report.note}</p> : null}

      <ul className="sftp-batch__list">
        {ordered.map((item) => {
          const icon = statusIcon(item.status)
          return (
            <li
              key={item.path}
              className="sftp-batch__row"
              data-testid="batch-item"
              data-path={item.path}
              data-status={item.status}
            >
              <Icon name={icon.name} size={12} className={icon.className} />
              <span className="sftp-batch__name" title={item.path}>
                {item.name}
                {item.isDirectory ? <span className="sftp-batch__dir">目录</span> : null}
              </span>
              <span className="sftp-batch__status">
                {item.status === 'ok' && item.changed !== undefined
                  ? `成功 · 改动 ${item.changed} 项`
                  : STATUS_LABEL[item.status]}
              </span>
              {item.status === 'failed' ? (
                <span className="sftp-batch__reason" title={item.error ?? '未知原因'}>
                  {item.error ?? '未知原因'}
                </span>
              ) : null}
              {/* chmod 的逐项失败：目标内部的哪些路径没改成（失败原因必须能看到） */}
              {item.details && item.details.length > 0 ? (
                <ul className="sftp-batch__details" data-testid="batch-item-detail">
                  {item.details.slice(0, 5).map((d) => (
                    <li key={d} title={d}>
                      {d}
                    </li>
                  ))}
                  {item.details.length > 5 ? <li>…还有 {item.details.length - 5} 项</li> : null}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
