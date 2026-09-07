// 2026-09-04 step④ 作答卷製作（生成答案卷單一流程的新步驟）。
//   分工：左＝版面參數（紙張、每列格數、格高）；右＝整頁即時預覽，點格開「格編輯視窗」
//   （格內所有物件：文字方塊、底圖）——底圖入口統一在格編輯視窗。
//   排版由 answerSheetGenerator（RPGEN2）決定性產出；⛔ 預覽與最終 PDF 必須同一引擎。
//   v1 調整能力＝參數化（不做自由拖格——與單頁保證/排版決定性相衝，v2 再評估）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, AlignLeft, AlignCenter, AlignRight, ArrowUpToLine, AlignVerticalJustifyCenter, ArrowDownToLine } from 'lucide-react'
import {
  generateAnswerSheet,
  type GenBaseImage,
  type GenCellText,
  type GenQuestion,
  type GenResult,
  type PageSize,
  type RefStroke,
  type SectionOverride
} from '../lib/answerSheetGenerator'

/** step④ 的可調狀態（存進 template.generatedSheet.sectionOverrides 等） */
export interface SheetMakerState {
  pageSize: PageSize
  sectionOverrides: Record<string, SectionOverride>
  /** 底圖：題目 id → 底圖（框選來源欄位僅題本框選有；上傳 jpg/png 無） */
  baseImages: Record<string, GenBaseImage & { bookletPage?: number; rect?: { x: number; y: number; w: number; h: number } }>
  /** 格內文字方塊：題目 id → 文字清單（點預覽格子編輯） */
  cellTexts: Record<string, GenCellText[]>
  /** 2026-09-07 內建參考答案：題目 id → 參考答案（紅字，只老師/批改看；學生版下載不含） */
  refAnswers?: Record<string, string>
  /** 2026-09-07 內建正解圖（畫筆）：題目 id → 紅色筆畫（繪圖題用；只老師版，學生版絕不含） */
  refDrawings?: Record<string, RefStroke[]>
}

export const EMPTY_SHEET_MAKER_STATE: SheetMakerState = { pageSize: 'A4', sectionOverrides: {}, baseImages: {}, cellTexts: {}, refAnswers: {}, refDrawings: {} }

// 標頭圖 data URI 模組層快取：元件卸載/重掛載（來回步驟）時免重 fetch、避免預覽空白
let cachedOmrHeader: string | null = null

interface Props {
  title: string
  questions: GenQuestion[]
  /** 題本每頁圖（dataURL/objectURL；底圖框選來源） */
  bookletImages: string[]
  state: SheetMakerState
  onStateChange: (next: SheetMakerState) => void
  /** 每次重排結果回拋（ok 才能儲存定版） */
  onResult?: (result: GenResult | null) => void
  /** 老師版（帶紅字參考答案）result；供「AI 解析」那步下載列印手寫。學生版走 onResult。 */
  onTeacherResult?: (result: GenResult | null) => void
  /** 版面能否放進單面一頁：ok=放得下、overflow=塞不下(需換B4/調小)、pending=計算中。供父層按鈕明確說明為何不能繼續。 */
  onFitStatus?: (status: 'ok' | 'overflow' | 'pending') => void
  /** 製作作答卷時就地改題型（AI 分類錯→老師選對，立刻重排版面，不必等人工檢核）。qids=該大題所有題號 */
  onQuestionCategoryChange?: (qids: string[], category: string) => void
}

// 製作作答卷可就地切換的題型（涵蓋版型差異大的類別；細分留人工檢核）
const SHEET_TYPE_OPTIONS: Array<[string, string]> = [
  ['single_choice', '選擇題（寫代號）'],
  ['true_false', '是非題'],
  ['fill_blank', '填空題'],
  ['short_answer', '簡答題'],
  ['fill_variants', '多元填空／注釋'],
  ['word_problem', '應用題（大框）'],
  ['grid_geometry', '作圖題'],
  ['circle_select_one', '圈選題'],
  ['mark_in_text', '圈詞題'],
  ['connect_dots', '連連看'],
  ['map_fill', '塗色／填圖'],
]

function sectionKeyOf(id: string): string {
  const parts = String(id).split('-')
  return parts.length > 1 ? parts.slice(0, -1).join('-') : id
}

const BIG_KINDS = new Set(['grid_geometry', 'word_problem'])
// 生成器也排「大框」的圈選/圖類（與 answerSheetGenerator 的 BIGBOX_IMAGE_TYPES 對齊）→ 控制面板要用大框控制項
const BIGBOX_IMAGE_KINDS = new Set(['circle_select_one', 'circle_select_many', 'matching', 'mark_in_text', 'map_symbol', 'connect_dots', 'diagram_draw', 'diagram_color', 'map_fill'])

// 文字寬度「實測」（同字型同字級；估算式對空白/混排不準會造成編輯器與卷面不一致）
// 2026-09-06 一律標楷體（文字方塊＋作答卷）：Windows=DFKai-SB/標楷體、mac=BiauKai、fallback Noto Serif TC
const SHEET_FONT = '"DFKai-SB", "BiauKai", "標楷體", "TW-Kai", "Noto Serif TC", serif'
let _measureCtx: CanvasRenderingContext2D | null = null
function measureTextPx(text: string, fontPx: number): number {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d')
  if (!_measureCtx) return text.length * fontPx
  _measureCtx.font = `${fontPx}px ${SHEET_FONT}`
  return _measureCtx.measureText(text).width
}

export default function AnswerSheetMakerStep({ title, questions, bookletImages, state, onStateChange, onResult, onTeacherResult, onFitStatus, onQuestionCategoryChange }: Props) {
  // 2026-09-07 標頭圖快取在模組層：離開製作作答卷再回來時元件會卸載/重掛載，
  //   若每次都重 fetch，headerDataUri 歸 null 期間 result=null → 預覽空白（user 回報「回上一步空白」）。
  //   快取後重掛載直接用、result 立刻算出、不空白。
  const [headerDataUri, setHeaderDataUri] = useState<string | null>(cachedOmrHeader)
  const [headerError, setHeaderError] = useState(false)
  const [cropTarget, setCropTarget] = useState<string | null>(null)
  const [editCell, setEditCell] = useState<string | null>(null)

  useEffect(() => {
    if (headerDataUri) return // 已有（模組快取）→ 免重 fetch
    let cancelled = false
    fetch('/templates/omr-header.png')
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('header fetch failed'))))
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const fr = new FileReader()
            fr.onload = () => resolve(String(fr.result))
            fr.onerror = () => reject(new Error('header read failed'))
            fr.readAsDataURL(blob)
          })
      )
      .then((uri) => {
        cachedOmrHeader = uri // 存模組快取，之後重掛載直接用
        if (!cancelled) setHeaderDataUri(uri)
      })
      .catch(() => {
        if (!cancelled) setHeaderError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 大題分組（控制面板用）
  const sections = useMemo(() => {
    const map = new Map<string, GenQuestion[]>()
    for (const q of questions) {
      const key = sectionKeyOf(q.id)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(q)
    }
    return [...map.entries()].flatMap(([key, qs]) => {
      const hintName = qs.map((q) => (String(q.anchorHint ?? '').match(/『(.+?)』/) ?? [])[1]).find(Boolean)
      const isChoice = qs.every((q) => ['single_choice', 'multi_choice', 'true_false'].includes(q.questionCategory))
      const hasBig = qs.some((q) => BIG_KINDS.has(q.questionCategory))
      // 圈選/連線/圈詞/繪圖/填圖類＝生成器也排「大框」，但不在 BIG_KINDS → 之前控制面板誤顯示 grid 控制項(每列格數/格高)、對大框無效。
      //   這類改用大框控制卡（每列格數=perRow、大格高度=bigH 預設50，與 buildSections 對齊）。
      const hasImageBig = !hasBig && qs.some((q) => BIGBOX_IMAGE_KINDS.has(q.questionCategory))
      if (hasImageBig) {
        return [{ key, qs, name: hintName ?? '作答區', isChoice: false, hasBig: true, bigDefault: 50 }]
      }
      if (!hasBig) {
        return [{ key, qs, name: hintName ?? (isChoice ? '選擇題' : '作答區'), isChoice, hasBig, bigDefault: 0 }]
      }
      // 作圖/計算拆成獨立控制卡（卷面仍同一個大題標題）；子鍵對應引擎的分開覆寫
      const gridQs = qs.filter((q) => q.questionCategory === 'grid_geometry')
      const essayQs = qs.filter((q) => !BIG_KINDS.has(q.questionCategory) ? false : q.questionCategory !== 'grid_geometry')
      const base = hintName ?? '計算作圖題'
      const cards = [] as Array<{ key: string; qs: GenQuestion[]; name: string; isChoice: boolean; hasBig: boolean; bigDefault: number }>
      if (gridQs.length) cards.push({ key: `${key}:grid`, qs: gridQs, name: `${base}・作圖（${gridQs.length} 題）`, isChoice: false, hasBig: true, bigDefault: 58 })
      if (essayQs.length) cards.push({ key: `${key}:essay`, qs: essayQs, name: `${base}・計算（${essayQs.length} 題）`, isChoice: false, hasBig: true, bigDefault: 44 })
      return cards
    })
  }, [questions])

  // 即時重排（決定性：同輸入同結果）
  const result = useMemo<ReturnType<typeof generateAnswerSheet> | null>(() => {
    if (!headerDataUri) return null
    const qs = questions.map((q) => ({
      ...q,
      ...(state.baseImages[q.id] ? { baseImage: state.baseImages[q.id] } : {}),
      ...(state.cellTexts?.[q.id]?.length ? { cellTexts: state.cellTexts[q.id] } : {}),
      ...(state.refAnswers?.[q.id] ? { refAnswer: state.refAnswers[q.id] } : {}),
    }))
    // ⛔ 鐵律：canonical result（onResult→存檔/學生下載）＝學生版、絕不帶紅字。
    //   紅字參考答案只在下方 previewResult（顯示用）畫；老師版帶紅的 PDF 由 AI 解析那條另生（Phase 3+）。
    return generateAnswerSheet({
      title,
      pageSize: state.pageSize,
      questions: qs,
      headerDataUri,
      sectionOverrides: state.sectionOverrides,
    })
  }, [title, questions, headerDataUri, state])

  // 預覽專用：帶紅字參考答案（老師看；不進 onResult、不落存檔）
  const previewResult = useMemo<ReturnType<typeof generateAnswerSheet> | null>(() => {
    if (!headerDataUri) return null
    const hasRef = questions.some((q) => (state.refAnswers?.[q.id] ?? '').trim() || (state.refDrawings?.[q.id]?.length ?? 0) > 0)
    if (!hasRef) return result // 沒填參考答案/正解圖 → 直接用 canonical（省一次生成）
    const qs = questions.map((q) => ({
      ...q,
      ...(state.baseImages[q.id] ? { baseImage: state.baseImages[q.id] } : {}),
      ...(state.cellTexts?.[q.id]?.length ? { cellTexts: state.cellTexts[q.id] } : {}),
      ...(state.refAnswers?.[q.id] ? { refAnswer: state.refAnswers[q.id] } : {}),
      ...(state.refDrawings?.[q.id]?.length ? { refDrawing: state.refDrawings[q.id] } : {}),
    }))
    return generateAnswerSheet({ title, pageSize: state.pageSize, questions: qs, headerDataUri, sectionOverrides: state.sectionOverrides, withRefAnswers: true })
  }, [title, questions, headerDataUri, state, result])

  useEffect(() => {
    onResult?.(result && result.ok ? (result as GenResult) : null)
    // 老師版（帶紅字參考答案）回傳給父層供「AI 解析」那步下載列印手寫用；學生版仍走 onResult
    onTeacherResult?.(previewResult && previewResult.ok ? (previewResult as GenResult) : null)
    // 版面適配狀態：result 尚未算出=pending；算出但 ok=false=塞不下(overflow)；ok=放得下
    onFitStatus?.(!result ? 'pending' : result.ok ? 'ok' : 'overflow')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, previewResult])

  const setOverride = (key: string, patch: Partial<SectionOverride>) => {
    onStateChange({
      ...state,
      sectionOverrides: { ...state.sectionOverrides, [key]: { ...state.sectionOverrides[key], ...patch } }
    })
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 min-h-0">
      {/* 左：控制面板 */}
      <div className="lg:w-72 shrink-0 space-y-3 overflow-y-auto">
        <div className="border rounded-lg p-3">
          <div className="text-xs font-bold text-gray-500 mb-2">紙張大小</div>
          <div className="flex gap-2">
            {(['A4', 'B4'] as PageSize[]).map((ps) => (
              <button
                key={ps}
                type="button"
                onClick={() => onStateChange({ ...state, pageSize: ps })}
                className={`flex-1 py-1.5 rounded border text-sm ${state.pageSize === ps ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700'}`}
              >
                {ps}
              </button>
            ))}
          </div>
        </div>

        {sections.map((sec) => {
          const ov = state.sectionOverrides[sec.key] ?? {}
          return (
            <div key={sec.key} className="border rounded-lg p-3 space-y-2">
              <div className="text-sm font-bold">{sec.name}</div>
              <div className="text-[11px] text-gray-400">{sec.qs.length} 題</div>
              {/* 就地改題型（AI 分類錯→老師選對，立刻重排）*/}
              {onQuestionCategoryChange && (() => {
                const cats = sec.qs.map((q) => q.questionCategory)
                const cur = cats[0] ?? ''
                const known = SHEET_TYPE_OPTIONS.some(([v]) => v === cur)
                return (
                  <label className="block text-xs text-gray-500">
                    題型{cats.some((c) => c !== cur) ? '（本區不一致，改此會統一）' : ''}
                    <select
                      value={known ? cur : ''}
                      onChange={(e) => e.target.value && onQuestionCategoryChange(sec.qs.map((q) => q.id), e.target.value)}
                      className="mt-0.5 w-full border rounded px-2 py-1 text-sm"
                    >
                      {!known && <option value="">{cur || '（未分類）'}</option>}
                      {SHEET_TYPE_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                    </select>
                  </label>
                )
              })()}
              {!sec.hasBig && (
                <>
                  {(() => { const isWide = sec.qs.some((q) => ['short_answer', 'fill_variants'].includes(q.questionCategory)); return (
                  <label className="block text-xs text-gray-500">
                    每列格數
                    <select
                      value={ov.cols ?? (sec.isChoice ? 10 : isWide ? 2 : 5)}
                      onChange={(e) => setOverride(sec.key, { cols: Number(e.target.value) })}
                      className="mt-0.5 w-full border rounded px-2 py-1 text-sm"
                    >
                      {(sec.isChoice ? [8, 10] : isWide ? [1, 2, 3, 4] : [3, 4, 5, 6]).map((c) => (
                        <option key={c} value={c}>{c} 格</option>
                      ))}
                    </select>
                  </label>
                  ) })()}
                  <label className="block text-xs text-gray-500">
                    格子高度
                    <div className="mt-0.5 flex gap-1">
                      {([['s', '小'], ['m', '中'], ['l', '大']] as const).map(([v, label]) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setOverride(sec.key, { cellSize: v })}
                          className={`flex-1 py-1 rounded border text-xs ${(ov.cellSize ?? 'm') === v ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </label>
                </>
              )}
              {sec.hasBig && (
                <>
                  <label className="block text-xs text-gray-500">
                    每列格數
                    <select
                      value={ov.perRow ?? 0}
                      onChange={(e) => setOverride(sec.key, { perRow: Number(e.target.value) || undefined })}
                      className="mt-0.5 w-full border rounded px-2 py-1 text-sm"
                    >
                      <option value={0}>自動</option>
                      {[1, 2, 3].map((c) => (
                        <option key={c} value={c}>{c} 格</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-gray-500">
                    大格高度：{ov.bigH ?? sec.bigDefault} mm
                    <input
                      type="range"
                      min={30}
                      max={90}
                      step={2}
                      value={ov.bigH ?? sec.bigDefault}
                      onChange={(e) => setOverride(sec.key, { bigH: Number(e.target.value) })}
                      className="w-full"
                    />
                  </label>
                  <p className="text-[11px] text-gray-400">底圖與格內文字：點右側預覽的格子編輯</p>
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* 右：整頁即時預覽 */}
      <div className="flex-1 min-w-0">
        {headerError && <div className="text-sm text-red-600">標頭圖載入失敗，請重新整理後再試</div>}
        {!result && !headerError && <div className="text-sm text-gray-400 py-10 text-center">版面計算中…</div>}
        {result && !result.ok && (
          <div className="border-2 border-red-400 rounded-lg bg-red-50 p-3">
            <div className="text-sm text-red-700 font-bold mb-2">
              ⚠ 一頁裝不下（作答卷固定單面一頁）——請調小格子高度／大格高度、增加每列格數，或改用 B4。裝不下前無法儲存。
            </div>
            <div
              className="bg-white shadow mx-auto opacity-70 [&>svg]:w-full [&>svg]:h-auto"
              style={{ maxWidth: 560 }}
              dangerouslySetInnerHTML={{ __html: result.previewSvg }}
            />
            <div className="text-[11px] text-red-500 mt-1 text-center">（僅顯示塞得下的部分——超出的題目不在畫面上）</div>
          </div>
        )}
        {result && result.ok && (
          <div className="border rounded-lg bg-gray-100 p-3">
            <div className="text-[11px] text-gray-500 mb-2">單面一頁預覽</div>
            <div
              className="bg-white shadow mx-auto [&>svg]:w-full [&>svg]:h-auto"
              style={{ maxWidth: 560 }}
              onClick={(e) => {
                const qid = (e.target as Element)?.getAttribute?.('data-qid')
                if (qid) setEditCell(qid)
              }}
              dangerouslySetInnerHTML={{ __html: (previewResult?.ok ? previewResult.svg : result.svg) }}
            />
            <div className="text-[11px] text-gray-400 mt-1 text-center">點任一格可加入文字方塊／底圖／參考答案（紅字為參考答案，學生版不含）</div>
          </div>
        )}
      </div>

      {editCell && result?.ok && (() => {
        const box = (result as GenResult).boxes.find((b) => b.id === editCell)
        if (!box) return null
        const cat = String(questions.find((q) => q.id === editCell)?.questionCategory ?? '')
        const isDrawing = ['grid_geometry', 'map_symbol', 'connect_dots', 'diagram_draw', 'diagram_color', 'map_fill'].includes(cat)
        return (
          <CellEditModal
            qid={editCell}
            cellWMm={box.xyMm[2]}
            cellHMm={box.xyMm[3]}
            texts={state.cellTexts?.[editCell] ?? []}
            baseImage={state.baseImages[editCell] ?? null}
            hasBooklet={bookletImages.length > 0}
            refAnswer={state.refAnswers?.[editCell] ?? ''}
            refAnswerHint={undefined}
            isDrawing={isDrawing}
            refDrawing={state.refDrawings?.[editCell] ?? []}
            onRefDrawingChange={(strokes) => {
              const next = { ...(state.refDrawings ?? {}) }
              if (strokes.length) next[editCell] = strokes; else delete next[editCell]
              onStateChange({ ...state, refDrawings: next })
            }}
            onRefAnswerChange={(v) => {
              const next = { ...(state.refAnswers ?? {}) }
              if (v.trim()) next[editCell] = v; else delete next[editCell]
              onStateChange({ ...state, refAnswers: next })
            }}
            onTextsChange={(texts) => onStateChange({ ...state, cellTexts: { ...state.cellTexts, [editCell]: texts } })}
            onBaseImageChange={(entry) => {
              const next = { ...state.baseImages }
              if (entry) next[editCell] = entry
              else delete next[editCell]
              onStateChange({ ...state, baseImages: next })
            }}
            onOpenCrop={() => setCropTarget(editCell)}
            onClose={() => setEditCell(null)}
          />
        )
      })()}
      {cropTarget && (
        <BaseImageCropModal
          bookletImages={bookletImages}
          existing={state.baseImages[cropTarget]}
          onCancel={() => setCropTarget(null)}
          onDone={(img) => {
            const next = { ...state.baseImages }
            if (img) next[cropTarget] = img
            else delete next[cropTarget]
            onStateChange({ ...state, baseImages: next })
            setCropTarget(null)
          }}
        />
      )}
    </div>
  )
}

// ── 底圖框選（沿用 referenceBbox crosshair 慣例，作用對象＝題本頁）──────────
interface CropModalProps {
  bookletImages: string[]
  existing?: SheetMakerState['baseImages'][string]
  onCancel: () => void
  onDone: (img: SheetMakerState['baseImages'][string] | null) => void
}

function BaseImageCropModal({ bookletImages, existing, onCancel, onDone }: CropModalProps) {
  const [pageIdx, setPageIdx] = useState(existing?.bookletPage ?? 0)
  const [align, setAlign] = useState<'left' | 'center' | 'right'>(existing?.align ?? 'center')
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(existing?.rect ?? null)
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const norm = (e: React.MouseEvent) => {
    const el = containerRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    }
  }

  const confirm = async () => {
    if (!draft || draft.w < 0.02 || draft.h < 0.02) return
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('題本圖載入失敗'))
      img.src = bookletImages[pageIdx]
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(draft.w * img.naturalWidth)
    canvas.height = Math.round(draft.h * img.naturalHeight)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(
      img,
      Math.round(draft.x * img.naturalWidth),
      Math.round(draft.y * img.naturalHeight),
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height
    )
    // 實體 mm：以題本 A4 直式比例換算（與原型一致）
    onDone({
      dataUri: canvas.toDataURL('image/png'),
      wMm: draft.w * 210,
      hMm: draft.h * 297,
      align,
      bookletPage: pageIdx,
      rect: draft
    })
  }

  return (
    <div className="fixed inset-0 z-[140] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="font-bold text-sm">框選作答底圖（拖曳選取題本上的作答區圖形）</div>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-4 overflow-y-auto">
          {bookletImages.length > 1 && (
            <div className="flex gap-1 mb-2">
              {bookletImages.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => { setPageIdx(i); setDraft(null) }}
                  className={`px-2 py-1 rounded border text-xs ${i === pageIdx ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'}`}
                >
                  第 {i + 1} 頁
                </button>
              ))}
            </div>
          )}
          <div
            ref={containerRef}
            className="relative cursor-crosshair select-none"
            onMouseDown={(e) => {
              const p = norm(e)
              if (p) { setDrawStart(p); setDraft(null) }
            }}
            onMouseMove={(e) => {
              if (!drawStart) return
              const p = norm(e)
              if (!p) return
              setDraft({
                x: Math.min(drawStart.x, p.x),
                y: Math.min(drawStart.y, p.y),
                w: Math.abs(p.x - drawStart.x),
                h: Math.abs(p.y - drawStart.y)
              })
            }}
            onMouseUp={() => setDrawStart(null)}
          >
            <img src={bookletImages[pageIdx]} alt="題本" className="w-full block" draggable={false} />
            {draft && (
              <div
                className="absolute border-2 border-green-500 bg-green-500/10 pointer-events-none"
                style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
              />
            )}
          </div>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => onDone(null)} className="text-sm text-red-600">清除底圖</button>
            <span className="mx-1 text-gray-300">｜</span>
            <span className="text-xs text-gray-500">格內位置</span>
            {([['left', '靠左'], ['center', '置中'], ['right', '靠右']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => setAlign(v)}
                className={`px-2 py-1 rounded border text-xs ${align === v ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded border text-sm">取消</button>
            <button
              type="button"
              onClick={confirm}
              disabled={!draft || draft.w < 0.02 || draft.h < 0.02}
              className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm disabled:opacity-40"
            >
              使用此底圖
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 格編輯視窗（Canva 式）：格子即畫布——文字方塊就地打字拖曳、底圖 8 點縮放拖移 ──
type BaseImageEntry = GenBaseImage & { bookletPage?: number; rect?: { x: number; y: number; w: number; h: number } }

function CellEditModal({ qid, cellWMm, cellHMm, texts, baseImage, hasBooklet, refAnswer, refAnswerHint, isDrawing, refDrawing, onRefDrawingChange, onRefAnswerChange, onTextsChange, onBaseImageChange, onOpenCrop, onClose }: {
  qid: string
  cellWMm: number
  cellHMm: number
  texts: GenCellText[]
  baseImage: BaseImageEntry | null
  hasBooklet: boolean
  refAnswer: string
  refAnswerHint?: string
  isDrawing: boolean
  refDrawing: RefStroke[]
  onRefDrawingChange: (strokes: RefStroke[]) => void
  onRefAnswerChange: (v: string) => void
  onTextsChange: (texts: GenCellText[]) => void
  onBaseImageChange: (entry: BaseImageEntry | null) => void
  onOpenCrop: () => void
  onClose: () => void
}) {
  // px/mm 縮放：畫布上限放大（760×500、單格最多 11x），modal max-w-95vw/max-h-90vh 仍保護不爆版
  const k = Math.min(760 / cellWMm, 500 / cellHMm, 11)
  const [selected, setSelected] = useState<number | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ kind: 'text' | 'img-move' | 'img-resize'; idx?: number; handle?: string; sx: number; sy: number; ox: number; oy: number; ow?: number; oh?: number } | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  // 畫筆（繪圖題正解圖，紅色、只老師版）：off/直線/曲線/圓橢圓/矩形/箭頭/塗色。
  //   點座標存 0~1 正規化（隨格子縮放）。用 ref 存進行中筆畫、drawTick 觸發重繪避免 stale closure。
  type DrawMode = 'off' | 'line' | 'curve' | 'ellipse' | 'rect' | 'arrow' | 'fill'
  const [drawMode, setDrawMode] = useState<DrawMode>('off')
  const TWO_PT = (m: DrawMode) => m === 'line' || m === 'ellipse' || m === 'rect' || m === 'arrow' // 拖框類：只留起訖兩點
  const drawingRef = useRef(false)
  const liveRef = useRef<Array<[number, number]> | null>(null)
  const [, setDrawTick] = useState(0)
  const toNorm = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const nx = Math.min(1, Math.max(0, (e.clientX - rect.left) / (cellWMm * k)))
    const ny = Math.min(1, Math.max(0, (e.clientY - rect.top) / (cellHMm * k)))
    return [+nx.toFixed(4), +ny.toFixed(4)]
  }
  const startStroke = (e: React.PointerEvent) => {
    e.stopPropagation()
    drawingRef.current = true
    liveRef.current = [toNorm(e)]
    setDrawTick((t) => t + 1)
  }
  const moveStroke = (e: React.PointerEvent) => {
    if (!drawingRef.current || !liveRef.current) return
    const p = toNorm(e)
    liveRef.current = TWO_PT(drawMode) ? [liveRef.current[0], p] : [...liveRef.current, p]
    setDrawTick((t) => t + 1)
  }
  // 進行中兩點 → 對應形狀 RefStroke（拖框類 rect/ellipse 由 bounding box 算）
  const strokeFromLive = (mode: DrawMode, pts: Array<[number, number]>): RefStroke | null => {
    if (pts.length < 2) return null
    const a = pts[0], b = pts[pts.length - 1]
    if (mode === 'rect') return { type: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) }
    if (mode === 'ellipse') return { type: 'ellipse', cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2 }
    if (mode === 'arrow') return { type: 'arrow', pts: [a, b] }
    if (mode === 'fill') return { type: 'fill', pts }
    return { type: 'poly', pts } // line(2點)/curve(多點)
  }
  const endStroke = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    const s = liveRef.current
    liveRef.current = null
    const stroke = s ? strokeFromLive(drawMode, s) : null
    if (stroke) onRefDrawingChange([...refDrawing, stroke])
    setDrawTick((t) => t + 1)
  }
  // 一筆 RefStroke → React SVG（各形狀）。SX/SY：正規化 0~1 → 畫布 px。dashed=進行中預覽。
  const SX = (nx: number) => nx * cellWMm * k
  const SY = (ny: number) => ny * cellHMm * k
  const drawEl = (s: RefStroke, key: React.Key, dashed = false) => {
    const type = s.type ?? 'poly'
    const RED = '#c00'; const sw = 1.4; const dash = dashed ? '5 3' : undefined
    if (type === 'rect' && s.w != null && s.h != null)
      return <rect key={key} x={SX(s.x ?? 0)} y={SY(s.y ?? 0)} width={s.w * cellWMm * k} height={s.h * cellHMm * k} fill="none" stroke={RED} strokeWidth={sw} strokeDasharray={dash} />
    if (type === 'ellipse' && s.rx != null && s.ry != null)
      return <ellipse key={key} cx={SX(s.cx ?? 0)} cy={SY(s.cy ?? 0)} rx={s.rx * cellWMm * k} ry={s.ry * cellHMm * k} fill="none" stroke={RED} strokeWidth={sw} strokeDasharray={dash} />
    if (s.pts && s.pts.length >= 2) {
      const pstr = s.pts.map(([px, py]) => `${SX(px)},${SY(py)}`).join(' ')
      if (type === 'fill')
        return <polygon key={key} points={pstr} fill="rgba(204,0,0,0.30)" stroke={RED} strokeWidth={sw} strokeLinejoin="round" strokeDasharray={dash} />
      if (type === 'arrow') {
        const a = s.pts[0], b = s.pts[s.pts.length - 1]
        const bx = SX(b[0]), by = SY(b[1]); const ang = Math.atan2(by - SY(a[1]), bx - SX(a[0])); const hl = 10, th = 0.44
        return (
          <g key={key}>
            <line x1={SX(a[0])} y1={SY(a[1])} x2={bx} y2={by} stroke={RED} strokeWidth={sw} strokeDasharray={dash} strokeLinecap="round" />
            <polygon points={`${bx},${by} ${bx - hl * Math.cos(ang - th)},${by - hl * Math.sin(ang - th)} ${bx - hl * Math.cos(ang + th)},${by - hl * Math.sin(ang + th)}`} fill={RED} />
          </g>
        )
      }
      return <polyline key={key} points={pstr} fill="none" stroke={RED} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} />
    }
    return null
  }

  const sizeMm = (t: GenCellText) => (t.size === 's' ? 2.6 : t.size === 'l' ? 4.2 : 3.2)

  // 舊 preset 文字轉自由座標（開啟時一次）；底圖無 place 時補 fit place（與引擎舊 fit 對齊）
  useEffect(() => {
    let changed = false
    const converted = texts.map((t) => {
      if (t.xMm != null && t.yMm != null) return t
      changed = true
      const size = sizeMm(t)
      const pos = t.pos ?? 'tl'
      const pad = 1.5
      const xMm = pos.endsWith('l') ? pad : pos.endsWith('c') ? cellWMm / 2 - 8 : cellWMm - pad - 16
      const yMm = pos.startsWith('t') ? pad : pos.startsWith('m') ? cellHMm / 2 - size / 2 : cellHMm - pad - size
      return { ...t, xMm: +xMm.toFixed(1), yMm: +Math.max(0, yMm).toFixed(1) }
    })
    if (changed) onTextsChange(converted)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (baseImage && !baseImage.place) {
      const availW = cellWMm - 2
      const availH = cellHMm - 2
      const sc = Math.min(availW / baseImage.wMm, availH / baseImage.hMm, 1e9)
      const wMm = +(baseImage.wMm * sc).toFixed(1)
      const hMm = +(baseImage.hMm * sc).toFixed(1)
      onBaseImageChange({ ...baseImage, place: { xMm: +((cellWMm - wMm) / 2).toFixed(1), yMm: +((cellHMm - hMm) / 2).toFixed(1), wMm, hMm } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseImage?.dataUri])

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

  // 2026-09-06 對齊工具：依文字方塊實測寬高，把 xMm/yMm snap 到格內對齊位置（水平左/中/右、垂直上/中/下）。
  //   讓老師一鍵對齊、每格一致（文字用自由座標定位，對齊＝重算座標）。
  const alignText = (i: number, axis: 'h' | 'v', where: 'start' | 'center' | 'end') => {
    const t = texts[i]
    const pad = 0.8 // 靠邊邊距（貼緣、與新增預設一致；1.5mm 太遠）
    const fs = sizeMm(t) * k
    const wMm = (Math.max(measureTextPx(t.text || '輸入文字', fs), 20) + 12) / k // 方塊外寬(含 padding/border)換算 mm
    const hMm = sizeMm(t) * 1.1 + 6 / k
    onTextsChange(texts.map((x, j) => {
      if (j !== i) return x
      if (axis === 'h') {
        const xMm = where === 'start' ? pad : where === 'center' ? (cellWMm - wMm) / 2 : cellWMm - wMm - pad
        return { ...x, xMm: +clamp(xMm, 0, cellWMm - 4).toFixed(1) }
      }
      const yMm = where === 'start' ? pad : where === 'center' ? (cellHMm - hMm) / 2 : cellHMm - hMm - pad
      return { ...x, yMm: +clamp(yMm, 0, cellHMm - 3).toFixed(1) }
    }))
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dxMm = (e.clientX - d.sx) / k
    const dyMm = (e.clientY - d.sy) / k
    if (d.kind === 'text' && d.idx != null) {
      onTextsChange(texts.map((t, i) => (i === d.idx ? { ...t, xMm: +clamp(d.ox + dxMm, 0, cellWMm - 4).toFixed(1), yMm: +clamp(d.oy + dyMm, 0, cellHMm - 3).toFixed(1) } : t)))
    } else if (baseImage?.place) {
      const p = baseImage.place
      if (d.kind === 'img-move') {
        onBaseImageChange({ ...baseImage, place: { ...p, xMm: +clamp(d.ox + dxMm, -p.wMm + 4, cellWMm - 4).toFixed(1), yMm: +clamp(d.oy + dyMm, -p.hMm + 4, cellHMm - 4).toFixed(1) } })
      } else if (d.kind === 'img-resize' && d.handle && d.ow != null && d.oh != null) {
        let { xMm, yMm } = { xMm: d.ox, yMm: d.oy }
        let wMm = d.ow
        let hMm = d.oh
        if (d.handle.includes('e')) wMm = d.ow + dxMm
        if (d.handle.includes('s')) hMm = d.oh + dyMm
        if (d.handle.includes('w')) { wMm = d.ow - dxMm; xMm = d.ox + dxMm }
        if (d.handle.includes('n')) { hMm = d.oh - dyMm; yMm = d.oy + dyMm }
        if (wMm < 4) { if (d.handle.includes('w')) xMm -= 4 - wMm; wMm = 4 }
        if (hMm < 4) { if (d.handle.includes('n')) yMm -= 4 - hMm; hMm = 4 }
        onBaseImageChange({ ...baseImage, place: { xMm: +xMm.toFixed(1), yMm: +yMm.toFixed(1), wMm: +wMm.toFixed(1), hMm: +hMm.toFixed(1) } })
      }
    }
  }
  const endDrag = () => { dragRef.current = null }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const dataUri = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('讀檔失敗'))
      fr.readAsDataURL(file)
    })
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('圖片載入失敗'))
      img.src = dataUri
    })
    const wMm = cellWMm * 0.5
    const hMm = wMm * (img.naturalHeight / Math.max(1, img.naturalWidth))
    onBaseImageChange({
      dataUri,
      wMm: +wMm.toFixed(1),
      hMm: +hMm.toFixed(1),
      place: { xMm: +((cellWMm - wMm) / 2).toFixed(1), yMm: +Math.max(0, (cellHMm - hMm) / 2).toFixed(1), wMm: +wMm.toFixed(1), hMm: +hMm.toFixed(1) }
    })
  }

  const HANDLES: Array<[string, string]> = [
    ['nw', 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize'],
    ['n', 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize'],
    ['ne', 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize'],
    ['e', 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize'],
    ['se', 'right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize'],
    ['s', 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize'],
    ['sw', 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize'],
    ['w', 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize']
  ]

  return (
    <div className="fixed inset-0 z-[130] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-fit max-w-[95vw] max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b">
          <div className="font-bold text-sm">編輯格子 <span className="font-mono text-xs text-gray-500">{qid}</span></div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="flex gap-3 p-4 overflow-auto">
          {/* 左：工具列 */}
          <div className="w-36 shrink-0 space-y-2">
            <button
              type="button"
              onClick={() => {
                // 2026-09-06 預設＝頂端細標題列（貼上緣、小字）：當題號/提示抬頭，下方整塊留給學生作答、不擠壓作答區。
                //   要別的位置/字級再用對齊工具與字級選單細調。多個方塊沿頂端往右錯開、不往下吃作答空間。
                onTextsChange([...texts, { text: '', size: 'm', xMm: +(0.8 + texts.length * 2.5).toFixed(1), yMm: 0.8 }])
                setSelected(texts.length)
              }}
              className="w-full text-xs px-2 py-1.5 rounded border text-blue-600 border-blue-300 hover:bg-blue-50 text-left"
            >
              ＋ 文字方塊
            </button>
            {hasBooklet && (
              <button type="button" onClick={onOpenCrop} className="w-full text-xs px-2 py-1.5 rounded border text-blue-600 border-blue-300 hover:bg-blue-50 text-left">
                ＋ 底圖（題本框選）
              </button>
            )}
            <button type="button" onClick={() => uploadRef.current?.click()} className="w-full text-xs px-2 py-1.5 rounded border text-blue-600 border-blue-300 hover:bg-blue-50 text-left">
              ＋ 底圖（上傳 jpg/png）
            </button>
            <input ref={uploadRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void handleUpload(e)} />
            {baseImage && (
              <button type="button" onClick={() => onBaseImageChange(null)} className="w-full text-xs px-2 py-1.5 rounded border text-red-500 border-red-200 hover:bg-red-50 text-left">
                清除底圖
              </button>
            )}
            <p className="text-[11px] text-gray-400 leading-relaxed pt-1">
              文字：框內打字、拖框移動。<br />底圖：拖曳移動、拉 8 點縮放。<br />改動即時反映在整份預覽。
            </p>
            {/* 2026-09-07 內建參考答案（紅字，只老師/批改看；學生版不含）*/}
            <div className="pt-2 mt-2 border-t">
              <div className="text-xs font-semibold text-red-600 mb-1">參考答案（紅字）</div>
              {refAnswerHint ? (
                <p className="text-[11px] text-amber-600 leading-relaxed">{refAnswerHint}</p>
              ) : (
                <>
                  <textarea
                    rows={2}
                    value={refAnswer}
                    onChange={(e) => onRefAnswerChange(e.target.value)}
                    placeholder="老師填的正解，會以紅字顯示"
                    className="w-full text-xs px-2 py-1 border border-red-200 rounded focus:border-red-400 focus:outline-none"
                  />
                  <p className="text-[11px] text-gray-400 mt-0.5">只老師／批改看得到；學生印的作答卷不會有。</p>
                </>
              )}
            </div>
            {/* 2026-09-07 正解圖畫筆（繪圖題用；紅色、只老師版）*/}
            {isDrawing && (
              <div className="pt-2 mt-2 border-t">
                <div className="text-xs font-semibold text-red-600 mb-1">正解圖（紅色畫筆）</div>
                <p className="text-[11px] text-amber-600 leading-relaxed mb-1.5">繪圖題可直接在右邊格子畫出正解，免印出手寫。只老師／批改看得到、學生版絕不含。</p>
                <div className="grid grid-cols-3 gap-1 mb-1">
                  {([['line', '直線'], ['curve', '曲線'], ['ellipse', '圓'], ['rect', '矩形'], ['arrow', '箭頭'], ['fill', '塗色']] as Array<[DrawMode, string]>).map(([m, label]) => (
                    <button key={m} type="button" onClick={() => setDrawMode(drawMode === m ? 'off' : m)}
                      className={`text-xs px-1 py-1.5 rounded border ${drawMode === m ? 'bg-red-600 text-white border-red-600' : 'text-red-600 border-red-300 hover:bg-red-50'}`}>{label}</button>
                  ))}
                </div>
                <div className="flex gap-1">
                  <button type="button" disabled={!refDrawing.length} onClick={() => onRefDrawingChange(refDrawing.slice(0, -1))}
                    className="flex-1 text-xs px-2 py-1 rounded border text-gray-600 border-gray-300 hover:bg-gray-50 disabled:opacity-40">復原</button>
                  <button type="button" disabled={!refDrawing.length} onClick={() => onRefDrawingChange([])}
                    className="flex-1 text-xs px-2 py-1 rounded border text-gray-600 border-gray-300 hover:bg-gray-50 disabled:opacity-40">清除</button>
                </div>
                {drawMode !== 'off' && (
                  <p className="text-[11px] text-red-500 mt-1">
                    {drawMode === 'curve' ? '在格子上按住拖曳＝自由曲線'
                      : drawMode === 'fill' ? '按住拖曳描出一塊區域→放開＝紅色塗滿（塗色/畫記題）'
                      : drawMode === 'line' ? '按住起點→拖到終點→放開＝直線'
                      : drawMode === 'arrow' ? '按住起點→拖到箭頭指向→放開＝箭頭'
                      : '按住拖曳出範圍→放開＝' + (drawMode === 'ellipse' ? '圓／橢圓' : '矩形')}
                    （可畫多筆）
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 右：格子畫布（1:1 比例） */}
          <div
            ref={canvasRef}
            className="relative bg-white border-2 border-gray-400 select-none"
            style={{ width: cellWMm * k, height: cellHMm * k, cursor: drawMode !== 'off' ? 'crosshair' : undefined, touchAction: drawMode !== 'off' ? 'none' : undefined }}
            onPointerMove={(e) => { if (drawMode !== 'off') moveStroke(e); else onPointerMove(e) }}
            onPointerUp={() => { if (drawMode !== 'off') endStroke(); else endDrag() }}
            onPointerLeave={() => { if (drawMode !== 'off') endStroke(); else endDrag() }}
            onPointerDown={(e) => {
              if (drawMode !== 'off') { startStroke(e); return }
              if (e.target === canvasRef.current) setSelected(null)
            }}
          >
            {baseImage?.place && (
              <div
                className="absolute"
                style={{ left: baseImage.place.xMm * k, top: baseImage.place.yMm * k, width: baseImage.place.wMm * k, height: baseImage.place.hMm * k, pointerEvents: drawMode !== 'off' ? 'none' : undefined }}
              >
                <img
                  src={baseImage.dataUri}
                  alt="底圖"
                  draggable={false}
                  className="w-full h-full cursor-move"
                  style={{ objectFit: 'fill' }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    setSelected(null)
                    dragRef.current = { kind: 'img-move', sx: e.clientX, sy: e.clientY, ox: baseImage.place!.xMm, oy: baseImage.place!.yMm }
                  }}
                />
                <div className="absolute inset-0 border border-blue-400 pointer-events-none" />
                {HANDLES.map(([h, cls]) => (
                  <div
                    key={h}
                    className={`absolute w-2.5 h-2.5 bg-white border border-blue-500 rounded-sm ${cls}`}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      dragRef.current = { kind: 'img-resize', handle: h, sx: e.clientX, sy: e.clientY, ox: baseImage.place!.xMm, oy: baseImage.place!.yMm, ow: baseImage.place!.wMm, oh: baseImage.place!.hMm }
                    }}
                  />
                ))}
              </div>
            )}

            {texts.map((t, i) => (
              <div
                key={i}
                className={`absolute rounded-sm border ${selected === i ? 'border-blue-500' : 'border-dashed border-gray-300'} bg-white/60 cursor-move`}
                style={{ left: (t.xMm ?? 0) * k, top: (t.yMm ?? 0) * k, padding: 2, pointerEvents: drawMode !== 'off' ? 'none' : undefined }}
                onPointerDown={(e) => {
                  setSelected(i)
                  if ((e.target as HTMLElement).tagName === 'INPUT') return
                  e.stopPropagation()
                  dragRef.current = { kind: 'text', idx: i, sx: e.clientX, sy: e.clientY, ox: t.xMm ?? 0, oy: t.yMm ?? 0 }
                }}
              >
                <input
                  value={t.text}
                  placeholder="輸入文字"
                  onChange={(e) => onTextsChange(texts.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  onFocus={() => setSelected(i)}
                  className="bg-transparent outline-none"
                  style={{
                    fontFamily: SHEET_FONT,
                    fontSize: sizeMm(t) * k,
                    lineHeight: 1.1,
                    // 寬度＝同字型同字級「實測」＋游標餘裕；上限＝格子右緣
                    width: Math.min(
                      Math.max(measureTextPx(t.text || '輸入文字', sizeMm(t) * k), 20) + 6,
                      Math.max(4, cellWMm - (t.xMm ?? 0) - 0.5) * k
                    ),
                    color: '#444'
                  }}
                />
                {selected === i && (
                  <div className="absolute -top-7 left-0 flex items-center gap-0.5 bg-white border rounded shadow px-1 py-0.5 whitespace-nowrap">
                    <select
                      value={t.size ?? 'm'}
                      onChange={(e) => onTextsChange(texts.map((x, j) => (j === i ? { ...x, size: e.target.value as GenCellText['size'] } : x)))}
                      className="text-xs border rounded px-0.5"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <option value="s">小</option>
                      <option value="m">中</option>
                      <option value="l">大</option>
                    </select>
                    <span className="mx-0.5 w-px h-4 bg-gray-200" />
                    {/* 水平對齊 */}
                    {([['start', AlignLeft, '水平置左'], ['center', AlignCenter, '水平置中'], ['end', AlignRight, '水平置右']] as const).map(([w, Icon, tip]) => (
                      <button key={`h-${w}`} type="button" title={tip}
                        className="p-0.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => alignText(i, 'h', w)}>
                        <Icon className="w-3.5 h-3.5" />
                      </button>
                    ))}
                    <span className="mx-0.5 w-px h-4 bg-gray-200" />
                    {/* 垂直對齊 */}
                    {([['start', ArrowUpToLine, '垂直置上'], ['center', AlignVerticalJustifyCenter, '垂直置中'], ['end', ArrowDownToLine, '垂直置下']] as const).map(([w, Icon, tip]) => (
                      <button key={`v-${w}`} type="button" title={tip}
                        className="p-0.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => alignText(i, 'v', w)}>
                        <Icon className="w-3.5 h-3.5" />
                      </button>
                    ))}
                    <span className="mx-0.5 w-px h-4 bg-gray-200" />
                    <button
                      type="button"
                      className="text-xs text-red-500 px-1"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => { onTextsChange(texts.filter((_, j) => j !== i)); setSelected(null) }}
                    >
                      刪除
                    </button>
                  </div>
                )}
              </div>
            ))}
            {/* 正解圖紅色畫筆：已存實線＋進行中虛線預覽；pointer-events-none 讓 canvas 收畫筆事件 */}
            <svg className="absolute inset-0 pointer-events-none" width={cellWMm * k} height={cellHMm * k}>
              {refDrawing.map((s, i) => drawEl(s, i))}
              {liveRef.current && (() => { const ls = strokeFromLive(drawMode, liveRef.current); return ls ? drawEl(ls, 'live', true) : null })()}
            </svg>
          </div>
        </div>
        <div className="px-4 py-2.5 border-t flex justify-end">
          <button type="button" onClick={onClose} className="px-4 py-1.5 rounded bg-blue-600 text-white text-sm">完成</button>
        </div>
      </div>
    </div>
  )
}
