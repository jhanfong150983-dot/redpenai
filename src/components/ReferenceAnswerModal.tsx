// 2026-09-05 環節⑤：上傳手寫參考答案卷（生成答案卷單一流程）。
//   老師把標準答案手寫在「下載的作答卷」上 → 拍照/掃描上傳 → 錨點對齊逐格裁圖（免 classify）
//   → 文字格合批 AI 轉錄自動填欄、作圖格 crop＝VJ 正解圖 → 老師逐題核對 → 寫回範本。
//   ⛔ 已人工確認過的欄位以老師此畫面的最終值為準（老師逐題可改）。

import { useMemo, useRef, useState } from 'react'
import { Loader2, Upload, X } from 'lucide-react'
import Button from '@/components/ui/Button'
import type { AnswerKeyTemplate } from '@/lib/db'
import { convertPdfToImages, getFileType, fileToBlob } from '@/lib/pdfToImage'
import { cropReferenceSheetCells, SheetAlignError } from '@/lib/generatedSheetAlign'
import { readReferenceAnswerCells } from '@/lib/gemini'
import InkConfirmModal from '@/components/InkConfirmModal'

/** 答案本身是圖的題型（crop＝VJ 正解圖，不轉錄文字） */
const DRAWING_TYPES = new Set(['grid_geometry', 'map_symbol', 'connect_dots', 'diagram_draw', 'diagram_color'])

const HINT_BY_TYPE: Record<string, string> = {
  single_choice: '手寫選項代號',
  multi_choice: '手寫多個代號',
  true_false: '○ 或 ✗',
  fill_blank: '手寫國字/注音/數值/數學式',
  short_answer: '手寫短句',
  word_problem: '手寫算式與答案',
  calculation: '手寫算式與答案'
}

export interface ReferenceReviewRow {
  id: string
  questionCategory: string
  cropDataUrl: string
  isDrawing: boolean
  /** 轉錄結果（老師可改；作圖題無） */
  text: string
}

interface Props {
  template: AnswerKeyTemplate
  onCancel: () => void
  /** 老師按「確認寫入」：rows 帶最終值 */
  onConfirm: (rows: ReferenceReviewRow[]) => Promise<void>
}

type Phase = 'upload' | 'ink' | 'processing' | 'review' | 'saving'

export default function ReferenceAnswerModal({ template, onCancel, onConfirm }: Props) {
  const [phase, setPhase] = useState<Phase>('upload')
  const [error, setError] = useState<string | null>(null)
  const [progressMsg, setProgressMsg] = useState('')
  const [rows, setRows] = useState<ReferenceReviewRow[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const pendingImageRef = useRef<HTMLImageElement | null>(null)

  const questions = useMemo(() => template.answerKey?.questions ?? [], [template])

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      const ft = getFileType(file)
      let blob: Blob
      if (ft === 'pdf') {
        const pages = await convertPdfToImages(file, { scale: 2, quality: 0.9 })
        if (!pages.length) throw new Error('PDF 沒有可用頁面')
        blob = pages[0] // 作答卷恆為單面一頁
      } else if (ft === 'image') {
        blob = await fileToBlob(file)
      } else {
        throw new Error(`不支援的檔案格式：${file.name}`)
      }
      const url = URL.createObjectURL(blob)
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('圖片載入失敗'))
        img.src = url
      })
      pendingImageRef.current = img
      setPhase('ink') // 轉錄要花墨水 → 先過同意框（慣例）
    } catch (err) {
      setError(err instanceof Error ? err.message : '檔案處理失敗')
    }
  }

  const runProcessing = async () => {
    const img = pendingImageRef.current
    if (!img || !template.generatedSheet) return
    setPhase('processing')
    setError(null)
    try {
      setProgressMsg('對齊定位方塊、裁切作答格…')
      const crops = cropReferenceSheetCells(img, template.generatedSheet)
      const cropById = new Map(crops.map((c) => [c.id, c.dataUrl]))
      const qRows: ReferenceReviewRow[] = questions
        .filter((q) => cropById.has(q.id))
        .map((q) => ({
          id: q.id,
          questionCategory: String(q.questionCategory ?? 'fill_blank'),
          cropDataUrl: cropById.get(q.id)!,
          isDrawing: DRAWING_TYPES.has(String(q.questionCategory)),
          text: ''
        }))
      const textRows = qRows.filter((r) => !r.isDrawing)
      setProgressMsg(`AI 轉錄手寫答案（${textRows.length} 格）…`)
      const reads = await readReferenceAnswerCells(
        textRows.map((r) => ({ id: r.id, dataUrl: r.cropDataUrl, hint: HINT_BY_TYPE[r.questionCategory] ?? '手寫作答' }))
      )
      for (const r of qRows) if (!r.isDrawing) r.text = reads.get(r.id) ?? ''
      setRows(qRows)
      setPhase('review')
    } catch (err) {
      setError(
        err instanceof SheetAlignError
          ? err.message
          : err instanceof Error
            ? err.message
            : '處理失敗，請稍後再試'
      )
      setPhase('upload')
    }
  }

  const handleConfirm = async () => {
    setPhase('saving')
    try {
      await onConfirm(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : '寫入失敗')
      setPhase('review')
    }
  }

  const blankCount = rows.filter((r) => !r.isDrawing && !r.text.trim()).length

  return (
    <div className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <div>
            <div className="font-bold text-gray-900">上傳手寫參考答案</div>
            <div className="text-xs text-gray-500">{template.name}</div>
          </div>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

          {phase === 'upload' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-700">
                請先從卡片<b>下載作答卷</b>並印出一份，把標準答案<b>手寫</b>在對應格子裡（作圖題直接在格內畫正解圖），
                再拍照或掃描成 PDF 上傳。系統會自動對齊、逐格讀取並填入答案。
              </p>
              <input ref={fileRef} type="file" accept="image/*,.pdf" className="hidden" onChange={handleFile} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full border-2 border-dashed border-blue-300 rounded-xl py-10 flex flex-col items-center gap-3 text-blue-500 hover:border-blue-400 hover:bg-blue-50/60 transition-colors"
              >
                <Upload className="w-8 h-8" />
                <span className="text-sm font-medium">點擊上傳參考答案卷（圖片或 PDF）</span>
                <span className="text-xs text-blue-400/80">請確保四角黑色定位方塊完整入鏡</span>
              </button>
            </div>
          )}

          {phase === 'processing' && (
            <div className="py-16 flex flex-col items-center">
              <Loader2 className="w-10 h-10 text-green-600 animate-spin" />
              <p className="mt-4 text-sm text-gray-600">{progressMsg}</p>
            </div>
          )}

          {(phase === 'review' || phase === 'saving') && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">
                逐題核對讀取結果（可直接修改）。作圖題的格圖會存為<b>正解圖</b>供批改比對。
                {blankCount > 0 && <span className="text-amber-700">　⚠ {blankCount} 格讀到空白——若卷上有寫，請手動補。</span>}
              </p>
              <div className="border rounded-lg divide-y max-h-[52vh] overflow-y-auto">
                {rows.map((r, idx) => (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-16 shrink-0 font-mono text-xs text-gray-500">{r.id}</span>
                    <img src={r.cropDataUrl} alt={r.id} className="h-10 max-w-[180px] object-contain border rounded bg-gray-50 shrink-0" />
                    {r.isDrawing ? (
                      <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-0.5">正解圖（供批改比對）</span>
                    ) : (
                      <input
                        value={r.text}
                        onChange={(e) => setRows((prev) => prev.map((x, i) => (i === idx ? { ...x, text: e.target.value } : x)))}
                        placeholder="（空白）"
                        className="flex-1 min-w-0 px-2 py-1 border border-gray-300 rounded text-sm"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-5 py-3 border-t bg-gray-50 shrink-0">
          <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
          {(phase === 'review' || phase === 'saving') && (
            <>
              <Button type="button" variant="outline" onClick={() => { setRows([]); setPhase('upload') }}>重新上傳</Button>
              <Button type="button" variant="primary" className="ml-auto" onClick={() => void handleConfirm()} disabled={phase === 'saving'}>
                {phase === 'saving' ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {phase === 'saving' ? '寫入中…' : '確認寫入答案'}
              </Button>
            </>
          )}
        </div>
      </div>

      <InkConfirmModal
        open={phase === 'ink'}
        warning="讀取手寫參考答案會消耗墨水（點數）"
        onConfirm={() => void runProcessing()}
        onCancel={() => { pendingImageRef.current = null; setPhase('upload') }}
      >
        <p className="text-sm text-gray-700">即將用 AI 逐格讀取這份參考答案卷的手寫內容並自動填入答案欄。</p>
      </InkConfirmModal>
    </div>
  )
}
