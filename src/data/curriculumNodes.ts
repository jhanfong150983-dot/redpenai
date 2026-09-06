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
export type { CurriculumNode, CurriculumCode } from './curriculumNodes.g7math'

export const ALL_MATH_NODES = [
  ...G4_MATH_NODES, ...G5_MATH_NODES, ...G6_MATH_NODES,
  ...G7_MATH_NODES, ...G8_MATH_NODES, ...G9_MATH_NODES, ...G10_MATH_NODES,
]
