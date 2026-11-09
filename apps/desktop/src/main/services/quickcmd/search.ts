// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 快速命令搜索：名称匹配 + **拼音首字母**匹配（spec §6.2「输入 qd 匹配 前端」）。
 *
 * 为什么自带表：为这一个功能引第三方拼音库不划算（体积、许可、渲染层也要用）。
 * 表只覆盖**常用字**是刻意的取舍 —— 表里没有的字不会误判，
 * 其原字符仍参与精确子串匹配，所以最坏情况是"少了拼音便利"，不会搜错。
 *
 * 多音字（重/行/长…）按本项目语料里更常见的读音取一个首字母，见 PINYIN_TABLE 注释。
 */

/** 按首字母分组的常用字表（每组的字符首字母即该组的字母） */
export const PINYIN_TABLE: Readonly<Record<string, string>> = {
  a: '阿啊安按案爱',
  b: '不部本表备版变步播包报白把百帮保北比边编标别病波补布并币必闭绑背被板崩半便',
  c: '测存错查参层次从出传车成程除初处串创磁词粗催才采菜残操草侧策差常场超朝潮彻沉陈称城承吃池迟持冲重抽储触川穿窗吹春纯此刺促存长插拆充',
  d: '的地大点电端段动定单打带代队对多度道到等低底第调丢东都读短断堆兑顿夺掉当但丁',
  e: '二额',
  f: '服分发方法放防复反非费封风否副负附番翻返犯饭泛房访飞废份丰峰浮符福富覆',
  g: '个管关高更工功公国过改干刚港告格各给根跟共沟构估古谷股故顾挂观官光广归规滚果隔盖固供',
  h: '和后会好环换回户化话还海含汉毫号合何核黑很红候忽湖互花华划画缓汇混活火或货恒函',
  j: '就进机记加检简建解接结计集技继家价间监见件健将交角脚叫教阶节界紧近经精警静究局举具据卷决绝军均键级截夹即剪兼',
  k: '可开看快空控口库客卡靠科壳课肯孔扣苦块宽况扩跨',
  l: '了里理力立联连流量路录列类来蓝览浪老乐冷离李历利例链良两亮临灵零领令留六龙楼漏旅率绿轮论落逻拉',
  m: '面码名明目密慢模某马埋买卖满忙毛么没美门们迷米免描秒民敏命摸默母',
  n: '你能内年女那南难脑呢念鸟您宁牛农弄努哪',
  o: '哦',
  p: '配平品批排盘判跑陪朋皮片票频评凭破普抛匹',
  q: '前起去全清请切区器权群其奇齐企启气弃汽千迁签强墙抢桥巧亲轻情穷求取缺确期嵌且',
  r: '人日如让认任热然容软若弱入仍',
  s: '数时上是生事设手收删速算所随素搜死四送松宋苏俗虽岁孙损缩锁署顺首识说色示索式属射受使',
  t: '他她它天通同头提体条特台太态谈弹探堂逃讨套题跳贴铁听停统投透图土推退吞托拖替填',
  w: '我为文无问完网位外万王往忘危微围维伟未稳握五午武务物误尾',
  x: '下小新想系信行修选许需序学西吸希息习喜细先显现线相香向项消效些写谢心辛星形性续宣寻询迅限析循响',
  y: '用一有要于与已也应压样页业移义引因银英影硬永优由邮游又余语域预元原员源远愿约月越云允运音映',
  z: '在做自字子最中主装状转注直知之支值只制质治致置终种周逐住抓专追准资总走租足阻组左作坐志真整展占再',
}

interface PinyinIndex {
  charToInitial: Map<string, string>
  /** 同一个字出现在多个分组时记录冲突（测试会断言为空） */
  conflicts: Array<{ char: string; first: string; ignored: string }>
}

function buildIndex(): PinyinIndex {
  const charToInitial = new Map<string, string>()
  const conflicts: Array<{ char: string; first: string; ignored: string }> = []
  for (const [initial, chars] of Object.entries(PINYIN_TABLE)) {
    for (const char of chars) {
      const existing = charToInitial.get(char)
      if (existing === undefined) {
        charToInitial.set(char, initial)
      } else if (existing !== initial) {
        conflicts.push({ char, first: existing, ignored: initial })
      }
    }
  }
  return { charToInitial, conflicts }
}

const INDEX = buildIndex()

/** 表内字符 → 首字母；表外返回 undefined */
export function initialOf(char: string): string | undefined {
  return INDEX.charToInitial.get(char)
}

/** 自检用：表里是否有同一个字被归到两个不同首字母（应为空） */
export function pinyinTableConflicts(): Array<{ char: string; first: string; ignored: string }> {
  return [...INDEX.conflicts]
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return code >= 0x3400 && code <= 0x9fff
}

/**
 * 文本 → 拼音首字母串。
 * - 表内汉字 → 首字母
 * - 表外汉字 → 跳过（不猜测，避免"猜错导致搜到不该搜到的"）
 * - ASCII 字母/数字 → 保留并小写
 * - 其它字符（空格、-、_、标点）→ 作为分隔符，产生分段
 */
export function pinyinInitials(text: string): string {
  let out = ''
  for (const ch of text) {
    const mapped = initialOf(ch)
    if (mapped !== undefined) {
      out += mapped
      continue
    }
    if (isCjk(ch)) continue
    if (/[A-Za-z0-9]/.test(ch)) {
      out += ch.toLowerCase()
    }
    // 其它字符直接丢弃（相当于分段）
  }
  return out
}

/** 按非字母数字/汉字切段，逐段算首字母（"前端 服务" → ["qd","fw"]） */
export function initialSegments(text: string): string[] {
  const parts = text.split(/[^A-Za-z0-9\u3400-\u9fff]+/).filter((p) => p !== '')
  const segments: string[] = []
  for (const part of parts) {
    const initials = pinyinInitials(part)
    if (initials !== '') segments.push(initials)
  }
  return segments
}

/** query 是否为 text 的首字母**前缀**（"qd" 命中 "前端"；"qdfw" 命中 "前端服务"） */
export function matchesPinyin(text: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const whole = pinyinInitials(text)
  if (whole.startsWith(q)) return true
  // 每个词单独也能命中（"前端 服务" 输入 qd）
  return initialSegments(text).some((seg) => seg.startsWith(q))
}

/** 是否命中子序列（"qdfw" 命中 "前端防火墙" 这种跨词缩写） */
export function matchesPinyinSubsequence(text: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const whole = pinyinInitials(text)
  let i = 0
  for (const ch of whole) {
    if (ch === q[i]) i++
    if (i === q.length) return true
  }
  return false
}

export interface SearchableItem {
  id: string
  name: string
  /** 备注也参与精确匹配（不参与拼音） */
  note?: string
}

export type MatchKind = 'exact' | 'pinyin' | 'fuzzy' | 'none'

/** 判定单个条目的匹配方式（返回值可直接用于排序） */
export function matchItem(item: SearchableItem, query: string): MatchKind {
  const q = query.trim().toLowerCase()
  if (q === '') return 'exact'
  const name = item.name.toLowerCase()
  if (name.includes(q)) return 'exact'
  if ((item.note ?? '').toLowerCase().includes(q)) return 'fuzzy'
  if (matchesPinyin(item.name, query)) return 'pinyin'
  if (matchesPinyinSubsequence(item.name, query)) return 'fuzzy'
  return 'none'
}

const KIND_RANK: Record<MatchKind, number> = { exact: 0, pinyin: 1, fuzzy: 2, none: 3 }

/**
 * 过滤并按"匹配强度 → 原名"排序。
 * 空查询返回原顺序（调用方通常按分组树展示）。
 */
export function searchItems<T extends SearchableItem>(items: readonly T[], query: string): T[] {
  const q = query.trim()
  if (q === '') return [...items]
  const scored = items
    .map((item) => ({ item, kind: matchItem(item, q) }))
    .filter((entry) => entry.kind !== 'none')
  scored.sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
    if (byKind !== 0) return byKind
    return a.item.name.localeCompare(b.item.name, 'zh-Hans-CN')
  })
  return scored.map((entry) => entry.item)
}
