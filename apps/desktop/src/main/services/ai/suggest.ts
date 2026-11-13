// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * 「AI 命令建议」（补全里的 `??` 通道）。
 *
 * 这里只做两件事，且都做成**可测的纯函数**：
 * 1. 构造提示词
 * 2. **解析模型输出** —— 这是这类功能真正的出错点
 *
 * 为什么解析要单独测：模型不会老老实实"每行一条命令"。它会加 markdown 代码块、
 * 加序号、加解释、有时重复。解析器松一点就会把 ``` 或 "1. " 当成命令塞进候选，
 * 用户一按 Tab 就把这些垃圾敲进终端 —— 比没有建议更糟。
 *
 * 与补全引擎的接缝（由 completion 侧定义）：AI 检定只需给出命令文本，
 * 不需要懂"候选"的数据结构。
 */

/**
 * 提示词轮次。
 *
 * 刻意不用 shared 的 `ChatMessage`：那个类型要求 `id`/`createdAt`，
 * 而这里要的是**纯函数**（同输入同输出、不依赖时钟与 UUID）。
 * 元数据由 `index.ts` 在真正发起请求时补齐。
 */
export interface PromptTurn {
  role: 'system' | 'user'
  content: string
}

/**
 * AI 建议的等待上限。
 *
 * **为什么是 8 秒而不是更长**：这是"按两下问号"顺手触发的功能，补全弹窗会一直挂着等结果 ——
 * 实测推理型模型（如 glm-5.3-flash）对这类提示要 **30 秒以上**（它先花大量 token 推理），
 * 那么等 30 秒的弹窗对用户等于卡死。**宁可快速失败并说清原因**，让用户去换个快模型，
 * 也不要让他对着一个转圈的面板猜。
 *
 * 我第一版写 15 秒、后来放宽到 40 秒，都被这个实测推翻：问题不在超时太短，而在**选错了模型类别**。
 */
export const SUGGEST_TIMEOUT_MS = 8_000

/** 建议上限的兜底（引擎也会传 limit，但解析器要能独立防失控） */
const HARD_LIMIT = 10

/** 模型输出里常见的装饰，解析时要去掉 */
const FENCE_RE = /^\s*```/
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/
const BACKTICK_WRAP_RE = /^`+|`+$/g

/**
 * 构造提示词。
 *
 * 刻意把格式要求写得**非常死**（每行一条、不要编号、不要代码块），
 * 因为解析器宁可简单可靠 —— 与其写一个能容错各种格式的复杂解析器，
 * 不如让模型按固定格式输出，再把"不按格式来"的情况当异常处理掉。
 */
export function buildSuggestPrompt(query: string, limit: number): PromptTurn[] {
  const n = Math.max(1, Math.min(HARD_LIMIT, limit))
  return [
    {
      role: 'system',
      content: [
        '你是 shell 命令助手。用户给出一个命令片段，你要补全成可直接执行的完整命令。',
        `最多给出 ${n} 条，按推荐程度排序。`,
        '输出格式（必须严格遵守）：',
        '- 每行一条完整命令，不要编号、不要项目符号、不要解释、不要 markdown 代码块',
        '- 若某条命令需要说明，在同一行的最后用 " | " 分隔一句很短的说明',
        '- 不要输出任何多余的文字',
      ].join('\n'),
    },
    { role: 'user', content: query.trim() },
  ]
}

export interface CommandSuggestion {
  command: string
  description?: string
}

/**
 * 解析模型输出为命令建议。
 *
 * 宽容但**不危险**：会剥掉代码块围栏、序号、项目符号、反引号包裹；
 * 但**不会**把明显不是命令的行（空行、纯说明文字）塞进结果 ——
 * 候选被用户按 Tab 接受后会直接进终端，宁可少给也不能给错的。
 */
export function parseCommandSuggestions(text: string, limit: number): CommandSuggestion[] {
  const max = Math.max(1, Math.min(HARD_LIMIT, limit))
  const out: CommandSuggestion[] = []
  const seen = new Set<string>()

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line === '') continue
    // 代码块围栏整行丢掉（连带语言标记 ```bash）
    if (FENCE_RE.test(line)) continue
    // 序号 / 项目符号
    line = line.replace(BULLET_RE, '').trim()
    if (line === '') continue
    // 反引号包裹（模型常给 `ls -la`）
    line = line.replace(BACKTICK_WRAP_RE, '').trim()
    if (line === '') continue

    // 说明与命令分离
    let command = line
    let description: string | undefined
    const sep = line.indexOf(' | ')
    if (sep > 0) {
      command = line.slice(0, sep).trim()
      const desc = line.slice(sep + 3).trim()
      if (desc !== '') description = desc
    }

    // 明显不是命令的行不要（说明文字常常带中文句号/冒号结尾，或是"以下是…"）
    if (command === '' || command.length > 500) continue
    if (/^(以下是|下面是|说明[:：]|注意[:：])/.test(command)) continue
    // 纯说明（不含任何空格分隔的命令结构）且以句末标点结尾 → 丢掉
    if (/[。；]$/.test(command) && !command.includes(' --')) continue

    const key = command.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    out.push(description === undefined ? { command } : { command, description })
    if (out.length >= max) break
  }

  return out
}

// ── 编排（依赖注入，便于测试与解耦）────────────────────

export interface SuggestDeps {
  /** 当前选中的供应商；返回 undefined 表示"没有可用供应商" */
  resolveProvider: () =>
    | { name: string; hasApiKey: boolean }
    | undefined
  /** 真正去问模型（由 index.ts 注入，内部用既有的 provider client） */
  ask: (messages: PromptTurn[], signal?: AbortSignal) => Promise<string>
}

/** 未配置供应商时给用户的**可操作**提示（不是"通道尚未接入"这种没用的说法） */
export const NO_PROVIDER_MESSAGE =
  'AI 建议需要先配置 AI 供应商：请打开「设置 > AI 助手」，选择供应商并填写 API Key 后重试'

export function missingApiKeyMessage(providerName: string): string {
  return `供应商「${providerName}」未配置 API Key：请打开「设置 > AI 助手」填写后重试`
}

/**
 * 取 AI 命令建议。
 *
 * 三条错误路径都给**可操作**的说明（而不是静默或"通道尚未接入"）：
 * 未配供应商 / 供应商没填 Key / 模型调用失败。
 */
export function createCommandSuggester(deps: SuggestDeps): (
  input: { query: string },
  limit: number,
) => Promise<CommandSuggestion[]> {
  return async (input, limit) => {
    const provider = deps.resolveProvider()
    if (!provider) throw new Error(NO_PROVIDER_MESSAGE)
    if (!provider.hasApiKey) throw new Error(missingApiKeyMessage(provider.name))

    const query = input.query.trim()
    if (query === '') return []

    // 超时保护：AI 建议是"顺手一按"的功能，卡住不如早点告诉用户
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS)
    let text: string
    try {
      text = await deps.ask(buildSuggestPrompt(query, limit), controller.signal)
    } finally {
      clearTimeout(timer)
    }

    return parseCommandSuggestions(text, limit)
  }
}
