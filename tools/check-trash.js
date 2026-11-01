// 回收站自检：删了能捞、捞回来还在、彻底删才真没了。
//
//   node tools/check-trash.js
//
// 全程用临时会话，不碰你正在聊的那些。

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) process.exitCode = 1
}

const j = async (path, opts) => {
  const res = await fetch(BASE + path, opts)
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

const listTrash = async () => (await j('/api/trash')).data.items
const listSessions = async () => (await j('/api/sessions')).data.sessions

// ---------- 造一个 ----------
const created = await j('/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '回收站自检' }),
})
const id = created.data.session.id
ok(Boolean(id), `建了一场临时会话：${id}`)

const sessionsBefore = (await listSessions()).length

// ---------- 删 → 应该进回收站，不是消失 ----------
{
  const { status } = await j(`/api/session/${id}`, { method: 'DELETE' })
  ok(status === 200, 'DELETE 返回 200')

  const stillThere = (await listSessions()).some((s) => s.id === id)
  ok(!stillThere, '会话列表里没有了')

  const inTrash = (await listTrash()).some((t) => t.id === id)
  ok(inTrash, '回收站里能找到它')

  ok((await listSessions()).length === sessionsBefore - 1, `会话数 ${sessionsBefore} → ${sessionsBefore - 1}`)
}

// ---------- 恢复 ----------
{
  const { status } = await j(`/api/trash/${id}/restore`, { method: 'POST' })
  ok(status === 200, '恢复返回 200')

  const back = (await listSessions()).some((s) => s.id === id)
  ok(back, '回到会话列表了')

  const stillInTrash = (await listTrash()).some((t) => t.id === id)
  ok(!stillInTrash, '回收站里不再有它')
}

// ---------- 再删一次，这次彻底删 ----------
{
  await j(`/api/session/${id}`, { method: 'DELETE' })
  ok((await listTrash()).some((t) => t.id === id), '又进回收站了')

  const { status } = await j(`/api/trash/${id}`, { method: 'DELETE' })
  ok(status === 200, '彻底删返回 200')
  ok(!(await listTrash()).some((t) => t.id === id), '回收站里也没有了')
}

// ---------- 不存在的 id ----------
{
  const { status } = await j('/api/trash/nope-1234/restore', { method: 'POST' })
  ok(status === 404, `恢复一个不存在的 → ${status}`)
}

console.log(process.exitCode ? '\n回收站有问题' : '\n回收站没问题')
