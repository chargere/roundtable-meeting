// 成员表：这才是"谁坐在桌边"的真相。
//
// 之前五个座位是写死在 src/seats.js 里的常量 —— 想改人设只能改源码。
// 现在它是 data/members.json 里的数据：前端能增删改，命令行也读同一份。
//
// 一个成员 = 人格 + 一条渠道。
// 渠道里存着 provider / model / key，所以"一个 key 一个成员"是成立的：
// 五个成员可以是五家不同的模型，那它们吵起来才有意义 ——
// 要是五个都用同一个模型，你只是花五倍的钱听同一个脑子说五遍。
//
// ⚠ 这个文件里有 API Key。它已经在 .gitignore 里了，别提交。

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { SEATS } from './seats.js'

const DIR = 'data'
const FILE = join(DIR, 'members.json')

export const PROVIDERS = [
  { id: 'mock', label: '假模型（不花钱）', ready: true },
  { id: 'deepseek', label: 'DeepSeek', ready: true },
  { id: 'glm', label: '智谱 GLM', ready: true },
  { id: 'doubao', label: '豆包（火山方舟）', ready: true },
  { id: 'hunyuan', label: '腾讯混元', ready: true },
  { id: 'openai', label: 'OpenAI 兼容', ready: true },
  { id: 'anthropic', label: 'Anthropic Claude', ready: true },
  { id: 'custom', label: '自定义地址', ready: true },
]

const LIMIT = {
  name: 16,
  persona: 600,
  rules: 10,
  rule: 100,
  model: 80,
  baseURL: 300,
  apiKey: 400,
}

const clamp01 = (v, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

function emptyChannel() {
  return { provider: 'mock', model: '', baseURL: '', apiKey: '' }
}

function seedMembers() {
  return SEATS.map((s) => ({ ...s, rules: [...s.rules], enabled: true, channel: emptyChannel() }))
}

/** 把任意来源的数据洗成合法成员：字段补齐、长度截断、数值夹紧、id 去重。 */
export function normalizeMembers(raw) {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []

  for (const item of list) {
    if (!item || typeof item !== 'object') continue

    let id = String(item.id ?? '').trim()
    if (!id) id = `m-${Math.random().toString(36).slice(2, 8)}`
    if (seen.has(id)) continue
    seen.add(id)

    const rules = (Array.isArray(item.rules) ? item.rules : [])
      .map((r) => String(r).slice(0, LIMIT.rule))
      .filter((r) => r.trim())
      .slice(0, LIMIT.rules)

    const provider = PROVIDERS.some((p) => p.id === item.channel?.provider)
      ? item.channel.provider
      : 'mock'

    out.push({
      id,
      name: String(item.name ?? '').slice(0, LIMIT.name) || '无名',
      persona: String(item.persona ?? '').slice(0, LIMIT.persona),
      rules,
      conformity: clamp01(item.conformity, 0.3),
      passRate: clamp01(item.passRate, 0.2),
      urgeBase: clamp01(item.urgeBase, 0.55),
      enabled: item.enabled !== false,
      channel: {
        provider,
        model: String(item.channel?.model ?? '').slice(0, LIMIT.model),
        baseURL: String(item.channel?.baseURL ?? '').slice(0, LIMIT.baseURL),
        apiKey: String(item.channel?.apiKey ?? '').slice(0, LIMIT.apiKey),
      },
    })
  }

  return out
}

export async function saveMembers(list) {
  await mkdir(DIR, { recursive: true })
  const clean = normalizeMembers(list)
  await writeFile(FILE, JSON.stringify(clean, null, 2), 'utf8')
  return clean
}

export async function loadMembers() {
  await mkdir(DIR, { recursive: true })

  if (!existsSync(FILE)) {
    return saveMembers(seedMembers())
  }

  try {
    return normalizeMembers(JSON.parse(await readFile(FILE, 'utf8')))
  } catch {
    // 文件坏了：留一份现场再重新播种。宁可丢掉人设，也别让服务起不来。
    await copyFile(FILE, `${FILE}.broken`).catch(() => {})
    return saveMembers(seedMembers())
  }
}

/**
 * 出给浏览器的版本：**把 key 拿掉**。
 * 只告诉页面"有没有 key""后四位是什么"，页面永远拿不到完整 key。
 */
export function publicMembers(list) {
  return list.map((m) => ({
    id: m.id,
    name: m.name,
    persona: m.persona,
    rules: m.rules,
    conformity: m.conformity,
    passRate: m.passRate,
    enabled: m.enabled,
    channel: {
      provider: m.channel.provider,
      model: m.channel.model,
      baseURL: m.channel.baseURL,
      hasKey: Boolean(m.channel.apiKey),
      keyHint: m.channel.apiKey ? `····${m.channel.apiKey.slice(-4)}` : '',
    },
  }))
}

/**
 * 合并页面传回来的成员：
 * 前端只改人设、不碰 key 的时候，channel 里不会有 apiKey 字段 —— 那就保留原来那把。
 * 传了 apiKey（哪怕是空字符串）就说明确实要改。
 */
export function mergeChannels(existing, incoming) {
  const byId = new Map(existing.map((m) => [m.id, m]))
  return incoming.map((m) => {
    const prev = byId.get(m.id)
    const touched = Object.prototype.hasOwnProperty.call(m.channel ?? {}, 'apiKey')
    const apiKey = touched ? String(m.channel.apiKey ?? '') : (prev?.channel?.apiKey ?? '')
    return { ...m, channel: { ...(m.channel ?? {}), apiKey } }
  })
}

export const MEMBERS_FILE = FILE
