// 一个"够用的假 DOM"。tools/ 里几个前端自检共用这一份 ——
// 之前每个脚本各抄一遍，改一处得改三处，抄到第三遍就该抽出来了。
//
// 它不追求像浏览器，只追求一件事：真的去点按钮，真的把回调跑起来。

/** 递归取文字。假 DOM 里 textContent 不会自动包含子节点，得自己拼。 */
export function textOf(node) {
  if (!node) return ''
  let s = String(node._text ?? node.textContent ?? '')
  for (const kid of node.children ?? []) s += textOf(kid)
  return s
}

export function parseIds(html) {
  const map = new Map()
  for (const m of String(html).matchAll(/id="([^"]+)"/g)) map.set(m[1], makeEl('input'))
  return map
}

export function makeEl(tag = 'div') {
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

/**
 * 装上全局桩：document / window / URL.createObjectURL，以及把 '/api/...' 补成完整地址。
 * 最后一个必需 —— 浏览器会自动补域名，node 里不会。
 */
export function installDom(ids, { base, onBlob } = {}) {
  globalThis.document = {
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    querySelector: (sel) => (sel.startsWith('#') ? ids.get(sel.slice(1)) ?? null : null),
    getElementById: (id) => ids.get(id) ?? null,
    addEventListener() {},
  }
  globalThis.window = { addEventListener() {} }
  globalThis.alert = (msg) => console.log(`  [alert] ${msg}`)

  globalThis.URL.createObjectURL = (blob) => {
    onBlob?.(blob)
    return 'blob:fake'
  }
  globalThis.URL.revokeObjectURL = () => {}

  if (base) {
    const realFetch = globalThis.fetch
    globalThis.fetch = (input, init) => realFetch(
      typeof input === 'string' && input.startsWith('/') ? base + input : input,
      init,
    )
  }
}
