// 假模型。
//
// 它不联网、不花钱、完全按规则吐出句子。目的不是"像真模型"，
// 而是把引擎的每一种情况（沉默、附和、挑刺、冷场、收敛）都逼出来，
// 让你在没有账单的情况下先把四根轨的脾气摸清。
//
// 接真模型时：这个文件整个换掉，引擎一行不用改。

import { chance, pickOne } from './rng.js'
import { nameOf } from './text.js'

// 每个座位两套台词：附和用的（agree）和输出新论据用的（fresh）。
// 台词写成"对任何议题都成立"，所以换议题不用改代码。
const LINES = {
  optimist: {
    fresh: [
      '能做。第一步不用花钱：先拉两个人手动跑一遍，看会不会真的吵起来。',
      '机会在这：这件事最缺的不是工具，是有人愿意认真跑三十次。',
      '别急着算总账。先做三天，能出一份像样的对比就已经值了。',
      '我押能做。失败成本很低，最多浪费两个周末。',
    ],
    agree: [
      '前面说的我认，加一条：先小范围试，别一上来就铺满。',
      '顺着刚才那句往下推：既然成本不高，那就先跑一遍再说。',
    ],
  },
  critic: {
    fresh: [
      '等一下，这套说法有个漏洞：谁来判断「吵得好」？没标准就只是热闹。',
      '你说的前提不成立。模型会互相附和，这不是调度能解决的。',
      '我挑一个最要命的：这件事没有验收口径，做完了也证明不了有用。',
      '反驳一下：如果五个模型最后说的是同一句话，你打算怎么办？',
    ],
    agree: [
      '行，这条我挑不出毛病。',
      '这个我暂时不反驳。',
    ],
  },
  accountant: {
    fresh: [
      '成本拆三块：接口调用、调试时间、你的注意力。第三块最贵。',
      '按最小规模算，量级是「一顿饭到一件外套」，不致命。',
      '被漏掉的是维护。换一家接口就重写一次适配，这活儿不轻。',
      '时间账：你说两周，实际通常乘二，申请接口还要等。',
    ],
    agree: [
      '钱不是问题，这条我同意。问题在时间。',
      '预算我算过了，能接受。',
    ],
  },
  opposition: {
    fresh: [
      '我站反方。如果这事真有价值，早该有人做了，为什么没成？',
      '反例在这：一个人拿三个角色自问自答，效果未必差，成本只有五分之一。',
      '我论证反面：多模型的前提是「模型真的不同」，可现在的模型越来越像。',
      '反过来看，你要的可能是「有人陪你想」，不是「五个模型吵架」。',
    ],
    agree: [
      '这个我反驳不了，但我不改立场。',
      '行，这条算你对。',
    ],
  },
  narrower: {
    fresh: [
      '先别谈值不值。下周能验证的一件事：同一个问题跑三种模式，看有没有差别。',
      '把范围收到最小：三个模型、两轮、一个问题。跑完再决定加不加人。',
      '先定一个「这就算成」的标准，否则做完了也说不清。',
      '别加功能。先让一轮对话跑通，能读就行。',
    ],
    agree: [
      '这个动作我改成更小的版本：今晚就能跑一次。',
      '同意方向，但先做一半。',
    ],
  },
}

/**
 * 附和：抓一条前面说过的话，套个壳再重复一遍。
 *
 * 这就是真模型在第三四轮的标准动作 ——「我同意 X 的说法」然后换句话复述。
 * 故意让它长得像重复，因为收敛检测靠的正是"这条有没有带来新词"。
 */
function echo(seat, state, rng) {
  const prior = state.messages.filter((m) => m.role === 'model' && m.seatId !== seat.id)
  if (!prior.length) return '前面说的我都同意，没什么要补的。'
  const target = prior.at(-1) // 复读最近那条，最像真的
  // 复读一条"已经在复读"的消息时，会把上一层的括号和省略号一起抄进来，
  // 于是出现「…」…」这种嵌套。所以切片之前先把壳剥干净。
  const head = target.text
    .replace(/^（回应[^）]*）/, '')
    .replace(/[「」『』]/g, '')
    .replace(/…+/g, '')
    .replace(/\s+/g, '')
    .slice(0, 20)
  const tail = pickOne(rng, ['这句我认。', '我这边结论一样。', '没什么可加的。'])
  return `（回应${nameOf(state.seats, target)}）「${head}…」${tail}`
}

export function createMockSpeaker({ rng }) {
  // 记住每个座位说过的句子，用完一轮再重置 —— 免得同一个座位上句下句一模一样。
  const used = new Map()
  const draw = (seat, pool) => {
    let seen = used.get(seat.id)
    if (!seen) { seen = new Set(); used.set(seat.id, seen) }
    let cands = pool.filter((line) => !seen.has(line))
    if (!cands.length) { seen.clear(); cands = pool }
    const line = pickOne(rng, cands)
    seen.add(line)
    return line
  }

  return {
    /**
     * 说一句话，或者说「过」。
     * 真模型版本这里就是：拼请求 → fetch → 取文本 → 判断是不是「过」。
     */
    async speak({ seat, state, mustSpeak = false }) {
      // 1. 沉默权。passRate=0 就是"必说"，0.8 就是"基本不说话"。
      //    但开场那一位不许过 —— 没人开口，这桌子就散了。
      if (!mustSpeak && chance(rng, seat.passRate ?? 0)) {
        return { pass: true, reason: '没有新东西可说' }
      }

      const pool = LINES[seat.id] ?? LINES.optimist
      const others = state.messages.filter((m) => m.role === 'model' && m.seatId !== seat.id)
      const last = others.at(-1)

      // 2. 复读倾向随轮次上升。
      //
      // 这一步是故意写歪的，但它写的是真事：真模型聊到第三四轮就开始说
      // "我同意前面那位"然后换句话重复一遍。不把这个行为放进假模型，
      // 收敛检测就永远测不出来 —— 你会以为刹车装好了，其实没有。
      const repeatBias = seat.conformity < 0.2
        ? seat.conformity // 挑刺者、反方：人设就是永远不附和
        : Math.min(0.85, seat.conformity + (state.round - 1) * 0.18)

      let text
      if (last && chance(rng, repeatBias)) {
        text = echo(seat, state, rng)
      } else {
        // 偶尔说一句纯附和的短句（池子只有两三句，说第二遍时它就成了"重复"）
        const poolUse = chance(rng, 0.15) ? pool.agree : pool.fresh
        text = draw(seat, poolUse)
      }

      // 3. 偶尔点名回应，让"模型真的看见了彼此"这件事在文字上留下证据。
      if (last && chance(rng, 0.45) && !text.startsWith('（回应')) {
        text = `（回应${nameOf(state.seats, last)}）${text}`
      }

      return { text }
    },
  }
}
