// 预设 = 四根轨的一次快照。
//
// 现在座位是外部传进来的（来自 data/members.json），预设只在这份副本上动手：
// 你可以把某个成员的"沉默概率"调成 0.6，然后在"正式会议"里它照样必须说话 ——
// 因为预设改的是这一趟的临时副本，不写回文件。
//
// 这个取舍要记住：**预设是临时覆盖，成员表是长期设置。**

import { fixedOrder, hostPicks, selfNominate, debateOrder } from './schedulers.js'
import { byRounds, byConvergence, byBudget } from './stopper.js'

export const PRESET_NAMES = ['正式会议', '茶话会', '吵架', '静默观察', '辩论']

export function buildPreset(name, { host, rng, seats: base = [], debateFirst = 'pro' }) {
  const seats = base.map((s) => ({ ...s, rules: [...(s.rules ?? [])] }))

  switch (name) {
    case '正式会议':
      // 发言权=固定序列 / 沉默权=没有 / 终止=轮数
      for (const s of seats) s.passRate = 0
      return {
        name,
        note: '固定顺序 · 不许沉默 · 三轮散会',
        seats,
        scheduler: fixedOrder(),
        stoppers: [byRounds(3), byBudget({ maxCalls: 40 })],
      }

    case '茶话会':
      // 发言权=主持点名 / 沉默权=有 / 终止=没新东西就散
      return {
        name,
        note: '主持点名 · 可以过 · 没新论据就散',
        seats,
        scheduler: hostPicks(host),
        stoppers: [byConvergence({ window: 3 }), byRounds(6), byBudget({ maxCalls: 40 })],
      }

    case '吵架':
      // 发言权=自己抢 / 沉默权=没有 / 终止=只停预算
      for (const s of seats) {
        s.passRate = 0
        s.conformity = Math.min(s.conformity, 0.15)
      }
      return {
        name,
        note: '自荐抢话 · 不许沉默 · 只停预算（这条最贵）',
        seats,
        scheduler: selfNominate({ rng, threshold: 0.55 }),
        stoppers: [byBudget({ maxCalls: 24 }), byRounds(8)],
      }

    case '静默观察':
      // 发言权=主持点名 / 沉默权=很大 / 终止=轮数
      for (const s of seats) s.passRate = Math.min(0.85, (s.passRate ?? 0) + 0.45)
      return {
        name,
        note: '默认沉默 · 被点名才开口',
        seats,
        scheduler: hostPicks(host),
        stoppers: [byRounds(2), byBudget({ maxCalls: 20 })],
      }

    case '辩论': {
      // 谁站哪边、第几辩，由网页在 seats 上标好（side + position）。
      // 命令行直接跑的话没有这些标记，就按顺序一正一反劈开，至少辩得起来。
      const hasSide = seats.some((s) => s.side === 'pro' || s.side === 'con')
      seats.forEach((s, i) => {
        if (!hasSide) s.side = i % 2 === 0 ? 'pro' : 'con'
        if (!s.position) s.position = Math.floor(i / 2) + 1
      })

      return {
        name,
        note: `正反方 · 一辩二辩 · ${debateFirst === 'con' ? '反方' : '正方'}先手`,
        seats,
        scheduler: debateOrder(seats, { first: debateFirst }),
        stoppers: [byRounds(2), byBudget({ maxCalls: 40 })],
      }
    }

    default:
      throw new Error(`没有这个预设：${name}（可选：${PRESET_NAMES.join('、')}）`)
  }
}
