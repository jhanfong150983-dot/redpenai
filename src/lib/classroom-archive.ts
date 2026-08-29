// 2026-08-29 班級歸檔（歷史資料）：
//   歸檔=classroom.archived 旗標（唯一 SSoT，資料夾歸檔只是批次打旗標）。
//   主介面所有「列班級」的載入點一律套 withoutArchivedClassrooms（仿 school-exam.ts 模式，
//   前科：withoutSchoolExamClassrooms 曾漏套 AiReport 一頁——新增列班級的頁面記得套）。
//   恢復=寫 false（不可寫 null/undefined：null 清除傳不過 local-first sync）。

export interface ArchivableClassroom {
  archived?: boolean
}

/** 主介面用：濾掉已歸檔班級 */
export function withoutArchivedClassrooms<T extends ArchivableClassroom>(rows: T[]): T[] {
  return rows.filter((r) => r.archived !== true)
}

/** 歷史資料頁用：只留已歸檔班級 */
export function onlyArchivedClassrooms<T extends ArchivableClassroom>(rows: T[]): T[] {
  return rows.filter((r) => r.archived === true)
}
