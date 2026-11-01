// 端到端自检：不开浏览器，也能确认服务端是对的。
//
//   node tools/smoke.js
//
// 干四件事：读配置 → 跑一轮（流式）→ 导入一份旧记录 → 看会话列表。

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function getJson(path) {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json()
}

async function main() {
  const config = await getJson('/api/config')
  console.log(`配置：${config.members.length} 个成员，预设 ${config.presets.join(' / ')}`)
  console.log('成员：' + config.members.map((m) => `${m.name}(${m.channel.provider})`).join(' / '))
  console.log('key 会不会漏给页面：' + (config.members.some((m) => m.channel.apiKey) ? '漏了！' : '没有（只有 hasKey）'))

  // ---- 跑一轮，边收边数 ----
  const res = await fetch(BASE + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: '自检：这件事值不值得做？', preset: '茶话会', seed: 7 }),
  })
  if (!res.ok) throw new Error(`/api/run → ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const count = {}
  let saved = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const line = chunk.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      const e = JSON.parse(line.slice(6))
      count[e.type] = (count[e.type] ?? 0) + 1
      if (e.type === 'saved') saved = e.session
    }
  }

  console.log('事件统计：', count)
  if (!saved) throw new Error('没有收到 saved 事件')
  console.log(`已保存会话：${saved.id} · ${saved.messages.length} 条 · 停止：${saved.stats?.stopReason}`)

  // ---- 导入一份 markdown 记录 ----
  const md = await (await fetch(BASE + '/style.css')).text() // 占位，确保静态服务正常
  console.log(`静态资源：style.css ${md.length} 字节`)

  const fs = await import('node:fs/promises')
  const raw = await fs.readFile('out/茶话会-seed7.md', 'utf8')
  const imported = await postJson('/api/import', { filename: '茶话会-seed7.md', content: raw })
  console.log(`导入：${imported.session.messages.length} 条，标题「${imported.session.title}」`)

  // ---- 列表 ----
  const { sessions } = await getJson('/api/sessions')
  console.log(`会话列表：${sessions.length} 个`)
  for (const s of sessions.slice(0, 4)) {
    console.log(`  ${s.id}  ${s.messageCount} 条  ${s.title}`)
  }
}

main().catch((err) => {
  console.error('自检失败：', err.message)
  process.exit(1)
})
