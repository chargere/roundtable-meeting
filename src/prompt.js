// 把"聊天记录"变成"下一次要发给模型的请求"。
//
// 假模型阶段这个文件看着没用（它不真的发请求），但它是接真模型时唯一不用改的地方之一。
// 更重要的：现在就能看见将来会发出去什么，尤其是"上下文压缩"那一段。

import { nameOf } from './text.js'

const POSITION_NAME = ['一辩', '二辩', '三辩', '四辩', '五辩']

/** 辩论模式里，这个人是谁、站哪边、这一轮该干什么。 */
function debateBlock(seat, hasDirective) {
  const sideName = seat.side === 'pro' ? '正方' : '反方'
  const pos = POSITION_NAME[seat.position - 1] ?? `第 ${seat.position} 位`

  const lines = [`你在这场辩论里是【${sideName}·${pos}】。`]
  if (seat.stanceText) lines.push(`本方立场（必须论证到底）：${seat.stanceText}`)

  lines.push('辩论规则：')
  lines.push('- 不许认同对方，不许说「双方都有道理」这种和事佬的话')
  lines.push('- 你必须发言，不许回「过」')

  // 主持人刚下过指令：辩位任务这一轮让位。
  // 两套指令同时在场，模型会服从先出现的那个（辩位），你的话就等于没说。
  if (hasDirective) {
    lines.push('- 这一轮按主持人的指令行事，下面的辩位任务暂停')
    return lines
  }

  if (seat.position === 1) lines.push('- 你是立论：先给定义和判断标准，再给两三条理由')
  if (seat.position === 2) lines.push('- 你是质询：抓对方一辩的一个具体说法，指出它错在哪，逼它回答')
  if (seat.position === 3) lines.push('- 你是总结：收束本方论点，指出对方到现在还没回答的那个问题')

  return lines
}

export function buildMessages(state, seat, { mustSpeak = false, brief = '' } = {}) {
  // 最新一条用户发言 = 主持人当场下的指令。
  // 以前它只是"最近六条"里的一行，排在辩位任务后面，模型就当他没说话。
  // 现在把它单独拎出来，并且明说优先级。
  const lastUserIndex = state.messages.map((m) => m.role).lastIndexOf('user')
  const recentWindow = lastUserIndex > 0 && lastUserIndex >= state.messages.length - 6
  const directive = recentWindow ? state.messages[lastUserIndex] : null

  const system = [
    `你是圆桌会议上的「${seat.name}」。`,
    seat.persona,
    ...(seat.side ? ['', ...debateBlock(seat, Boolean(directive))] : []),
    ...(directive
      ? ['', '【主持人的最新指令】它优先于上面给你的辩位任务：先照它做，再回到你的角色。']
      : []),
    '',
    '规则：',
    ...(seat.rules ?? []).map((r) => `- ${r}`),
    '- 只回应具体的人的具体说法，不要泛泛而谈',
    `- 一次不超过 ${seat.maxChars ?? 120} 字`,
    // "过"是沉默权。但开场不能沉默 —— 没人开口，这桌子就散了。
    mustSpeak
      ? '- 现在是你开口，议题还没有人表过态：正面给出你的看法，不许回「过」'
      : '- 没有新东西可说时，只输出一个「过」字，不要解释',
    // 有资料的时候，"过"还被借来当刹车：想说的东西不在资料里，就别硬说。
    brief
      ? '- 资料是这次讨论唯一的事实来源：资料里没有的数字和事实，不要编'
      : null,
    brief
      ? '- 想说的东西如果和议题、资料都无关，就回「过」，不要去聊别的'
      : null,
  ].filter(Boolean).join('\n')

  const parts = [`议题：${state.topic}`]

  if (directive) {
    parts.push('')
    // 别写"主持人刚刚说"—— 主持是那个 AI，这是人说的话。混淆了模型会当成第三方发言。
    parts.push('【你刚刚说】')
    parts.push(directive.text)
    parts.push('（先照这条做）')
    parts.push('')
  }

  // 主持 AI 这一轮的问题（由引擎在轮首写进 state）。只有问题，没有顺序。
  if (state.directive?.focus) {
    const d = state.directive
    const who = d.to === 'pro' ? '正方' : d.to === 'con' ? '反方' : '双方'
    parts.push('')
    parts.push('【主持人这一轮的问题】')
    parts.push(`${d.focus}（问${who}）`)
    if (d.angle) {
      parts.push('【主持人的观察】')
      parts.push(d.angle)
    }
    if (seat.side && d.to !== 'both') {
      parts.push(seat.side === d.to
        ? '这个问题是问你的：必须正面回答，不许绕开。'
        : '这个问题是问对方的：你可以借它进攻。')
    }
    parts.push('')
  }

  // 资料放在议题后面、纪要前面：先让人知道要谈什么，再给依据，最后才是别人说了什么。
  if (brief) {
    parts.push('')
    parts.push('【资料】')
    parts.push(brief)
    parts.push('（以上是这次讨论的全部依据）')
    parts.push('')
  }

  // 上下文压缩 —— 这是省钱的关键，也是自由轮能不能跑得动的关键。
  // 不喂全文，只喂三样：上一轮纪要、最近几条发言、你自己上一轮的原话。
  // 全文喂进去，第三轮的输入量会是第一轮的好几倍，而且越到后面越跑偏。
  if (state.summary) parts.push(`上一轮纪要：${state.summary}`)

  // 主持的话不进"最近发言"：它已经作为"这一轮的问题"单独喂了，重复一遍只会稀释它。
  // 你说的话也不进：要么是议题、要么已经单独放在上面了。
  const recent = state.messages
    .filter((m) => m.role !== 'pass' && m.role !== 'host' && m.role !== 'user')
    .slice(-6)
  if (recent.length) {
    parts.push('最近的发言：')
    for (const m of recent) parts.push(`${nameOf(state.seats, m)}：${m.text}`)
  }

  const mine = [...state.messages].reverse().find((m) => m.seatId === seat.id && m.role === 'model')
  if (mine) parts.push(`你上一轮说：${mine.text}`)

  parts.push(`现在轮到你（第 ${state.round} 轮）。`)

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ]
}
