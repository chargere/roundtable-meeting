// 辩论稿导出自检：不开浏览器，点一次「辩论稿」，把导出的文本抠出来看。
//
//   node tools/check-transcript.js
//
// 为什么值得单独测：这个功能的价值全在"排版对不对"，
// 而排版错了浏览器里只会安静地下载一个坏文件 —— 不点开根本发现不了。

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

const ok = (cond, label) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`)
  if (!cond) process.exitCode = 1
}

async function main() {
  // ---- 先造一场有主持、有辩位、有"过"的辩论 ----
  const created = await (await fetch(BASE + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '辩论稿自检' }),
  })).json()
  const id = created.session.id

  const members = (await (await fetch(BASE + '/api/members')).json()).members
  const a = members[0]
  const b = members[1]

  await fetch(`${BASE}/api/session/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      debate: {
        proStance: '甲方立场',
        conStance: '乙方立场',
        first: 'pro',
        step: true,
        sides: { [a.id]: { side: 'pro', order: 1 }, [b.id]: { side: 'con', order: 2 } },
      },
    }),
  })

  // 直接改会话文件塞消息 —— PUT 只收 brief/debate，塞 messages 更方便直接写盘。
  // 不花钱跑模型，测的是排版不是模型。
  const fs = await import('node:fs/promises')
  const file = `sessions/${id}.json`
  const s = JSON.parse(await fs.readFile(file, 'utf8'))
  s.messages = [
    { role: 'user', text: '辩论稿自检', round: 0, at: Date.now() },
    { role: 'host', seatId: 'host', text: '承接：开场。\n本轮问双方：为什么？', round: 1, at: Date.now() },
    { role: 'model', seatId: a.id, text: '正方立论。\n第二行。', round: 1, at: Date.now() },
    { role: 'model', seatId: b.id, text: '反方立论。', round: 1, at: Date.now() },
    { role: 'pass', seatId: b.id, text: '过', round: 2, at: Date.now() },
    { role: 'model', seatId: a.id, text: '第二轮。', round: 2, at: Date.now() },
  ]
  s.stats = { ...(s.stats ?? {}), round: 2 }
  await fs.writeFile(file, JSON.stringify(s, null, 2), 'utf8')

  // ---- 假 DOM ----
  const { readFile } = await import('node:fs/promises')
  const html = await readFile('public/index.html', 'utf8')
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

  // 等会话列表渲染出来
  const list = ids.get('sessionList')
  for (let i = 0; i < 80 && list.children.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  ok(list.children.length > 0, `会话列表渲染了 ${list.children.length} 项`)

  // 点第一个（最新的就是刚才那场）
  const firstItem = list.children[0]?.children?.[0]
  ok(Boolean(firstItem), '列表里第一项能点')
  await firstItem.dispatch('click')
  await new Promise((r) => setTimeout(r, 400))

  // ---- 点「辩论稿」 ----
  await ids.get('textBtn').dispatch('click')
  ok(Boolean(captured), '点了「辩论稿」之后有文件生成')

  if (captured) {
    // BOM 得看字节，不能看 text()：Blob.text() 会按规范把开头的 BOM 吃掉，
    // 所以这里读 arrayBuffer 查 EF BB BF。
    const bytes = new Uint8Array(await captured.arrayBuffer())
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ok(bom, `文件头是 EF BB BF（实际 ${[...bytes.slice(0, 3)].map((b) => b.toString(16).toUpperCase()).join(' ')}）`)
    const text = await captured.text()
    ok(text.includes('【议题】辩论稿自检'), '第一行是议题')
    ok(text.includes('【正方】甲方立场') && text.includes('【反方】乙方立场'), '双方立场都写了')
    ok(text.includes('第 1 轮') && text.includes('第 2 轮'), '按轮分节')
    ok(/正方·一辩 .+：/.test(text), `辩位标签：${(text.match(/正方·一辩 .+：/) ?? ['(没有)'])[0]}`)
    ok(/反方·二辩 .+：/.test(text), '反方的序号也对')
    ok(!text.includes('过'), '"过"不进稿子')
    ok(!/\{|\}|"role"/.test(text), '没有 json 残留')
    ok(text.includes('第二行。'), '多行正文保留了换行')

    console.log('\n---------------- 导出的稿子 ----------------')
    console.log(text.replace(/^\uFEFF/, ''))
    console.log('--------------------------------------------')
  }

  await fetch(`${BASE}/api/session/${id}`, { method: 'DELETE' })
  await fetch(`${BASE}/api/trash/${id}`, { method: 'DELETE' })
  console.log('\n（临时会话已删）')
}

await main()
