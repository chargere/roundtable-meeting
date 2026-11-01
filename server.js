// 本地服务：一个 html 页面 + 几个接口。零依赖，只用 node 自带的 http。
//
//   node server.js        然后浏览器打开 http://127.0.0.1:4173
//
// 为什么是"服务端存会话"而不是"浏览器 localStorage"：
// 聊天记录是你会想备份、想拖来拖去、想用编辑器改的东西。
// 存在 sessions/ 里就是普通 json 文件，看得见摸得着；localStorage 你碰不到。

import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'

import { PROVIDERS, loadMembers, mergeChannels, publicMembers, saveMembers } from './src/members.js'
import { buildPreset, PRESET_NAMES } from './src/presets.js'
import { byRounds } from './src/stopper.js'
import { createMockHost } from './src/host.js'
import { createSpeaker } from './src/speaker.js'
import { listModels } from './src/models.js'
import { buildDirectorPrompt, parseDirector } from './src/director.js'
import { createRng } from './src/rng.js'
import { createLog } from './src/log.js'
import { runRoundtable } from './src/engine.js'
import { parseImport } from './src/import.js'

const ROOT = process.cwd()
const PUBLIC_DIR = join(ROOT, 'public')
const SESSION_DIR = join(ROOT, 'sessions')
const TRASH_DIR = join(SESSION_DIR, '.trash')
const PORT = Number(process.env.PORT || 4173)

const DEFAULT_TOPIC = '给这个圆桌项目每月花 300 块 API 费，值不值？'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

// ---------- 会话读写 ----------

function makeSession(data = {}) {
  const now = Date.now()
  return {
    id: data.id ?? `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: data.title ?? '新会话',
    preset: data.preset ?? '茶话会',
    seed: data.seed ?? 7,
    createdAt: data.createdAt ?? now,
    updatedAt: now,
    messages: data.messages ?? [],
    stats: data.stats ?? null,
    // 这一场的资料：会上每个人都会先读一遍，之后每次发言也都带着它。
    brief: data.brief ?? { text: '', updatedAt: null },
    // 辩论：谁站哪边、第几辩、双方预先定好的立场。
    debate: data.debate ?? { proStance: '', conStance: '', first: 'pro', sides: {} },
    importedFrom: data.importedFrom ?? null,
  }
}

/** 辩论配置的清洗：只收合法的阵营和 1~5 辩位。 */
function normalizeDebate(d) {
  const sides = {}
  for (const [id, v] of Object.entries(d?.sides ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue
    if (v?.side !== 'pro' && v?.side !== 'con') continue
    sides[id] = { side: v.side, order: Math.max(1, Math.min(5, Number(v.order) || 1)) }
  }
  return {
    proStance: String(d?.proStance ?? '').slice(0, 600),
    conStance: String(d?.conStance ?? '').slice(0, 600),
    first: d?.first === 'con' ? 'con' : 'pro',
    // 逐轮确认：每轮结束就停，下一轮谁先开口由人来点。
    // 默认开 —— "每轮讲完都该问一句"才是这个功能该有的样子；
    // 老会话里没有这个字段，也按开处理，不然升级之后它永远不生效。
    step: d?.step !== false,
    // 主持 AI：每轮开头由它定先手、给一句要求。空字符串 = 不用。
    hostId: /^[A-Za-z0-9_-]{1,64}$/.test(String(d?.hostId ?? '')) ? String(d.hostId) : '',
    sides,
  }
}

async function saveSession(session) {
  session.updatedAt = Date.now()
  const file = join(SESSION_DIR, `${session.id}.json`)
  await writeFile(file, JSON.stringify(session, null, 2), 'utf8')
  return session
}

async function readSession(id) {
  const file = join(SESSION_DIR, `${id}.json`)
  const raw = await readFile(file, 'utf8')
  return JSON.parse(raw)
}

async function listSessions() {
  const files = (await readdir(SESSION_DIR)).filter((f) => f.endsWith('.json'))
  const out = []
  for (const f of files) {
    try {
      const s = JSON.parse(await readFile(join(SESSION_DIR, f), 'utf8'))
      out.push({
        id: s.id,
        title: s.title,
        preset: s.preset,
        updatedAt: s.updatedAt,
        messageCount: s.messages?.length ?? 0,
        importedFrom: s.importedFrom ?? null,
      })
    } catch {
      // 文件坏了就跳过，不要因为它让整个列表挂掉
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function ensureData() {
  await mkdir(SESSION_DIR, { recursive: true })
  await mkdir(TRASH_DIR, { recursive: true })
  await mkdir('out', { recursive: true })
  const files = await readdir(SESSION_DIR).catch(() => [])
  if (files.some((f) => f.endsWith('.json'))) return

  // 第一次打开时给一个默认界面，不是空白页。
  await saveSession(makeSession({
    title: '默认会话',
    messages: [{
      id: 'welcome', role: 'host', seatId: 'host', round: 0, ts: Date.now(),
      text: '拖一个聊天记录文件到窗口里可以载入（.json / .jsonl / .md）。'
        + '或者直接在下面写一个议题，选个预设，按「开跑」。',
    }],
  }))
}

// ---------- 回收站 ----------
//
// 删会话默认是"挪走"不是"销毁"：文件从 sessions/ 移到 sessions/.trash/。
// 手滑一次不至于丢一整场对话 —— 本地工具的容错就该这么便宜。

async function listTrash() {
  const files = (await readdir(TRASH_DIR).catch(() => [])).filter((f) => f.endsWith('.json'))
  const out = []
  for (const f of files) {
    try {
      const s = JSON.parse(await readFile(join(TRASH_DIR, f), 'utf8'))
      out.push({
        id: s.id,
        title: s.title,
        deletedAt: s.deletedAt ?? null,
        messageCount: s.messages?.length ?? 0,
      })
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
}

async function moveToTrash(id) {
  const session = await readSession(id) // 不存在会抛
  session.deletedAt = Date.now()
  await mkdir(TRASH_DIR, { recursive: true })
  await writeFile(join(TRASH_DIR, `${id}.json`), JSON.stringify(session, null, 2), 'utf8')
  await rm(join(SESSION_DIR, `${id}.json`))
}

async function restoreFromTrash(id) {
  const raw = await readFile(join(TRASH_DIR, `${id}.json`), 'utf8')
  const session = JSON.parse(raw)
  delete session.deletedAt
  session.updatedAt = Date.now()
  await writeFile(join(SESSION_DIR, `${id}.json`), JSON.stringify(session, null, 2), 'utf8')
  await rm(join(TRASH_DIR, `${id}.json`))
}

async function purgeTrash(id) {
  await rm(join(TRASH_DIR, `${id}.json`))
}

async function emptyTrash() {
  const files = (await readdir(TRASH_DIR).catch(() => [])).filter((f) => f.endsWith('.json'))
  for (const f of files) await rm(join(TRASH_DIR, f))
  return files.length
}

// ---------- 小工具 ----------

function json(res, data, code = 200) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function fail(res, code, message) {
  json(res, { error: message }, code)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function serveStatic(path, res) {
  const rel = path === '/' ? '/index.html' : path
  const file = resolve(PUBLIC_DIR, '.' + rel)
  // 目录穿越保护：解析后的路径必须还在 public 里面
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return fail(res, 403, 'forbidden')
  try {
    const buf = await readFile(file)
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(buf)
  } catch {
    fail(res, 404, 'not found')
  }
}

// ---------- 路由 ----------

const server = createServer(async (req, res) => {
  // 每个请求记一行：谁来了、回了什么码、花了多久。
  // "点了没反应"这种问题，第一步就该确认请求到底有没有到服务端。
  const startedAt = Date.now()
  res.on('finish', () => {
    const line = `${new Date().toISOString()} ${req.method} ${req.url} → ${res.statusCode} ${Date.now() - startedAt}ms\n`
    try { appendFileSync(join('out', 'requests.log'), line) } catch { /* 记不上就算了，别影响请求 */ }
  })

  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = decodeURIComponent(url.pathname)
    const method = req.method

    if (path === '/api/config' && method === 'GET') {
      return json(res, {
        members: publicMembers(await loadMembers()),
        providers: PROVIDERS,
        presets: PRESET_NAMES,
        defaultTopic: DEFAULT_TOPIC,
      })
    }

    if (path === '/api/members' && method === 'GET') {
      return json(res, {
        members: publicMembers(await loadMembers()),
        providers: PROVIDERS,
      })
    }

    if (path === '/api/members' && method === 'PUT') {
      const body = await readBody(req)
      const incoming = Array.isArray(body.members) ? body.members : null
      if (!incoming) return fail(res, 400, 'members 得是个数组')
      if (!incoming.length) return fail(res, 400, '至少留一个成员')

      const existing = await loadMembers()
      const merged = mergeChannels(existing, incoming)
      const saved = await saveMembers(merged)
      return json(res, { members: publicMembers(saved) })
    }

    if (path === '/api/sessions' && method === 'GET') {
      return json(res, { sessions: await listSessions() })
    }

    if (path === '/api/session' && method === 'POST') {
      const body = await readBody(req)
      const session = await saveSession(makeSession({ title: body.title ?? '新会话', preset: body.preset }))
      return json(res, { session })
    }

    if (path.startsWith('/api/session/')) {
      const id = path.slice('/api/session/'.length)
      // id 会拼进文件路径，只收字母数字和横杠 —— 挡住 ../ 这类东西。
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(res, 400, '会话 id 不合法')
      if (method === 'GET') {
        try { return json(res, { session: await readSession(id) }) }
        catch { return fail(res, 404, '没有这个会话') }
      }
      if (method === 'PUT') {
        // 资料库 / 辩论配置：只改传进来的那几项，别的字段一概不碰。
        const body = await readBody(req)
        if (typeof body.brief !== 'string' && !body.debate) {
          return fail(res, 400, '要传 brief 字符串或 debate 对象')
        }
        let session
        try { session = await readSession(id) } catch { return fail(res, 404, '没有这个会话') }
        if (typeof body.brief === 'string') {
          session.brief = { text: body.brief.slice(0, 20000), updatedAt: Date.now() }
        }
        if (body.debate) {
          session.debate = normalizeDebate(body.debate)
        }
        await saveSession(session)
        return json(res, { session })
      }
      if (method === 'DELETE') {
        try { await moveToTrash(id) }
        catch { return fail(res, 404, '没有这个会话') }
        return json(res, { ok: true, trashed: true })
      }
    }

    // 拉这个 key 能用哪些模型 —— 让"模型名"从手打变成选择。
    if (path === '/api/models' && method === 'POST') {
      const body = await readBody(req)
      if (!body.member?.channel) return fail(res, 400, '没有拿到成员配置')
      const [merged] = mergeChannels(await loadMembers(), [body.member])
      try {
        const models = await listModels(merged)
        return json(res, { ok: true, models })
      } catch (err) {
        return json(res, { ok: false, error: err.message })
      }
    }

    // 单独测一个成员：发一句最短的话，把结果或错误原文带回来。
    // 这就是"我配的 key 到底通不通"的答案，不用靠一场完整的会议去试。
    if (path === '/api/test-member' && method === 'POST') {
      const body = await readBody(req)
      if (!body.member?.channel) return fail(res, 400, '没有拿到成员配置')

      // 页面没传 key（说明用户没改过）就用已存的那把
      const [merged] = mergeChannels(await loadMembers(), [body.member])
      const seat = { ...merged, name: merged.name || '这个成员' }

      const speaker = createSpeaker({ rng: createRng(1) })
      const startedAt = Date.now()
      try {
        const out = await speaker.speak({
          seat,
          state: { topic: '连接测试', messages: [], seats: [seat], round: 1, spoken: new Set() },
          prompt: [
            { role: 'system', content: '这是一次连接测试。不管我说什么，只回复两个字：通了。' },
            { role: 'user', content: '在吗' },
          ],
        })
        return json(res, {
          ok: true,
          ms: Date.now() - startedAt,
          model: seat.channel.model,
          provider: seat.channel.provider,
          sample: String(out.text ?? '（它选择了沉默）').slice(0, 120),
        })
      } catch (err) {
        return json(res, {
          ok: false,
          ms: Date.now() - startedAt,
          provider: seat.channel.provider,
          error: err.message,
        })
      }
    }

    if (path === '/api/trash' && method === 'GET') {
      return json(res, { items: await listTrash() })
    }

    if (path === '/api/trash' && method === 'DELETE') {
      const n = await emptyTrash()
      return json(res, { ok: true, removed: n })
    }

    if (path.startsWith('/api/trash/')) {
      const rest = path.slice('/api/trash/'.length)
      const restoring = rest.endsWith('/restore')
      const id = restoring ? rest.slice(0, -'/restore'.length) : rest
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(res, 400, '会话 id 不合法')

      if (restoring && method === 'POST') {
        try {
          await restoreFromTrash(id)
          return json(res, { ok: true, session: await readSession(id) })
        } catch {
          return fail(res, 404, '回收站里没有这一条')
        }
      }
      if (!restoring && method === 'DELETE') {
        await purgeTrash(id)
        return json(res, { ok: true })
      }
    }

    if (path === '/api/import' && method === 'POST') {
      const { filename, content } = await readBody(req)
      if (!content) return fail(res, 400, '文件是空的')
      let parsed
      try { parsed = parseImport(filename, content) }
      catch (err) { return fail(res, 400, `认不出这个文件：${err.message}`) }

      const session = await saveSession(makeSession({
        title: parsed.title,
        preset: parsed.preset ?? '茶话会',
        messages: parsed.messages,
        importedFrom: parsed.source,
      }))
      return json(res, { session })
    }

    if (path === '/api/run' && method === 'POST') {
      return await handleRun(req, res)
    }

    return await serveStatic(path, res)
  } catch (err) {
    if (!res.headersSent) return fail(res, 500, err.message)
    try { res.end() } catch { /* 已经断了 */ }
  }
})

// ---------- 开跑（SSE 流式回传） ----------

async function handleRun(req, res) {
  const body = await readBody(req)

  let session = null
  if (body.sessionId) {
    try { session = await readSession(body.sessionId) } catch { session = null }
  }
  if (!session) session = makeSession({ title: (body.topic ?? '新会话').slice(0, 30) })

  let userMessage = null
  if (body.topic) {
    const lastRound = session.messages.reduce((m, x) => Math.max(m, x.round ?? 0), 0)
    userMessage = {
      id: `u-${Date.now().toString(36)}`,
      role: 'user',
      seatId: 'user',
      text: body.topic,
      round: lastRound,
      ts: Date.now(),
    }
    session.messages.push(userMessage)
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  // 页面把连接掐了（按停止 / 关标签页），这边的请求也跟着收手。
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableFinished) controller.abort() })

  const send = (obj) => {
    if (res.destroyed || res.writableEnded) return // 那头已经走了，写也没用
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  // 先把"你刚说的话"推给页面。
  // 引擎拿到的是 history，历史消息不会重新发出来 —— 不在这儿补一条，
  // 你打的字就要等到刷新才看得见。
  if (userMessage) send({ type: 'message', message: userMessage })

  const seed = Number(body.seed ?? session.seed ?? 7)
  const presetName = body.preset ?? session.preset ?? '茶话会'

  const rng = createRng(seed)
  const host = createMockHost({ rng })

  // 谁来参会：成员表里"启用"的那些，再按页面这一趟勾掉的减一遍。
  const roster = await loadMembers()
  let base = roster.filter((m) => m.enabled !== false)
  if (Array.isArray(body.seats) && body.seats.length) {
    base = base.filter((m) => body.seats.includes(m.id))
  }

  // 辩论模式：参会的人由"辩论面板"里的分配决定，不看启用开关 ——
  // 你既然把某人排到了反方二辩，他就该站在那里。
  let seatsForPreset = base
  if (presetName === '辩论') {
    const d = session.debate ?? { sides: {} }
    seatsForPreset = Object.entries(d.sides ?? {})
      .map(([id, v]) => {
        const m = roster.find((x) => x.id === id)
        if (!m) return null
        return {
          ...m,
          side: v.side,
          position: Number(v.order) || 1,
          stanceText: v.side === 'pro' ? d.proStance : d.conStance,
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.position - b.position)

    const hasPro = seatsForPreset.some((s) => s.side === 'pro')
    const hasCon = seatsForPreset.some((s) => s.side === 'con')
    if (!hasPro || !hasCon) {
      send({ type: 'error', message: '辩论得两边都有人。点「辩论」分配正反方和辩位。' })
      return res.end()
    }
  } else if (!base.length) {
    send({ type: 'error', message: '一个成员都没开，没法开会' })
    return res.end()
  }

  const preset = buildPreset(presetName, {
    host,
    rng,
    seats: seatsForPreset,
    debateFirst: session.debate?.first ?? 'pro',
  })

  // 逐轮确认：每轮走完就停，把"下一轮谁先开口"交回给人。
  // 用 !== false 而不是 === true：老会话没有这个字段，也得按"开"来跑。
  //
  // 注意它管的是"跑完这一趟之后要不要问"，不是"只跑一轮"。
  // 你填的「轮」就是这一趟连跑几轮 —— 两件事各管各的，别再互相覆盖。
  const stepMode = presetName === '辩论' && session.debate?.step !== false

  let stoppers = preset.stoppers
  const wanted = Number(body.maxRounds) || null
  if (wanted) {
    stoppers = stoppers.filter((s) => !s.name.startsWith('轮数'))
    stoppers = [byRounds(Math.max(1, Math.min(20, wanted))), ...stoppers]
  }

  const seats = preset.seats
  const perRound = Number(body.perRound) || null

  // 资料：只取前 3000 字。再长的话，每次调用都要重读一遍，钱和延迟都不划算。
  const brief = String(session.brief?.text ?? '').slice(0, 3000).trim()

  const speaker = createSpeaker({ rng, signal: controller.signal })
  const log = createLog({ dir: join('out', 'logs'), tag: presetName })

  // 主持 AI：每轮开头问一次"这一轮怎么打"。
  // 它和辩手走同一条说话通道，所以它说的话会作为一条真实发言进对话 ——
  // 你能看见它在指挥，而不是在背后偷偷改参数。
  let onRoundStart = null
  const hostId = presetName === '辩论' ? session.debate?.hostId : ''
  const hostMember = hostId ? roster.find((m) => m.id === hostId) : null
  if (hostMember) {
    onRoundStart = async (state) => {
      const out = await speaker.speak({
        seat: hostMember,
        state,
        prompt: buildDirectorPrompt(state, session),
        mustSpeak: true,
      })
      return parseDirector(out.text)
    }
  }

  let result = null
  try {
    result = await runRoundtable({
      topic: session.title,
      seats,
      scheduler: preset.scheduler,
      stoppers,
      speaker,
      host,
      log,
      history: session.messages, // 接着已有记录往下跑
      onEvent: send,
      perRound,
      brief,
      onRoundStart,
      signal: controller.signal,
    })
  } finally {
    // 无论是正常散会还是被按了停止，已经说出去的话都要落盘。
    // 少这一句的话，"说到一半停下"会让那几句话凭空消失。
    if (result) {
      session.messages = result.state.messages
      session.preset = presetName
      session.seed = seed
      session.title = session.messages.find((m) => m.role === 'user')?.text?.slice(0, 40) ?? session.title
      session.stats = {
        calls: result.state.calls,
        chars: result.state.chars,
        passes: result.state.passes,
        round: result.state.round,
        stopReason: result.stopReason,
        // 这一趟是不是"逐轮确认"模式 —— 页面靠它决定要不要显示"下一轮谁先开口"
        step: stepMode,
        // 报错也要存进会话。
        // 以前只推给页面，刷新之后就没有了 —— 记录里看起来像"某个人突然不说话"，
        // 到底为什么，只有翻 logs 才知道。
        errors: result.events
          .filter((e) => e.type === 'error')
          .map((e) => ({ seat: e.seat, seatId: e.seatId, message: e.message, round: e.round })),
      }
      await saveSession(session)
      send({ type: 'saved', session })
    }
    if (!res.writableEnded) res.end()
  }
}

// ---------- 启动 ----------

await ensureData()
server.listen(PORT, '127.0.0.1', () => {
  console.log(`圆桌已开：http://127.0.0.1:${PORT}`)
  console.log(`会话存在：${SESSION_DIR}`)
})
