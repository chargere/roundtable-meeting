// 可复现的随机数。
//
// 为什么第一件事是写这个：自由轮天生不可复现 —— 同样的输入，下一位可能是 A 也可能是 C。
// 调试的时候你只会想骂人。所以从第一行起就让"随机"由种子决定：
// 同一个 seed，跑出来一模一样，出了问题能原样重放一遍。
export function createRng(seed = 1) {
  let s = (seed >>> 0) || 1
  return function next() {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

export function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length]
}

export function chance(rng, p) {
  return rng() < p
}
