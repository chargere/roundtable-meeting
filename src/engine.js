// 引擎：一个循环，加三个可插拔的策略。
//
//   调度器  决定下一位是谁
//   说话者  把"轮到你了"变成一句话，或者一个「过」
//   终止器  决定什么时候散会
//
// 回合制和自由轮共用这一个循环 —— 它们只是传进来的策略不同。
// 所以你以后加第五种模式，也不用碰这个文件。

import { buildMessages } from './prompt.js'

let seq = 0
// 每次运行一个前缀：同一个进程里可能并发好几场（开好几个标签页），
// 只用一个自增数字的话，id 会撞。
const RUN = Math.random().toString(36).slice(2, 7)
const nextId = () => `${RUN}-${++seq}`

export async function runRoundtable({
  topic,
  seats,
  scheduler,
  stoppers = [],
  speaker,
  host,
  log = null,
  maxTurns = 60,
  perRound = null, // 这一轮最多几个人发言（null = 所有人都可以）
  brief = '',      // 这一场的资料：每个人开口前都能看到
  onRoundStart = null, // 每轮开头问一次"这一轮怎么打"（辩论里的主持 AI 用）
  signal = null,   // 外部打断：页面上的「强制停止」会 abort 它
  history = [],   // 已有的聊天记录：网页版靠它"接着上次继续聊"
  onEvent = null, // 每产生一个事件就回调一次：网页版靠它流式渲染
}) {
  // 每轮人数夹紧：不能比人多，也不能是 0。
  const roundQuota = perRound ? Math.max(1, Math.min(Number(perRound), seats.length)) : null

  const state = {
    topic,
    seats,
    round: 1,      // 当前轮次（接着旧会话跑时，从历史最后一轮往后数）
    rounds: 0,     // 这一趟已经走完几轮 —— 终止判据看的是它，不是 round
    turn: 0,       // 已经说了多少句（「过」不算）
    roundTurns: 0, // 本轮已经说了几句（「过」不算）
    messages: [],
    spoken: new Set(), // 本轮已经发过言（或过）的人
    dead: new Set(),   // 这一场里连不上的人：报过错就摘掉，别每轮再撞一次
    calls: 0,      // 调了多少次模型
    chars: 0,      // 累计多少字
    passes: 0,     // 过了多少次
    summary: '',   // 上一轮纪要，给下一轮的 prompt 用
    assess: null,  // 上一轮的打分
    roundQuota,    // 给打分和界面看的
  }

  const events = []
  const emit = (e) => { e.at = Date.now(); events.push(e); log?.event(e); onEvent?.(e) }
  const say = (m) => {
    const msg = { id: nextId(), ts: Date.now(), ...m }
    state.messages.push(msg)
    emit({ type: 'message', message: msg })
    return msg
  }

  if (history.length) {
    // 接着已有的记录往下跑：别人的话不重新说一遍，只重新计数。
    for (const m of history) state.messages.push({ ...m })
    state.round = state.messages.reduce((mx, m) => Math.max(mx, m.round ?? 0), 0) + 1
  } else {
    // 你先把议题放上桌。
    say({ seatId: 'user', role: 'user', text: topic, round: 0 })
  }

  let stopReason = null
  let iterations = 0
  let lastDirectedRound = 0

  while (state.turn < maxTurns) {
    // 保护：万一调度器出 bug 返回个重复的座位，也不能死循环。
    if (++iterations > maxTurns * 4) { stopReason = '保护性终止（迭代次数过多）'; break }

    // 页面按了「强制停止」。在两次调用之间收手，已经说出去的话留着。
    if (signal?.aborted) { stopReason = '被你按了停止'; break }

    // 全员连不上就别硬撑，直接散会并说清楚原因。
    if (state.dead.size >= seats.length) { stopReason = '所有成员都连不上，散会'; break }

    // ---------- 每轮开头：主持 AI 定这一轮怎么打 ----------
    // 只在"这一轮还没人说话"时问一次。它决定谁先开口，并给一句本轮的要求。
    // 这句话会作为一条真实发言进对话，所以你能看见它在指挥。
    if (state.spoken.size === 0 && onRoundStart && state.round !== lastDirectedRound) {
      lastDirectedRound = state.round
      try {
        const info = await onRoundStart(state)
        if (info?.first) state.first = info.first

        // 顺序和内容分两条路：顺序只改 state.first（机器执行），内容才进 prompt。
        // 主持的三段话：承接 → 发现 → 启下。它得先看懂上一轮，才问得出下一轮。
        if (info?.focus || info?.recap || info?.angle) {
          const to = info.to === 'pro' || info.to === 'con' ? info.to : 'both'
          state.directive = { focus: info.focus, angle: info.angle, to }

          const who = to === 'pro' ? '正方' : to === 'con' ? '反方' : '双方'
          const lines = []
          if (info.recap) lines.push(`承接：${info.recap}`)
          if (info.angle) lines.push(`有意思的是：${info.angle}`)
          if (info.focus) lines.push(`本轮问${who}：${info.focus}`)

          say({
            seatId: 'host',
            role: 'host',
            text: lines.join('\n'),
            round: state.round,
            meta: { first: info.first ?? state.first, to },
          })
        }
      } catch (err) {
        // 主持人自己说不出来，不该拖垮辩论 —— 沉默的主持，大家照常打。
        emit({ type: 'error', seat: '主持', message: `主持没说话：${err.message}`, round: state.round, soft: true })
      }
    }

    // ---------- 一轮结束了吗 ----------
    // 两个条件：所有人都轮到过了，或者本轮的人数配额用完了。
    if (state.spoken.size >= seats.length || (roundQuota && state.roundTurns >= roundQuota)) {
      const spokeThisRound = state.messages.some(
        (m) => m.role === 'model' && m.round === state.round,
      )

      // 冷场：这一轮所有人都选择了沉默。
      //
      // 以前这里会由"主持"说一句救场台词。那句话是写死的，会被模型当成真指令照做——
      // 一次关于审美的聊天，被它硬掰成"接下来一周先做哪一步"。
      // 所以现在不再往对话里塞任何伪造的发言：没话说就是没话说，老实散会。
      if (!spokeThisRound) {
        stopReason = '全场沉默：这一轮没人有话说'
        break
      }

      // 结算这一轮
      state.assess = await host.assess(state)
      state.summary = state.assess.summary
      state.rounds++
      emit({ type: 'assess', assess: state.assess, round: state.round })

      for (const s of stoppers) {
        const r = s.check(state)
        if (r.stop) { stopReason = `${s.name}：${r.reason}`; break }
      }
      if (stopReason) break

      state.round++
      state.spoken.clear()
      state.roundTurns = 0
      emit({ type: 'round', round: state.round })
      continue
    }

    // ---------- 挑下一位 ----------
    const seatId = await scheduler.pick(state)
    if (!seatId) {
      // 没人愿意接话 ≠ 整场结束。
      // 自由轮里这是常态：这一轮的话说完了，剩下的人没东西可加。
      // 处理成"本轮余下的人沉默"，交给下面的轮末逻辑去结算、救场或收尾 ——
      // 早先这里直接 break，结果是自由轮只要碰上一次没人想说话就整场判死。
      emit({ type: 'silence', round: state.round, by: scheduler.name })
      for (const s of seats) state.spoken.add(s.id)
      continue
    }

    const seat = seats.find((s) => s.id === seatId)
    if (!seat) { stopReason = `调度器返回了不存在的座位：${seatId}`; break }
    if (state.spoken.has(seat.id)) { stopReason = `调度器重复点名：${seat.name}`; break }

    // 这一场里已经废掉的座位：嘴上说一句"过了"，人不再叫。
    if (state.dead.has(seat.id)) {
      state.spoken.add(seat.id)
      continue
    }

    // ---------- 说 ----------
    // 你刚说完话之后的第一个人，不许"过"。
    // 否则会出现这种情况：你打了句"听下"，两个人齐刷刷沉默，你看着一个空房间。
    const lastUserIndex = state.messages.map((m) => m.role).lastIndexOf('user')
    const mustSpeak = !state.messages.slice(lastUserIndex + 1).some((m) => m.role === 'model')

    const prompt = buildMessages(state, seat, { mustSpeak, brief })

    let res
    try {
      res = await speaker.speak({ seat, state, prompt, mustSpeak })
    } catch (err) {
      // 因为"停止"而报的错不是错误，是预期内的收手。
      if (signal?.aborted) { stopReason = '被你按了停止'; break }

      state.calls++
      state.spoken.add(seat.id)

      // soft 错误：这一轮没说出话，但人没坏（比如思考模型把预算烧完了）。
      // 这种不该把人从整场里摘掉，下一轮还轮得到他。
      const soft = Boolean(err.soft)
      if (!soft) state.dead.add(seat.id)

      log?.call({ round: state.round, seat: seat.id, prompt, error: err.message })
      emit({ type: 'error', seat: seat.name, seatId: seat.id, message: err.message, round: state.round, soft })

      // 辩论时一方全掉线，就别让另一边对着空气吵 —— 那种"自言自语"是最难看的。
      const sides = [...new Set(seats.map((s) => s.side).filter(Boolean))]
      if (sides.length === 2) {
        const wiped = sides.find((side) =>
          seats.filter((s) => s.side === side).every((s) => state.dead.has(s.id)))
        if (wiped) {
          stopReason = `${wiped === 'pro' ? '正方' : '反方'}全员掉线，辩不下去了`
          break
        }
      }
      continue
    }

    state.calls++
    log?.call({ round: state.round, seat: seat.id, prompt, response: res })

    if (res.pass) {
      state.passes++
      state.spoken.add(seat.id)
      emit({ type: 'pass', seat: seat.name, round: state.round })
      continue
    }

    const text = String(res.text ?? '').trim()
    if (!text) {
      state.passes++
      state.spoken.add(seat.id)
      emit({ type: 'pass', seat: seat.name, round: state.round })
      continue
    }

    state.spoken.add(seat.id)
    state.turn++
    state.roundTurns++
    state.chars += text.length
    say({ seatId: seat.id, role: 'model', text, round: state.round })
  }

  if (!stopReason) stopReason = `达到最大发言条数（${maxTurns}）`
  emit({ type: 'stop', reason: stopReason })

  return { state, events, stopReason }
}
