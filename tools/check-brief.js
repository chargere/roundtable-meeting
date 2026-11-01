// 资料库自检：存得住、带得进 prompt、清得掉。
//
//   node tools/check-brief.js
//
// 用假模型跑，几秒钟，不花钱。

import { readdirSync, readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) process.exitCode = 1
}

const get = async (p) => (await fetch(BASE + p)).json()

const putJson = async (p, body) => {
  const res = await fetch(BASE + p, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

const BRIEF = [
  '【自检资料】',
  '1. 这个项目是本地单机工具，不联网、不要账号。',
  '2. 每月 API 预算上限 300 元。',
  '3. 只有两个成员参会。',
].join('\n')

const newestLog = () => {
  const files = readdirSync('out/logs').filter((f) => f.endsWith('.jsonl'))
  const newest = files
    .map((f) => ({ f, t: (f.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)/) ?? [])[1] ?? '' }))
    .sort((a, b) => a.t.localeCompare(b.t))
    .at(-1)
  return readFileSync(`out/logs/${newest.f}`, 'utf8')
}

// ---------- 用一场临时会话，别弄脏你真在用的 ----------
const created = await (await fetch(BASE + '/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '资料库自检（跑完自动删）' }),
})).json()
const id = created.session.id
const original = ''

// ---------- 1. 存 ----------
{
  const { status, data } = await putJson(`/api/session/${id}`, { brief: BRIEF })
  ok(status === 200 && data.session.brief.text === BRIEF, `资料存住了（${BRIEF.length} 字）`)

  const reread = (await get(`/api/session/${id}`)).session
  ok(reread.brief.text === BRIEF, '从磁盘读回来还在')
}

// ---------- 2. 真的进了 prompt ----------
{
  await fetch(BASE + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id, topic: '预算该怎么花？', preset: '茶话会', seed: 7, maxRounds: 1, perRound: 1 }),
  }).then((r) => r.text())

  const log = newestLog()
  ok(log.includes('【资料】'), 'prompt 里有【资料】这一段')
  ok(log.includes('每月 API 预算上限 300 元'), '资料正文原样带进去了')
  ok(log.includes('资料是这次讨论唯一的事实来源'), 'system 里带了"不许编资料外的事实"')
  ok(log.includes('和议题、资料都无关，就回「过」'), 'system 里带了"跑题就过"')
}

// ---------- 3. 清空 ----------
{
  const { data } = await putJson(`/api/session/${id}`, { brief: '' })
  ok(data.session.brief.text === '', '清得掉')
}

// ---------- 4. 还原 ----------
{
  await putJson(`/api/session/${id}`, { brief: original })
  console.log('（临时会话用完，删掉）')
  await fetch(`${BASE}/api/session/${id}`, { method: 'DELETE' })
}

console.log(process.exitCode ? '\n资料库有问题' : '\n资料库没问题')
