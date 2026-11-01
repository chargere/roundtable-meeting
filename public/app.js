// 前端全部逻辑。没有框架、没有构建，浏览器直接跑。
//
// 数据只有两个来源：服务端的文件（sessions/ 与 data/members.json），和 /api/run 的流式事件。
// 页面上不保存任何"真相"，刷新之后一切都能从文件重建。

const $ = (sel) => document.querySelector(sel)

// 改前端的时候把这个号加一，页面上会显示。
// 用途很实际：分不清"我的改动没生效"和"浏览器还在用旧文件"时，看一眼号码就知道。
const BUILD = 'v15'

const ui = {
  list: $('#sessionList'),
  title: $('#title'),
  preset: $('#preset'),
  seed: $('#seed'),
  rounds: $('#rounds'),
  perRound: $('#perRound'),
  stopBtn: $('#stopBtn'),
  seats: $('#seats'),
  feed: $('#feed'),
  input: $('#input'),
  runBtn: $('#runBtn'),
  sendBtn: $('#sendBtn'),
  exportBtn: $('#exportBtn'),
  newBtn: $('#newBtn'),
  trashBtn: $('#trashBtn'),
  membersBtn: $('#membersBtn'),
  briefBtn: $('#briefBtn'),
  debateBtn: $('#debateBtn'),
  drop: $('#drop'),
  drawer: $('#drawer'),
  drawerTitle: $('#drawerTitle'),
  drawerBody: $('#drawerBody'),
  drawerClose: $('#drawerClose'),
  scrim: $('#scrim'),
}

const state = {
  config: null,
  members: [],
  providers: [],
  session: null,
  sessions: [],
  trash: [],
  running: false,
  panel: 'members', // 抽屉里放什么：members | brief
  view: 'list',   // 抽屉视图：list | form
  draft: null,    // 正在编辑的成员
}

// ---------- 小工具 ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

// 颜色不再写死在 CSS 里 —— 成员是数据，颜色也得跟着数据走。
const PALETTE = ['#f0b429', '#ff7b72', '#7ee787', '#d2a8ff', '#79c0ff', '#ffa657', '#56d4dd', '#f778ba']

function colorFor(id) {
  let h = 7
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function memberById(id) {
  return state.members.find((m) => m.id === id) ?? null
}

function seatInfo(id) {
  return memberById(id) ?? { id, name: id, persona: '', channel: { provider: 'mock', model: '' } }
}

function providerLabel(id) {
  return state.providers.find((p) => p.id === id)?.label ?? id
}

function describeChannel(m) {
  const base = m.channel.provider === 'mock'
    ? providerLabel('mock')
    : `${providerLabel(m.channel.provider)}${m.channel.model ? ' · ' + m.channel.model : ''}`
  return m.channel.hasKey ? `${base} · ${m.channel.keyHint}` : base
}

function scrollDown() {
  ui.feed.scrollTop = ui.feed.scrollHeight
}

/** 标题右边挂一个"资料 N 字"，一眼知道这场有没有喂材料。 */
function renderTitle() {
  ui.title.textContent = state.session?.title || '未命名'
  const n = (state.session?.brief?.text ?? '').length
  if (n) ui.title.append(el('span', 'tag', `资料 ${n} 字`))
}

// ---------- 出错别静默 ----------
//
// 上面那个 null.addEventListener 的教训：一个没接住的异常会让后面整段代码不执行，
// 但页面看起来一切正常，只是按钮没反应。用户完全不知道该看哪儿。
// 所以任何漏出来的错都往屏幕上扔一句。

window.addEventListener('error', (e) => {
  try { toast(`页面出错：${e.message}`) } catch { /* 连 toast 都没了就算了 */ }
})

window.addEventListener('unhandledrejection', (e) => {
  try { toast(`请求出错：${e.reason?.message ?? e.reason}`) } catch { /* 同上 */ }
})

let toastTimer = null
function toast(text) {
  let node = document.getElementById('toast')
  if (!node) {
    node = el('div')
    node.id = 'toast'
    document.body.append(node)
  }
  node.textContent = text
  node.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('on'), 2200)
}

// ---------- 接口 ----------

async function api(path, opts) {
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`)
  return data
}

function postJson(path, body, method = 'POST') {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------- 渲染：会话列表 ----------

function renderSessions() {
  ui.list.replaceChildren()
  for (const s of state.sessions) {
    const on = state.session?.id === s.id
    const wrap = el('div', 'item-wrap' + (on ? ' on' : ''))

    const btn = el('button', 'item')
    btn.append(el('span', 't', s.title || '未命名'))
    const meta = el('span', 'm')
    meta.append(el('span', null, `${s.messageCount} 条`))
    meta.append(el('span', null, s.preset || ''))
    if (s.importedFrom) meta.append(el('span', 'imp', '导入'))
    btn.append(meta)
    btn.onclick = () => loadSession(s.id)

    // 删除按钮是 item 的兄弟节点，不是子节点 ——
    // <button> 里不能套 <button>，套了有些浏览器会直接不渲染里面那个。
    const del = el('button', 'item-del', '×')
    del.title = '删掉这个会话'
    del.onclick = () => deleteSession(s)

    wrap.append(btn, del)
    ui.list.append(wrap)
  }
}

async function deleteSession(s) {
  if (!confirm(`把「${s.title || '未命名'}」移到回收站？\n在里面可以捞回来。`)) return

  try {
    await api(`/api/session/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
    const wasCurrent = state.session?.id === s.id
    await Promise.all([refreshSessions(), refreshTrash()])

    if (!wasCurrent) { toast('移到回收站了'); return }

    // 删的是正在看的那一场：换到最近的一个；一个都不剩就开一场新的。
    if (state.sessions.length) {
      await loadSession(state.sessions[0].id)
    } else {
      const { session } = await postJson('/api/session', { title: '新会话' })
      await refreshSessions()
      await loadSession(session.id)
    }
    toast('移到回收站了')
  } catch (err) {
    alert(`没删掉：${err.message}`)
  }
}

// ---------- 回收站 ----------

async function refreshTrash() {
  try {
    state.trash = (await api('/api/trash')).items
  } catch {
    state.trash = []
  }
  ui.trashBtn.textContent = state.trash.length ? `回收站（${state.trash.length}）` : '回收站'
}

function openTrash() {
  state.panel = 'trash'
  ui.drawer.classList.add('on')
  ui.scrim.classList.add('on')
  renderDrawer()
}

// ---------- 辩论 ----------

function openDebate() {
  state.panel = 'debate'
  ui.drawer.classList.add('on')
  ui.scrim.classList.add('on')
  renderDrawer()
}

const POSITIONS = ['一辩', '二辩', '三辩']

function renderDebate() {
  const d = state.session?.debate ?? { proStance: '', conStance: '', sides: {} }
  const sides = d.sides ?? {}

  const opt = (value, label, current) =>
    `<option value="${value}"${String(current) === String(value) ? ' selected' : ''}>${esc(label)}</option>`

  const rows = state.members.map((m) => {
    const cur = sides[m.id] ?? { side: 'none', order: 1 }
    return `
      <div class="d-row" data-id="${esc(m.id)}">
        <span class="dname">${esc(m.name)}</span>
        <select class="d-side">
          ${opt('none', '不参加', cur.side)}
          ${opt('pro', '正方', cur.side)}
          ${opt('con', '反方', cur.side)}
        </select>
        <select class="d-order">
          ${POSITIONS.map((p, i) => opt(i + 1, p, cur.order)).join('')}
        </select>
      </div>`
  }).join('')

  const box = el('div', 'form')
  box.innerHTML = `
    <div class="hint">
      辩题就是这一场的议题：<b>${esc(state.session?.title || '（还没写）')}</b><br>
      发言顺序固定为：正方一辩 → 反方一辩 → 正方二辩 → 反方二辩 → …（一轮一方说一次）
    </div>
    <label>正方立场（他们必须论证到底）
      <textarea id="d-pro" placeholder="比如：这个项目值得做，因为它能验证一个真问题">${esc(d.proStance ?? '')}</textarea>
    </label>
    <label>反方立场
      <textarea id="d-con" placeholder="比如：不值得，因为成本远超收益">${esc(d.conStance ?? '')}</textarea>
    </label>
    <label>谁先开口
      <select id="d-first">
        ${opt('pro', '正方先手（一辩 → 反方一辩 → …）', d.first ?? 'pro')}
        ${opt('con', '反方先手（反方一辩 → 正方一辩 → …）', d.first ?? 'pro')}
      </select>
    </label>
    <label class="checkline">
      <input type="checkbox" id="d-step"${d.step ? ' checked' : ''} />
      <span>逐轮确认：每轮结束停下，等我选下一轮谁先开口</span>
    </label>
    <label>主持 AI
      <select id="d-host">
        <option value="">不用，我自己定</option>
        ${state.members.map((m) => `<option value="${esc(m.id)}"${d.hostId === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select>
      <span class="hint">每轮开头它会定谁先开口，并写一句"这一轮必须回答什么"。它说的话会作为一条发言出现在对话里。</span>
    </label>
    <div class="hint">谁站哪边、第几辩：</div>
    <div class="d-rows">${rows}</div>
    <div class="form-actions">
      <button class="primary" id="d-save">保存，并切到「辩论」</button>
    </div>
    <div class="hint" id="d-status"></div>
  `
  ui.drawerBody.replaceChildren(box)

  const status = box.querySelector('#d-status')

  box.querySelector('#d-save').onclick = async () => {
    if (!state.session?.id) {
      status.textContent = '还没有会话，先开一场。'
      return
    }

    const picked = {}
    for (const row of box.querySelectorAll('.d-row')) {
      const id = row.dataset.id
      const side = row.querySelector('.d-side').value
      const order = Number(row.querySelector('.d-order').value) || 1
      if (side === 'pro' || side === 'con') picked[id] = { side, order }
    }

    const pro = Object.values(picked).filter((v) => v.side === 'pro').length
    const con = Object.values(picked).filter((v) => v.side === 'con').length
    if (!pro || !con) {
      status.textContent = '两边都得有人，不然辩不起来。'
      return
    }

    status.textContent = '正在保存…'
    try {
      const { session } = await api(`/api/session/${state.session.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          debate: {
            proStance: box.querySelector('#d-pro').value,
            conStance: box.querySelector('#d-con').value,
            first: box.querySelector('#d-first').value,
            step: box.querySelector('#d-step').checked,
            hostId: box.querySelector('#d-host').value,
            sides: picked,
          },
        }),
      })
      state.session = session
      ui.preset.value = '辩论'
      status.textContent = `存好了：正方 ${pro} 人、反方 ${con} 人。预设已切到「辩论」。`
      toast('辩论配置存好了')
    } catch (err) {
      status.textContent = `没存上：${err.message}`
    }
  }
}

function renderTrash() {
  const box = el('div')

  if (!state.trash.length) {
    box.append(el('div', 'hint', '回收站是空的。删掉的会话会先到这里。'))
    ui.drawerBody.replaceChildren(box)
    return
  }

  for (const item of state.trash) {
    const row = el('div', 'trow')

    const info = el('div')
    info.append(el('div', 'mname', item.title || '未命名'))
    const when = item.deletedAt ? new Date(item.deletedAt).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '不知道什么时候'
    info.append(el('div', 'mmeta', `${item.messageCount} 条 · 删于 ${when}`))

    const back = el('button', 'ghost sm', '恢复')
    back.onclick = () => restoreSession(item)

    const gone = el('button', 'ghost sm danger', '彻底删')
    gone.onclick = () => purgeSession(item)

    row.append(info, back, gone)
    box.append(row)
  }

  const empty = el('button', 'addbtn', '清空回收站')
  empty.style.color = '#d98b86'
  empty.onclick = emptyTrash
  box.append(empty)

  ui.drawerBody.replaceChildren(box)
}

async function restoreSession(item) {
  try {
    await postJson(`/api/trash/${encodeURIComponent(item.id)}/restore`, {})
    await Promise.all([refreshSessions(), refreshTrash()])
    renderDrawer()
    await loadSession(item.id)
    toast('捞回来了')
  } catch (err) {
    alert(`没恢复成功：${err.message}`)
  }
}

async function purgeSession(item) {
  if (!confirm(`把「${item.title || '未命名'}」彻底删掉？\n这次真的没有了。`)) return
  try {
    await api(`/api/trash/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
    await refreshTrash()
    renderDrawer()
    toast('彻底删掉了')
  } catch (err) {
    alert(`没删掉：${err.message}`)
  }
}

async function emptyTrash() {
  if (!confirm(`清空回收站？${state.trash.length} 场对话会真的没有。`)) return
  try {
    await api('/api/trash', { method: 'DELETE' })
    await refreshTrash()
    renderDrawer()
    toast('清空了')
  } catch (err) {
    alert(`没清掉：${err.message}`)
  }
}

// ---------- 渲染：成员芯片与预设 ----------

function renderChips() {
  ui.seats.replaceChildren()
  for (const m of state.members) {
    const chip = el('button', 'chip ' + (m.enabled ? 'on' : 'off'), m.name)
    chip.style.setProperty('--seat-color', colorFor(m.id))
    chip.title = describeChannel(m)
    chip.onclick = () => toggleMember(m.id)
    ui.seats.append(chip)
  }
  if (!state.members.some((m) => m.enabled)) {
    ui.seats.append(el('span', 'line err', '全关了，开跑前至少开一个'))
  }
}

function renderPresets() {
  ui.preset.replaceChildren()
  for (const name of state.config.presets) {
    const opt = el('option', null, name)
    opt.value = name
    ui.preset.append(opt)
  }
}

// ---------- 渲染：消息 ----------

function nodeFor(m) {
  if (m.role === 'pass') {
    return el('div', 'line pass', `${seatInfo(m.seatId).name} 过了`)
  }

  const node = el('div', 'msg ' + (m.role === 'user' ? 'me' : m.role === 'host' ? 'host' : 'model'))
  node.dataset.seat = m.seatId
  node.style.setProperty('--seat-color', colorFor(m.seatId))

  const who = el('div', 'who')
  const name = m.role === 'user' ? '你' : m.role === 'host' ? '主持' : seatInfo(m.seatId).name
  who.append(el('span', 'avatar', name.slice(0, 1)))
  who.append(el('span', 'name', name))
  if (m.round) who.append(el('span', 'round', `第 ${m.round} 轮`))

  // 谁先开口是"控制信息"，单独做个小标签 —— 绝不混进正文，
  // 不然辩手会把"反方先"当成对自己说的。
  if (m.role === 'host' && m.meta?.first) {
    who.append(el('span', 'chan', m.meta.first === 'pro' ? '正方先' : '反方先'))
  }

  // 顺便标一下这条是谁家的模型说的 —— 假模型和真模型一眼能分开。
  if (m.role === 'model') {
    const member = memberById(m.seatId)
    if (member && member.channel.provider !== 'mock') {
      const label = providerLabel(member.channel.provider)
      who.append(el('span', 'chan', member.channel.model ? `${label} · ${member.channel.model}` : label))
    }
  }

  node.append(who, el('div', 'text', m.text))
  return node
}

function renderFeed() {
  ui.feed.replaceChildren()
  for (const m of state.session?.messages ?? []) ui.feed.append(nodeFor(m))

  // 报错也画出来。不然记录里只会看到"某个人突然不说话了"，不知道为什么。
  for (const e of state.session?.stats?.errors ?? []) {
    ui.feed.append(el('div', 'line err',
      `${e.seat} 没说出话${e.round ? `（第 ${e.round} 轮）` : ''}：${e.message}`))
  }

  renderStats()

  // 逐轮确认：这一轮走完了，把"下一轮谁先开口"交回给人。
  if (state.session?.stats?.step) ui.feed.append(nextBar())

  scrollDown()
}

function nextBar() {
  const bar = el('div', 'nextbar')
  bar.append(el('span', 'nextbar-t', '这一轮结束。下一轮谁先开口？'))

  const pro = el('button', 'ghost sm', '正方先')
  pro.onclick = () => nextRound('pro')

  const con = el('button', 'ghost sm', '反方先')
  con.onclick = () => nextRound('con')

  bar.append(pro, con)
  return bar
}

async function nextRound(first) {
  if (state.running) return
  const d = state.session?.debate ?? {}
  try {
    const { session } = await api(`/api/session/${state.session.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ debate: { ...d, first } }),
    })
    state.session = session
  } catch (err) {
    alert(`没切过去：${err.message}`)
    return
  }
  ui.preset.value = '辩论'
  await run(null)
}

function renderStats() {
  const s = state.session?.stats
  if (!s) return
  ui.feed.append(el('div', 'line', `停止：${s.stopReason} · 调用 ${s.calls} 次 · 过 ${s.passes} 次 · ${s.chars} 字`))
}

// ---------- 载入 ----------

async function loadSession(id) {
  const { session } = await api(`/api/session/${id}`)
  state.session = session
  renderTitle()
  if (session.preset && state.config.presets.includes(session.preset)) ui.preset.value = session.preset
  if (session.seed) ui.seed.value = session.seed
  renderFeed()
  renderSessions()
}

async function refreshSessions() {
  const { sessions } = await api('/api/sessions')
  state.sessions = sessions
  renderSessions()
}

// ---------- 成员：保存 ----------

async function persistMembers(next) {
  const { members } = await postJson('/api/members', { members: next }, 'PUT')
  state.members = members
  renderChips()
  renderDrawer()
  renderFeed() // 名字或颜色可能变了，重画一遍省心
  return members
}

async function toggleMember(id) {
  const next = state.members.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m))
  await persistMembers(next)
}

// ---------- 成员：抽屉 ----------

function openMembers() {
  state.panel = 'members'
  state.view = 'list'
  state.draft = null
  ui.drawer.classList.add('on')
  ui.scrim.classList.add('on')
  renderDrawer()
}

function openBrief() {
  state.panel = 'brief'
  ui.drawer.classList.add('on')
  ui.scrim.classList.add('on')
  renderDrawer()
}

function closeMembers() {
  ui.drawer.classList.remove('on')
  ui.scrim.classList.remove('on')
  state.view = 'list'
  state.draft = null
}

function renderDrawer() {
  if (state.panel === 'trash') {
    ui.drawerTitle.textContent = '回收站'
    ui.drawerTitle.append(el('span', 'tag', BUILD))
    renderTrash()
    return
  }

  if (state.panel === 'debate') {
    ui.drawerTitle.textContent = '辩论'
    ui.drawerTitle.append(el('span', 'tag', BUILD))
    renderDebate()
    return
  }

  if (state.panel === 'brief') {
    ui.drawerTitle.textContent = '这一场的资料'
    ui.drawerTitle.append(el('span', 'tag', BUILD))
    renderBrief()
    return
  }

  ui.drawerTitle.textContent = state.view === 'form'
    ? (state.draft?.isNew ? '新成员' : '编辑成员')
    : `成员（${state.members.length}）`

  ui.drawerTitle.append(el('span', 'tag', BUILD))

  if (state.view === 'form') renderForm()
  else renderMemberList()
}

// ---------- 资料库 ----------

function renderBrief() {
  const text = state.session?.brief?.text ?? ''

  const box = el('div', 'form')
  box.innerHTML = `
    <div class="hint">
      这次会议的背景资料。每个人开口前都会读到它，之后每一次发言也都带着它。
      所以它同时是<b>依据</b>，也是<b>防跑题的绳子</b>。
    </div>
    <textarea id="b-text" style="min-height:240px" placeholder="把要讨论的材料贴在这里：数据、背景、规则、原文节选……">${esc(text)}</textarea>
    <div class="hint" id="b-meta"></div>
    <div class="form-actions">
      <button class="ghost" id="b-clear">清空</button>
      <span class="spacer"></span>
      <button class="ghost" id="b-file-btn">从文件读入</button>
      <button class="primary" id="b-save">保存到本会话</button>
    </div>
    <div class="hint" id="b-status"></div>
    <input type="file" id="b-file" accept=".txt,.md,.markdown,.csv,.json" style="display:none" />
  `
  ui.drawerBody.replaceChildren(box)

  const ta = box.querySelector('#b-text')
  const meta = box.querySelector('#b-meta')
  const status = box.querySelector('#b-status')

  const updateMeta = () => {
    const n = ta.value.length
    meta.textContent = n === 0
      ? '还没有资料。没有资料也能开会，只是没人拦得住跑题。'
      : `${n} 字${n > 3000 ? `（超过 3000 的部分不会带进对话，现在只算前 3000）` : '，每次调用都会带上'}` 
  }
  updateMeta()
  ta.addEventListener('input', updateMeta)

  box.querySelector('#b-file-btn').onclick = () => box.querySelector('#b-file').click()

  box.querySelector('#b-file').onchange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const content = await file.text()
    ta.value = ta.value ? `${ta.value}\n\n${content}` : content
    updateMeta()
    status.textContent = `读入了 ${file.name}（${content.length} 字），记得按保存。`
  }

  box.querySelector('#b-clear').onclick = () => {
    ta.value = ''
    updateMeta()
    status.textContent = '清空了，记得按保存。'
  }

  box.querySelector('#b-save').onclick = async () => {
    if (!state.session?.id) {
      status.textContent = '还没有会话可以存 —— 先开一场。'
      return
    }
    status.textContent = '正在保存…'
    try {
      const { session } = await api(`/api/session/${state.session.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: ta.value }),
      })
      state.session = session
      renderTitle()
      status.textContent = '存好了。'
      toast('资料存好了')
    } catch (err) {
      status.textContent = `没存上：${err.message}`
    }
  }
}

function renderMemberList() {
  const box = el('div')

  for (const m of state.members) {
    const row = el('div', 'mrow')
    row.style.setProperty('--seat-color', colorFor(m.id))

    const dot = el('button', 'mdot' + (m.enabled ? '' : ' off'))
    dot.title = m.enabled ? '点一下：这一位不参加' : '点一下：让他回来'
    dot.onclick = () => toggleMember(m.id)

    const info = el('div')
    info.append(el('div', 'mname' + (m.enabled ? '' : ' off'), m.name))
    info.append(el('div', 'mmeta', describeChannel(m)))

    const edit = el('button', 'ghost sm', '编辑')
    edit.onclick = () => startEdit(m)

    const del = el('button', 'ghost sm danger', '删')
    del.onclick = () => removeMember(m)

    row.append(dot, info, edit, del)
    box.append(row)
  }

  const add = el('button', 'addbtn', '＋ 新增成员')
  add.onclick = startAdd
  box.append(add)

  const hint = el('div', 'hint')
  hint.style.padding = '14px 8px 0'
  hint.textContent = '一个成员 = 一个人格 + 一条渠道。五个人都接同一个模型的话，你只是在听同一个脑子说五遍。'
  box.append(hint)

  ui.drawerBody.replaceChildren(box)
}

function startEdit(m) {
  state.draft = { ...m, channel: { ...m.channel }, rules: [...m.rules], isNew: false }
  state.view = 'form'
  renderDrawer()
}

function startAdd() {
  state.draft = {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    name: '新成员',
    persona: '',
    rules: [],
    conformity: 0.4,
    passRate: 0.2,
    enabled: true,
    channel: { provider: 'mock', model: '', baseURL: '', hasKey: false, keyHint: '' },
    isNew: true,
  }
  state.view = 'form'
  renderDrawer()
}

function removeMember(m) {
  if (state.members.length <= 1) return
  if (!confirm(`删掉「${m.name}」？\n他过去的发言会留在记录里，但没人再扮演这个角色了。`)) return
  persistMembers(state.members.filter((x) => x.id !== m.id))
    .then(() => toast('删掉了'))
    .catch((err) => alert(`没删掉：${err.message}`))
}

function renderForm() {
  const d = state.draft
  const options = state.providers
    .map((p) => `<option value="${p.id}"${p.id === d.channel.provider ? ' selected' : ''}>${esc(p.label)}</option>`)
    .join('')

  ui.drawerBody.innerHTML = `
    <div class="form">
      <label>名字
        <input type="text" id="f-name" maxlength="16" value="${esc(d.name)}" />
      </label>

      <label>角色设定
        <textarea id="f-persona" placeholder="他相信什么、关注什么、站在哪一边">${esc(d.persona)}</textarea>
      </label>

      <label>规则（一行一条，写禁令比写鼓励有用）
        <textarea id="f-rules" placeholder="禁止说「同意」&#10;每条只挑一个漏洞">${esc((d.rules ?? []).join('\n'))}</textarea>
      </label>

      <label>附和倾向 <span class="tag">越高越爱说「我同意」</span>
        <span class="range-row">
          <input type="range" id="f-conformity" min="0" max="1" step="0.05" value="${d.conformity}" />
          <output id="o-conformity">${Number(d.conformity).toFixed(2)}</output>
        </span>
      </label>

      <label>沉默概率 <span class="tag">0 = 必说</span>
        <span class="range-row">
          <input type="range" id="f-pass" min="0" max="1" step="0.05" value="${d.passRate}" />
          <output id="o-pass">${Number(d.passRate).toFixed(2)}</output>
        </span>
      </label>

      <label>渠道
        <select id="f-provider">${options}</select>
      </label>

      <label>模型
        <span class="range-row">
          <select id="f-model-pick"><option value="">（点右边拉列表）</option></select>
          <button class="ghost sm" id="f-model-pull">拉列表</button>
        </span>
        <input type="text" id="f-model" value="${esc(d.channel.model)}" placeholder="也可以手打，比如 deepseek-chat" />
        <span class="hint" id="f-model-hint"></span>
      </label>

      <label>接口地址（一般留空）
        <input type="text" id="f-baseurl" value="${esc(d.channel.baseURL ?? '')}" placeholder="只有自定义渠道才填" />
      </label>

      <label>API Key
        <span class="range-row">
          <input type="password" id="f-key" value="" placeholder="${d.channel.hasKey ? '已保存 ' + esc(d.channel.keyHint) + '，留空不改' : '还没填'}" />
          ${d.channel.hasKey ? '<button class="ghost sm danger" id="f-clearkey">清除</button>' : ''}
        </span>
      </label>

      <div class="hint" id="f-provider-hint"></div>
      <div class="hint" id="f-status"></div>

      <div class="form-actions">
        <button class="ghost" id="f-test">测一下连接</button>
        <span class="spacer"></span>
        <button class="ghost" id="f-cancel">取消</button>
        <button class="primary" id="f-save">保存</button>
      </div>
    </div>
  `

  const $n = (id) => ui.drawerBody.querySelector(id)

  const providerHint = () => {
    const p = state.providers.find((x) => x.id === $n('#f-provider').value)
    const box = $n('#f-provider-hint')
    if (!p) return
    if (p.id === 'mock') {
      box.innerHTML = '假模型：不联网、不花钱，台词是写死的演示文本。'
      return
    }
    if (p.id === 'anthropic') {
      box.innerHTML = '走 Anthropic 的 messages 接口。模型名比如 <code>claude-sonnet-4-5</code>。'
      return
    }
    box.innerHTML = '走 OpenAI 兼容接口（大多数家都是这个形状）。模型名照服务商文档填；接口地址一般留空。'
  }

  $n('#f-provider').addEventListener('change', () => {
    providerHint()
    // 换了服务商，如果 key 已经在，就顺手把列表拉了 —— 省一次点击。
    const prov = $n('#f-provider').value
    if (prov !== 'mock' && ($n('#f-key').value || d.channel.hasKey)) pullModels()
  })
  providerHint()

  $n('#f-conformity').addEventListener('input', (e) => {
    $n('#o-conformity').textContent = Number(e.target.value).toFixed(2)
  })
  $n('#f-pass').addEventListener('input', (e) => {
    $n('#o-pass').textContent = Number(e.target.value).toFixed(2)
  })

  // 没填过 key 的成员不会渲染这个按钮。
  // 必须先用 ?. 判断存在 —— 直接 .addEventListener 会在 null 上抛错，
  // 而抛错之后同一段代码里后面的绑定（包括"保存"）全部跳过，
  // 表现就是：表单能打开、字段能输入、点保存毫无反应。
  $n('#f-clearkey')?.addEventListener('click', () => {
    state.draft.keyTouched = true
    state.draft.channel.apiKey = ''
    $n('#f-key').value = ''
    $n('#f-key').placeholder = '保存后会清掉这把 key'
  })

  $n('#f-key').addEventListener('input', (e) => {
    state.draft.keyTouched = true
    state.draft.channel.apiKey = e.target.value
  })

  $n('#f-cancel').addEventListener('click', () => {
    state.view = 'list'
    state.draft = null
    renderDrawer()
  })

  // 把表单读成一个成员对象。"保存"和"测一下"都用它，省得两边逻辑跑偏。
  const collect = () => {
    const member = {
      id: d.id,
      name: $n('#f-name').value.trim(),
      persona: $n('#f-persona').value,
      rules: $n('#f-rules').value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 10),
      conformity: Number($n('#f-conformity').value),
      passRate: Number($n('#f-pass').value),
      enabled: d.enabled !== false,
      channel: {
        provider: $n('#f-provider').value,
        model: $n('#f-model').value.trim(),
        baseURL: $n('#f-baseurl').value.trim(),
      },
    }
    // 只有真的动过 key 才传 apiKey 字段；
    // 没动就不传，服务端会保留原来那把（页面从来拿不到完整 key）。
    if (state.draft.keyTouched) member.channel.apiKey = state.draft.channel.apiKey ?? ''
    return member
  }

  // 向服务商要"这个 key 能用哪些模型"，填进下拉框。
  // 拉不到就明说，手打那条路一直留着 —— 不能因为一个接口不给面子就把人卡死。
  const pullModels = async () => {
    const pick = $n('#f-model-pick')
    const hint = $n('#f-model-hint')
    const cur = $n('#f-model').value.trim()

    hint.textContent = '正在问服务商要列表…'
    try {
      const out = await postJson('/api/models', { member: collect() })
      if (!out.ok) throw new Error(out.error)

      const opts = out.models.map((m) =>
        `<option value="${esc(m.id)}"${m.id === cur ? ' selected' : ''}>${esc(m.label)}</option>`)
      pick.innerHTML = opts.join('')
      if (cur && !out.models.some((m) => m.id === cur)) {
        pick.insertAdjacentHTML(
          'afterbegin',
          `<option value="${esc(cur)}" selected>${esc(cur)}（当前，列表里没有）</option>`,
        )
      }
      hint.textContent = `拿到 ${out.models.length} 个可选模型。选一个会填到下面；想用别的直接改下面的框。`
    } catch (err) {
      hint.textContent = `拉不到列表：${err.message}。手打也行。`
    }
  }

  $n('#f-model-pull').addEventListener('click', pullModels)
  $n('#f-model-pick').addEventListener('change', (e) => {
    if (e.target.value) $n('#f-model').value = e.target.value
  })

  $n('#f-test').addEventListener('click', async () => {
    const status = $n('#f-status')
    const member = collect()
    if (member.channel.provider === 'mock') {
      status.textContent = '假模型不用测，它不联网。'
      return
    }
    status.textContent = `正在连 ${member.channel.model || '（没填模型名）'}…`
    try {
      const out = await postJson('/api/test-member', { member })
      status.textContent = out.ok
        ? `通了（${out.ms}ms，${out.provider}/${out.model}）：${out.sample}`
        : `连不上：${out.error}（${out.ms}ms）`
      status.style.color = out.ok ? 'var(--accent)' : '#ff7b72'
    } catch (err) {
      status.textContent = `连不上：${err.message}`
      status.style.color = '#ff7b72'
    }
  })

  $n('#f-save').addEventListener('click', async () => {
    const status = $n('#f-status')
    const member = collect()
    if (!member.name) {
      status.textContent = '名字不能空。'
      $n('#f-name').focus()
      return
    }

    const next = d.isNew
      ? [...state.members, member]
      : state.members.map((m) => (m.id === member.id ? member : m))

    status.textContent = '正在保存…'
    try {
      await persistMembers(next)
      state.view = 'list'
      state.draft = null
      renderDrawer()
      toast(d.isNew ? '加进去了' : '存好了')
    } catch (err) {
      status.textContent = `没保存成功：${err.message}`
      toast(`没保存成功：${err.message}`)
    }
  })
}

// ---------- 开跑（流式） ----------

async function run(topic) {
  if (state.running) return

  const active = state.members.filter((m) => m.enabled).map((m) => m.id)
  if (!active.length) {
    appendLine('一个成员都没开。点上面的「成员」放一个人回来。', 'err')
    return
  }

  setRunning(true)
  state.abort = new AbortController()
  const marker = el('div', 'line round', '···')
  ui.feed.append(marker)
  scrollDown()

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.abort.signal,
      body: JSON.stringify({
        sessionId: state.session?.id ?? null,
        topic: topic || null,
        preset: ui.preset.value,
        seed: Number(ui.seed.value) || 7,
        seats: active,
        maxRounds: Number(ui.rounds.value) || null,
        perRound: Number(ui.perRound.value) || null,
      }),
    })
    if (!res.ok || !res.body) throw new Error(`服务端回了 ${res.status}`)
    await readStream(res.body, marker)
  } catch (err) {
    if (err.name === 'AbortError') {
      marker.remove()
      appendLine('已停止。已经说出去的都存下来了。')
    } else {
      marker.remove()
      appendLine(`出错了：${err.message}`, 'err')
    }
  } finally {
    setRunning(false)
    state.abort = null
    // 停下来的那一下，服务端还在把半场落盘。等一小会儿再拉一次，
    // 免得你看到的是"页面上有、文件里没有"。
    setTimeout(() => {
      if (state.session?.id) loadSession(state.session.id).catch(() => {})
      refreshSessions().catch(() => {})
    }, 350)
  }
}

async function readStream(body, marker) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = chunk.split('\n').find((l) => l.startsWith('data: '))
      if (line) handleEvent(JSON.parse(line.slice(6)), marker)
    }
  }
}

function handleEvent(e, marker) {
  if (e.type === 'message') {
    marker.before(nodeFor(e.message))
    scrollDown()
    return
  }

  if (e.type === 'pass') {
    marker.before(el('div', 'line pass', `${e.seat} 过了`))
  } else if (e.type === 'assess') {
    const a = e.assess
    marker.before(el('div', 'line', `本轮 · 新论据 ${a.newArguments} · 复读 ${a.repeats} · 纯附和 ${a.agreementOnly ?? 0}`))
  } else if (e.type === 'round') {
    marker.before(el('div', 'line round', `第 ${e.round} 轮`))
  } else if (e.type === 'nudge') {
    marker.before(el('div', 'line', '（冷场）'))
  } else if (e.type === 'stop') {
    marker.before(el('div', 'line', `停止：${e.reason}`))
  } else if (e.type === 'error') {
    marker.before(el('div', 'line err', e.seat ? `${e.seat} 连不上：${e.message}` : e.message))
  } else if (e.type === 'saved') {
    state.session = e.session
    renderTitle()
    refreshSessions()
    // 逐轮确认：这一趟走完了，重画一遍，把"下一轮谁先开口"的按钮挂出来。
    if (e.session.stats?.step) renderFeed()
  }
}

function appendLine(text, cls = '') {
  ui.feed.append(el('div', 'line ' + cls, text))
  scrollDown()
}

function setRunning(on) {
  state.running = on
  ui.runBtn.disabled = on
  ui.sendBtn.disabled = on
  ui.stopBtn.disabled = !on
  ui.runBtn.textContent = on ? '跑着…' : '开跑'
}

// ---------- 拖拽载入 ----------

let dragDepth = 0

window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  dragDepth++
  ui.drop.classList.add('on')
})

window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
})

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) ui.drop.classList.remove('on')
})

window.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  ui.drop.classList.remove('on')
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  await importFile(file)
})

async function importFile(file) {
  try {
    const content = await file.text()
    const { session } = await postJson('/api/import', { filename: file.name, content })
    await refreshSessions()
    await loadSession(session.id)
  } catch (err) {
    appendLine(`载入失败：${err.message}`, 'err')
  }
}

// ---------- 交互 ----------

ui.membersBtn.onclick = openMembers
ui.briefBtn.onclick = openBrief
ui.debateBtn.onclick = openDebate
ui.trashBtn.onclick = async () => {
  await refreshTrash()
  openTrash()
}
ui.drawerClose.onclick = closeMembers
ui.scrim.onclick = closeMembers

ui.stopBtn.onclick = () => {
  if (!state.abort) return
  state.abort.abort() // 掐断这条 SSE，服务端会跟着收手
  toast('正在停…')
}

ui.runBtn.onclick = () => run(null)

ui.sendBtn.onclick = () => {
  const text = ui.input.value.trim()
  if (!text) return
  ui.input.value = ''
  autoGrow()
  run(text)
}

ui.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    ui.sendBtn.click()
  }
})

function autoGrow() {
  ui.input.style.height = 'auto'
  ui.input.style.height = Math.min(160, ui.input.scrollHeight) + 'px'
}

ui.input.addEventListener('input', autoGrow)

ui.newBtn.onclick = async () => {
  const { session } = await postJson('/api/session', { title: '新会话' })
  await refreshSessions()
  await loadSession(session.id)
  ui.input.focus()
}

ui.exportBtn.onclick = () => {
  if (!state.session) return
  const blob = new Blob([JSON.stringify(state.session, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(state.session.title || '会话').replace(/[\\/:*?"<>|]/g, '_')}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

// ---------- 启动 ----------

async function init() {
  state.config = await api('/api/config')
  state.members = state.config.members
  state.providers = state.config.providers
  ui.input.placeholder = `比如：${state.config.defaultTopic}`

  renderPresets()
  renderChips()
  await Promise.all([refreshSessions(), refreshTrash()])

  const first = state.sessions[0]
  if (first) await loadSession(first.id)
}

init().catch((err) => {
  document.body.append(el('div', 'line err', `启动失败：${err.message}（服务开了吗？node server.js）`))
})
