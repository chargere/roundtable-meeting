// 向服务商要"你这个 key 能用哪些模型"。
//
// 为什么值得单独写：模型名是这套东西里最容易写错的一个字段。
// 它是自由文本，服务商只在你真的发请求时才告诉你写错了 ——
// 而那时候往往已经开了一场会、花了几次调用的钱。
// 拉一次列表，就再也不用猜。

import { BASE_URL } from './speaker.js'

const TIMEOUT_MS = 12_000

function endpointOf(seat) {
  const ch = seat.channel ?? {}
  const base = (ch.baseURL || BASE_URL[ch.provider] || '').replace(/\/+$/, '')
  if (!base) throw new Error('没有接口地址')
  return `${base}/models`
}

/**
 * 返回 [{ id, label }]。
 * label 是给人看的（有的服务商给 display_name），id 才是要写进请求的。
 */
export async function listModels(seat) {
  const ch = seat.channel ?? {}

  if (!ch.provider || ch.provider === 'mock') {
    throw new Error('假模型不需要选')
  }
  if (!ch.apiKey) {
    throw new Error('还没有 API Key，填了才能拉列表')
  }

  const url = endpointOf(seat)
  const headers = ch.provider === 'anthropic'
    ? { 'x-api-key': ch.apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${ch.apiKey}` }

  // 12 秒。有的平台（比如腾讯 TokenHub）根本没有 /models 这个接口，
  // 请求会一直挂着不回 —— 等太久不如早点说清楚，让人直接手打模型名。
  let res
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new Error(`这家 ${TIMEOUT_MS / 1000} 秒没回，多半不支持列模型。模型名手打就行`)
    }
    throw new Error(`连不上：${err.message}`)
  }
  const raw = await res.text()

  if (!res.ok) {
    throw new Error(`${ch.provider} 回 ${res.status}：${raw.replace(/\s+/g, ' ').slice(0, 160)}`)
  }

  let data
  try { data = JSON.parse(raw) } catch {
    throw new Error(`${ch.provider} 回的不是 json：${raw.slice(0, 120)}`)
  }

  const list = (data.data ?? data.models ?? [])
    .map((m) => ({
      id: String(m.id ?? m.model ?? m.name ?? ''),
      label: String(m.display_name ?? m.id ?? m.model ?? m.name ?? ''),
    }))
    .filter((m) => m.id)

  if (!list.length) throw new Error(`${ch.provider} 没返回模型列表（这个接口可能不支持）`)

  return list.sort((a, b) => a.id.localeCompare(b.id))
}
