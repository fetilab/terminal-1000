// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 外观纯函数层的判决测试。
 *
 * 两个不变量最要紧：
 * 1. **可读性**：任何预设 × 明暗组合，正文对背景的对比度不得低于 WCAG AA（4.5）——
 *    历史上出过"浅色主题黑底黑字"，靠人眼巡检发现不了，固化成测试。
 * 2. **默认观感不漂移**：默认预设（aurora 深色）的锚色必须与 global.css 的
 *    实色令牌逐字一致 —— 加了外观层之后，用户不做任何设置时界面应与从前完全一样。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './color'
import {
  PRESET_IDS,
  THEME_PRESETS,
  isThemePresetId,
  paletteFor,
  paletteToCssVars,
} from './presets'
import {
  APPEARANCE_DEFAULTS,
  BACKGROUND_SURFACE_FACTOR,
  effectiveSurfaceAlpha,
  resolveAppearance,
  resolveMode,
  backgroundImageUrl,
  readThemeMode,
} from './appearance'

describe('主题预设', () => {
  it('五个预设都带完整明暗两套配色', () => {
    expect(PRESET_IDS).toEqual(['aurora', 'graphite', 'ember', 'forest', 'violet'])
    for (const p of THEME_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.hint.length).toBeGreaterThan(0)
      // 每套配色必须填满全部键（derivePalette 缺键会静默回退 undefined）；
      // overlay 是带透明度的 rgba，其余是 hex
      for (const mode of ['dark', 'light'] as const) {
        for (const [k, v] of Object.entries(p[mode])) {
          expect(v, `${p.id}.${mode}.${k}`).toMatch(/^(#[0-9a-fA-F]{3,8}|rgba?\()/)
        }
      }
    }
  })

  it('★ 正文/弱化文本对背景的对比度 ≥ 4.5（WCAG AA，全部预设 × 明暗）', () => {
    for (const p of THEME_PRESETS) {
      for (const mode of ['dark', 'light'] as const) {
        const pal = paletteFor(p.id, mode)
        expect(
          contrastRatio(pal.fg, pal.bg),
          `${p.id}/${mode} 正文对比度`,
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          contrastRatio(pal.fgMuted, pal.bg),
          `${p.id}/${mode} 次要文本对比度`,
        ).toBeGreaterThanOrEqual(3.5)
      }
    }
  })

  it('isThemePresetId 只认已知 id；paletteFor 未知值回退默认预设', () => {
    expect(isThemePresetId('aurora')).toBe(true)
    expect(isThemePresetId('nonsense')).toBe(false)
    expect(paletteFor('nonsense', 'dark')).toEqual(paletteFor('aurora', 'dark'))
  })

  it('★ 默认预设深色锚色与 global.css 实色令牌一致（防漂移）', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(join(here, '../styles/global.css'), 'utf-8')
    const token = (name: string): string | undefined =>
      css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1]
    const aurora = paletteFor('aurora', 'dark')
    expect(aurora.bg).toBe(token('--t1000-bg-solid'))
    expect(aurora.bgSunken).toBe(token('--t1000-bg-sunken-solid'))
    expect(aurora.bgPanel).toBe(token('--t1000-bg-panel-solid'))
    expect(aurora.bgInput).toBe(token('--t1000-bg-input-solid'))
  })

  it('paletteToCssVars 输出带 --t1000- 前缀的完整令牌表', () => {
    const vars = paletteToCssVars(paletteFor('aurora', 'dark'), 'dark')
    const keys = Object.keys(vars)
    expect(keys.length).toBeGreaterThanOrEqual(20)
    expect(keys.every((k) => k.startsWith('--t1000-'))).toBe(true)
  })
})

describe('resolveAppearance（脏值容错）', () => {
  it('缺分组/缺字段 → 全默认', () => {
    expect(resolveAppearance(undefined)).toEqual(APPEARANCE_DEFAULTS)
    expect(resolveAppearance({})).toEqual(APPEARANCE_DEFAULTS)
    expect(resolveAppearance({ app: {} })).toEqual(APPEARANCE_DEFAULTS)
  })

  it('越界与脏值被钳制/回退，绝不让界面因设置损坏而不可用', () => {
    const cfg = resolveAppearance({
      app: {
        appearance: {
          preset: 'hacker-rainbow',
          backgroundImage: 42,
          backgroundOpacity: 7,
          opacity: 0.1,
          scale: 99,
        },
      },
    })
    expect(cfg.preset).toBe(APPEARANCE_DEFAULTS.preset)
    expect(cfg.backgroundImage).toBe('')
    expect(cfg.backgroundOpacity).toBe(1)
    expect(cfg.opacity).toBe(0.5)
    expect(cfg.scale).toBe(1.4)
  })

  it('合法值原样通过', () => {
    const cfg = resolveAppearance({
      app: { appearance: { preset: 'ember', backgroundImage: '/tmp/wall.png', backgroundOpacity: 0.5, opacity: 0.9, scale: 1.2 } },
    })
    expect(cfg).toEqual({
      preset: 'ember',
      backgroundImage: '/tmp/wall.png',
      backgroundOpacity: 0.5,
      opacity: 0.9,
      scale: 1.2,
      // backgroundImage 非空且未显式给 backgroundType → 兼容旧文档视为图片背景
      backgroundType: 'image',
      backgroundColor: APPEARANCE_DEFAULTS.backgroundColor,
      backgroundVideo: '',
      backgroundScript: '',
      backgroundFps: APPEARANCE_DEFAULTS.backgroundFps,
    })
  })
})

describe('背景图 URL 白名单', () => {
  it('http(s)/javascript: 一律拒绝 —— 背景图不允许发起外部请求', () => {
    expect(backgroundImageUrl('https://evil.example/wall.png')).toBe('')
    expect(backgroundImageUrl('http://evil.example/wall.png')).toBe('')
    expect(backgroundImageUrl('javascript:alert(1)')).toBe('')
  })

  it('本地来源可用：data:/file:/blob:/绝对路径', () => {
    expect(backgroundImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(backgroundImageUrl('file:///home/u/wall.png')).toBe('file:///home/u/wall.png')
    expect(backgroundImageUrl('/home/u/wall.png')).toBe('file:///home/u/wall.png')
    expect(backgroundImageUrl('')).toBe('')
  })
})

describe('明暗解析与表面透明度', () => {
  it('resolveMode：system 跟随系统，显式值优先', () => {
    expect(resolveMode('system', true)).toBe('light')
    expect(resolveMode('system', false)).toBe('dark')
    expect(resolveMode('light', false)).toBe('light')
    expect(resolveMode('dark', true)).toBe('dark')
  })

  it('readThemeMode：未知值按 system 处理', () => {
    expect(readThemeMode({ app: { theme: 'light' } })).toBe('light')
    expect(readThemeMode({ app: { theme: 'weird' } })).toBe('system')
    expect(readThemeMode(undefined)).toBe('system')
  })

  it('设了背景图时表面按系数变透，未设时就是用户设置的值', () => {
    const cfg = { ...APPEARANCE_DEFAULTS, opacity: 0.9 }
    expect(effectiveSurfaceAlpha(cfg, false)).toBe(0.9)
    expect(effectiveSurfaceAlpha(cfg, true)).toBeCloseTo(0.9 * BACKGROUND_SURFACE_FACTOR)
  })
})
