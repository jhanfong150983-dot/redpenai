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
export type { CurriculumNode, CurriculumCode } from './curriculumNodes.g7math'
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

export const ALL_MATH_NODES = [
  ...G4_MATH_NODES, ...G5_MATH_NODES, ...G6_MATH_NODES,
  ...G7_MATH_NODES, ...G8_MATH_NODES, ...G9_MATH_NODES, ...G10_MATH_NODES,
  ...G11A_MATH_NODES, ...G11B_MATH_NODES, ...G12A_MATH_NODES, ...G12B_MATH_NODES,
]

/** 第二層節點總池（數學＋國語＋社會，代碼不衝突→依代碼分組天然分開） */
export const ALL_KP_NODES = [...ALL_MATH_NODES, ...GUOYU_NODES, ...SOCIAL_NODES, ...ALL_SCIENCE_NODES]
