// 成本可见自检：拿一个假的 OpenAI 兼容服务端，真跑一轮，看账记没记对。
//
//   node tools/check-cost.js
//
// 为什么不用假模型测：假模型不吐 usage，测出来永远是 0，等于没测。
// 这里起一个本地小服务，回一个带 usage 的标准响应 —— 这是唯一能验证
// "token 从服务商一路走到页面上" 的办法。

import http from 'node:http'
import { readFile } from 'node:fs/promises'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'
const STUB_PORT = 4311

let bad = 0
const ok = (cond, label) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`)
  if (!cond) bad++
}

// ---------------- 假的模型服务端 ----------------

const stub = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'stub-1',
      object: 'chat.completion',
      model: 'stub-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '这是一段用来测账的回复。' }, finish_reason: 'stop' }],
      // 关键：这两个数字就是要被记下来的东西
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    }))
  })
})

await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))

const realFetch = globalThis.fetch
const api = (path, init) => realFetch(
  path.startsWith('http') ? path : BASE + path,
  init,
).then((r) => r.json())

const saved = (await api('/api/members')).members

async function main() {
  // ---- 1. 造一个指向假服务端的成员，填好单价 ----
  const stubMember = {
    id: 'cost-probe',
    name: '账房先生',
    persona: '你负责说话，别的不干。',
    rules: [],
    conformity: 0.3,
    passRate: 0,
    enabled: true,
    channel: {
      provider: 'custom',
      model: 'stub-model',
      baseURL: `http://127.0.0.1:${STUB_PORT}/v1`,
      apiKey: 'sk-stub',
      priceIn: 2,   // 元 / 百万 token
      priceOut: 8,
    },
  }
  const only = [...saved.filter((m) => m.id !== stubMember.id).map((m) => ({ ...m, enabled: false })), stubMember]
  await api('/api/members', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members: only }),
  })

  // ---- 2. 跑一轮 ----
  // 标题带时间戳：列表里可能还留着上一轮跑失败的同名会话，靠顺序找会找错人。
  const tag = `成本自检 ${Date.now()}`
  const c = await api('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: tag }),
  })
  const id = c.session.id

  const text = await realFetch(BASE + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id, topic: tag, preset: '正式会议', seed: 7, maxRounds: 1, perRound: 2 }),
  }).then((r) => r.text())

  const run = text.split('\n\n').filter(Boolean)
    .map((x) => JSON.parse(x.slice(6)))
    .find((e) => e.type === 'saved')

  const st = run?.session?.stats
  ok(Boolean(st), '这一趟跑完了，有 stats')
  ok(st.tokens?.in > 0 && st.tokens?.out > 0, `记下了 token：入 ${st.tokens?.in} 出 ${st.tokens?.out}`)
  ok(st.bySeat?.[stubMember.id]?.calls > 0, `按人记账：${stubMember.name} 调了 ${st.bySeat?.[stubMember.id]?.calls} 次`)
  ok(st.bySeat?.[stubMember.id]?.in === 120, '输入 token 对得上（120）')

  // ---- 3. 页面上真的显示出来了吗 ----
  const { makeEl, textOf, installDom } = await import('./_dom.js')
  const html = await readFile('public/index.html', 'utf8')
  const ids = new Map()
  for (const m of html.matchAll(/id="([^"]+)"/g)) ids.set(m[1], makeEl('div'))
  installDom(ids, { base: BASE })

  await import(new URL('../public/app.js', import.meta.url).href)

  const list = ids.get('sessionList')
  for (let i = 0; i < 80 && list.children.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }

  // 按标题找，不靠列表顺序 —— 列表里可能还留着别的会话
  const item = list.children.map((w) => w.children?.[0]).find((b) => textOf(b).includes(tag))
  ok(Boolean(item), `列表里找到了「${tag}」`)
  await item?.dispatch('click')
  await new Promise((r) => setTimeout(r, 400))

  const bar = ids.get('costbar')
  const line = String(bar.textContent ?? '')
  console.log(`\n页面上的成本条：${line || '(空)'}\n`)
  ok(line.includes('次调用'), '成本条写了调用次数')
  ok(/输入 [\d,]+/.test(line), '成本条写了输入 token')
  ok(line.includes('¥'), `成本条算出了钱（${(line.match(/¥[\d.]+/) ?? ['(没有)'])[0]}）`)
  ok(!line.includes('算不出钱'), '填了单价就不该说算不出钱')

  await api(`/api/session/${id}`, { method: 'DELETE' })
  await api(`/api/trash/${id}`, { method: 'DELETE' })
}

try {
  await main()
} finally {
  // 把成员恢复原样 —— 别把用户的成员表留在测试状态
  await api('/api/members', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members: saved }),
  }).catch(() => {})
  stub.close()
  console.log('（成员已恢复原样）')
}

if (bad) {
  console.log(`\n有 ${bad} 条没过`)
  process.exitCode = 1
} else {
  console.log('\n成本记账没问题')
}
