// SPDX-License-Identifier: GPL-3.0-or-later
//
// 服务端 TSC/1 是仓库里的**零依赖 JS**（不进 TS 编译），所以这里只声明测试用到的部分。
// 声明保持**最小**：写全了反而会掩盖服务端真实签名变化导致的失配。

declare module '*/tsc1/listener.js' {
  export interface Tsc1StartOptions {
    /** 路由分发（HTTP 与 TSC/1 共用同一份） */
    dispatch: (arg: {
      method: string
      path: string
      body?: unknown
      req?: { headers?: Record<string, string> }
      res?: unknown
    }) => Promise<unknown>
    log: (message: string) => void
    dataDir?: string
    host?: string
    port?: number
    identity?: unknown
  }
  export function startTsc1Server(opts: Tsc1StartOptions): Promise<{
    server: { close: (cb?: () => void) => void; address: () => { port: number } | string | null }
    identity: { publicKeyRaw: Buffer; fingerprint: string }
  }>
}

declare module '*/tsc1/identity.js' {
  export function readIdentityPublicRaw(dir?: string): Buffer | undefined
  export function readIdentityFingerprint(dir?: string): string | undefined
}
