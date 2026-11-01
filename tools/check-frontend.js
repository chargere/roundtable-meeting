// 前端自检：不开浏览器，也把"点一下"这件事真的跑一遍。
//
//   node tools/check-frontend.js
//
// 做法：手搓一个够用的假 DOM，把 public/app.js 当模块加载进来，
// 然后真的去点「成员」→「新增成员」→ 填名字 → 点「保存」，
// 最后去问服务端：那个新成员到底存进去没有。
//
// 这不是为了炫技。因为这个项目里已经出现过两次"按钮没反应"，
// 而两次的原因都是某个元素没渲染出来、绑定时炸在 null 上 ——
// 这种错 tab 里看不出来，只有真跑一遍才看得见。

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

// ---------------- 极简 DOM ----------------

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

    querySelector(sel) {
      if (sel.startsWith('#')) return this._ids.get(sel.slice(1)) ?? null
      return null
    },
    querySelectorAll() { return [] },
  }
}

/** 在子树里按文字找元素（用来点"＋ 新增成员"这种没有 id 的按钮）。 */
function findByText(root, needle) {
  if (String(root.textContent ?? '').includes(needle)) return root
  for (const kid of root.children ?? []) {
    const hit = findByText(kid, needle)
    if (hit) return hit
  }
  return null
}

async function main() {
  const { readFile } = await import('node:fs/promises')
  const html = await readFile('public/index.html', 'utf8')

  const ids = new Map()
  for (const m of html.matchAll(/id="([^"]+)"/g)) ids.set(m[1], makeEl('div'))

  const document = {
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    querySelector: (sel) => (sel.startsWith('#') ? ids.get(sel.slice(1)) ?? null : null),
    getElementById: (id) => ids.get(id) ?? null,
    addEventListener() {},
  }
  globalThis.document = document
  globalThis.window = { addEventListener() {} }
  globalThis.confirm = () => true
  globalThis.alert = (msg) => console.log(`  [alert] ${msg}`)
  globalThis.URL.createObjectURL = () => 'blob:fake'
  globalThis.URL.revokeObjectURL = () => {}

  // 浏览器里 fetch('/api/config') 会自动补上当前域名，node 里不会 —— 补上。
  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => realFetch(
    typeof input === 'string' && input.startsWith('/') ? BASE + input : input,
    init,
  )

  // 加载前端。它自己会跑 init()。
  await import(new URL('../public/app.js', import.meta.url).href)

  // 等 init 把成员芯片渲染出来
  const chips = ids.get('seats')
  for (let i = 0; i < 60 && chips.children.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!chips.children.length) {
    const err = document.body.children.map((n) => n.textContent).join(' | ')
    throw new Error(`init 没跑起来（芯片一直是空的）${err ? '。页面上的报错：' + err : ''}`)
  }

  const before = (await (await fetch(BASE + '/api/members')).json()).members
  console.log(`起始成员：${before.length} 个`)

  // ---- 点「成员」 ----
  await ids.get('membersBtn').dispatch('click')

  const drawerBody = ids.get('drawerBody')
  if (!drawerBody.children.length) throw new Error('点「成员」之后抽屉是空的')

  // ---- 点「＋ 新增成员」 ----
  const addBtn = findByText(drawerBody, '新增成员')
  if (!addBtn) throw new Error('抽屉里找不到「新增成员」按钮')
  await addBtn.dispatch('click')

  const nameInput = drawerBody.querySelector('#f-name')
  const saveBtn = drawerBody.querySelector('#f-save')
  if (!nameInput) throw new Error('新成员表单里没有名字输入框')
  if (!saveBtn) throw new Error('新成员表单里没有保存按钮')

  // ---- 填名字、点保存 ----
  nameInput.value = '自检新成员'
  await saveBtn.dispatch('click')
  await new Promise((r) => setTimeout(r, 400))

  const after = (await (await fetch(BASE + '/api/members')).json()).members
  const added = after.find((m) => m.name === '自检新成员')

  const pass = (cond, msg) => {
    console.log(`${cond ? '✓' : '✗'} ${msg}`)
    if (!cond) process.exitCode = 1
  }

  pass(after.length === before.length + 1, `成员数 ${before.length} → ${after.length}`)
  pass(Boolean(added), '服务端收到了这个新成员')

  // ---- 收尾：删掉它 ----
  if (added) {
    const rest = after.filter((m) => m.id !== added.id)
    await fetch(BASE + '/api/members', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: rest }),
    })
    const final = (await (await fetch(BASE + '/api/members')).json()).members
    pass(final.length === before.length, `已清理，回到 ${final.length} 个`)
  }

  // ---- 左侧删除会话 ----
  const idsNow = async () => (await (await fetch(BASE + '/api/sessions')).json()).sessions.map((s) => s.id)
  const beforeIds = await idsNow()

  await ids.get('newBtn').dispatch('click') // 「＋ 新会话」
  await new Promise((r) => setTimeout(r, 400))

  const afterNew = await idsNow()
  pass(afterNew.length === beforeIds.length + 1, '「新会话」建出来了')

  const wraps = ids.get('sessionList').children
  const delBtn = wraps[0]?.children?.find((c) => c.className === 'item-del')
  pass(Boolean(delBtn), '列表每一项都有删除按钮')
  if (delBtn) {
    await delBtn.dispatch('click')
    await new Promise((r) => setTimeout(r, 500))
    pass((await idsNow()).length === beforeIds.length, `删掉了，回到 ${beforeIds.length} 个`)
  }

  // 自检不留垃圾：删掉的东西现在进回收站了，从那儿也清掉。
  const trash = (await (await fetch(BASE + '/api/trash')).json()).items
  for (const t of trash) {
    if (!beforeIds.includes(t.id)) {
      await fetch(`${BASE}/api/trash/${t.id}`, { method: 'DELETE' })
    }
  }

  console.log(process.exitCode ? '\n前端有问题' : '\n新增成员和删除会话这两条路都是通的')
}

main().catch((err) => {
  console.error('自检失败：', err.message)
  process.exit(1)
})
