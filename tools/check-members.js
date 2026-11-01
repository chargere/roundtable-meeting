// 成员表自检：改人设、存 key、不把 key 漏给页面。
//
//   node tools/check-members.js
//
// 会临时改第一个成员的名字 / 人设 / key，跑完再改回去。

import { readFile } from 'node:fs/promises'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'
const FILE = 'data/members.json'

const get = async (p) => (await fetch(BASE + p)).json()
const put = async (p, body) => {
  const res = await fetch(BASE + p, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || res.status)
  return data
}

const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) process.exitCode = 1
}

const { members } = await get('/api/config')
const target = members[0]
const original = { name: target.name, persona: target.persona }

// 1. 改名字 + 人设 + 存一把 key
const next = members.map((m) => (m.id === target.id
  ? {
    ...m,
    name: '测试改名',
    persona: '你是一台测试用的机器。',
    channel: { ...m.channel, provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-test-00001234' },
  }
  : m))

const saved = await put('/api/members', { members: next })
const after = saved.members.find((m) => m.id === target.id)

ok(after.name === '测试改名', `名字改掉了：${after.name}`)
ok(after.channel.provider === 'deepseek' && after.channel.model === 'deepseek-chat', '渠道存住了')
ok(after.channel.hasKey === true, 'hasKey = true')
ok(after.channel.keyHint === '····1234', `只给后四位：${after.channel.keyHint}`)
ok(after.channel.apiKey === undefined, 'PUT 的返回里没有明文 key')

// 2. 磁盘上确实存了
const disk = JSON.parse(await readFile(FILE, 'utf8'))
const onDisk = disk.find((m) => m.id === target.id)
ok(onDisk.channel.apiKey === 'sk-test-00001234', 'data/members.json 里有完整 key（本地文件，已 gitignore）')

// 3. 改过的人设真的会进 prompt —— 跑一轮，翻日志里发出去的那段 system
await fetch(BASE + '/api/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ topic: '成员表自检', preset: '正式会议', seed: 7 }),
}).then((r) => r.text())

const { readdir } = await import('node:fs/promises')
const logs = (await readdir('out/logs')).filter((f) => f.endsWith('.jsonl'))
// 按文件名里的时间戳排，不能按文件名排 —— 中文预设名的码点顺序和时间顺序不是一回事。
const newest = logs
  .map((f) => ({ f, t: f.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)/)?.[1] ?? '' }))
  .sort((a, b) => a.t.localeCompare(b.t))
  .at(-1)
const latest = await readFile(`out/logs/${newest.f}`, 'utf8')
ok(latest.includes('测试改名'), '新名字出现在发出去的 system prompt 里')
ok(latest.includes('你是一台测试用的机器。'), '新的人设也进去了')

// 3. 只改人设、不传 key，key 不能被抹掉
const again = saved.members.map((m) => (m.id === target.id
  ? { ...m, persona: '你又改了一次设定，但没碰 key。' }
  : m))
await put('/api/members', { members: again })
const kept = JSON.parse(await readFile(FILE, 'utf8')).find((m) => m.id === target.id)
ok(kept.channel.apiKey === 'sk-test-00001234', '不传 apiKey 时，旧 key 保留')

// 4. 传空字符串才是「清除」
const clear = saved.members.map((m) => (m.id === target.id
  ? { ...m, channel: { ...m.channel, apiKey: '' } }
  : m))
await put('/api/members', { members: clear })
const cleared = JSON.parse(await readFile(FILE, 'utf8')).find((m) => m.id === target.id)
ok(cleared.channel.apiKey === '', '传空字符串可以清掉 key')

// 5. 还原
const restore = (await get('/api/config')).members.map((m) => (m.id === target.id
  ? { ...m, name: original.name, persona: original.persona, channel: { ...m.channel, provider: 'mock', model: '' } }
  : m))
await put('/api/members', { members: restore })
const final = (await get('/api/config')).members.find((m) => m.id === target.id)
ok(final.name === original.name, `已还原：${final.name}`)

console.log(process.exitCode ? '\n有问题' : '\n成员表没问题')
