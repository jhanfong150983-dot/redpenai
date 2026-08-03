import {
  applyDiagnosisAndCrops,
  diagnosisWrongsOf,
  fetchQuestionCrops,
  generateParentComment,
  generateParentDiagnosis,
  saveCachedComment,
  saveParentReportCache,
  type DiagnosisItem,
  type StudentReport
} from '@/lib/parentReport'

/**
 * 2026-08-03:把「一份作業的家長報告 AI 生成」從 ParentReportTab 抽出來,
 *   讓行政端的全校批次可以重用同一條路——不能有兩套生成邏輯,
 *   否則老師按的和行政批次按的會產出不一樣的東西。
 *
 * ⚠ 逐位生成完就立刻存一位(不是整批最後才存)。這是踩過的雷:
 *   曾經整批最後才存、存失敗又被靜默吞掉,害 31 位 × 兩輪的 AI 診斷全部白跑。
 */

export interface GenerateResult {
  done: number
  failed: number
  /** 生成成功但雲端儲存失敗的——呼叫端必須讓它浮上 UI,不可靜默 */
  unsaved: Array<{ studentId: string; diagnosis: Record<string, DiagnosisItem>; comment: string }>
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++])
    })
  )
}

export async function generateParentReports(opts: {
  assignmentId: string
  subject: string
  targets: StudentReport[]
  /** true = 連已有的評語也重生(逐位「重新生成」用);false = 只補空的,保護老師編輯過的 */
  forceComment: boolean
  concurrency?: number
  /** 每位完成時回拋更新後的報告,讓畫面即時反映 */
  onDone?: (updated: StudentReport) => void
  onProgress?: (done: number, total: number) => void
}): Promise<GenerateResult> {
  const { assignmentId, subject, targets, forceComment, concurrency = 3, onDone, onProgress } = opts
  const unsaved: GenerateResult['unsaved'] = []
  let done = 0
  let failed = 0
  if (targets.length === 0) return { done, failed, unsaved }

  await runWithConcurrency(targets, concurrency, async (r) => {
    try {
      const qids = r.errorRows.map((e) => e.questionId)
      const [diag, crops] = await Promise.all([
        r.errorRows.length
          ? generateParentDiagnosis(assignmentId, subject, diagnosisWrongsOf(r))
          : Promise.resolve(new Map<string, DiagnosisItem>()),
        r.errorRows.length
          ? fetchQuestionCrops(assignmentId, r.studentId, qids)
          : Promise.resolve(new Map<string, string>())
      ])
      let updated = applyDiagnosisAndCrops(r, diag, crops)
      let comment = forceComment ? '' : r.comment || ''
      if (!comment) {
        const t = await generateParentComment(updated, subject)
        comment = t || r.comment || ''
        if (t) saveCachedComment(assignmentId, r.studentId, t)
      }
      updated = { ...updated, comment }
      const item = { studentId: r.studentId, diagnosis: Object.fromEntries(diag), comment }
      if (!(await saveParentReportCache(assignmentId, [item]))) unsaved.push(item)
      onDone?.(updated)
    } catch {
      failed += 1
    }
    done += 1
    onProgress?.(done, targets.length)
  })

  // 結尾補救:剛才存失敗的再試一次整批
  if (unsaved.length && (await saveParentReportCache(assignmentId, unsaved))) unsaved.length = 0
  return { done, failed, unsaved }
}
