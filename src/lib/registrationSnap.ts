// 2026-09-14 建卷時把 AI 抓的 answerBbox 貼齊老師掃描卷自己的印刷格線（疊合服務 /snap、零 AI）。
//   fail-open：服務沒開／失敗 → 原框不動。只動有格線可貼的格；貼過的重做裁切截圖，老師檢核看到的就是批改會裁的格。
import type { AnswerKey } from './db'
import { recropAnswerKeyQuestions } from './gemini'

const blobToBase64Raw = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
  r.onerror = () => reject(new Error('read blob failed'))
  r.readAsDataURL(blob)
})

const pageOf = (q: { id: string; pageIndex?: number }) =>
  Number.isInteger(q.pageIndex) ? (q.pageIndex as number) : Math.max(0, (parseInt(String(q.id).split('-')[0], 10) || 1) - 1)

/**
 * @returns 貼齊的題數（0＝沒動）；會就地更新 answerKey.questions[].answerBbox / cropImageUrl
 */
export async function snapAnswerKeyToGrid(
  answerKey: AnswerKey,
  pageBlobs: Blob[],
  onProgress?: (m: string) => void,
): Promise<number> {
  const qs = answerKey.questions.filter((q) => q.answerBbox && pageOf(q) < pageBlobs.length)
  if (qs.length === 0 || pageBlobs.length === 0) return 0
  try {
    onProgress?.('把作答格貼齊印刷格線…')
    const pages = await Promise.all(pageBlobs.map(blobToBase64Raw))
    const res = await fetch('/api/registration/snap', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pages,
        boxes: qs.map((q) => ({ id: q.id, page: pageOf(q), bbox: q.answerBbox, kind: q.questionCategory ?? null })),
      }),
    })
    if (!res.ok) { console.info('[snap] 服務未啟用或失敗，維持原框', res.status); return 0 }
    const data = await res.json() as { boxes?: Array<{ id: string; bbox: { x: number; y: number; w: number; h: number }; snapped_edges?: string[] }> }
    const byId = new Map((data.boxes ?? []).filter((b) => b.snapped_edges?.length).map((b) => [b.id, b.bbox]))
    if (byId.size === 0) return 0
    const touched: typeof answerKey.questions = []
    for (const q of answerKey.questions) {
      const nb = byId.get(q.id)
      if (!nb) continue
      q.answerBbox = { x: nb.x, y: nb.y, w: nb.w, h: nb.h }
      touched.push(q)
    }
    // 貼過的格重做裁切截圖（純 canvas）
    try {
      const crops = await recropAnswerKeyQuestions(touched, pageBlobs)
      for (const q of touched) { const c = crops.get(q.id); if (c) q.cropImageUrl = c }
    } catch (err) { console.warn('[snap] 重裁失敗（框已更新、截圖沿用舊的）', err) }
    console.log(`[snap] 貼齊格線 ${touched.length}/${qs.length} 題`)
    return touched.length
  } catch (err) {
    console.warn('[snap] 例外，維持原框', err)
    return 0
  }
}
