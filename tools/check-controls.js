// 控制项自检：每轮人数、轮数上限、强制停止。
//
//   node tools/check-controls.js
//
// 不连真模型 —— 用一个"每问必答"的假说话器，把引擎的行为逼出来。
// 这样跑一次只要几毫秒，也不会花你的钱。

import { runRoundtable } from '../src/engine.js'
import { fixedOrder } from '../src/schedulers.js'
import { byRounds, byBudget } from '../src/stopper.js'
import { createMockHost } from '../src/host.js'
import { createRng } from '../src/rng.js'

const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) process.exitCode = 1
}

function seats(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, name: `人${i}`, persona: '', rules: [],
    conformity: 0, passRate: 0,
  }))
}

/** 每问必答，说第几句由计数器决定。 */
function talkingSpeaker() {
  let n = 0
  return { async speak() { return { text: `第 ${++n} 句` } } }
}

function silentSpeaker() {
  return { async speak() { return { pass: true } } }
}

const base = { scheduler: fixedOrder(), host: createMockHost({ rng: createRng(1) }) }

// ---------- 1. 每轮只让 N 个人说 ----------
{
  const r = await runRoundtable({
    ...base,
    topic: '测试',
    seats: seats(5),
    speaker: talkingSpeaker(),
    stoppers: [byRounds(2), byBudget({ maxCalls: 99 })],
    perRound: 2,
  })
  const speeches = r.state.messages.filter((m) => m.role === 'model')
  ok(speeches.length === 4, `5 个人、每轮 2 个、2 轮 → 发言 ${speeches.length} 条（应为 4）`)
  ok(r.state.round === 2, `停在第 ${r.state.round} 轮（轮数到就散，不再进下一轮）`)
  ok(r.stopReason.includes('轮数'), `停止原因：${r.stopReason}`)
}

// ---------- 2. 每轮人数不能超过人头 ----------
{
  const r = await runRoundtable({
    ...base,
    topic: '测试',
    seats: seats(2),
    speaker: talkingSpeaker(),
    stoppers: [byRounds(1), byBudget({ maxCalls: 99 })],
    perRound: 9,
  })
  const speeches = r.state.messages.filter((m) => m.role === 'model')
  ok(speeches.length === 2, `只有 2 个人却设了每轮 9 个 → 实际 ${speeches.length} 条（应夹到 2）`)
}

// ---------- 3. 强制停止 ----------
{
  const controller = new AbortController()
  let calls = 0
  const speaker = {
    async speak() {
      calls++
      if (calls === 2) controller.abort() // 第二句刚说完就按停止
      return { text: `第 ${calls} 句` }
    },
  }

  const r = await runRoundtable({
    ...base,
    topic: '测试',
    seats: seats(5),
    speaker,
    stoppers: [byRounds(5), byBudget({ maxCalls: 99 })],
    signal: controller.signal,
  })

  const speeches = r.state.messages.filter((m) => m.role === 'model')
  ok(speeches.length <= 3, `按停止之后最多再多说一句 → 共 ${speeches.length} 条`)
  ok(r.stopReason.includes('停止'), `停止原因：${r.stopReason}`)
  ok(r.state.messages.length === speeches.length + 1, '已经说出去的话都还在（加上开场的议题）')
}

// ---------- 4. 全员沉默 ----------
{
  const r = await runRoundtable({
    ...base,
    topic: '测试',
    seats: seats(3),
    speaker: silentSpeaker(),
    stoppers: [byRounds(5), byBudget({ maxCalls: 99 })],
  })
  ok(r.stopReason.includes('沉默'), `停止原因：${r.stopReason}`)
}

// ---------- 5. soft 错误不等于掉线 ----------
{
  let n = 0
  const speaker = {
    async speak() {
      n++
      if (n === 1) {
        const err = new Error('思维链把预算烧完了')
        err.soft = true
        throw err
      }
      return { text: `第 ${n} 句` }
    },
  }

  const r = await runRoundtable({
    ...base,
    topic: '测试',
    seats: seats(3),
    speaker,
    stoppers: [byRounds(2), byBudget({ maxCalls: 99 })],
  })

  const speeches = r.state.messages.filter((m) => m.role === 'model')
  ok(speeches.length >= 3, `软错误之后人还在，继续说了 ${speeches.length} 句`)
  ok(r.state.dead.size === 0, '没有人被误判成掉线')
}

// ---------- 6. 辩论里一方全掉线就收场 ----------
{
  const debateSeats = [
    { id: 'p1', name: '正一', persona: '', rules: [], side: 'pro', position: 1, conformity: 0, passRate: 0 },
    { id: 'c1', name: '反一', persona: '', rules: [], side: 'con', position: 1, conformity: 0, passRate: 0 },
  ]

  const speaker = {
    async speak({ seat }) {
      if (seat.side === 'pro') throw new Error('正方的接口挂了')
      return { text: '反方继续说' }
    },
  }

  const r = await runRoundtable({
    topic: '测试辩题',
    seats: debateSeats,
    scheduler: fixedOrder(),
    speaker,
    host: createMockHost({ rng: createRng(1) }),
    stoppers: [byRounds(5), byBudget({ maxCalls: 99 })],
  })

  ok(r.stopReason.includes('辩不下去'), `停止原因：${r.stopReason}`)
  const conCount = r.state.messages.filter((m) => m.seatId === 'c1').length
  ok(conCount <= 1, `反方没有对着空气吵（说了 ${conCount} 句）`)
}

// ---------- 7. 超时 / 网络错误不算掉线 ----------
{
  const { friendlyError } = await import('../src/speaker.js')

  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  const t = friendlyError(timeout)
  ok(t.soft === true, '超时被标成"这一轮先跳过"')
  ok(/秒/.test(t.message), `提示是人话：${t.message}`)

  ok(friendlyError(new Error('fetch failed')).soft === true, '网络抖一下也不算掉线')

  const auth = new Error('deepseek 回了 401：invalid api key')
  ok(!friendlyError(auth).soft, '鉴权错才算真掉线')
}

console.log(process.exitCode ? '\n控制项有问题' : '\n控制项都对')
