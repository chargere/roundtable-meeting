// 日志：一条不漏地记下每次调用。
//
// 这不是"以后再说"的东西。自由轮不可复现，
// 没有完整 prompt 落盘，出了怪事你连重放都做不到。
// 顺带它就是你将来的"会议纪要"和账单依据。

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function createLog({ dir = 'out/logs', tag = 'session' } = {}) {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${tag}-${stamp}.jsonl`)

  const write = (obj) => appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')

  return {
    file,
    event(e) { write({ kind: 'event', ...e }) },
    call(c) { write({ kind: 'call', ...c }) },
  }
}
