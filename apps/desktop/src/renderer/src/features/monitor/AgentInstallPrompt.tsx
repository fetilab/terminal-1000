// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 「要不要在这台服务器上装监控代理？」的询问弹窗。
 *
 * 触发时机：连接成功、探测到**没装**（或版本落后）、且用户没说过"别再问"。
 *
 * 为什么值得单独装一个代理：
 * - 旧路子是每拍 exec 一段 shell，CPU/网络的速率只能靠"两次采样 + 临时文件"，
 *   一台忙的机器上单帧要几十毫秒，监控本身就成了负担；
 * - 代理常驻，计数器在内存里，速率是真增量；数据经 **SSH 隧道**取回，
 *   服务器不用开任何入站端口，也不用改防火墙。
 *
 * 措辞必须把"装在哪、跑多久、怎么删"讲清楚 —— 在别人的服务器上装东西，
 * 含糊其辞比不装更糟。
 */

import type { AgentAsk } from '../../lib/store'
import { declineAgent, dismissAgentAsk, installAgent, useStoreShallow } from '../../lib/store'
import { Badge } from '../../components/Feedback'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'

export function AgentInstallPrompt(): React.JSX.Element | null {
  const { ask, busy } = useStoreShallow((s) => ({ ask: s.agentAsk, busy: s.agentBusy }))
  if (!ask) return null

  const upgrade = ask.needsUpgrade
  const title = upgrade ? '把监控代理升级到新版本？' : '在这台服务器上安装性能监控代理？'

  return (
    <Modal
      open
      size="md"
      title={title}
      subtitle={
        <span>
          {ask.username}@{ask.host}
          {ask.port === null ? '' : `:${ask.port}`}
        </span>
      }
      onClose={() => dismissAgentAsk()}
      footer={
        <div className="agent-ask__footer">
          {/* 左：永久拒绝。放最边上，避免误点 */}
          <Button variant="ghost" size="sm" onClick={() => void declineAgent(ask.sessionId, true)}>
            不再询问这台服务器
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => void declineAgent(ask.sessionId, false)}>
            暂不安装
          </Button>
          <Button variant="primary" icon="download" loading={busy} onClick={() => void installAgent(ask.sessionId)}>
            {upgrade ? '升级并启用' : '安装并启用'}
          </Button>
        </div>
      }
    >
      <div className="agent-ask">
        <p className="agent-ask__lead">
          装上之后，监控数据改由服务器上的<strong>常驻代理</strong>采集，经{' '}
          <strong>SSH 隧道</strong>取回：采样更快、速率更准，也不再每隔几秒在远端起一个 shell。
        </p>

        <ul className="agent-ask__facts">
          <li>
            <Icon name="folder" size={13} />
            <span>
              位置：<code>~/.t1000-monitor/t1000-agent</code>（单文件<strong>静态二进制</strong>，约 5 MiB，
              不依赖 python、glibc 或任何运行时）
            </span>
          </li>
          <li>
            <Icon name="shield" size={13} />
            <span>
              网络：只监听服务器本机的 <code>127.0.0.1</code>，由 SSH 隧道直接连过去，
              <strong>不开放任何入站端口</strong>，也不改防火墙
            </span>
          </li>
          <li>
            <Icon name="clock" size={13} />
            <span>资源：空闲 15 分钟自动退出；随连接自动启动，不注册开机自启</span>
          </li>
          <li>
            <Icon name="trash" size={13} />
            <span>卸载：监控面板里的「卸载代理」一键停止并删除文件</span>
          </li>
        </ul>

        <div className="agent-ask__note">
          <Badge tone="outline">脚本模式仍可用</Badge>
          <span>
            不安装也能监控，只是每次采集都要在远端起一个 shell —— 慢一些，图表刷新也粗一些。
          </span>
        </div>

        {ask.arch === null ? (
          <div className="agent-ask__note agent-ask__note--warn">
            <Icon name="alert-triangle" size={13} />
            <span>
              服务器架构 <code>{ask.machine ?? '未知'}</code> 暂时没有随包提供的代理，只能继续用脚本模式。
            </span>
          </div>
        ) : (
          <div className="agent-ask__path">
            将上传内置的 <code>linux/{ask.arch}</code> 静态二进制（约 5 MiB，无需 python / glibc）· 代理版本 v
            {ask.agentVersion}
          </div>
        )}
      </div>
    </Modal>
  )
}

export default AgentInstallPrompt
