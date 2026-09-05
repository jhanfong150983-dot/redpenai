// 2026-09-05 數學答案等價判定（code-first）。
//   場景：AI 解題兩輪答案字串不同但數學等價（x-12+9 vs x-3、2x+2(x-3000) vs 2(x+x-3000)、
//   頓號 vs 逗號的數列）。國中列式 99% 是一元一次式/不等式 → 線性正規化器可 code 判定；
//   回傳 null＝判不動（非線性/多變數/解析失敗），呼叫端退 AI 等價 call。
//   ⛔ 回傳 true/false 都是可信判定：線性域內展開比對係數是精確運算，不是啟發式。

/** 線性多項式 a·x + b（有理數用浮點近似；比對容忍 1e-9 相對誤差） */
interface LinPoly {
  a: number
  b: number
}

const COMPARATORS = ['<=', '>=', '<', '>', '='] as const
type Comparator = (typeof COMPARATORS)[number]

function normalizeMathText(s: string): string {
  return String(s ?? '')
    .replace(/[\s]/g, '')
    .replace(/[０-９ａ-ｚＡ-Ｚ（）]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/≤|≦/g, '<=')
    .replace(/≥|≧/g, '>=')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/[Xｘ]/g, 'x')
    .toLowerCase()
}

// ── 遞迴下降解析：expr := term (('+'|'-') term)*；term := factor (('*'|'/'|juxtaposition) factor)*
//    factor := number | 'x' | '(' expr ')' | '-' factor
//    乘出 x·x（非線性）或除以含 x 的式子 → throw（呼叫端轉 null）
class NonLinearError extends Error {}

function parseLinear(input: string): LinPoly {
  let pos = 0
  const peek = () => input[pos]
  const eat = () => input[pos++]

  const add = (p: LinPoly, q: LinPoly): LinPoly => ({ a: p.a + q.a, b: p.b + q.b })
  const sub = (p: LinPoly, q: LinPoly): LinPoly => ({ a: p.a - q.a, b: p.b - q.b })
  const mul = (p: LinPoly, q: LinPoly): LinPoly => {
    if (p.a !== 0 && q.a !== 0) throw new NonLinearError()
    return { a: p.a * q.b + q.a * p.b, b: p.b * q.b }
  }
  const div = (p: LinPoly, q: LinPoly): LinPoly => {
    if (q.a !== 0) throw new NonLinearError()
    if (q.b === 0) throw new NonLinearError()
    return { a: p.a / q.b, b: p.b / q.b }
  }

  function parseExpr(): LinPoly {
    let v = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = eat()
      const t = parseTerm()
      v = op === '+' ? add(v, t) : sub(v, t)
    }
    return v
  }

  function parseTerm(): LinPoly {
    let v = parseFactor()
    for (;;) {
      const c = peek()
      if (c === '*' || c === '/') {
        const op = eat()
        const f = parseFactor()
        v = op === '*' ? mul(v, f) : div(v, f)
      } else if (c === '(' || c === 'x') {
        // 隱式乘法：2(x+3)、3x、(x+1)(…)——後者會在 mul 時因非線性丟出
        const f = parseFactor()
        v = mul(v, f)
      } else {
        return v
      }
    }
  }

  function parseFactor(): LinPoly {
    const c = peek()
    if (c === '-') {
      eat()
      const f = parseFactor()
      return { a: -f.a, b: -f.b }
    }
    if (c === '+') {
      eat()
      return parseFactor()
    }
    if (c === '(') {
      eat()
      const v = parseExpr()
      if (eat() !== ')') throw new NonLinearError()
      return v
    }
    if (c === 'x') {
      eat()
      return { a: 1, b: 0 }
    }
    // 數字（含小數）
    let num = ''
    while (/[0-9.]/.test(peek() ?? '')) num += eat()
    if (!num) throw new NonLinearError()
    const n = Number(num)
    if (!Number.isFinite(n)) throw new NonLinearError()
    return { a: 0, b: n }
  }

  const v = parseExpr()
  if (pos !== input.length) throw new NonLinearError()
  return v
}

function splitComparator(s: string): { lhs: string; rhs: string; cmp: Comparator } | null {
  for (const cmp of COMPARATORS) {
    const i = s.indexOf(cmp)
    if (i > 0) {
      // 只容許單一比較子
      if (s.indexOf(cmp, i + cmp.length) >= 0) return null
      return { lhs: s.slice(0, i), rhs: s.slice(i + cmp.length), cmp }
    }
  }
  return null
}

const near = (p: number, q: number) => Math.abs(p - q) <= 1e-9 * Math.max(1, Math.abs(p), Math.abs(q))

/** 複合不等式 L op1 M op2 R → 拆成兩條完整單不等式（方向須一致；反向鏈交給呼叫端交叉配對） */
function splitChain(s: string): [string, string] | null {
  const found: Array<{ i: number; cmp: Comparator }> = []
  for (let i = 0; i < s.length; i++) {
    for (const cmp of ['<=', '>=', '<', '>'] as Comparator[]) {
      if (s.startsWith(cmp, i)) { found.push({ i, cmp }); i += cmp.length - 1; break }
    }
  }
  if (found.length !== 2) return null
  const lhs = s.slice(0, found[0].i)
  const mid = s.slice(found[0].i + found[0].cmp.length, found[1].i)
  const rhs = s.slice(found[1].i + found[1].cmp.length)
  if (!lhs || !mid || !rhs) return null
  if (found[0].cmp.startsWith('<') !== found[1].cmp.startsWith('<')) return null
  return [`${lhs}${found[0].cmp}${mid}`, `${mid}${found[1].cmp}${rhs}`]
}

/**
 * 判定兩個數學答案是否等價。
 * @returns true/false＝可信判定；null＝code 判不動（呼叫端退 AI）
 */
export function mathAnswersEquivalent(rawA: string, rawB: string): boolean | null {
  const A = normalizeMathText(rawA)
  const B = normalizeMathText(rawB)
  if (!A || !B) return null
  if (A === B) return true

  // 數列答案（15,16,17 vs 15、16或17）：抽出所有數字比多重集合
  const listLike = /^[-0-9.,、，;；或和及\s]+$/
  if (listLike.test(rawA.replace(/\s/g, '')) && listLike.test(rawB.replace(/\s/g, ''))) {
    const nums = (s: string) => (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).sort((x, y) => x - y)
    const na = nums(rawA)
    const nb = nums(rawB)
    if (na.length && na.length === nb.length) return na.every((v, i) => near(v, nb[i]))
    return false
  }

  // 複合不等式（a < x <= b）：拆成兩條各自比對（1-1-14 防禦性誤報的修法）
  const chainA = splitChain(A)
  const chainB = splitChain(B)
  if (chainA && chainB) {
    // 交叉配對：正向鏈與反向鏈（-7/3<x<=5 vs 5>=x>-7/3）拆出的兩條界限順序相反
    const straight = [mathAnswersEquivalent(chainA[0], chainB[0]), mathAnswersEquivalent(chainA[1], chainB[1])]
    if (straight[0] === true && straight[1] === true) return true
    const crossed = [mathAnswersEquivalent(chainA[0], chainB[1]), mathAnswersEquivalent(chainA[1], chainB[0])]
    if (crossed[0] === true && crossed[1] === true) return true
    if ((straight[0] === false || straight[1] === false) && (crossed[0] === false || crossed[1] === false)) return false
    return null
  }
  if (!!chainA !== !!chainB) return null

  const ca = splitComparator(A)
  const cb = splitComparator(B)
  if (!!ca !== !!cb) return null // 一邊是式子一邊是不等式——非同型，交給 AI 或人判

  try {
    if (ca && cb) {
      // 不等式/等式：移項成 (a·x + b) cmp 0，正規化方向後比例比對（k>0 縮放等價）
      const canon = (c: { lhs: string; rhs: string; cmp: Comparator }) => {
        const p = parseLinear(c.lhs)
        const q = parseLinear(c.rhs)
        let poly = { a: p.a - q.a, b: p.b - q.b }
        let cmp: Comparator = c.cmp
        if (cmp === '>' || cmp === '>=') {
          poly = { a: -poly.a, b: -poly.b }
          cmp = cmp === '>' ? '<' : '<='
        }
        return { poly, cmp }
      }
      const x = canon(ca)
      const y = canon(cb)
      if (x.cmp !== y.cmp) return false
      // 比例（k>0）：ax/ay = bx/by；處理零係數
      const { poly: P } = x
      const { poly: Q } = y
      if (near(P.a, 0) && near(Q.a, 0)) return near(P.b, 0) === near(Q.b, 0) && (near(P.b, 0) || P.b * Q.b > 0)
      if (near(P.a, 0) || near(Q.a, 0)) return false
      const k = P.a / Q.a
      if (k <= 0) return false
      return near(P.b, k * Q.b)
    }
    // 純式子：展開後係數必須完全相同（不容縮放——2x 和 x 不是同一個答案）
    const p = parseLinear(A)
    const q = parseLinear(B)
    return near(p.a, q.a) && near(p.b, q.b)
  } catch (err) {
    if (err instanceof NonLinearError) return null
    return null
  }
}
