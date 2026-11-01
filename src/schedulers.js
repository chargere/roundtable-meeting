// 「谁决定下一位说话」—— 四根轨里的第一根。
//
// 三种调度器就是三个函数，引擎对它们的唯一要求是：
//   给我一个还没说话的座位 id，或者 null。
//
// 所以"回合制"和"自由轮"不是两套代码，是换了这个函数。

/** 固定序列：一号说完二号说。最像"会议"。 */
export function fixedOrder() {
  return {
    name: '固定序列',
    async pick(state) {
      const next = state.seats.find((s) => !state.spoken.has(s.id))
      return next?.id ?? null
    },
  }
}

/** 主持点名：主持看完最近几条，决定点谁。最像"真人主持"。 */
export function hostPicks(host) {
  return {
    name: '主持点名',
    async pick(state) {
      return host.chooseNext(state)
    },
  }
}

/**
 * 自荐抢话：每个人先估一下自己"有多想说"，够格的抢到话筒。
 * 这就是自由轮。关键是那个 threshold —— 低于线就闭嘴，
 * 没有这条线，自由轮会退化成"五个模型轮流复读"。
 */
export function selfNominate({ rng, threshold = 0.55 }) {
  return {
    name: '自荐抢话',
    async pick(state) {
      const cands = state.seats.filter((s) => !state.spoken.has(s.id))
      if (!cands.length) return null

      let best = null
      let bestScore = -Infinity
      for (const s of cands) {
        const score = urge(state, s, rng)
        if (score > bestScore) { bestScore = score; best = s }
      }
      if (bestScore < threshold) return null
      return best.id
    },
  }
}

/**
 * 辩论顺序：正方一辩 → 反方一辩 → 正方二辩 → 反方二辩 → …
 *
 * 队列在开场前就定死了，中途不改。辩论跟自由讨论不一样：
 * 它的规则性就是它的意义，谁什么时候开口不该是随机的。
 */
export function debateOrder(seats, { first = 'pro' } = {}) {
  const build = (leader) => {
    const pro = seats.filter((s) => s.side === 'pro')
    const con = seats.filter((s) => s.side === 'con')
    const [a, b] = leader === 'con' ? [con, pro] : [pro, con]
    const queue = []
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) queue.push(a[i].id)
      if (b[i]) queue.push(b[i].id)
    }
    return queue
  }

  return {
    name: '辩论顺序',
    // 每一轮现拼队列：state.first 可能被主持人改过。
    // 以前队列是开场时固定死的，所以"这一轮反方先"永远不可能生效。
    async pick(state) {
      const queue = build(state.first ?? first)
      return queue.find((id) => !state.spoken.has(id)) ?? null
    },
  }
}

/** "想说"的程度：被晾着越久越想说话，刚说过就让一让。 */
function urge(state, seat, rng) {
  const recent = state.messages.filter((m) => m.role === 'model').slice(-4)
  let score = seat.urgeBase ?? 0.5

  if (recent.some((m) => m.seatId !== seat.id)) score += 0.15 // 别人说过了，我有得接
  if (recent.at(-1)?.seatId === seat.id) score -= 0.4        // 我刚说过，让一让
  score += (state.round - 1) * 0.05                          // 越拖越想抢

  return score + (rng() - 0.5) * 0.3                         // 一点随机，别每次都一样
}
