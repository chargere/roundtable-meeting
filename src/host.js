// 假主持。
//
// 主持在圆桌里干两件事，这两件事接真模型时是两个不同的 prompt：
//   1. chooseNext —— 决定下一位（"主持点名"模式要它）
//   2. assess     —— 每轮结束打分：这一轮有多少新论据、多少是重复
//
// 以前还有第三个"救场"：冷场时由主持说一句话把话题拽回来。
// 砍掉了 —— 那句是写死的，模型会把它当成真指令照做，
// 一次关于审美的闲聊被它硬掰成了"接下来一周先做哪一步"。
// 冷场就是冷场，散会就好。
//
// 为什么不能每个座位自己调一次 API 问"你要不要说"：
// 五个人就是五次调用，比正文还贵。一次批量判断，只真调被点到的一两个。

import { chance, pickOne } from './rng.js'
import { isAgreementOnly, nameOf, novelty } from './text.js'

export function createMockHost({ rng }) {
  return {
    async chooseNext(state) {
      const cands = state.seats.filter((s) => !state.spoken.has(s.id))
      if (!cands.length) return null

      // 开场让乐观派先说，不然一上来就吵架，看起来不像会议。
      const saidSomething = state.messages.some((m) => m.role === 'model')
      if (!saidSomething) {
        return (cands.find((s) => s.id === 'optimist') ?? cands[0]).id
      }

      // 之后优先点"该反驳的人"，这是让讨论真的推进的便宜办法。
      for (const prefer of ['critic', 'opposition', 'accountant', 'narrower', 'optimist']) {
        const s = cands.find((c) => c.id === prefer)
        if (s && chance(rng, 0.8)) return s.id
      }
      return pickOne(rng, cands).id
    },

    async assess(state) {
      // 按时间顺序走一遍，让同一轮里后说的那条也要跟先说的那条比。
      // 只跟"上一轮以前"比的话，同一轮里两个人说了几乎一样的话，会双双算成新论据。
      const all = state.messages.filter((m) => m.role === 'model')
      const priorTexts = []
      let newArguments = 0
      let repeats = 0
      let agreementOnly = 0

      for (const m of all) {
        if (m.round === state.round) {
          if (isAgreementOnly(m.text)) {
            // 纯附和：剥掉"我同意""说得对"之后基本不剩东西。
            agreementOnly++
          } else if (novelty(m.text, priorTexts) < 0.45) {
            // 说了点东西，但基本都是前面说过的词。
            repeats++
          } else {
            newArguments++
          }
        }
        priorTexts.push(m.text)
      }

      const thisRound = all.filter((m) => m.round === state.round)
      const summary = thisRound.length
        ? thisRound.map((m) => `${nameOf(state.seats, m)}：${m.text.slice(0, 22)}`).join('；')
        : ''

      return { newArguments, repeats, agreementOnly, summary }
    },
  }
}
