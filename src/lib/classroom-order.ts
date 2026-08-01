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
