// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 记录层状态机：把 TCP 字节流切成帧、解密、并把要发的消息编成帧。
 *
 * 规范 §4 的纪律在这里落实：
 * - `seq` 严格递增（收到不等于期望值 → 断开）
 * - `length` 上限 16 MiB（超限立即断开，不分配内存）
 * - 半包/粘包由内部缓冲处理（TCP 是流，不能假设一次 data == 一帧）
 */

import {
  FRAME_OVERHEAD,
  MAX_FRAME_LEN,
  NONCE_PREFIX_C2S,
  NONCE_PREFIX_S2C,
  Tsc1Error,
  decryptFrame,
  encryptFrame,
} from './crypto.js'

/**
 * 一个方向的**接收**状态：累积字节、逐帧解出明文。
 *
 * 用法：`feed(chunk)` 返回本批解出的明文数组；抛 Tsc1Error 即应断开。
 */
export class RecordReceiver {
  #key
  #prefix
  #expectedSeq = 0
  #buffer = Buffer.alloc(0)
  #closed = false

  constructor({ key, prefix }) {
    this.#key = key
    this.#prefix = prefix
  }

  get expectedSeq() {
    return this.#expectedSeq
  }

  /**
   * 喂入一段字节，返回解出的明文帧数组。
   *
   * 注意 `length` 检查发生在**读头部时**，而不是等收满整帧——
   * 否则攻击者只要声称 length=16MiB 就能让我们白白分配并等待。
   */
  feed(chunk) {
    if (this.#closed) throw new Tsc1Error('RECORD_CLOSED', '记录层已关闭')
    if (chunk.length > 0) {
      this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk])
    }

    const plaintexts = []

    for (;;) {
      if (this.#buffer.length < 4) break

      const length = this.#buffer.readUInt32BE(0)
      // 先判上限：超限时**立刻**抛错，不等数据到齐
      if (length > MAX_FRAME_LEN) {
        throw new Tsc1Error(
          'FRAME_TOO_LARGE',
          `length ${length} 超过上限 ${MAX_FRAME_LEN}（拒绝为它分配内存）`,
        )
      }
      if (length < FRAME_OVERHEAD) {
        throw new Tsc1Error('FRAME_BAD_LENGTH', `length ${length} 小于最小开销 ${FRAME_OVERHEAD}`)
      }

      const total = 4 + 8 + length
      if (this.#buffer.length < total) break // 半包：等更多数据

      const frame = this.#buffer.subarray(0, total)
      const { plaintext } = decryptFrame({
        key: this.#key,
        prefix: this.#prefix,
        frame,
        expectedSeq: this.#expectedSeq,
      })
      this.#expectedSeq += 1
      plaintexts.push(plaintext)

      this.#buffer = this.#buffer.subarray(total)
    }

    return plaintexts
  }

  /** 关闭并释放缓冲（不释放会一直占着最多一整帧的内存） */
  close() {
    this.#closed = true
    this.#buffer = Buffer.alloc(0)
  }
}

/**
 * 一个方向的**发送**状态：维护自己的 seq 计数器。
 *
 * 规范 §3.4：双向各自独立密钥 → 两个方向各用自己的 seq，互不干扰。
 */
export class RecordSender {
  #key
  #prefix
  #seq = 0
  #closed = false

  constructor({ key, prefix }) {
    this.#key = key
    this.#prefix = prefix
  }

  get seq() {
    return this.#seq
  }

  /** 把一个明文消息编成一帧 */
  send(plaintext) {
    if (this.#closed) throw new Tsc1Error('RECORD_CLOSED', '记录层已关闭')
    const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)
    if (buf.length + FRAME_OVERHEAD > MAX_FRAME_LEN) {
      throw new Tsc1Error('FRAME_TOO_LARGE', `明文 ${buf.length} 字节，编码后超过帧上限`)
    }
    const frame = encryptFrame({
      key: this.#key,
      prefix: this.#prefix,
      seq: this.#seq,
      plaintext: buf,
    })
    this.#seq += 1
    return frame
  }

  close() {
    this.#closed = true
  }
}

/**
 * 服务端视角的一对收发器：c2s 方向收、s2c 方向发。
 *
 * 用各自的 nonce 前缀与各自的密钥——这正是「双向独立密钥」的落点：
 * 即便实现出错把两个方向混用同一把 key，nonce 前缀不同也不会撞。
 */
export function createServerRecords({ c2sKey, s2cKey }) {
  return {
    receiver: new RecordReceiver({ key: c2sKey, prefix: NONCE_PREFIX_C2S }),
    sender: new RecordSender({ key: s2cKey, prefix: NONCE_PREFIX_S2C }),
  }
}
