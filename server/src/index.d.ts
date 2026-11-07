// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * server 是纯 JS（刻意零运行时依赖，部署时无需 npm install 或编译）。
 *
 * 这里只为**跨包引用**提供最小类型声明：
 * 桌面端的同步测试会直接 import 本模块起一个真实后端做端到端验证，
 * 没有声明文件时 TS 会报 TS7016（隐式 any）。
 * 声明保持最小 —— 只描述被跨包用到的那部分，避免与实现漂移。
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** 创建 HTTP 服务实例（不自动监听，便于测试用随机端口） */
export function createServer(): Server<typeof IncomingMessage, typeof ServerResponse>
