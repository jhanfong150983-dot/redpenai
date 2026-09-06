// 2026-09-06 數學課綱知識節點總索引（自研）。目前收錄七、八年級。
//   第二層 KP 節點歸類吃這份合併清單；代碼本身已分年級（A-7-x vs A-8-x），
//   按 code 分組時天然分開，第一層選對代碼、第二層就落到對的年級節點。
//   ⚠ 加新年級：建 curriculumNodes.gNmath.ts → 在此併入 ALL_MATH_NODES 即可。

import { G4_MATH_NODES } from './curriculumNodes.g4math'
import { G5_MATH_NODES } from './curriculumNodes.g5math'
import { G6_MATH_NODES } from './curriculumNodes.g6math'
import { G7_MATH_NODES } from './curriculumNodes.g7math'
import { G8_MATH_NODES } from './curriculumNodes.g8math'
import { G9_MATH_NODES } from './curriculumNodes.g9math'
import { G10_MATH_NODES } from './curriculumNodes.g10math'
import { G11A_MATH_NODES } from './curriculumNodes.g11A_math'
import { G11B_MATH_NODES } from './curriculumNodes.g11B_math'
import { G12A_MATH_NODES } from './curriculumNodes.g12A_math'
import { G12B_MATH_NODES } from './curriculumNodes.g12B_math'
import { GUOYU_NODES } from './curriculumNodes.guoyu'
import { SOCIAL_NODES } from './curriculumNodes.social'
import { SCIENCE_NODES } from './curriculumNodes.science'
import { PHYSCHEM_NODES } from './curriculumNodes.physchem'
import { EARTHSCI_NODES } from './curriculumNodes.earthsci'
import { HSBIO_NODES } from './curriculumNodes.hsbio'
import { HSCHEM_NODES } from './curriculumNodes.hschem'
import { HSPHYS_NODES } from './curriculumNodes.hsphys'
import { HSEARTH_NODES } from './curriculumNodes.hsearth'
import type { CurriculumNode } from './curriculumNodes.g7math'
export type { CurriculumNode, CurriculumCode } from './curriculumNodes.g7math'

// 2026-09-06 後設變體收合（user 拍板 B）：因材網高中數學每個代碼尾端有「統整/綜應/綜合應用/混合」
//   整卷級收尾節點，名字幾乎一樣、AI 選不準、雷達難讀、診斷價值低 → 同概念收合成一個。
//   ⚠ 只收「code 內有強標記(統整/綜應/綜合應用/混合)的 base」，概念級 Bloom 對(理解/應用)不碰。
//   ⚠ 原始年級檔保留完整（因材網記錄），只在此彙整時轉換；保留第一個 meta 節點的 id。
function collapseMetaVariants(nodes: CurriculumNode[]): CurriculumNode[] {
  const STRONG = ['綜合應用', '統整', '綜應', '混合'] // 強標記＝認定為 code 級收尾
  const SUFFIX = ['綜合應用', '生活應用', '統整', '綜應', '混合', '應用'] // 可剝除尾綴（長優先）
  const stripBase = (name: string) => {
    let s = name.replace(/[一二三四五六七八九]+$/, '')
    for (const suf of SUFFIX) if (s.endsWith(suf)) { s = s.slice(0, -suf.length); break }
    return s
  }
  const isMetaSuffixed = (name: string) => {
    const s = name.replace(/[一二三四五六七八九]+$/, '')
    return SUFFIX.some((suf) => s.endsWith(suf))
  }
  const byCode = new Map<string, CurriculumNode[]>()
  for (const n of nodes) { const g = byCode.get(n.code); if (g) g.push(n); else byCode.set(n.code, [n]) }
  const out: CurriculumNode[] = []
  for (const [, group] of byCode) {
    const strongBases = new Set<string>()
    for (const n of group) if (STRONG.some((m) => n.name.includes(m))) strongBases.add(stripBase(n.name))
    const mergedBase = new Set<string>()
    for (const n of group) {
      const base = stripBase(n.name)
      const isMeta = strongBases.has(base) && isMetaSuffixed(n.name)
      if (!isMeta) { out.push(n); continue }
      if (mergedBase.has(base)) continue // 同 base 後續 meta 節點丟棄
      mergedBase.add(base)
      out.push({ id: n.id, code: n.code, name: `${base}·統整應用`, desc: `統整與綜合應用${base}的相關概念`, ...(n.stage ? { stage: n.stage } : {}) })
    }
  }
  return out
}
/** 國語精選節點（掛學習內容代碼；第二層用） */
export { GUOYU_NODES } from './curriculumNodes.guoyu'
/** 社會節點（國中地理/歷史/公民；小學不做二層） */
export { SOCIAL_NODES } from './curriculumNodes.social'
/** 自然節點（國中生物+國中理化+國中地科+高中生物/化學…；小學自然不做二層） */
export { SCIENCE_NODES } from './curriculumNodes.science'
export { PHYSCHEM_NODES } from './curriculumNodes.physchem'
export { EARTHSCI_NODES } from './curriculumNodes.earthsci'
export { HSBIO_NODES } from './curriculumNodes.hsbio'
export { HSCHEM_NODES } from './curriculumNodes.hschem'
export { HSPHYS_NODES } from './curriculumNodes.hsphys'
export { HSEARTH_NODES } from './curriculumNodes.hsearth'
/** 自然科第二層總池（國中生物/理化/地科 + 高中生物/化學/物理/地科）。
 *  代碼零交集：國中無前綴、高中生物 B*、化學 C*、物理 P*、地科 E*。 */
export const ALL_SCIENCE_NODES = [
  ...SCIENCE_NODES, ...PHYSCHEM_NODES, ...EARTHSCI_NODES,
  ...HSBIO_NODES, ...HSCHEM_NODES, ...HSPHYS_NODES, ...HSEARTH_NODES,
]

export const ALL_MATH_NODES = collapseMetaVariants([
  ...G4_MATH_NODES, ...G5_MATH_NODES, ...G6_MATH_NODES,
  ...G7_MATH_NODES, ...G8_MATH_NODES, ...G9_MATH_NODES, ...G10_MATH_NODES,
  ...G11A_MATH_NODES, ...G11B_MATH_NODES, ...G12A_MATH_NODES, ...G12B_MATH_NODES,
])

/** 第二層節點總池（數學＋國語＋社會，代碼不衝突→依代碼分組天然分開） */
export const ALL_KP_NODES = [...ALL_MATH_NODES, ...GUOYU_NODES, ...SOCIAL_NODES, ...ALL_SCIENCE_NODES]
