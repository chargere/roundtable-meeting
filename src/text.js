// 判断"这条发言有没有带新东西"。
//
// 不用装分词器：中文按相邻两字切（bigram）就够用了。
// 但光看 bigram 有个明显的漏洞 ——「同意方向，但先做一半」这种话，
// 换了说法、出现了新词，其实一个字的新信息都没有。
// 所以先剥掉附和套话，剩下的才算"有效内容"。
//
// 这个检测器是**筛子，不是裁判**：它只负责在明显退化时踩刹车，
// 不负责判断讨论好不好。真接上模型之后，这块八成要换成让模型自己判。

const PUNCT = /[\s，。、；：！？…—\-（）()《》「」『』""''"'.,!?;:]/g

// 附和套话。剥掉之后剩下的字，才是这个人真的说了点什么。
const FILLER = [
  '我这边结论一样',
  '我这边也是一样',
  '没什么可加的',
  '没什么要补的',
  '这句我认',
  '我完全同意',
  '我同意',
  '同意方向',
  '同意',
  '赞同',
  '认同',
  '有道理',
  '说得对',
  '确实',
  '没错',
  '补充一点',
  '补充一下',
  '挑不出毛病',
  '暂时不反驳',
  '无法反驳',
  '算你对',
  '我认',
  '认可',
  '这个我接受',
]

// 剥之前先把否定式护住。否则"我不同意"会被剥成"我不"，意思正好反过来。
const NEG_GUARD = '\u0000NEG\u0000'

/**
 * 剥掉附和套话和标点，只留下"实质内容"。
 * 「同意方向，但先做一半」→「方向但先做一半」（还有东西，算内容）
 * 「我这边结论一样」        →「」（什么都没有，算纯附和）
 */
export function stripFiller(text) {
  let t = String(text)
  // 开头的称呼/引用前缀（「（回应乐观派）」「（回张三）」）不是内容。
  // 不剥掉的话，一条纯附和的话会靠着这七八个字躲过"没有实质"的判定。
  t = t.replace(/^（[^）]{0,12}）/, '').replace(/^（[^）]{0,12}\)/, '')
  // 剥之前先把否定式护住。否则"我不同意"会被剥成"我不"，意思正好反过来。
  t = t.replace(/不(同意|认同|赞同|认可|接受|能同意)/g, NEG_GUARD)
  for (const word of FILLER) t = t.split(word).join('')
  t = t.replace(new RegExp(NEG_GUARD, 'g'), '不同意')
  return t.replace(PUNCT, '')
}

// 有效字数低于这个数，就当它什么实质内容都没说。
const MIN_EFFECTIVE = 8

// 太短但有这些字眼，说明还是表了个态（"但先做一半"、"问题在时间"），不能算纯附和。
const PUSH = /[但不过反驳问题先要应该如果成本时间标准漏洞反例证据风险代价]/

/** 是不是纯附和：剥完套话基本什么都不剩，而且没带任何推进/分歧的字眼。 */
export function isAgreementOnly(text) {
  const eff = stripFiller(text)
  if (eff.length >= MIN_EFFECTIVE) return false
  if (eff.length >= 3 && PUSH.test(eff)) return false
  return true
}

export function bigrams(text) {
  const clean = String(text).replace(PUNCT, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

/**
 * 新鲜度：这条发言里有多少比例的两字组，是前面所有发言里从没出现过的。
 * 1.0 = 全新，0 = 全是旧词的重排（也就是复读 / 附和）。
 *
 * 注意它在"剥完套话的文本"上算，所以纯附和直接得 0 分。
 */
export function novelty(text, priorTexts) {
  const effective = stripFiller(text)
  if (effective.length < MIN_EFFECTIVE) return 0

  const now = bigrams(effective)
  if (now.size === 0) return 0

  const prior = new Set()
  for (const t of priorTexts) for (const b of bigrams(stripFiller(t))) prior.add(b)

  let fresh = 0
  for (const b of now) if (!prior.has(b)) fresh++
  return fresh / now.size
}

export function nameOf(seats, msg) {
  if (msg.seatId === 'user') return '你'
  if (msg.seatId === 'host') return '主持'
  return seats.find((s) => s.id === msg.seatId)?.name ?? msg.seatId
}
