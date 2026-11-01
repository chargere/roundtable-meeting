// 真正去调模型的说话器。
//
// 之前引擎里塞的是 createMockSpeaker —— 不管成员配了什么渠道，都在念写死的台词。
// 这个文件按成员自己的渠道分发：mock 走假模型，别的走真接口。
//
// 兼容面：市面上绝大多数家都是 OpenAI 的 chat/completions 形状，
// DeepSeek、智谱 GLM、火山方舟（豆包）、OpenAI 自己、以及各种中转站都算。
// 只有 Anthropic 是另一套（messages + x-api-key），单独写一支。
//
// 一家连不上不该拖垮整场会议：错误往上抛，引擎负责把这个人从这场里摘掉，
// 其他人接着说 —— 这也是"五个人"的好处，死一个还剩四个。

import { createMockSpeaker } from './mock-speaker.js'

export const BASE_URL = {
  deepseek: 'https://api.deepseek.com/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  hunyuan: 'https://api.hunyuan.cloud.tencent.com/v1',
  // 腾讯的 MaaS 聚合平台，hy3 这类模型在它上面，不在混元那边。
  // 两家都是腾讯，但 key 不通用 —— 走错地址就是 401。
  tokenhub: 'https://tokenhub.tencentmaas.com/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
}

// 120 秒，不是 60。
// 思考模型在长上下文里（辩论那种：资料 + 十几轮历史）想一分钟以上是常态，
// 60 秒会把它当"挂了"摘掉 —— 其实它只是在想。
const TIMEOUT_MS = 120_000

// 4000 而不是 500：现在的 flash 系列多半是"思考模型"，
// 它会先花几百上千个 token 在思维链上。辩论那种长上下文尤其吃预算，
// 给少了就会 finish_reason=length、content 是空字符串 —— 看起来像"模型没回话"。
const MAX_TOKENS = 4000

/**
 * 把 fetch 抛出来的底层错误，翻译成人能看懂的一句话。
 * 顺便决定这件事是"这一轮先跳过"（soft）还是"这个人掉线了"。
 */
export function friendlyError(err) {
  const name = err?.name ?? ''

  if (name === 'TimeoutError') {
    const e = new Error(`等了 ${TIMEOUT_MS / 1000} 秒还没回。思考模型在长上下文下会这样，这一轮先记过，下一轮再试`)
    e.soft = true
    return e
  }

  if (name === 'AbortError') {
    const e = new Error('请求被中断了')
    e.soft = true
    return e
  }

  if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(err?.message ?? '')) {
    const e = new Error(`连不上服务商：${err.message}`)
    e.soft = true // 网络抖一下就判死刑太狠了
    return e
  }

  return err
}

function short(text, n = 160) {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** "过" 是提示词里约定的沉默信号：整条回复只有一个"过"字才算。 */
function isPass(text) {
  return /^[过過][。.!！]?$/.test(text.trim())
}

/** 有些模型会把名字或 markdown 加粗抄进来，擦掉再入库。 */
function cleanup(text) {
  return text
    .replace(/^\s*\*\*(.+?)\*\*\s*[:：]\s*/, '')
    .replace(/^\s*[A-Za-z\u4e00-\u9fa5]{1,12}\s*[:：]\s*(?=\S)/, '')
    .trim()
}

function endpointOf(seat) {
  const ch = seat.channel ?? {}
  const base = (ch.baseURL || BASE_URL[ch.provider] || '').replace(/\/+$/, '')
  if (!base) throw new Error(`「${seat.name}」没填接口地址`)
  if (base.endsWith('/chat/completions')) return base
  return `${base}/chat/completions`
}

async function callOpenAICompatible(seat, prompt, signal) {
  const url = endpointOf(seat)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${seat.channel.apiKey}`,
    },
    body: JSON.stringify({
      model: seat.channel.model,
      messages: prompt,
      temperature: 0.8,
      max_tokens: MAX_TOKENS,
    }),
    signal,
  })

  const raw = await res.text()

  if (!res.ok) {
    // 把服务商的原文带出来，别翻译成"请求失败" —— 403 和 429 的处理方式完全不同。
    throw new Error(`${seat.channel.provider} 回了 ${res.status}：${short(raw)}`)
  }

  let data
  try { data = JSON.parse(raw) } catch {
    throw new Error(`${seat.channel.provider} 回的不是 json：${short(raw)}`)
  }

  const choice = data.choices?.[0]
  const text = choice?.message?.content ?? choice?.text ?? ''

  if (!String(text).trim()) {
    // 最常见的两种情况：思考模型把预算全烧在思维链上，或者内容被内容审核吞了。
    const usage = data.usage ?? {}
    const why = choice?.finish_reason === 'length'
      ? `它把 ${usage.completion_tokens ?? '?'} 个 token 全花在思考上了（finish_reason=length），content 是空的`
      : `它回了空 content（finish_reason=${choice?.finish_reason ?? '?'}）`
    const err = new Error(`${why}。换个非思考模型，或者把 src/speaker.js 里的 MAX_TOKENS 调大`)
    // soft：这一轮没说出话，但这个人没坏。下一轮还能轮到他。
    // 网络、鉴权那种错则相反 —— 那才是真的掉线，该摘掉。
    err.soft = true
    throw err
  }

  return String(text)
}

async function callAnthropic(seat, prompt, signal) {
  const system = prompt.find((m) => m.role === 'system')?.content ?? ''
  const messages = prompt.filter((m) => m.role !== 'system')

  const res = await fetch(`${BASE_URL.anthropic}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': seat.channel.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: seat.channel.model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    }),
    signal,
  })

  const raw = await res.text()
  if (!res.ok) throw new Error(`anthropic 回了 ${res.status}：${short(raw)}`)

  let data
  try { data = JSON.parse(raw) } catch {
    throw new Error(`anthropic 回的不是 json：${short(raw)}`)
  }

  const text = (data.content ?? []).map((c) => c.text ?? '').join('')
  if (!text.trim()) throw new Error('anthropic 回了空内容')
  return text
}

export function createSpeaker({ rng, signal = null } = {}) {
  const mock = createMockSpeaker({ rng })

  // 把"这一场被叫停"和"单次调用超时"合成一个信号，喂给 fetch。
  // 少了这一层，按停止只能等这次请求自己回完 —— 思考模型一次可以想十几秒。
  const guard = () => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  return {
    async speak({ seat, state, prompt, mustSpeak }) {
      const ch = seat.channel ?? {}

      if (!ch.provider || ch.provider === 'mock') {
        return mock.speak({ seat, state, mustSpeak })
      }

      if (!ch.apiKey) throw new Error(`「${seat.name}」还没填 API Key`)
      if (!ch.model) throw new Error(`「${seat.name}」还没填模型名`)

      const text = ch.provider === 'anthropic'
        ? await callAnthropic(seat, prompt, guard()).catch((e) => { throw friendlyError(e) })
        : await callOpenAICompatible(seat, prompt, guard()).catch((e) => { throw friendlyError(e) })

      const value = cleanup(text)
      if (!value) throw new Error(`「${seat.name}」的回复是空的`)
      if (isPass(value)) return { pass: true, reason: '模型自己说了「过」' }

      // 提示词里要求它一次不超过 120 字，模型经常不听，这里硬截一下，免得刷屏。
      return { text: value.length > 600 ? `${value.slice(0, 600)}…` : value }
    },
  }
}
