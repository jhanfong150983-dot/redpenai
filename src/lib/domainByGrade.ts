// 2026-08-29 新增答案卷「年級→領域」對照（user 拍板：選年級才可選領域，依課綱分科）。
//   ⛔ 關鍵設計：畫面標籤（社會-歷史）與存檔 domain 值（社會）分離——
//   server 批改管線多處寫死 domain === '社會'/'自然'/'國語'/'數學'/'英語' 的分支
//   （staged-grading.js 社自 short_answer/SOCIAL_WORD_PROBLEM/domainHint 等），
//   細科目若直接存檔會掉出既有規則。細科目標籤只用於公版範本的「科目」列印。
//   高中清單 user 拍板＝與國中相同。

export interface GradeChoice {
  /** 1~12 */
  value: number
  /** 選單顯示（一年級…） */
  label: string
}

export interface GradeGroup {
  stage: '國小' | '國中' | '高中'
  grades: GradeChoice[]
}

const CN = ['一', '二', '三', '四', '五', '六'] as const

export const GRADE_GROUPS: GradeGroup[] = [
  { stage: '國小', grades: Array.from({ length: 6 }, (_, i) => ({ value: i + 1, label: `${CN[i]}年級` })) },
  { stage: '國中', grades: Array.from({ length: 3 }, (_, i) => ({ value: i + 7, label: `${CN[i]}年級` })) },
  { stage: '高中', grades: Array.from({ length: 3 }, (_, i) => ({ value: i + 10, label: `${CN[i]}年級` })) }
]

/** 年級數字 → 「國中二年級」完整標（清單/唯讀顯示用） */
export function gradeFullLabel(grade: number): string {
  for (const g of GRADE_GROUPS) {
    const hit = g.grades.find((x) => x.value === grade)
    if (hit) return `${g.stage}${hit.label}`
  }
  return ''
}

/** 年級數字 → 該學段內的「X年級」短標（範本標題列印用） */
export function gradeShortLabel(grade: number): string {
  for (const g of GRADE_GROUPS) {
    const hit = g.grades.find((x) => x.value === grade)
    if (hit) return hit.label
  }
  return ''
}

export interface SubjectOption {
  /** 畫面/範本科目標籤 */
  label: string
  /** 存檔用傘狀 domain（管線相容值） */
  domain: string
}

const ELEMENTARY: SubjectOption[] = [
  { label: '國語', domain: '國語' },
  { label: '英語', domain: '英語' },
  { label: '數學', domain: '數學' },
  { label: '社會', domain: '社會' },
  { label: '自然', domain: '自然' },
  { label: '其他', domain: '其他' }
]

// 國中＝高中（user 2026-08-29 拍板「高中和國中先一樣」）
const SECONDARY: SubjectOption[] = [
  { label: '國語', domain: '國語' },
  { label: '英語', domain: '英語' },
  { label: '數學', domain: '數學' },
  { label: '社會', domain: '社會' },
  { label: '社會-歷史', domain: '社會' },
  { label: '社會-地理', domain: '社會' },
  { label: '社會-公民', domain: '社會' },
  { label: '自然', domain: '自然' },
  { label: '自然-理化', domain: '自然' },
  { label: '自然-生物', domain: '自然' },
  { label: '自然-地科', domain: '自然' },
  { label: '其他', domain: '其他' }
]

export function subjectOptionsForGrade(grade: number): SubjectOption[] {
  if (grade >= 1 && grade <= 6) return ELEMENTARY
  if (grade >= 7 && grade <= 12) return SECONDARY
  return []
}
