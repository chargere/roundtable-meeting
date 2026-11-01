// 辩论模式自检：分配生效、顺序对、立场进了 prompt。
//
//   node tools/check-debate.js
//
// 用假模型跑，不花钱；跑完把临时会话删掉。

import { readdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) process.exitCode = 1
}

const j = async (path, opts) => {
  const res = await fetch(BASE + path, opts)
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

const newestLog = () => {
  const files = readdirSync('out/logs').filter((f) => f.endsWith('.jsonl'))
  const newest = files
    .map((f) => ({ f, t: (f.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)/) ?? [])[1] ?? '' }))
    .sort((a, b) => a.t.localeCompare(b.t))
    .at(-1)
  return readFileSync(`out/logs/${newest.f}`, 'utf8')
}

// ---------- 准备 ----------
const { members } = (await j('/api/members')).data
const [pro1, con1, pro2] = members
ok(Boolean(pro1 && con1 && pro2), '至少有三个成员可用')

const created = await j('/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '辩论自检' }),
})
const id = created.data.session.id

// ---------- 分配 ----------
const sides = {
  [pro1.id]: { side: 'pro', order: 1 },
  [con1.id]: { side: 'con', order: 1 },
  [pro2.id]: { side: 'pro', order: 2 },
}
const put = await j(`/api/session/${id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    debate: { proStance: '应当做这个项目', conStance: '不应当做这个项目', sides },
  }),
})
ok(put.status === 200, '辩论配置存住了')
ok(Object.keys(put.data.session.debate.sides).length === 3, '三个人的阵营都存下来了')

// ---------- 跑一轮 ----------
await fetch(BASE + '/api/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: id, topic: '这个项目该不该做？', preset: '辩论', seed: 7, maxRounds: 1 }),
}).then((r) => r.text())

const calls = newestLog()
  .trim().split('\n').map((l) => JSON.parse(l))
  .filter((x) => x.kind === 'call')

const order = calls.map((c) => c.seat)
ok(order[0] === pro1.id, `第一个是正方一辩（${order[0]}）`)
ok(order[1] === con1.id, `第二个是反方一辩（${order[1]}）`)
ok(order[2] === pro2.id, `第三个是正方二辩（${order[2]}）`)

const firstPrompt = calls[0]?.prompt?.[0]?.content ?? ''
ok(firstPrompt.includes('正方·一辩'), 'prompt 里写清了"正方·一辩"')
ok(firstPrompt.includes('应当做这个项目'), '正方立场进了 prompt')
ok(firstPrompt.includes('不许认同对方'), '带了"不许认同对方"的禁令')

const conPrompt = calls[1]?.prompt?.[0]?.content ?? ''
ok(conPrompt.includes('反方·一辩'), '反方的 prompt 里是"反方·一辩"')
ok(conPrompt.includes('不应当做这个项目'), '反方立场进了 prompt')

// ---------- 先手换成反方 + 用户指令优先 ----------
{
  await j(`/api/session/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      debate: { proStance: '应当做这个项目', conStance: '不应当做这个项目', first: 'con', sides },
    }),
  })

  const INSTRUCTION = '进入攻守环节，请反方先进攻，正方逐条回复'
  await fetch(BASE + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id, topic: INSTRUCTION, preset: '辩论', seed: 7, maxRounds: 1 }),
  }).then((r) => r.text())

  const calls2 = newestLog()
    .trim().split('\n').map((l) => JSON.parse(l))
    .filter((x) => x.kind === 'call')

  ok(calls2[0]?.seat === con1.id, `反方先手了（第一个是 ${calls2[0]?.seat}）`)
  ok(calls2[1]?.seat === pro1.id, `第二个是正方（${calls2[1]?.seat}）`)

  const prompt = calls2[0]?.prompt ?? []
  const sys = prompt[0]?.content ?? ''
  const user = prompt[1]?.content ?? ''
  ok(sys.includes('主持人的最新指令'), 'system 里说明了指令优先')
  ok(user.includes('【你刚刚说】'), '用户刚说的话被单独拎出来了')
  ok(user.includes(INSTRUCTION), '指令原文在里面')
}


// ---------- 逐轮确认：每轮走完就停 ----------
{
  await j(`/api/session/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      debate: { proStance: '应当做', conStance: '不应当做', first: 'pro', step: true, sides },
    }),
  })

  const before = (await j(`/api/session/${id}`)).data.session.messages.length

  const txt = await fetch(BASE + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 要 5 轮就该跑 5 轮 —— 勾选框只管"跑完之后问不问"，不该砍掉轮数
    body: JSON.stringify({ sessionId: id, topic: '第一轮开始', preset: '辩论', seed: 7, maxRounds: 5 }),
  }).then((r) => r.text())

  const saved = txt.split('\n\n').filter(Boolean)
    .map((x) => JSON.parse(x.slice(6)))
    .find((e) => e.type === 'saved')

  ok(saved?.session?.stats?.step === true, '会话记下了"跑完停下问一句"')
  const added = saved.session.messages.length - before
  ok(added > 4, `要 5 轮就连跑 5 轮（新增 ${added} 条）`)
  ok(/5 轮/.test(saved.session.stats.stopReason), `停止原因：${saved.session.stats.stopReason}`)
}

// ---------- 主持 AI：每轮开头它说话 ----------
{
  await j(`/api/session/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      debate: { proStance: '应当做', conStance: '不应当做', first: 'pro', step: false, hostId: pro2.id, sides },
    }),
  })

  const txt = await fetch(BASE + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id, topic: '主持自检', preset: '辩论', seed: 7, maxRounds: 2 }),
  }).then((r) => r.text())

  const saved = txt.split('\n\n').filter(Boolean)
    .map((x) => JSON.parse(x.slice(6)))
    .find((e) => e.type === 'saved')

  const hostMsgs = saved.session.messages.filter((m) => m.role === 'host')
  ok(hostMsgs.length >= 2, `两轮各有一次主持发言（共 ${hostMsgs.length} 条）`)
  ok(hostMsgs.every((m) => !m.text.startsWith('（主持）')), '主持的话没有重复加"（主持）"前缀')
  ok(hostMsgs.every((m) => !/先开口|方先[，。]/.test(m.text)), '正文里不夹"谁先开口"（那是控制信息）')
  ok(hostMsgs.every((m) => m.text.includes('本轮问')), '正文里有"本轮问谁：问题"')

  const calls3 = newestLog()
    .trim().split('\n').map((l) => JSON.parse(l))
    .filter((x) => x.kind === 'call')
  const withDirective = calls3.filter((c) => JSON.stringify(c.prompt).includes('主持人这一轮的问题'))
  ok(withDirective.length >= 2, `辩手的 prompt 里带上了主持人的问题（${withDirective.length} 次）`)
}

// ---------- 主持的输出解析（不花调用，纯逻辑） ----------
{
  const { parseDirector } = await import('../src/director.js')

  const full = parseDirector('```json\n{"first":"con","to":"pro","recap":"两人都承认成本不对称。","angle":"正方把辨识度当收益，却绕开了被标签化。","focus":"被简化成固定形象，还算表达空间吗"}\n```')
  ok(full.first === 'con' && full.to === 'pro', '解析出 先手 和 问谁')
  ok(full.recap.includes('成本'), `承接：${full.recap}`)
  ok(full.angle.includes('标签化'), `发现：${full.angle}`)
  ok(full.focus.includes('表达空间'), `启下：${full.focus}`)

  // 模型不老实，把"反方先"写进正文 —— 得剥掉，不然又会读歪
  const messy = parseDirector('这一轮反方先，请正方回答：凭什么成本高还更好')
  ok(!messy.focus.includes('反方先'), `剥掉顺序后的正文：${messy.focus}`)

  // 完全不是 JSON：整段当问题，不崩
  const plain = parseDirector('凭什么成本高还更好')
  ok(plain.focus === '凭什么成本高还更好', '不是 JSON 也能兜住')
}

// ---------- 老会话（配置里没有 step 字段）也按"逐轮确认"跑 ----------
{
  await j(`/api/session/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // 故意不传 step —— 模拟升级前存下来的配置
      debate: { proStance: '应当做', conStance: '不应当做', first: 'pro', sides },
    }),
  })

  const cfg = (await j(`/api/session/${id}`)).data.session
  ok(cfg.debate.step === true, '存的时候补上了 step: true（默认开）')

  const before = cfg.messages.length
  const txt = await fetch(BASE + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id, topic: '老配置自检', preset: '辩论', seed: 7, maxRounds: 5 }),
  }).then((r) => r.text())

  const saved = txt.split('\n\n').filter(Boolean)
    .map((x) => JSON.parse(x.slice(6)))
    .find((e) => e.type === 'saved')

  ok(saved?.session?.stats?.step === true, '跑起来也认作"跑完停下问一句"')
  ok(saved.session.messages.length - before > 4, `要 5 轮就跑 5 轮（新增 ${saved.session.messages.length - before} 条）`)
}

await j(`/api/session/${id}`, { method: 'DELETE' })
await j(`/api/trash/${id}`, { method: 'DELETE' })
console.log('（临时会话已删）')

console.log(process.exitCode ? '\n辩论模式有问题' : '\n辩论模式没问题')
