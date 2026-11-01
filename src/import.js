// 把拖进来的文件变成一份会话。
//
// 支持三种，都是我们自己产出的格式：
//   .json   本程序导出的会话
//   .jsonl  out/logs 里的运行日志
//   .md     out/xxx.md 里的对话记录
//
// 认不出来的格式直接报错，不猜——猜错了导入一堆垃圾比拒绝更糟。

import { SEATS } from './seats.js'

const NAME2ID = new Map(SEATS.map((s) => [s.name, s.id]))

// 记录里的元信息行，不是消息
const SKIP_NAMES = new Set(['议题', '停止', '账'])

function normalizeMessage(m, i) {
  return {
    id: m.id ?? `imp-${i}`,
    role: m.role ?? (m.seatId === 'user' ? 'user' : 'model'),
    seatId: m.seatId ?? 'host',
    text: String(m.text ?? ''),
    round: Number(m.round ?? 0),
    ts: Number(m.ts ?? Date.now()),
  }
}

function fromJson(content) {
  const data = JSON.parse(content)
  const raw = Array.isArray(data) ? data : data.messages
  if (!Array.isArray(raw)) throw new Error('这个 json 里没有 messages 数组')
  return {
    title: data.title ?? null,
    preset: data.preset ?? null,
    messages: raw.map(normalizeMessage).filter((m) => m.text),
  }
}

function fromJsonl(content) {
  const messages = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let row
    try { row = JSON.parse(t) } catch { continue } // 坏行跳过，日志里可能有半行
    if (row.kind === 'event' && row.type === 'message' && row.message) {
      messages.push(normalizeMessage(row.message, messages.length))
    }
  }
  if (!messages.length) throw new Error('这个 jsonl 里没有找到对话事件')
  return { title: null, preset: null, messages }
}

function fromMarkdown(content) {
  const messages = []
  let preset = null
  let round = 0

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('# ')) { preset = line.slice(2).trim(); continue }
    if (line.startsWith('>')) continue
    if (line.startsWith('`') || line === '---') continue

    const roundHit = line.match(/^\*\*第 (\d+) 轮\*\*$/)
    if (roundHit) { round = Number(roundHit[1]); continue }

    const passed = line.match(/^_(.+?) 过了_$/)
    if (passed) {
      messages.push({
        id: `imp-${messages.length}`, role: 'pass',
        seatId: NAME2ID.get(passed[1]) ?? passed[1],
        text: `${passed[1]} 过了`, round, ts: Date.now(),
      })
      continue
    }

    // 主持的旁白：_（冷场）_ / _（主持）……_
    const aside = line.match(/^_(.+)_$/)
    if (aside) {
      messages.push({
        id: `imp-${messages.length}`, role: 'host', seatId: 'host',
        text: aside[1], round, ts: Date.now(),
      })
      continue
    }

    const msg = line.match(/^\*\*(.+?)\*\*：(.*)$/)
    if (msg) {
      const [name, text] = [msg[1].trim(), msg[2].trim()]
      if (SKIP_NAMES.has(name)) continue
      messages.push({
        id: `imp-${messages.length}`,
        role: name === '你' ? 'user' : 'model',
        seatId: name === '你' ? 'user' : (NAME2ID.get(name) ?? name),
        text, round, ts: Date.now(),
      })
    }
  }

  if (!messages.length) throw new Error('这个 markdown 里没有认出对话')
  return { title: null, preset, messages }
}

export function parseImport(filename = '', content = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const text = String(content)

  let result
  if (ext === 'json') result = fromJson(text)
  else if (ext === 'jsonl') result = fromJsonl(text)
  else if (ext === 'md' || ext === 'markdown') result = fromMarkdown(text)
  else {
    // 没有扩展名就猜：先当 json，再当 jsonl，最后当 markdown
    const t = text.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      try { result = fromJson(text) } catch { result = fromMarkdown(text) }
    } else if (t.includes('"kind"') && t.includes('\n')) {
      result = fromJsonl(text)
    } else {
      result = fromMarkdown(text)
    }
  }

  return {
    ...result,
    title: result.title ?? filename.replace(/\.[^.]+$/, '') ?? '导入的会话',
    source: filename,
  }
}
