// 命令行入口。三个玩法：
//
//   node run.js                              看「茶话会」
//   node run.js --preset=吵架                 换一个预设
//   node run.js --compare                    同一个议题，四个预设全跑一遍
//
// 加参数：
//   --topic=你想聊的事   --seed=7（同一个种子，结果完全一样）
//
// 每次跑完都会在 out/ 下留一份 markdown 记录和一份完整 jsonl 日志。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runRoundtable } from './src/engine.js'
import { buildPreset, PRESET_NAMES } from './src/presets.js'
import { loadMembers } from './src/members.js'
import { createSpeaker } from './src/speaker.js'
import { createMockHost } from './src/host.js'
import { createRng } from './src/rng.js'
import { createLog } from './src/log.js'
import { nameOf } from './src/text.js'

// ---------- 参数 ----------
const args = {}
for (const raw of process.argv.slice(2)) {
  if (raw === '--compare') { args.compare = true; continue }
  const m = raw.match(/^--([^=]+)=(.*)$/)
  if (m) args[m[1]] = m[2]
}

const topic = args.topic ?? '给这个圆桌项目每月花 300 块 API 费，值不值？'
const seed = Number(args.seed ?? 7)

// ---------- 跑一次 ----------
async function runOne(presetName) {
  const rng = createRng(seed)
  const host = createMockHost({ rng })

  // 座位来自 data/members.json —— 和网页版读的是同一份。
  // 你在网页里改的个人设，命令行这边立刻也是新的。
  const roster = await loadMembers()
  const base = roster.filter((m) => m.enabled !== false)
  if (!base.length) throw new Error('成员全关了，去 data/members.json 或网页里开一个')

  const preset = buildPreset(presetName, { host, rng, seats: base })
  const speaker = createSpeaker({ rng })
  const logger = createLog({ dir: join('out', 'logs'), tag: presetName })

  const result = await runRoundtable({
    topic,
    seats: preset.seats,
    scheduler: preset.scheduler,
    stoppers: preset.stoppers,
    speaker,
    host,
    log: logger,
  })

  return { ...result, preset, logger }
}

// ---------- 变成可读的记录 ----------
function render(result) {
  const { state, events, stopReason, preset } = result
  const L = []

  L.push(`# ${preset.name}`)
  L.push('')
  L.push(`> 假模型演示 · 种子 ${seed} · ${preset.note}`)
  L.push(`> ⚠ 台词是写死的演示文本，不含任何真实数据或结论。`)
  L.push('')
  L.push(`**议题**：${topic}`)
  L.push('')

  for (const e of events) {
    if (e.type === 'message') {
      const m = e.message
      if (m.role === 'user') { L.push(`**你**：${m.text}`, ''); continue }
      if (m.role === 'host') { L.push(`_${m.text}_`, ''); continue }
      L.push(`**${nameOf(state.seats, m)}**：${m.text}`, '')
    } else if (e.type === 'pass') {
      L.push(`_${e.seat} 过了_`, '')
    } else if (e.type === 'nudge') {
      L.push('_（冷场）_', '')
    } else if (e.type === 'assess') {
      L.push(
        `\`本轮：新论据 ${e.assess.newArguments} · 复读 ${e.assess.repeats} · 纯附和 ${e.assess.agreementOnly ?? 0}\``,
        '',
      )
    } else if (e.type === 'round') {
      L.push('---', '', `**第 ${e.round} 轮**`, '')
    }
  }

  const speeches = state.messages.filter((m) => m.role === 'model')
  L.push('---')
  L.push('')
  L.push(`**停止**：${stopReason}`)
  L.push(`**账**：调用 ${state.calls} 次 · 发言 ${speeches.length} 条 · 过 ${state.passes} 次 · 共 ${state.chars} 字 · 走到第 ${state.round} 轮`)
  L.push('')
  L.push(`日志：${result.logger.file}`)

  return L.join('\n')
}

function statsOf(result) {
  const speeches = result.state.messages.filter((m) => m.role === 'model')
  const a = result.state.assess ?? { newArguments: 0, repeats: 0, agreementOnly: 0 }
  return {
    模式: result.preset.name,
    发言: speeches.length,
    过: result.state.passes,
    调用: result.state.calls,
    字数: result.state.chars,
    末轮新: a.newArguments,
    末轮复读: a.repeats,
    末轮附和: a.agreementOnly ?? 0,
    轮: result.state.round,
    停止: result.stopReason,
  }
}

// ---------- 主流程 ----------
mkdirSync('out', { recursive: true })

if (args.compare) {
  const names = args.preset ? [args.preset] : PRESET_NAMES
  const rows = []
  const files = []

  for (const name of names) {
    const result = await runOne(name)
    const text = render(result)
    const file = join('out', `${name}-seed${seed}.md`)
    writeFileSync(file, text, 'utf8')
    rows.push(statsOf(result))
    files.push(file)
  }

  console.log(`\n议题：${topic}`)
  console.log(`种子：${seed}（固定种子 = 可复现，改种子看另一种走法）\n`)
  console.table(rows)
  console.log('\n完整记录：')
  for (const f of files) console.log('  ' + f)

  const head = [`# 四模式对比`, '', `议题：${topic}`, `种子：${seed}`, '']
  const cols = Object.keys(rows[0])
  head.push('| ' + cols.join(' | ') + ' |')
  head.push('|' + cols.map(() => '---').join('|') + '|')
  for (const r of rows) head.push('| ' + cols.map((c) => r[c]).join(' | ') + ' |')
  writeFileSync(join('out', `compare-seed${seed}.md`), head.join('\n'), 'utf8')
  console.log(`  out/compare-seed${seed}.md`)
} else {
  const name = args.preset ?? '茶话会'
  const result = await runOne(name)
  const text = render(result)
  const file = join('out', `${name}-seed${seed}.md`)
  writeFileSync(file, text, 'utf8')
  console.log(text)
  console.log(`\n记录已写入：${file}`)
}
