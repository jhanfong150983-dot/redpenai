// 2026-08-01 班級排序共用（user 回報行政端成績統計下拉「亂七八糟」）：
//   Dexie/DB 回傳順序是寫入順序、不是人看的順序。教師端班級少沒感覺，
//   行政端鏡像全校 74 班就完全亂掉 → 一律用「年級 → 班序」自然排序。
//   邏輯原本私有在 SchoolAdminPanel（年級分組用），抽出來給成績簿等頁面共用。

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 班名格式「X年N班」→ 年級數字；推不出來回 null（非標準命名的自訂班級） */
export function gradeFromLabel(label: string): number | null {
  const m = String(label ?? '').match(/^([一二三四五六七八九])年/)
  return m ? CN_NUM[m[1]] ?? null : null
}

/** 班名「X年N班」→ 班序 N；推不出來回 9999（排在同年級最後） */
export function classNumFromLabel(label: string): number {
  const m = String(label ?? '').match(/年(\d+)/)
  return m ? parseInt(m[1], 10) : 9999
}

/**
 * 班級名稱比較子：年級 → 班序 → 名稱。
 * 推不出年級的（自訂命名，如「五年級測試班級」）一律排在有年級的之後、彼此按名稱排。
 */
export function compareClassroomName(a: string, b: string): number {
  const ga = gradeFromLabel(a)
  const gb = gradeFromLabel(b)
  if (ga != null && gb != null) {
    if (ga !== gb) return ga - gb
    const na = classNumFromLabel(a)
    const nb = classNumFromLabel(b)
    if (na !== nb) return na - nb
    return a.localeCompare(b, 'zh-Hant')
  }
  if (ga != null) return -1
  if (gb != null) return 1
  return a.localeCompare(b, 'zh-Hant')
}

/** 依班名排序（不改原陣列） */
export function sortClassroomsByName<T extends { name?: string }>(rows: T[]): T[] {
  return [...rows].sort((x, y) => compareClassroomName(x.name ?? '', y.name ?? ''))
}

// ── 2026-08-29 班級下拉「學年度區塊」──
//   學年資訊不在 school_year 欄位（前端拿不到、手動班為 null），而是在 folder 名稱：
//   1Campus 同步班 folder=「校名 114-2」、也可能有手動的「112學年度」。以 folder 分組。

export const UNGROUPED_FOLDER_LABEL = '未分類'

/** 資料夾名稱 → 學年鍵：「培英國中 114-2」→ {114,2}、「112學年度」→ {112,0}；抓不到回 null */
function folderYearKey(label: string): { year: number; semester: number } | null {
  const ys = label.match(/(\d{2,3})\s*-\s*(\d)\b/)
  if (ys) return { year: parseInt(ys[1], 10), semester: parseInt(ys[2], 10) }
  const y = label.match(/(\d{2,3})\s*學年/)
  if (y) return { year: parseInt(y[1], 10), semester: 0 }
  return null
}

/**
 * 資料夾（學年度區塊）比較子：帶學年的排前面且新學年優先（老師多半選當期），
 * 抓不到學年的自訂資料夾按名稱排在後面。
 */
export function compareFolderLabel(a: string, b: string): number {
  const ka = folderYearKey(a)
  const kb = folderYearKey(b)
  if (ka && kb) {
    if (ka.year !== kb.year) return kb.year - ka.year
    if (ka.semester !== kb.semester) return kb.semester - ka.semester
    return a.localeCompare(b, 'zh-Hant')
  }
  if (ka) return -1
  if (kb) return 1
  return a.localeCompare(b, 'zh-Hant')
}

export interface ClassroomFolderGroup<T> {
  label: string
  classrooms: T[]
}

/**
 * 依 folder（學年度）分組：組間 compareFolderLabel、無 folder 歸「未分類」排最後，
 * 組內 sortClassroomsByName。不改原陣列。
 */
export function groupClassroomsByFolder<T extends { name?: string; folder?: string | null }>(
  rows: T[]
): ClassroomFolderGroup<T>[] {
  const byFolder = new Map<string, T[]>()
  for (const row of rows) {
    const key = (row.folder ?? '').trim() || UNGROUPED_FOLDER_LABEL
    const bucket = byFolder.get(key)
    if (bucket) bucket.push(row)
    else byFolder.set(key, [row])
  }
  const labels = [...byFolder.keys()].sort((a, b) => {
    if (a === UNGROUPED_FOLDER_LABEL) return 1
    if (b === UNGROUPED_FOLDER_LABEL) return -1
    return compareFolderLabel(a, b)
  })
  return labels.map((label) => ({
    label,
    classrooms: sortClassroomsByName(byFolder.get(label) ?? [])
  }))
}
