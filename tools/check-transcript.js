// 文稿导出自检：不开浏览器，点一次「文稿」，把导出的文本抠出来逐条对。
//
//   node tools/check-transcript.js
//
// 两种会都要过：辩论（有立场、有辩位）和普通会（只有名字）。
// 这两条的排版逻辑是分开的，只测一种等于没测。

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

// ---------------- 极简 DOM（同 check-frontend.js） ----------------

function parseIds(html) {
  const map = new Map()
  for (const m of String(html).matchAll(/id="([^"]+)"/g)) map.set(m[1], makeEl('input'))
  return map
}

function makeEl(tag = 'div') {
  return {
    tagName: tag,
    children: [],
    listeners: {},
    dataset: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, contains: () => false },
    _text: '',
    _html: '',
    _ids: new Map(),
    value: '',
    title: '',
    placeholder: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    get textContent() { return this._text },
    set textContent(v) { this._text = String(v) },
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); this._ids = parseIds(this._html) },
    append(...kids) { this.children.push(...kids) },
    appendChild(k) { this.children.push(k); return k },
    replaceChildren(...kids) { this.children = kids },
    remove() {},
    before() {},
    focus() {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
    async dispatch(type, extra = {}) {
      const ev = { type, target: this, preventDefault() {}, ...extra }
      const jobs = []
      if (type === 'click' && typeof this.onclick === 'function') jobs.push(this.onclick(ev))
      for (const fn of this.listeners[type] ?? []) jobs.push(fn(ev))
      await Promise.all(jobs)
    },
    click() { return this.dispatch('click') },
    querySelector(sel) { return sel.startsWith('#') ? this._ids.get(sel.slice(1)) ?? null : null },
    querySelectorAll() { return [] },
  }
}

let bad = 0
const ok = (cond, label) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`)
  if (!cond) bad++
}

const fs = await import('node:fs/promises')

/** 直接改会话文件塞消息 —— PUT 只收 brief/debate，塞消息走磁盘更快也更真。 */
async function seed(id, patch) {
  const file = `sessions/${id}.json`
  const s = JSON.parse(await fs.readFile(file, 'utf8'))
  Object.assign(s, patch)
  await fs.writeFile(file, JSON.stringify(s, null, 2), 'utf8')
}

async function createSession(title, put = {}) {
  const r = await (await fetch(BASE + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })).json()
  const id = r.session.id
  if (put.debate) {
    await fetch(`${BASE}/api/session/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ debate: put.debate }),
    })
  }
  return id
}

async function main() {
  const members = (await (await fetch(BASE + '/api/members')).json()).members
  const a = members[0]
  const b = members[1]
  const now = Date.now()

  // ---- 1. 普通会（自由轮）：没有辩论配置 ----
  const plainId = await createSession('自由轮自检')
  await seed(plainId, {
    preset: '自由轮',
    createdAt: now - 60_000,
    brief: { text: '这是一段背景资料，用来验证它会不会被写进稿子。' },
    stats: { round: 2 },
    messages: [
      { role: 'user', seatId: 'user', text: '自由轮自检', round: 0, ts: now },
      { role: 'model', seatId: a.id, text: '我先说两句。', round: 1, ts: now },
      { role: 'model', seatId: b.id, text: '我不同意。', round: 1, ts: now },
      { role: 'pass', seatId: b.id, text: '过', round: 2, ts: now },
      { role: 'model', seatId: a.id, text: '那我说完了。', round: 2, ts: now },
    ],
  })

  // ---- 2. 辩论会：有立场、有辩位 ----
  const debateId = await createSession('辩论自检', {
    debate: {
      proStance: '甲方立场',
      conStance: '乙方立场',
      first: 'pro',
      step: true,
      sides: { [a.id]: { side: 'pro', order: 1 }, [b.id]: { side: 'con', order: 2 } },
    },
  })
  await seed(debateId, {
    preset: '辩论',
    createdAt: now - 30_000,
    stats: { round: 2 },
    messages: [
      { role: 'user', seatId: 'user', text: '辩论自检', round: 0, ts: now },
      { role: 'host', seatId: 'host', text: '承接：开场。\n本轮问双方：为什么？', round: 1, ts: now },
      { role: 'model', seatId: a.id, text: '正方立论。\n第二行。', round: 1, ts: now },
      { role: 'model', seatId: b.id, text: '反方立论。', round: 1, ts: now },
      { role: 'model', seatId: a.id, text: '第二轮。', round: 2, ts: now },
    ],
  })

  // ---- 假 DOM ----
  const html = await fs.readFile('public/index.html', 'utf8')
  const ids = new Map()
  for (const m of html.matchAll(/id="([^"]+)"/g)) ids.set(m[1], makeEl('div'))

  globalThis.document = {
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    querySelector: (sel) => (sel.startsWith('#') ? ids.get(sel.slice(1)) ?? null : null),
    getElementById: (id) => ids.get(id) ?? null,
    addEventListener() {},
  }
  globalThis.window = { addEventListener() {} }
  globalThis.alert = (msg) => console.log(`  [alert] ${msg}`)

  let captured = null
  globalThis.URL.createObjectURL = (blob) => { captured = blob; return 'blob:fake' }
  globalThis.URL.revokeObjectURL = () => {}

  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => realFetch(
    typeof input === 'string' && input.startsWith('/') ? BASE + input : input,
    init,
  )

  await import(new URL('../public/app.js', import.meta.url).href)

  const list = ids.get('sessionList')
  for (let i = 0; i < 80 && list.children.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  ok(list.children.length >= 2, `会话列表渲染了 ${list.children.length} 项`)

  /** 点列表第 n 项、点「文稿」、把文本拿回来 */
  async function exportAt(n) {
    const item = list.children[n]?.children?.[0]
    if (!item) throw new Error(`列表里没有第 ${n} 项`)
    await item.dispatch('click')
    await new Promise((r) => setTimeout(r, 400))
    captured = null
    await ids.get('textBtn').dispatch('click')
    if (!captured) throw new Error('点了「文稿」没有生成文件')
    const bytes = new Uint8Array(await captured.arrayBuffer())
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const text = await captured.text()
    // Blob.text() 会按规范吃掉 BOM，所以要另看字节
    return { text, bom }
  }

  // 最新的在最上面：先辩论、后普通
  const d = await exportAt(0)
  ok(d.bom, '辩论稿：文件头是 EF BB BF')
  ok(d.text.includes('【议题】辩论自检'), '辩论稿：第一行是议题')
  ok(d.text.includes('【正方】甲方立场') && d.text.includes('【反方】乙方立场'), '辩论稿：双方立场')
  ok(/正方·一辩 .+：/.test(d.text), `辩论稿：辩位标签 ${(d.text.match(/正方·一辩 .+：/) ?? ['(没有)'])[0]}`)
  ok(/反方·二辩 .+：/.test(d.text), '辩论稿：反方序号也对')
  ok(d.text.includes('主持：'), '辩论稿：主持的发言也在')
  ok(d.text.includes('第 1 轮') && d.text.includes('第 2 轮'), '辩论稿：按轮分节')

  const p = await exportAt(1)
  ok(p.text.includes('【预设】自由轮'), '普通会：写了预设名')
  ok(!p.text.includes('【正方】'), '普通会：不硬写正反方')
  ok(!/正方·|反方·/.test(p.text), '普通会：不出现辩位')
  ok(/：\n/.test(p.text), '普通会：发言人都有名字')
  ok(p.text.includes('【背景资料】') && p.text.includes('背景资料，用来验证'), '普通会：背景资料带上了')
  ok(p.text.includes('【在场】'), '普通会：列了在场的人')
  ok(!p.text.includes('过\n'), '两种会："过"都不进稿子')
  ok(!/\{|\}|"role"/.test(p.text), '两种会：没有 json 残留')

  console.log('\n---------------- 普通会的稿子 ----------------')
  console.log(p.text)
  console.log('----------------------------------------------')

  await fetch(`${BASE}/api/session/${plainId}`, { method: 'DELETE' })
  await fetch(`${BASE}/api/trash/${plainId}`, { method: 'DELETE' })
  await fetch(`${BASE}/api/session/${debateId}`, { method: 'DELETE' })
  await fetch(`${BASE}/api/trash/${debateId}`, { method: 'DELETE' })
  console.log('\n（临时会话已删）')

  if (bad) {
    console.log(`\n有 ${bad} 条没过`)
    process.exitCode = 1
  } else {
    console.log('\n文稿导出没问题')
  }
}

await main()
