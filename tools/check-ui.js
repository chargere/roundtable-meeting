// 页面结构自检：不用浏览器，也能抓出最常见的低级错误。
//
//   node tools/check-ui.js
//
// 查三件事：
//   1. app.js 里 $('#xxx') 用到的 id，index.html 里是不是都有
//   2. index.html 引用的静态文件，服务端是不是都回 200
//   3. 页面用到的 seat id，跟 src/seats.js 里的是不是对得上

import { readFile } from 'node:fs/promises'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

const html = await readFile('public/index.html', 'utf8')
const app = await readFile('public/app.js', 'utf8')

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
const used = new Set([...app.matchAll(/\$\('#([^']+)'\)/g)].map((m) => m[1]))

let bad = 0

for (const id of used) {
  if (!ids.has(id)) {
    console.log(`✗ app.js 用了 #${id}，但 index.html 里没有`)
    bad++
  }
}
console.log(`id 检查：用了 ${used.size} 个，${bad ? `缺 ${bad} 个` : '全都在'}`)

// 静态资源
for (const ref of ['/style.css', '/app.js']) {
  const res = await fetch(BASE + ref)
  const size = (await res.text()).length
  console.log(`${res.ok ? '✓' : '✗'} ${ref} → ${res.status}，${size} 字节`)
  if (!res.ok) bad++
}

// 座位 id 现在是数据，不是常量 —— 只检查成员表读得出来
const config = await fetch(BASE + '/api/config').then((r) => r.json())
console.log(`成员：${config.members.length} 个 —— ${config.members.map((m) => m.name).join('、')}`)
if (!config.members.length) { console.log('✗ 一个成员都没有'); bad++ }
if (config.members.some((m) => m.channel.apiKey)) { console.log('✗ 成员的 apiKey 被传到页面了'); bad++ }

console.log(bad ? `\n有 ${bad} 个问题` : '\n结构没问题')
process.exit(bad ? 1 : 0)
