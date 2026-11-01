// 模型列表自检：能不能从服务商那儿拿到"这个 key 能用的模型"。
//
//   node tools/check-models.js
//
// 只读，不花调用的钱（/models 通常不计费）。

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) process.exitCode = 1
}

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

const { members } = await (await fetch(BASE + '/api/members')).json()
const real = members.filter((m) => m.channel.provider !== 'mock' && m.channel.hasKey)

ok(real.length > 0, `有 ${real.length} 个配了 key 的真模型成员`)

for (const m of real) {
  const out = await post('/api/models', { member: m })
  if (out.ok) {
    const ids = out.models.map((x) => x.id)
    ok(ids.length > 0, `${m.name}（${m.channel.provider}）拿到 ${ids.length} 个：${ids.slice(0, 4).join(', ')}…`)
    ok(ids.includes(m.channel.model), `${m.name} 当前用的 ${m.channel.model} 在列表里`)
  } else {
    ok(false, `${m.name} 拉列表失败：${out.error}`)
  }
}

const mock = members.find((m) => m.channel.provider === 'mock')
if (mock) {
  const out = await post('/api/models', { member: mock })
  ok(out.ok === false, `假模型不参与选择：${out.error}`)
}

const badKey = {
  id: 'probe-bad', name: '坏 key', persona: '', rules: [],
  conformity: 0.3, passRate: 0.2, enabled: true,
  channel: { provider: 'deepseek', model: 'deepseek-flash', baseURL: '', apiKey: 'sk-invalid-probe' },
}
const bad = await post('/api/models', { member: badKey })
ok(bad.ok === false && /401|403|invalid/i.test(bad.error), `坏 key 会拿到服务商原文：${String(bad.error).slice(0, 60)}`)

console.log(process.exitCode ? '\n模型列表有问题' : '\n模型列表没问题')
