// 2026-07-30 獨立模型(user 拍板):學校考卷的資料放在行政帳號名下(批改管線需要 owner),
// 但「所有考卷操作與顯示只發生在學校檢視(行政端)」——教師介面一律不顯示學校考卷的東西,
// 即使是行政自己的帳號切回教師介面也一樣,兩邊完全不混。
// 這裡是唯一的判定點:folder='學校考卷' 的班級,教師端各班級列表/選單全部過濾。
// Step 6 之後的考卷作業(assignment)建立時會沿用同一資料夾標記,一併在此過濾。

export const SCHOOL_EXAM_FOLDER = '學校考卷'

export function isSchoolExamClassroom(c: { folder?: string | null } | null | undefined): boolean {
  return (c?.folder ?? '') === SCHOOL_EXAM_FOLDER
}

export function withoutSchoolExamClassrooms<T extends { folder?: string | null }>(rows: T[]): T[] {
  return rows.filter((c) => !isSchoolExamClassroom(c))
}
