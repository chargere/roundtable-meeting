// 检测器自检工具。
//
//   node tools/check-detector.js
//
// 把几句话丢进去，看它被判成「新论据 / 复读 / 纯附和」。
// 想调敏感度，就改 src/text.js 里的 MIN_EFFECTIVE 和 FILLER，再跑这个。
//
// 这些例句是从真实跑出来的记录里抄的 —— 包括那条骗过旧检测器的
// 「同意方向，但先做一半」。

import { isAgreementOnly, novelty, stripFiller } from '../src/text.js'

// 前面已经说过的内容，作为"旧词"的底。
const PRIOR = [
  '钱不是问题，这条我同意。问题在时间。',
  '成本拆三块：接口调用、调试时间、你的注意力。第三块最贵。',
  '我站反方。如果这事真有价值，早该有人做了，为什么没成？',
]

const CASES = [
  '钱不是问题，这条我同意。问题在时间。',      // 旧句，应该判复读
  '我这边结论一样。',                        // 纯附和
  '同意方向，但先做一半。',                   // 旧检测器放行的那句
  '这句我认。',                              // 纯附和
  '我不同意。',                              // 否定式，不能被剥成"我不"
  '等一下，这套说法有个漏洞：谁来判断「吵得好」？没标准就只是热闹。', // 新论据
  '把范围收到最小：三个模型、两轮、一个问题。',  // 新论据
  '按最小规模算，量级是「一顿饭到一件外套」，不致命。', // 新论据（前面没说过）
  '这个我完全认同，没什么可加的。',            // 纯附和
  '（回应算账的）「行，这条算你对。…」我这边结论一样。', // 带引用前缀的纯附和
  '你说的前提不成立。模型会互相附和，这不是调度能解决的。', // 新论据
]

function classify(text) {
  if (isAgreementOnly(text)) return '纯附和'
  return novelty(text, PRIOR) < 0.45 ? '复读' : '新论据'
}

const pad = (s, n) => {
  // 中文按两个字宽算，让表对齐
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)
  return s + ' '.repeat(Math.max(0, n - w))
}

console.log(pad('判定', 10) + pad('新鲜度', 10) + pad('剥离后', 30) + '原句')
console.log('-'.repeat(100))

for (const c of CASES) {
  const kind = classify(c)
  const score = novelty(c, PRIOR).toFixed(2)
  const eff = stripFiller(c).slice(0, 14) || '（空）'
  console.log(pad(kind, 10) + pad(score, 10) + pad(eff, 30) + c)
}

console.log('\n判定规则：纯附和 → 剥完套话剩不到 8 字且没有推进/分歧字眼；')
console.log('          复读   → 有新词但新鲜度 < 0.45；其余算新论据。')
