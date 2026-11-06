// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * parser 单测：全部用手写的「真实风格」采集输出样本，不连任何主机。
 *
 * 覆盖：
 * - GNU coreutils 环境（ps/top 风格数值）
 * - busybox 环境（字段值可能是字符串、字段名可能是别名、部分进程缺 user/cpu）
 * - 坏数据（空输出、非 JSON 噪声、JSON 截断、负数、缺字段、null、类型错乱）
 * - 有噪声前缀 / 包一层 wrapper 的输出
 */

import { describe, expect, it } from 'vitest'
import { extractJsonObject, parseCollectorOutput } from './parser'

/** GNU coreutils / procps 环境的一次完整采集输出 */
const GNU_SAMPLE = JSON.stringify({
  system: {
    hostname: 'web-01',
    distro: 'ubuntu',
    release: '22.04',
    kernel: '5.15.0-91-generic',
    arch: 'x86_64',
    timezone: 'UTC',
    uptimeSeconds: 864000,
    users: 3,
    loadAvg: [0.52, 0.58, 0.59],
  },
  cpu: {
    usage: 12.5,
    cores: [
      { index: 0, usage: 10.2, mhz: 3200 },
      { index: 1, usage: 14.8 },
    ],
    model: 'Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz',
    logicalCount: 2,
    physicalCount: 1,
    temperatureC: 45,
  },
  memory: {
    totalBytes: 16777216000,
    usedBytes: 8388608000,
    freeBytes: 4194304000,
    cachedBytes: 4194304000,
    swapTotalBytes: 2147483648,
    swapUsedBytes: 1048576,
  },
  network: {
    interfaces: [
      { name: 'eth0', rxBytes: 1234567890, txBytes: 987654321, rxSpeed: 10240, txSpeed: 2048 },
      { name: 'eth1', rxBytes: 42, txBytes: 24 },
    ],
    rxTotalBytes: 1234567932,
    txTotalBytes: 987654345,
    rxSpeed: 10240,
    txSpeed: 2048,
  },
  disk: {
    partitions: [
      {
        mount: '/',
        device: '/dev/sda1',
        fsType: 'ext4',
        totalBytes: 107374182400,
        usedBytes: 21474836480,
        availableBytes: 85899345920,
        usedPercent: 20,
        readSpeed: 1048576,
        writeSpeed: 524288,
      },
    ],
    readSpeed: 1048576,
    writeSpeed: 524288,
  },
  process: [
    { pid: 1, command: '/sbin/init splash', cpu: 0.1, memory: 0.2, user: 'root', state: 'Ss' },
    { pid: 2048, command: 'nginx: worker process', cpu: 15.4, memory: 1.1, user: 'www-data', state: 'S' },
    { pid: 3333, command: 'node /opt/app/server.js --port 8080', cpu: 42.7, memory: 3.4, user: 'deploy', state: 'Rl' },
  ],
  gpu: [
    {
      index: 0,
      name: 'NVIDIA GeForce RTX 3080',
      utilization: 37,
      memoryTotalBytes: 10737418240,
      memoryUsedBytes: 2147483648,
      temperatureC: 61,
    },
  ],
})

/**
 * busybox 环境：数值可能是字符串，字段名可能是别名，
 * 部分进程（内核线程）没有 user / cpu 字段。
 */
const BUSYBOX_SAMPLE = JSON.stringify({
  system: {
    hostname: 'router',
    id: 'alpine',
    version: '3.19',
    kernel: '6.6.7-0-lts',
    arch: 'aarch64',
    uptime: '123456',
    load: '0.00 0.01 0.05',
  },
  cpu: {
    usage: '8.3',
    cores: [
      { index: 0, usage: '5.0' },
      { index: 1, usage: '11.6' },
    ],
    logicalCount: '2',
  },
  memory: {
    total: '262144',
    used: '131072',
    free: '65536',
    cached: '65536',
  },
  process: [
    { pid: 7, cmd: '/usr/sbin/dropbear -F', pcpu: 0, '%mem': 0.4, stat: 'S', username: 'root' },
    { pid: 9, args: '[kworker/0:1-events]', mem: 0, stat: 'I' },
  ],
  network: {
    ifaces: [
      { iface: 'eth0', rx: 1234567, tx: 7654321, rxBytesPerSec: 120 },
    ],
    txBytesPerSec: 240,
  },
})

describe('parseCollectorOutput / GNU 环境', () => {
  const snap = parseCollectorOutput({
    sessionId: 's-gnu',
    stdout: GNU_SAMPLE,
    elapsedMs: 42.7,
    requestedModules: ['system', 'cpu', 'memory', 'network', 'disk', 'process', 'gpu'],
    at: '2026-01-01T00:00:00.000Z',
  })

  it('保留会话、时刻与耗时', () => {
    expect(snap.sessionId).toBe('s-gnu')
    expect(snap.at).toBe('2026-01-01T00:00:00.000Z')
    expect(snap.elapsedMs).toBe(43)
  })

  it('system 全字段解析', () => {
    expect(snap.system).toEqual({
      hostname: 'web-01',
      distro: 'ubuntu',
      release: '22.04',
      kernel: '5.15.0-91-generic',
      arch: 'x86_64',
      timezone: 'UTC',
      uptimeSeconds: 864000,
      users: 3,
      loadAvg: [0.52, 0.58, 0.59],
    })
  })

  it('cpu 逐核解析并按 index 排序', () => {
    expect(snap.cpu?.usage).toBe(12.5)
    expect(snap.cpu?.cores).toEqual([
      { index: 0, usage: 10.2, mhz: 3200 },
      { index: 1, usage: 14.8 },
    ])
    expect(snap.cpu?.model).toContain('Xeon')
    expect(snap.cpu?.logicalCount).toBe(2)
    expect(snap.cpu?.physicalCount).toBe(1)
    expect(snap.cpu?.temperatureC).toBe(45)
  })

  it('memory / network / disk / gpu 解析', () => {
    expect(snap.memory?.totalBytes).toBe(16777216000)
    expect(snap.memory?.swapUsedBytes).toBe(1048576)
    expect(snap.network?.interfaces).toHaveLength(2)
    expect(snap.network?.interfaces[1]?.name).toBe('eth1')
    expect(snap.network?.rxSpeed).toBe(10240)
    expect(snap.disk?.partitions[0]?.mount).toBe('/')
    expect(snap.disk?.partitions[0]?.usedPercent).toBe(20)
    expect(snap.disk?.readSpeed).toBe(1048576)
    expect(snap.gpu?.[0]?.name).toBe('NVIDIA GeForce RTX 3080')
    expect(snap.gpu?.[0]?.memoryUsedBytes).toBe(2147483648)
  })

  it('process 按 CPU 降序', () => {
    expect(snap.processes?.map((p) => p.pid)).toEqual([3333, 2048, 1])
    expect(snap.processes?.[0]?.command).toBe('node /opt/app/server.js --port 8080')
    expect(snap.warnings).toBeUndefined()
  })
})

describe('parseCollectorOutput / busybox 环境（别名 + 字符串数值 + 缺字段）', () => {
  const snap = parseCollectorOutput({
    sessionId: 's-bb',
    stdout: BUSYBOX_SAMPLE,
    requestedModules: ['system', 'cpu', 'memory', 'network', 'process'],
  })

  it('system 别名与字符串 loadavg 都能吃', () => {
    expect(snap.system?.distro).toBe('alpine')
    expect(snap.system?.release).toBe('3.19')
    expect(snap.system?.uptimeSeconds).toBe(123456)
    expect(snap.system?.loadAvg).toEqual([0, 0.01, 0.05])
  })

  it('cpu 字符串数值被转成数字', () => {
    expect(snap.cpu?.usage).toBe(8.3)
    expect(snap.cpu?.cores).toEqual([
      { index: 0, usage: 5 },
      { index: 1, usage: 11.6 },
    ])
    expect(snap.cpu?.logicalCount).toBe(2)
  })

  it('memory 别名（total/used/free/cached）解析', () => {
    expect(snap.memory).toEqual({
      totalBytes: 262144,
      usedBytes: 131072,
      freeBytes: 65536,
      cachedBytes: 65536,
    })
  })

  it('process 别名（cmd/pcpu/%mem/stat/username）解析，缺字段不崩', () => {
    expect(snap.processes).toHaveLength(2)
    const dropbear = snap.processes?.[0]
    expect(dropbear?.pid).toBe(7)
    expect(dropbear?.command).toBe('/usr/sbin/dropbear -F')
    expect(dropbear?.memory).toBe(0.4)
    expect(dropbear?.user).toBe('root')
    expect(dropbear?.state).toBe('S')

    // 内核线程：没有 user / cpu 字段
    const kworker = snap.processes?.[1]
    expect(kworker?.pid).toBe(9)
    expect(kworker?.command).toBe('[kworker/0:1-events]')
    expect(kworker?.cpu).toBe(0)
    expect(kworker?.user).toBeUndefined()
  })

  it('network 别名（ifaces/iface/rx/tx）解析，缺的速率从接口求和', () => {
    expect(snap.network?.interfaces[0]?.name).toBe('eth0')
    expect(snap.network?.interfaces[0]?.rxBytes).toBe(1234567)
    expect(snap.network?.rxSpeed).toBe(120)
    expect(snap.network?.txSpeed).toBe(240)
    expect(snap.network?.rxTotalBytes).toBe(1234567)
  })
})

describe('parseCollectorOutput / 坏数据不抛异常', () => {
  it('空输出 → 只有警告', () => {
    const snap = parseCollectorOutput({ sessionId: 's1', stdout: '   \n' })
    expect(snap.sessionId).toBe('s1')
    expect(snap.warnings).toEqual(['采集输出为空'])
    expect(snap.cpu).toBeUndefined()
    expect(snap.memory).toBeUndefined()
  })

  it('纯 stderr 噪声（命令不存在）→ 警告而不是异常', () => {
    const snap = parseCollectorOutput({
      sessionId: 's1',
      stdout: "ps: bad -o argument 'pcpu', supported arguments: pid,stat\n",
    })
    expect(snap.warnings?.[0]).toBe('采集输出不是合法 JSON')
  })

  it('JSON 被截断 → 警告', () => {
    const snap = parseCollectorOutput({
      sessionId: 's1',
      stdout: '{"cpu":{"usage":10,"cores":[{"index":0,',
    })
    expect(snap.warnings?.[0]).toBe('采集输出不是合法 JSON')
    expect(snap.cpu).toBeUndefined()
  })

  it('噪声前缀 + JSON → 截取花括号仍能解析', () => {
    const snap = parseCollectorOutput({
      sessionId: 's1',
      stdout: 'who: cannot open /var/run/utmp\n{"system":{"hostname":"h1","users":0}}\n',
    })
    expect(snap.system?.hostname).toBe('h1')
    expect(snap.system?.users).toBe(0)
  })

  it('字段类型错乱、负数、null、空数组都不崩', () => {
    const bad = JSON.stringify({
      system: 'oops',
      cpu: { usage: 'abc', cores: null, logicalCount: -3 },
      memory: { totalBytes: '-5', usedBytes: 'x' },
      network: null,
      disk: { partitions: [] },
      process: [
        { command: 'no-pid-at-all' },
        { pid: '12', command: '', cpu: '-4', memory: '999', user: null },
      ],
      gpu: [{ name: 'iGPU only, no index' }],
    })
    const snap = parseCollectorOutput({
      sessionId: 's2',
      stdout: bad,
      requestedModules: ['system', 'cpu', 'memory', 'network', 'disk', 'process', 'gpu'],
    })

    expect(snap.system).toBeUndefined()
    expect(snap.cpu).toBeUndefined() // usage 不可解析且没有可用 cores
    expect(snap.memory).toBeUndefined() // 总量为负
    expect(snap.network).toBeUndefined() // null
    expect(snap.disk).toBeUndefined() // 没有分区

    // 无 pid 的条目被丢弃；pid=12 的条目保留，空 command 回退成 pid 字符串
    expect(snap.processes).toHaveLength(1)
    expect(snap.processes?.[0]?.command).toBe('12')
    expect(snap.processes?.[0]?.cpu).toBe(0) // 负值归零
    expect(snap.processes?.[0]?.memory).toBe(100) // 超过 100% 截断
    expect(snap.processes?.[0]?.user).toBeUndefined()

    // gpu 缺 index 时用数组下标
    expect(snap.gpu?.[0]?.index).toBe(0)
    expect(snap.gpu?.[0]?.name).toBe('iGPU only, no index')

    // 「返回了但解析不了」与「压根没返回」要区分开
    expect(snap.warnings).toContain('模块 cpu 内容无法解析')
    expect(snap.warnings).toContain('模块 system 内容无法解析')
    expect(snap.warnings).toContain('模块 disk 内容无法解析')
    expect(snap.warnings).toContain('模块 network 未返回数据')
    expect(snap.warnings?.some((w) => w.includes('process'))).toBe(false)
  })

  it('数值容忍 % 与千分位', () => {
    const snap = parseCollectorOutput({
      sessionId: 's3',
      stdout: JSON.stringify({
        cpu: { usage: '12.5%', cores: [] },
        memory: { totalBytes: '16,777,216,000', usedBytes: '8,000', freeBytes: '1,000' },
      }),
    })
    expect(snap.cpu?.usage).toBe(12.5)
    expect(snap.memory?.totalBytes).toBe(16777216000)
  })

  it('被 data/result 包一层时自动下钻', () => {
    const snap = parseCollectorOutput({
      sessionId: 's4',
      stdout: JSON.stringify({ result: { cpu: { usage: 50, cores: [] } } }),
    })
    expect(snap.cpu?.usage).toBe(50)
  })

  it('远端自报的 warnings 会合并进来', () => {
    const snap = parseCollectorOutput({
      sessionId: 's5',
      stdout: JSON.stringify({ warnings: ['df: /run/user/1000: Permission denied'], cpu: { usage: 1, cores: [] } }),
    })
    expect(snap.warnings).toContain('df: /run/user/1000: Permission denied')
  })

  it('多核下单进程 CPU 可以 >100，不做裁剪', () => {
    const snap = parseCollectorOutput({
      sessionId: 's6',
      stdout: JSON.stringify({ process: [{ pid: 1, command: 'busy', cpu: 385.5, memory: 12 }] }),
    })
    expect(snap.processes?.[0]?.cpu).toBe(385.5)
  })

  it('非对象根（数组/字符串）→ 警告', () => {
    expect(parseCollectorOutput({ sessionId: 's7', stdout: '[1,2,3]' }).warnings?.[0]).toBe(
      '采集输出不是 JSON 对象',
    )
    expect(parseCollectorOutput({ sessionId: 's7', stdout: '"hello"' }).warnings?.[0]).toBe(
      '采集输出不是 JSON 对象',
    )
  })
})

describe('extractJsonObject', () => {
  it('直接可解析时返回原对象', () => {
    expect(extractJsonObject('{"a":1}').value).toEqual({ a: 1 })
  })

  it('截取失败时给出 warning', () => {
    const r = extractJsonObject('no json here')
    expect(r.value).toBeNull()
    expect(r.warning).toBe('采集输出不是合法 JSON')
  })

  it('末尾噪声不影响解析', () => {
    expect(extractJsonObject('{"a":1}\ntrailing junk').value).toEqual({ a: 1 })
  })
})
