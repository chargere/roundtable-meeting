// 主持 AI：每轮开头由它决定"这一轮怎么打"。
//
// 为什么要它：人当主持人太累。每轮都要判断"该让谁先说、这一轮该逼他们回答什么"，
// 这不是机械劳动，是注意力消耗。交给另一个模型，你只负责看和不看。
//
// 它只输出两样东西：先手、一句要求。不写总结、不表立场 ——
// 位置一多，主持就会开始替辩手说话。

const ROLE = [
  '你是这场辩论的主持人。你不是报时员，是主编。',
  '',
  '你的价值只有一件事：听出哪句话背后还有东西没被挖出来，然后把下一轮推到那里。',
  '机械地"挑一个没被回答的说法"没有意义 —— 那种东西辩手自己会补。你要找的是',
  '双方都没点破、但一旦点破整场就会变的那件事。',
  '',
  '每轮你输出四样：',
  '1. recap：承接。一句话说清刚才发生了什么（不超过 30 字）。只讲态势，不讲谁赢。',
  '2. angle：发现。一句话指出最有张力的那一处（不超过 40 字）。',
  '   —— 可以是两人偷偷共用了一个没验证的前提，可以是某句话自己打自己，',
  '      也可以是某句看似退让的话其实留了后门。要具体，指着某句话。',
  '3. focus：启下。下一轮要问的问题（不超过 40 字）。必须由 angle 长出来。',
  '4. first / to：谁先开口、这个问题砸给谁（to = pro / con / both）。',
  '',
  '禁止：评谁占上风、给结论、总结双方观点、说"请深入讨论"这种废话。',
  '禁止：把 first（谁先开口）写进任何一句正文里 —— 那是机器的活，写进来辩手会读歪。',
  '',
  '只输出一行 JSON，别的话一个字都不要：',
  '{"first":"con","to":"pro","recap":"两人都承认成本不对称，但没人解释它为什么不算缺点。",',
  ' "angle":"正方把「辨识度」当收益，却绕开了「被标签化之后还算不算表达」。",',
  ' "focus":"被简化成固定形象，还算表达空间吗"}',
].join('\n')

function nameOf(seats, m) {
  if (m.role === 'user') return '主持人（你）'
  if (m.role === 'host') return '主持人'
  return seats.find((s) => s.id === m.seatId)?.name ?? m.seatId
}

export function buildDirectorPrompt(state, session) {
  const d = session.debate ?? {}
  const recent = state.messages.filter((m) => m.role === 'model').slice(-4)

  const lines = [
    `辩题：${state.topic}`,
    d.proStance ? `正方立场：${d.proStance}` : '',
    d.conStance ? `反方立场：${d.conStance}` : '',
    '',
    `现在是第 ${state.round} 轮。`,
  ].filter(Boolean)

  if (recent.length) {
    lines.push('', '刚才的发言：')
    for (const m of recent) lines.push(`${nameOf(state.seats, m)}：${m.text.slice(0, 140)}`)
  } else {
    lines.push('', '这是开场，还没有人发言。')
  }

  lines.push('', '按格式给出这一轮的决定。')

  return [
    { role: 'system', content: ROLE },
    { role: 'user', content: lines.join('\n') },
  ]
}

/** 从模型回复里抠出 { first, to, recap, angle, focus }。模型经常不老实只给 JSON，所以尽量宽容。 */
export function parseDirector(text) {
  const raw = String(text ?? '').trim()
  const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim()

  let first = null
  let to = 'both'
  let recap = ''
  let angle = ''
  let focus = ''

  // 1. 理想情况：整段就是 JSON
  try {
    const j = JSON.parse(clean)
    if (j.first === 'pro' || j.first === 'con') first = j.first
    if (j.to === 'pro' || j.to === 'con' || j.to === 'both') to = j.to
    recap = String(j.recap ?? '').trim()
    angle = String(j.angle ?? '').trim()
    focus = String(j.focus ?? j.directive ?? '').trim()
  } catch { /* 不是纯 JSON，往下走 */ }

  // 2. 混着别的话：按字段抠
  const grab = (key) => {
    const m = clean.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))
    return m ? m[1].trim() : ''
  }
  if (!first) {
    const m = clean.match(/"first"\s*:\s*"(pro|con)"/)
    if (m) first = m[1]
  }
  if (!recap) recap = grab('recap')
  if (!angle) angle = grab('angle')
  if (!focus) focus = grab('focus') || grab('directive')

  // 3. 连 JSON 都不是：整段当问题用，先手不动
  if (!focus && clean && clean.length <= 120 && !clean.includes('{')) {
    focus = clean.replace(/\s+/g, ' ')
  }

  // 兜底：模型有时候会把"反方先"写进正文。那句话属于 first，不属于内容。
  const strip = (s) => s
    .replace(/^(这一轮)?(正方|反方)先[开口说，。、]*/g, '')
    .replace(/^请?(正方|反方)(先)?(回答|说)[：:，,]*/g, '')
    .trim()

  return {
    first,
    to,
    recap: strip(recap),
    angle: strip(angle),
    focus: strip(focus),
  }
}
