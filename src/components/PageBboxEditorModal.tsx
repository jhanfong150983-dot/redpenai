// 2026-09-14 user：「4-I-1 讓我意識到這樣很難框」→ 點截圖預覽直接跳出整頁大圖框選。
//   取代原本「調整框選區域」按鈕＋在 144px 高的小縮圖上拖曳。
//   老師在整頁上拖曳畫框；可切頁（AI 有時把題目放錯頁）；確定後回傳 normalized bbox + pageIndex。
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import Button from '@/components/ui/Button'

export interface NormalizedBbox { x: number; y: number; w: number; h: number }

interface Props {
  /** 各頁圖（依頁序）；沒有圖就顯示提示 */
  pageBlobs: Blob[]
  /** 題號（顯示用） */
  questionId: string
  /** 目前的頁 */
  initialPage: number
  /** 目前的框（老師框或 AI 框）；null＝尚未框 */
  initialBbox: NormalizedBbox | null
  /** 目前的框是不是 AI 自動標記（決定顏色與提示） */
  isAiBbox: boolean
  onConfirm: (bbox: NormalizedBbox, pageIndex: number) => void
  onClear: () => void
  onClose: () => void
}

export default function PageBboxEditorModal({ pageBlobs, questionId, initialPage, initialBbox, isAiBbox, onConfirm, onClear, onClose }: Props) {
  const [page, setPage] = useState(Math.min(Math.max(0, initialPage), Math.max(0, pageBlobs.length - 1)))
  const [draft, setDraft] = useState<NormalizedBbox | null>(null)
  const [drawing, setDrawing] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const url = useMemo(() => (pageBlobs[page] ? URL.createObjectURL(pageBlobs[page]) : null), [pageBlobs, page])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 換頁後原框不再適用（只在同頁顯示原框）
  const shown: NormalizedBbox | null = draft ?? (page === initialPage ? initialBbox : null)
  const shownIsAi = !draft && page === initialPage && isAiBbox

  const norm = (e: React.PointerEvent) => {
    const el = imgRef.current ?? boxRef.current; if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }
  }
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!url) return
    const c = norm(e); if (!c) return
    start.current = c; setDrawing(true); setDraft({ x: c.x, y: c.y, w: 0, h: 0 })
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing || !start.current) return
    const c = norm(e); if (!c) return
    const s = start.current
    setDraft({ x: Math.min(s.x, c.x), y: Math.min(s.y, c.y), w: Math.abs(c.x - s.x), h: Math.abs(c.y - s.y) })
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing) return
    setDrawing(false); start.current = null
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId) } catch { /* noop */ }
    // 太小＝誤點，不當作框
    if (draft && (draft.w < 0.005 || draft.h < 0.005)) setDraft(null)
  }
  const canConfirm = !!draft && draft.w >= 0.005 && draft.h >= 0.005

  return (
    <div className="fixed inset-0 z-[130] bg-black/70 flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[96vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 shrink-0">
          <div className="text-sm">
            <span className="font-semibold text-gray-800">框選作答區 <span className="ml-1">{questionId}</span></span>
            <span className="ml-3 text-xs text-gray-500">在考卷上按住拖曳，框住學生會作答的整個範圍</span>
          </div>
          <div className="flex items-center gap-2">
            {pageBlobs.length > 1 && (
              <div className="flex items-center gap-1 text-xs text-gray-600">
                <button type="button" className="p-1 rounded hover:bg-gray-100 disabled:opacity-30" disabled={page <= 0} onClick={() => { setPage((p) => p - 1); setDraft(null) }} aria-label="上一頁"><ChevronLeft className="w-4 h-4" /></button>
                <span className="tabular-nums">第 {page + 1} / {pageBlobs.length} 頁</span>
                <button type="button" className="p-1 rounded hover:bg-gray-100 disabled:opacity-30" disabled={page >= pageBlobs.length - 1} onClick={() => { setPage((p) => p + 1); setDraft(null) }} aria-label="下一頁"><ChevronRight className="w-4 h-4" /></button>
              </div>
            )}
            <button type="button" onClick={onClose} className="p-1 rounded hover:bg-gray-100" aria-label="關閉"><X className="w-5 h-5 text-gray-500" /></button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto bg-gray-100 flex justify-center items-start p-3">
          {url ? (
            <div
              ref={boxRef}
              className="relative inline-block self-start select-none cursor-crosshair touch-none leading-[0]"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              <img ref={imgRef} src={url} alt={`第 ${page + 1} 頁`} className="block max-w-full pointer-events-none" draggable={false} style={{ maxHeight: 'calc(96vh - 110px)' }} />
              {shown && (
                <div
                  className={`absolute border-2 pointer-events-none ${draft ? 'border-green-600 bg-green-500/15' : shownIsAi ? 'border-blue-500 bg-blue-500/10' : 'border-green-500 bg-green-500/10'}`}
                  style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.w * 100}%`, height: `${shown.h * 100}%` }}
                />
              )}
            </div>
          ) : (
            <div className="text-sm text-gray-500 self-center">尚無這一頁的圖片</div>
          )}
        </div>
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-200 shrink-0 text-xs">
          <div className="text-gray-500">
            {draft
              ? '新框（綠）會取代原本的框'
              : shown
                ? (shownIsAi ? '藍框＝AI 自動標記；直接拖曳畫新框即可取代' : '綠框＝老師框選；直接拖曳畫新框即可取代')
                : '尚未框選'}
          </div>
          <div className="flex items-center gap-2">
            {(initialBbox && !isAiBbox) && (
              <button type="button" onClick={() => { onClear(); onClose() }} className="px-2 py-1 text-gray-500 hover:text-red-600">清除老師框選（改用 AI 框）</button>
            )}
            <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
            <Button size="sm" disabled={!canConfirm} onClick={() => { if (draft) { onConfirm(draft, page); onClose() } }}>確定</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
