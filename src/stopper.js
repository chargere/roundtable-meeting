// 「什么时候停」—— 四根轨里的第三根。
//
// 每个 stopper 只有一个方法 check(state)，返回 { stop, reason }。
// 引擎每轮结束挨个问一遍，谁先说停就停。
//
// 这就是为什么"吵架模式"能烧穿预算而"正式会议"不会：
// 同一个引擎，换一组 stopper 而已。

/** 轮数到就停。数的是"这一趟走了几轮"，不是会话的总轮数。 */
export function byRounds(n) {
  return {
    name: `轮数≥${n}`,
    check(state) {
      // 用 state.rounds（本趟已完成的轮数），不用 state.round（会话总轮数）。
      // 不然在一个已经聊过八轮的会话里接着聊，"满三轮就散"会在第一轮就触发。
      return (state.rounds ?? 0) >= n
        ? { stop: true, reason: `这一趟已满 ${n} 轮` }
        : { stop: false }
    },
  }
}

/**
 * 收敛检测：最近几轮的累计重复 ≥ 累计新论据，就散。
 *
 * 为什么用滑窗而不是"连续两轮"：
 * 连续两轮的判据太脆。一轮走神就清零，一场正在变坏的讨论能靠"回光返照"多跑三轮；
 * 反过来，一场好讨论也可能被两轮偶然的低谷掐死。
 * 滑窗看的是趋势，不是单轮的运气。
 *
 * 门槛取 window 轮满窗之后才判，否则第一轮就可能误停。
 */
export function byConvergence({ window = 3 } = {}) {
  const history = []
  return {
    name: `收敛检测(${window}轮滑窗)`,
    check(state) {
      const a = state.assess
      if (!a) return { stop: false }

      // 纯附和也计入"重复"：它同样没带来新信息，只是形式上更好看。
      history.push({ n: a.newArguments, r: (a.repeats ?? 0) + (a.agreementOnly ?? 0) })
      if (history.length > window) history.shift()
      if (history.length < window) return { stop: false }

      const n = history.reduce((s, x) => s + x.n, 0)
      const r = history.reduce((s, x) => s + x.r, 0)

      return r > 0 && r >= n
        ? { stop: true, reason: `最近 ${window} 轮累计：新论据 ${n} 条，重复/附和 ${r} 条` }
        : { stop: false }
    },
  }
}

/** 预算闸：调用次数或用字量超线就停。这是最后一道保险，永远开着。 */
export function byBudget({ maxCalls = 40, maxChars = 8000 } = {}) {
  return {
    name: '预算闸',
    check(state) {
      if (state.calls >= maxCalls) return { stop: true, reason: `调用 ${state.calls} 次，到预算上限` }
      if (state.chars >= maxChars) return { stop: true, reason: `累计 ${state.chars} 字，到预算上限` }
      return { stop: false }
    },
  }
}
