// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

import type { T1000Bridge } from './index'

declare global {
  interface Window {
    t1000: T1000Bridge
  }
}

export {}
