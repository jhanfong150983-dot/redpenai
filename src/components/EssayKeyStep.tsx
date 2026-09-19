// 2026-09-19 作文模式建卷步驟「題目與稿紙」：
//   左＝作文的「答案卷」內容（題目／圖意／寫作任務／可接受的詮釋範圍／離題定義；AI 起草、老師確認）
//   右＝系統稿紙預覽（比照會考：每面 23 行×22 格、正反兩頁）＋下載 PDF
//   只有「立意取材」和題目有關；其餘三向度用內建會考通用六級分規準（第一版固定、此處僅顯示）。
import { useEffect, useMemo, useState } from 'react'
import { Download, Loader2, Plus, Trash2 } from 'lucide-react'
import Button from '@/components/ui/Button'
import type { EssayKeyData } from '@/lib/db'
import { generateEssaySheet, buildEssaySheetPdf, ESSAY_GRID, type EssaySheetResult } from '@/lib/essaySheetGenerator'

interface EssayKeyStepProps {
  value: EssayKeyData
  onChange: (next: EssayKeyData) => void
  /** 稿紙標題（學校＋考試名稱） */
  sheetTitle: string
  questionId: string
  readOnly?: boolean
  onSheetReady: (result: EssaySheetResult | null) => void
}

const RUBRIC_DIMENSIONS = [
  { name: '立意取材', note: '依下方「寫作任務／可接受的詮釋範圍」判斷是否切題、材料運用與闡述' },
  { name: '結構組織', note: '結構完整度、段落連貫與轉折' },
  { name: '遣詞造句', note: '用詞精確度、句型變化、冗詞贅句與口語化' },
  { name: '錯別字、格式與標點符號', note: '錯別字（筆畫級小錯不處理）、格式、標點' },
]

async function fetchOmrHeaderDataUri(): Promise<string | null> {
  try {
    const r = await fetch('/templates/omr-header.png')
    if (!r.ok) return null
    const blob = await r.blob()
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('read failed'))
      fr.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export default function EssayKeyStep({ value, onChange, sheetTitle, questionId, readOnly = false, onSheetReady }: EssayKeyStepProps) {
  const [headerUri, setHeaderUri] = useState<string | null>(null)
  const [headerFailed, setHeaderFailed] = useState(false)
  const [previewPage, setPreviewPage] = useState(0)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchOmrHeaderDataUri().then((uri) => {
      if (!alive) return
      if (uri) setHeaderUri(uri)
      else setHeaderFailed(true)
    })
    return () => { alive = false }
  }, [])

  const sheet = useMemo(
    () => (headerUri ? generateEssaySheet({ title: sheetTitle, headerDataUri: headerUri, questionId }) : null),
    [headerUri, sheetTitle, questionId],
  )
  useEffect(() => { onSheetReady(sheet) }, [sheet, onSheetReady])

  const previewUrl = useMemo(() => {
    if (!sheet) return null
    return URL.createObjectURL(new Blob([sheet.svgs[previewPage] ?? sheet.svgs[0]], { type: 'image/svg+xml' }))
  }, [sheet, previewPage])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const handleDownload = async () => {
    if (!sheet || downloading) return
    setDownloading(true)
    try {
      const pdf = await buildEssaySheetPdf(sheet.svgs)
      const url = URL.createObjectURL(pdf)
      const a = document.createElement('a')
      a.href = url
      a.download = `${sheetTitle || '作文'}_稿紙.pdf`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } finally {
      setDownloading(false)
    }
  }

  const set = <K extends keyof EssayKeyData>(k: K, v: EssayKeyData[K]) => onChange({ ...value, [k]: v })
  const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm leading-relaxed focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100 disabled:bg-gray-50 disabled:text-gray-600'

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* ── 左：作文答案卷內容 ── */}
        <div className="space-y-4">
          <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 leading-relaxed">
            以下內容由 AI 依題目起草，是 AI 批改這篇作文的依據，<b>請務必確認</b>。特別是「可接受的詮釋範圍」：
            寫得太窄，會讓用比喻、意象來發揮的好文章被判成不切題。
          </div>

          <section>
            <label className="block text-sm font-semibold text-gray-800 mb-1">作文題目（全文）</label>
            <textarea className={inputCls} rows={8} value={value.topicText} disabled={readOnly} onChange={(e) => set('topicText', e.target.value)} placeholder="題目引導語、寫作條件、注意事項…" />
          </section>

          <section>
            <label className="block text-sm font-semibold text-gray-800 mb-1">圖片內容描述 <span className="font-normal text-xs text-gray-500">（看圖寫作才需要；只描述看得到的，不要寫寓意）</span></label>
            <textarea className={inputCls} rows={3} value={value.imageDescription} disabled={readOnly} onChange={(e) => set('imageDescription', e.target.value)} placeholder="題目沒有圖片就留空" />
          </section>

          <section>
            <label className="block text-sm font-semibold text-gray-800 mb-1">寫作任務 <span className="font-normal text-xs text-gray-500">（學生要回應什麼才算切題）</span></label>
            <div className="space-y-2">
              {value.writingTasks.map((t, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="mt-2 text-xs text-gray-500 w-4 shrink-0">{i + 1}.</span>
                  <textarea className={inputCls} rows={2} value={t} disabled={readOnly} onChange={(e) => set('writingTasks', value.writingTasks.map((x, k) => (k === i ? e.target.value : x)))} />
                  {!readOnly && (
                    <button type="button" aria-label="刪除這一點" onClick={() => set('writingTasks', value.writingTasks.filter((_, k) => k !== i))} className="mt-1.5 p-1.5 rounded hover:bg-red-50">
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <button type="button" onClick={() => set('writingTasks', [...value.writingTasks, ''])} className="inline-flex items-center gap-1 text-xs text-green-700 hover:underline">
                  <Plus className="w-3.5 h-3.5" /> 新增一點
                </button>
              )}
            </div>
          </section>

          <section>
            <label className="block text-sm font-semibold text-gray-800 mb-1">可接受的詮釋範圍</label>
            <textarea className={inputCls} rows={4} value={value.acceptableRange} disabled={readOnly} onChange={(e) => set('acceptableRange', e.target.value)} placeholder="例：抽象、比喻、意象式的寫法只要能扣回題目核心，也算切題…" />
          </section>

          <section>
            <label className="block text-sm font-semibold text-gray-800 mb-1">離題與抄題的定義</label>
            <textarea className={inputCls} rows={3} value={value.offTopicRule} disabled={readOnly} onChange={(e) => set('offTopicRule', e.target.value)} />
          </section>

          <section className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-sm font-semibold text-gray-800 mb-1">評分規準：會考寫作測驗六級分（內建）</div>
            <ul className="text-xs text-gray-600 space-y-1">
              {RUBRIC_DIMENSIONS.map((d) => (
                <li key={d.name}><b className="text-gray-800">{d.name}</b>：{d.note}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-gray-500">滿分 6 分＝六級分。AI 會給「建議級分」與逐句修改建議，最後成績由你確認。</p>
          </section>
        </div>

        {/* ── 右：稿紙預覽 ── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-gray-800">作文稿紙 <span className="font-normal text-xs text-gray-500">B4（8K）・每面 {ESSAY_GRID.cols} 行 × {ESSAY_GRID.rows} 格＝{ESSAY_GRID.cols * ESSAY_GRID.rows} 格・正反兩頁</span></div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs">
                {[0, 1].map((p) => (
                  <button key={p} type="button" onClick={() => setPreviewPage(p)} className={`px-3 py-1 ${p > 0 ? 'border-l border-gray-300' : ''} ${previewPage === p ? 'bg-green-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>第 {p + 1} 頁</button>
                ))}
              </div>
              <Button type="button" variant="outline" onClick={() => void handleDownload()} disabled={!sheet || downloading}>
                {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                下載稿紙 PDF
              </Button>
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-slate-100 p-3 flex items-center justify-center min-h-[320px]">
            {headerFailed && <p className="text-sm text-red-600">稿紙標頭圖載入失敗，請重新整理後再試。</p>}
            {!headerFailed && !previewUrl && <Loader2 className="w-6 h-6 animate-spin text-gray-400" />}
            {previewUrl && <img src={previewUrl} alt={`作文稿紙第 ${previewPage + 1} 頁預覽`} className="max-h-[70vh] w-auto bg-white shadow" />}
          </div>
          <p className="mt-2 text-xs text-gray-500 leading-relaxed">
            請用 <b>B4（8K）雙面列印</b>、不要縮放。學生把紙橫放書寫（座號欄在右側）：由右邊第 1 行開始、由上往下寫。
            批改時系統依稿紙上的定位方塊對齊，不需要再框選作答區。
          </p>
        </div>
      </div>
    </div>
  )
}
