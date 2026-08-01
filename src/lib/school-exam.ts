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

/** 反向：只留學校考卷班級（行政端頁面用，例如行政端成績統計） */
export function onlySchoolExamClassrooms<T extends { folder?: string | null }>(rows: T[]): T[] {
  return rows.filter((c) => isSchoolExamClassroom(c))
}

// 2026-08-01（user 回報教師端首頁「作業總覽」跑出一堆行政端的「行政英語TEST」、且顯示「未知班級」）：
//   原本只過濾 classrooms、忘了 assignments——跨班彙總的頁面（首頁總覽、作業列表）直接讀
//   db.assignments.toArray() 就把學校考卷一起撈進來；班級已被濾掉所以查無名稱＝「未知班級」。
//   以班級為單位進入的頁面不受影響（班級沒出現、作業自然進不去）。
/** 學校考卷班級的 id 集合（給 assignment / submission 過濾用） */
export function schoolExamClassroomIds(
  classrooms: Array<{ id: string; folder?: string | null }>
): Set<string> {
  return new Set(classrooms.filter(isSchoolExamClassroom).map((c) => c.id))
}

/** 過濾掉學校考卷的作業：①所屬班級是學校考卷班 ②作業本身標了學校考卷資料夾（兩條件皆擋、防單邊漏標） */
export function withoutSchoolExamAssignments<T extends { classroomId?: string; folder?: string | null }>(
  rows: T[],
  schoolClassroomIds: Set<string>
): T[] {
  return rows.filter(
    (a) =>
      !(a.classroomId && schoolClassroomIds.has(a.classroomId)) &&
      (a.folder ?? '') !== SCHOOL_EXAM_FOLDER
  )
}
