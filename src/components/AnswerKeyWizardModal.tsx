import { useState, useCallback, useEffect, useRef } from 'react'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  rectSortingStrategy, useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  RotateCw, Check, X, AlertTriangle, Loader2, ChevronRight, Crop, Plus, Trash2
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import type { AnswerKey, AnswerKeyQuestion, QuestionCategory, Rubric } from '@/lib/db'
import { QUESTION_CATEGORY_TO_BUCKET, QUESTION_CATEGORY_LABELS as CATEGORY_LABELS } from '@/lib/db'

function getEffectiveCategory(q: AnswerKeyQuestion): QuestionCategory {
  if (q.questionCategory) return q.questionCategory
  const t = typeof q.type === 'number' ? q.type : 2
  if (t === 1) return 'fill_blank'
  if (t === 3) return 'short_answer'
  return 'fill_variants'
}

function hasVocabFillWarning(q: AnswerKeyQuestion, domain?: string): boolean {
  if (domain && domain !== '國語') return false
  const cat = getEffectiveCategory(q)
  if (cat !== 'fill_blank') return false
  const ans = q.answer ?? q.referenceAnswer ?? ''
  const phoneticRe = /^[\u3105-\u312F\u02CA\u02C7\u02CB\u02D9]+$/
  const singleCjkRe = /^[\u4E00-\u9FFF]$/
  return singleCjkRe.test(ans.trim()) || phoneticRe.test(ans.trim())
}

const rubricLabels = ['優秀', '良好', '尚可', '待努力'] as const

function buildDefaultRubric(maxScore: number): Rubric {
  const s = Math.max(1, Math.round(maxScore))
  const r = [
    { label: '優秀', min: Math.max(1, Math.ceil(s * 0.9)), max: s },
    { label: '良好', min: Math.max(1, Math.ceil(s * 0.7)), max: Math.max(1, Math.ceil(s * 0.9) - 1) },
    { label: '尚可', min: Math.max(1, Math.ceil(s * 0.5)), max: Math.max(1, Math.ceil(s * 0.7) - 1) },
    { label: '待努力', min: 1, max: Math.max(1, Math.ceil(s * 0.5) - 1) },
  ]
  return { levels: r.map((l, i) => ({ ...l, label: rubricLabels[i], criteria: '' })) }
}

// ─── page order types ───────────────────────────────────────────────────────

interface PageItem {
  id: string
  originalIndex: number
  url: string
  rotation: number
}

function SortablePageCard({ item, onRotate, onDelete, canDelete }: { item: PageItem; onRotate: (id: string) => void; onDelete: (id: string) => void; canDelete: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 50 : undefined, opacity: isDragging ? 0.8 : 1 }} className={`relative group h-full ${isDragging ? 'shadow-2xl' : ''}`}>
      <div {...attributes} {...listeners} className="border-2 border-gray-200 rounded-xl overflow-hidden cursor-grab active:cursor-grabbing bg-white hover:border-green-400 transition-colors h-full flex flex-col">
        <div className="bg-gray-50 px-2 py-1.5 text-xs text-gray-600 font-medium flex items-center justify-between shrink-0">
          <span>第 {item.originalIndex + 1} 頁</span>
          {item.rotation !== 0 && <span className="text-[10px] text-orange-600 font-semibold">{item.rotation}°</span>}
        </div>
        <div className="flex-1 bg-white overflow-hidden flex items-center justify-center">
          <img src={item.url} alt={`第 ${item.originalIndex + 1} 頁`} className="w-full h-full object-contain" style={{ transform: `rotate(${item.rotation}deg)` }} draggable={false} />
        </div>
      </div>
      <button type="button" onClick={(e) => { e.stopPropagation(); onRotate(item.id) }} className="absolute top-9 right-1 p-1.5 rounded-full bg-white/90 border border-gray-300 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-gray-100" title="旋轉 90°">
        <RotateCw className="w-3.5 h-3.5 text-gray-600" />
      </button>
      {canDelete && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(item.id) }} className="absolute top-9 left-1 p-1.5 rounded-full bg-white/90 border border-red-300 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50" title="刪除此頁">
          <Trash2 className="w-3.5 h-3.5 text-red-500" />
        </button>
      )}
    </div>
  )
}

// ─── main component ─────────────────────────────────────────────────────────

type WizardStep = 'page_order' | 'loading' | 'results'
type WizardOverlay = null | 'confirm_extract' | 'confirm_save'

interface NormalizedBbox { x: number; y: number; w: number; h: number }

export interface AnswerKeyWizardModalProps {
  initialPages: Array<{ index: number; url: string; blob: Blob }>
  initialStep?: WizardStep
  initialAnswerKey?: AnswerKey | null
  initialAnswerSheetImages?: Blob[]
  scoringMode?: 'scored' | 'unscored'
  hasGradedSubmissions?: boolean
  domain?: string
  onExtract: (
    orderedBlobs: Array<{ index: number; url: string; blob: Blob }>,
    onProgress: (msg: string) => void
  ) => Promise<{ answerKey: AnswerKey; imageBlobs: Blob[]; notice: string | null }>
  onSave: (answerKey: AnswerKey, imageBlobs: Blob[]) => Promise<void>
  onCancel: () => void
}

export default function AnswerKeyWizardModal({
  initialPages,
  initialStep = 'page_order',
  initialAnswerKey = null,
  initialAnswerSheetImages = [],
  scoringMode = 'scored',
  hasGradedSubmissions = false,
  domain,
  onExtract,
  onSave,
  onCancel,
}: AnswerKeyWizardModalProps) {
  // ── step / overlay state ──
  const [step, setStep] = useState<WizardStep>(initialStep)
  const [overlay, setOverlay] = useState<WizardOverlay>(null)

  // ── page order state ──
  const [items, setItems] = useState<PageItem[]>(() =>
    initialPages.map((p) => ({ id: `page-${p.index}`, originalIndex: p.index, url: p.url, rotation: 0 }))
  )

  // ── extraction result state ──
  const [editingKey, setEditingKey] = useState<AnswerKey | null>(initialAnswerKey)
  const [imageBlobs, setImageBlobs] = useState<Blob[]>(initialAnswerSheetImages.length > 0 ? initialAnswerSheetImages : [])

  // 當 prop 從外部非同步載入（下載完成）時，更新 imageBlobs（前提是尚未自行提取）
  useEffect(() => {
    if (initialAnswerSheetImages.length > 0 && imageBlobs.length === 0) {
      setImageBlobs(initialAnswerSheetImages)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAnswerSheetImages])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [loadingMsg, setLoadingMsg] = useState('正在解析…')
  const [extractError, setExtractError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // ── bbox drawing state ──
  const [isDrawingBbox, setIsDrawingBbox] = useState(false)
  const [bboxDraft, setBboxDraft] = useState<NormalizedBbox | null>(null)
  const bboxDrawStart = useRef<{ x: number; y: number } | null>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const [imageObjUrl, setImageObjUrl] = useState<string | null>(null)
  const [manualCropUrl, setManualCropUrl] = useState<string | null>(null) // canvas crop after manual bbox draw

  // ── image URL management — use the correct page for the selected question ──
  useEffect(() => {
    const q = editingKey?.questions[selectedIdx]
    // pageIndex 優先；未設定時從 ID 首段（1-based）推算（舊資料相容）
    const pageIdx = q?.pageIndex ?? Math.max(0, (parseInt(String(q?.id ?? '').split('-')[0], 10) || 1) - 1)
    const blob = imageBlobs[pageIdx] ?? imageBlobs[0] ?? null
    if (!blob) { setImageObjUrl(null); return }
    const url = URL.createObjectURL(blob)
    setImageObjUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [imageBlobs, selectedIdx, editingKey])

  // ── DnD sensors ──
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setItems((prev) => {
        const oldIdx = prev.findIndex((i) => i.id === active.id)
        const newIdx = prev.findIndex((i) => i.id === over.id)
        return arrayMove(prev, oldIdx, newIdx)
      })
    }
  }, [])

  const handleRotateOne = useCallback((id: string) => {
    setItems((prev) => prev.map((item) => item.id === id ? { ...item, rotation: (item.rotation + 90) % 360 } : item))
  }, [])

  const handleRotateAll = useCallback(() => {
    setItems((prev) => prev.map((item) => ({ ...item, rotation: (item.rotation + 90) % 360 })))
  }, [])

  const handleDeletePage = useCallback((id: string) => {
    setItems((prev) => {
      if (prev.length <= 1) return prev
      return prev.filter((item) => item.id !== id)
    })
  }, [])

  // ── step 1 → extraction ──
  const handleConfirmOrder = () => setOverlay('confirm_extract')

  const handleStartExtract = async () => {
    setOverlay(null)
    setStep('loading')
    setExtractError(null)
    setLoadingMsg('準備中…')
    try {
      const orderedBlobs = items.map((item, newIdx) => {
        const orig = initialPages.find((p) => p.index === item.originalIndex)!
        return { index: newIdx, url: orig.url, blob: orig.blob, rotation: item.rotation }
      })

      // 先應用老師的手動旋轉（90°/180°/270°），再做透視校正（並行處理）
      setLoadingMsg('校正圖片角度…')
      try {
        const [{ rotateImageBlob }, { correctPerspective }] = await Promise.all([
          import('../lib/imageCompression'),
          import('../lib/perspectiveCorrection')
        ])
        await Promise.all(orderedBlobs.map(async (item) => {
          // 旋轉
          if (item.rotation !== 0) {
            item.blob = await rotateImageBlob(item.blob, item.rotation)
          }
          // 透視校正
          const oldUrl = item.url
          item.blob = await correctPerspective(item.blob)
          URL.revokeObjectURL(oldUrl)
          item.url = URL.createObjectURL(item.blob)
        }))
      } catch (err) {
        console.warn('[AnswerKeyWizard] perspective correction failed, using originals:', err)
      }

      const { answerKey, imageBlobs: blobs, notice: n } = await onExtract(orderedBlobs, setLoadingMsg)
      setEditingKey(answerKey)
      setImageBlobs(blobs)
      setNotice(n)
      setSelectedIdx(0)
      setStep('results')
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : String(err))
      setStep('page_order')
    }
  }

  // ── step 3 save ──
  const handleSaveClick = () => {
    if (hasGradedSubmissions) {
      setOverlay('confirm_save')
    } else {
      void doSave()
    }
  }

  const doSave = async () => {
    if (!editingKey) return
    // 檢查多維度配分加總是否與題目配分一致
    const mismatchQuestions = editingKey.questions.filter((q) => {
      if (!q.rubricsDimensions || q.rubricsDimensions.length === 0) return false
      const dimSum = q.rubricsDimensions.reduce((s, d) => s + (d.maxScore ?? 0), 0)
      return dimSum !== (q.maxScore ?? 0)
    })
    if (mismatchQuestions.length > 0) {
      const ids = mismatchQuestions.map((q) => q.id).join('、')
      alert(`以下題目的評分維度加總與題目配分不一致，請調整後再儲存：\n${ids}`)
      return
    }
    setOverlay(null)
    setIsSaving(true)
    try {
      // 同步 totalScore 為各題 maxScore 加總
      const updatedKey: AnswerKey = {
        ...editingKey,
        totalScore: editingKey.questions.reduce((s, q) => s + (q.maxScore ?? 0), 0),
      }
      await onSave(updatedKey, imageBlobs)
    } finally {
      setIsSaving(false)
    }
  }

  // ── question editing helpers ──
  const updateField = (idx: number, field: keyof AnswerKeyQuestion, value: unknown) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => i === idx ? { ...q, [field]: value } : q) }
    })
  }

  const removeQuestion = (idx: number) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      const questions = prev.questions.filter((_, i) => i !== idx)
      return { ...prev, questions }
    })
    if (selectedIdx >= idx && selectedIdx > 0) setSelectedIdx((s) => s - 1)
  }

  const addQuestion = () => {
    setEditingKey((prev) => {
      if (!prev) return prev
      const newQ: AnswerKeyQuestion = { id: `新題${prev.questions.length + 1}`, type: 1, questionCategory: 'fill_blank', maxScore: 2, answer: '' }
      return { ...prev, questions: [...prev.questions, newQ] }
    })
    setSelectedIdx(editingKey ? editingKey.questions.length : 0)
  }

  const addAcceptableAnswer = (idx: number) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => i === idx ? { ...q, acceptableAnswers: [...(q.acceptableAnswers ?? []), ''] } : q) }
    })
  }

  const updateAcceptableAnswer = (qIdx: number, ansIdx: number, value: string) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => {
        if (i !== qIdx) return q
        const ans = [...(q.acceptableAnswers ?? [])]
        ans[ansIdx] = value
        return { ...q, acceptableAnswers: ans }
      })}
    })
  }

  const removeAcceptableAnswer = (qIdx: number, ansIdx: number) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => {
        if (i !== qIdx) return q
        return { ...q, acceptableAnswers: (q.acceptableAnswers ?? []).filter((_, j) => j !== ansIdx) }
      })}
    })
  }

  const addDimension = (idx: number) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => {
        if (i !== idx) return q
        const dims = [...(q.rubricsDimensions ?? []), { name: '', criteria: '', maxScore: 1 }]
        return { ...q, rubricsDimensions: dims, rubric: undefined }
      })}
    })
  }

  const updateDimension = (qIdx: number, dIdx: number, field: string, value: unknown) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => {
        if (i !== qIdx) return q
        const dims = (q.rubricsDimensions ?? []).map((d, j) => j === dIdx ? { ...d, [field]: value } : d)
        return { ...q, rubricsDimensions: dims }
      })}
    })
  }

  const removeDimension = (qIdx: number, dIdx: number) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => {
        if (i !== qIdx) return q
        return { ...q, rubricsDimensions: (q.rubricsDimensions ?? []).filter((_, j) => j !== dIdx) }
      })}
    })
  }

  const switchRubricType = (idx: number, type: 'multi-dimension' | '4-level') => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => {
        if (i !== idx) return q
        if (type === 'multi-dimension') {
          return { ...q, rubricsDimensions: q.rubricsDimensions ?? [{ name: '作答依據', criteria: '', maxScore: Math.ceil((q.maxScore ?? 2) / 2) }, { name: '結論表達', criteria: '', maxScore: Math.floor((q.maxScore ?? 2) / 2) }], rubric: undefined }
        }
        return { ...q, rubric: q.rubric ?? buildDefaultRubric(q.maxScore ?? 2), rubricsDimensions: undefined }
      })}
    })
  }

  // ── bbox drawing ──
  const getNormalizedCoords = (e: React.MouseEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const container = imageContainerRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    }
  }

  const handleBboxMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawingBbox) return
    const coords = getNormalizedCoords(e)
    if (!coords) return
    bboxDrawStart.current = coords
    setBboxDraft({ x: coords.x, y: coords.y, w: 0, h: 0 })
    e.preventDefault()
  }

  const handleBboxMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawingBbox || !bboxDrawStart.current) return
    const coords = getNormalizedCoords(e)
    if (!coords) return
    const start = bboxDrawStart.current
    setBboxDraft({
      x: Math.min(start.x, coords.x),
      y: Math.min(start.y, coords.y),
      w: Math.abs(coords.x - start.x),
      h: Math.abs(coords.y - start.y),
    })
  }

  const handleBboxMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawingBbox || !bboxDrawStart.current) return
    const coords = getNormalizedCoords(e)
    if (!coords || !bboxDraft || bboxDraft.w < 0.01 || bboxDraft.h < 0.01) {
      setBboxDraft(null)
      bboxDrawStart.current = null
      return
    }
    const finalBbox = {
      x: Math.min(bboxDrawStart.current.x, coords.x),
      y: Math.min(bboxDrawStart.current.y, coords.y),
      w: Math.abs(coords.x - bboxDrawStart.current.x),
      h: Math.abs(coords.y - bboxDrawStart.current.y),
    }
    updateField(selectedIdx, 'referenceBbox', finalBbox)
    setBboxDraft(null)
    bboxDrawStart.current = null
    setIsDrawingBbox(false)
  }

  // ── derived ──
  const selectedQuestion = editingKey?.questions[selectedIdx] ?? null
  const selectedCategory = selectedQuestion ? getEffectiveCategory(selectedQuestion) : 'fill_blank'
  const selectedBucket = QUESTION_CATEGORY_TO_BUCKET[selectedCategory] ?? 'A'
  const showAnswerField = selectedBucket === 'A' || selectedBucket === 'D'
  const showAcceptableAnswers = selectedBucket === 'B'
  const showRubric = selectedBucket === 'C' || selectedBucket === 'D'
  const activeBbox: NormalizedBbox | null = bboxDraft ?? selectedQuestion?.referenceBbox ?? selectedQuestion?.answerBbox ?? null
  const bboxIsAiDetected = !bboxDraft && !selectedQuestion?.referenceBbox && !!selectedQuestion?.answerBbox

  // Reset drawing mode and manual crop when switching questions
  useEffect(() => { setIsDrawingBbox(false); setManualCropUrl(null) }, [selectedIdx])

  // Canvas crop — recalculates on bboxDraft (while drawing) or referenceBbox (after confirmed)
  // referenceBbox is used as fallback so the crop persists after bboxDraft is cleared on mouseUp
  useEffect(() => {
    const bbox = bboxDraft ?? selectedQuestion?.referenceBbox ?? null
    if (!bbox || !imageObjUrl) { setManualCropUrl(null); return }
    let cancelled = false
    const img = new window.Image()
    img.onload = () => {
      if (cancelled) return
      const canvas = document.createElement('canvas')
      const pad = 0.015
      const px = Math.max(0, bbox.x - pad)
      const py = Math.max(0, bbox.y - pad)
      const pw = Math.min(1 - px, bbox.w + pad * 2)
      const ph = Math.min(1 - py, bbox.h + pad * 2)
      const sx = Math.round(img.naturalWidth * px)
      const sy = Math.round(img.naturalHeight * py)
      const sw = Math.max(1, Math.round(img.naturalWidth * pw))
      const sh = Math.max(1, Math.round(img.naturalHeight * ph))
      canvas.width = sw
      canvas.height = sh
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
      if (!cancelled) setManualCropUrl(canvas.toDataURL('image/jpeg', 0.92))
    }
    img.src = imageObjUrl
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bboxDraft, selectedQuestion?.referenceBbox, imageObjUrl])

  const stepTitle: Record<WizardStep, string> = {
    page_order: '調整頁面順序',
    loading: 'AI 解析中',
    results: '標準答案',
  }

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-[90vh] overflow-hidden flex flex-col relative">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">{stepTitle[step]}</h2>
            {step === 'results' && (
              <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">你可以相信 AI，但你一定要認真檢查</span>
            )}
            {step === 'results' && notice && (
              <span className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">{notice}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === 'page_order' && (
              <button type="button" onClick={handleRotateAll} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                <RotateCw className="w-3.5 h-3.5" /> 全部旋轉
              </button>
            )}
            {step !== 'loading' && (
              <button type="button" onClick={onCancel} className="p-2 rounded-lg hover:bg-gray-100 transition-colors" aria-label="取消">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden relative min-h-0 flex flex-col">

          {/* Step 1: Page Order */}
          {step === 'page_order' && (
            <div className="flex-1 overflow-hidden p-4 flex flex-col">
              {items.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">沒有頁面資料</p>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={items.map((i) => i.id)} strategy={rectSortingStrategy}>
                    <div
                      className="grid gap-4 flex-1 min-h-0 overflow-y-auto"
                      style={{ gridTemplateColumns: `repeat(${Math.min(items.length, 2)}, minmax(0, 1fr))` }}
                    >
                      {items.map((item) => (
                        <SortablePageCard key={item.id} item={item} onRotate={handleRotateOne} onDelete={handleDeletePage} canDelete={items.length > 1} />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
              {extractError && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{extractError}</div>
              )}
            </div>
          )}

          {/* Step 2: Loading */}
          {step === 'loading' && (
            <div className="h-full flex flex-col items-center justify-center gap-4">
              <Loader2 className="w-10 h-10 text-green-600 animate-spin" />
              <p className="text-sm text-gray-600">{loadingMsg}</p>
            </div>
          )}

          {/* Step 3: Results */}
          {step === 'results' && editingKey && (
            <div className="flex-1 flex overflow-hidden min-h-0">

              {/* Left sidebar: question list */}
              <div className="w-56 border-r border-gray-200 flex flex-col shrink-0 min-h-0">
                <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-500">共 {editingKey.questions.length} 題</span>
                  <button type="button" onClick={addQuestion} className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-green-600" title="新增題目">
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto py-1">
                  {editingKey.questions.map((q, idx) => {
                    const cat = getEffectiveCategory(q)
                    const vocabWarn = hasVocabFillWarning(q, domain)
                    const multiFillWarn = hasMultiFillQuestions(q)
                    // Detect placeholder/missing answers that need teacher attention
                    const PLACEHOLDER_ANSWERS = ['?', '？', '未知', 'unknown', 'N/A']
                    const ans = (q.answer ?? '').trim()
                    const ref = (q.referenceAnswer ?? '').trim()
                    const answerMissing = (!ans || PLACEHOLDER_ANSWERS.includes(ans)) && (!ref || PLACEHOLDER_ANSWERS.includes(ref))
                      && cat !== 'short_answer' && cat !== 'word_problem' && cat !== 'calculation' // these types may legitimately have no answer field
                    const hasWarn = vocabWarn || multiFillWarn || answerMissing
                    const isSelected = idx === selectedIdx
                    return (
                      <button
                        key={q.id ?? idx}
                        type="button"
                        onClick={() => setSelectedIdx(idx)}
                        className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-start gap-2 ${
                          isSelected
                            ? answerMissing ? 'bg-red-100 text-red-900' : hasWarn ? 'bg-orange-100 text-orange-900' : 'bg-green-50 text-green-900'
                            : answerMissing ? 'bg-red-50 text-red-800 hover:bg-red-100' : hasWarn ? 'bg-orange-50 text-orange-800 hover:bg-orange-100' : 'hover:bg-gray-50 text-gray-700'
                        }`}
                      >
                        <ChevronRight className={`w-3 h-3 mt-0.5 shrink-0 ${isSelected ? 'opacity-100' : 'opacity-0'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-medium truncate">{q.id || `題 ${idx + 1}`}</span>
                            {scoringMode !== 'unscored' && typeof q.maxScore === 'number' && (
                              <span className={`shrink-0 text-[10px] tabular-nums ${
                                q.maxScore <= 0 ? 'text-red-500 font-semibold' : 'text-gray-400'
                              }`}>
                                {q.maxScore}分
                              </span>
                            )}
                          </div>
                          <div className={`text-[10px] truncate ${answerMissing ? 'text-red-600 font-semibold' : hasWarn ? 'text-orange-600' : 'text-gray-400'}`}>
                            {answerMissing ? '❌ 缺少標準答案' : hasWarn ? (vocabWarn ? '⚠ 請核對注音' : '⚠ 多項填入') : CATEGORY_LABELS[cat]}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
                {editingKey.questions.length > 0 && scoringMode !== 'unscored' && (
                  <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500">
                    總分 {editingKey.questions.reduce((s, q) => s + (q.maxScore ?? 0), 0)} 分
                  </div>
                )}
              </div>

              {/* Right panel */}
              <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                {selectedQuestion ? (
                  <>
                    {/* Image preview */}
                    <div className="shrink-0 border-b border-gray-100 p-3 bg-gray-50">
                      {/* Cropped preview: backend Sharp crop (AI) or canvas crop (after manual draw) or Storage path */}
                      {(manualCropUrl || selectedQuestion.cropImageUrl || selectedQuestion.cropImagePath) && !isDrawingBbox ? (
                        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden flex items-center justify-center h-40">
                          <img src={manualCropUrl ?? selectedQuestion.cropImageUrl ?? `/api/storage/download?assignmentId=${encodeURIComponent(selectedQuestion.cropImagePath!.split('/')[1])}&cropPath=${encodeURIComponent(selectedQuestion.cropImagePath!)}`} alt="答案區截圖" className="max-w-full max-h-full object-contain pointer-events-none" draggable={false} />
                        </div>
                      ) : (
                        /* Full image with drawing overlay */
                        /* Outer: centers the image horizontally */
                        <div className="w-full flex justify-center rounded-lg border border-gray-200 bg-white overflow-hidden h-40">
                          {/* Inner: sized to actual rendered image — bbox % is relative to this */}
                          <div
                            ref={imageContainerRef}
                            className={`relative inline-block max-h-40 ${isDrawingBbox ? 'cursor-crosshair' : 'cursor-default'}`}
                            onMouseDown={handleBboxMouseDown}
                            onMouseMove={handleBboxMouseMove}
                            onMouseUp={handleBboxMouseUp}
                          >
                            {imageObjUrl ? (
                              <img src={imageObjUrl} alt="答案卷" className="block max-w-full max-h-40 pointer-events-none" draggable={false} />
                            ) : (
                              <div className="flex items-center justify-center h-24 w-48 text-gray-400 text-xs">尚無圖片</div>
                            )}
                            {activeBbox && imageObjUrl && (
                              <div
                                className={`absolute border-2 pointer-events-none ${bboxIsAiDetected ? 'border-blue-500 bg-blue-500/10' : 'border-green-500 bg-green-500/10'}`}
                                style={{
                                  left: `${activeBbox.x * 100}%`,
                                  top: `${activeBbox.y * 100}%`,
                                  width: `${activeBbox.w * 100}%`,
                                  height: `${activeBbox.h * 100}%`,
                                }}
                              />
                            )}
                          </div>
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-1.5">
                        <button
                          type="button"
                          onClick={() => setIsDrawingBbox((v) => !v)}
                          className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${isDrawingBbox ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'}`}
                        >
                          <Crop className="w-3 h-3" />
                          {isDrawingBbox ? '點擊拖曳框選' : '調整框選區域'}
                        </button>
                        {selectedQuestion.referenceBbox ? (
                          <button type="button" onClick={() => updateField(selectedIdx, 'referenceBbox', undefined)} className="text-xs text-gray-400 hover:text-red-500">清除框選</button>
                        ) : bboxIsAiDetected ? (
                          <span className="text-xs text-blue-500">AI 已自動標記（可調整）</span>
                        ) : (
                          <span className="text-xs text-gray-400">尚未框選（點擊按鈕後拖曳標記位置）</span>
                        )}
                      </div>
                    </div>

                    {/* Editing form */}
                    <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
                      {/* id + category + maxScore */}
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col gap-1">
                          <span className="text-gray-500">題號</span>
                          <span className="w-20 px-2 py-1 border border-gray-200 rounded bg-gray-100 text-gray-600 select-all">{selectedQuestion.id ?? ''}</span>
                        </div>
                        <div className="flex-1 flex flex-col gap-1">
                          <span className="text-gray-500">題型 <span className="text-[10px] text-gray-400">(由 AI 自動分類)</span></span>
                          <span className="w-full px-2 py-1 border border-gray-200 rounded bg-gray-100 text-gray-700">
                            {CATEGORY_LABELS[selectedCategory] ?? selectedCategory}
                          </span>
                        </div>
                        {scoringMode !== 'unscored' && (
                          <div className="flex flex-col gap-1">
                            <span className="text-gray-500">配分</span>
                            <NumericInput className="w-16 px-2 py-1 border border-gray-300 rounded text-right" value={selectedQuestion.maxScore} allowDecimal onChange={(v) => updateField(selectedIdx, 'maxScore', v)} />
                          </div>
                        )}
                        <button type="button" onClick={() => removeQuestion(selectedIdx)} className="mt-4 p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* order mode */}
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500 w-16 shrink-0">順序規則</span>
                        <select className="flex-1 px-2 py-1 border border-gray-300 rounded bg-white" value={(selectedQuestion.orderMode ?? 'strict') === 'unordered' ? 'unordered' : 'strict'} onChange={(e) => updateField(selectedIdx, 'orderMode', e.target.value)}>
                          <option value="strict">固定位置（預設）</option>
                          <option value="unordered">同組可互換</option>
                        </select>
                      </div>
                      {(selectedQuestion.orderMode ?? 'strict') === 'unordered' && (
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500 w-16 shrink-0">互換組別</span>
                          <input className="flex-1 px-2 py-1 border border-gray-300 rounded" value={selectedQuestion.unorderedGroupId ?? ''} onChange={(e) => updateField(selectedIdx, 'unorderedGroupId', e.target.value)} placeholder="例如：1" />
                        </div>
                      )}

                      {/* Bucket A / D: 標準答案 / 圈選 / 勾選 / 寫入結果 */}
                      {showAnswerField && (
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500 w-16 shrink-0">
                            {(selectedCategory === 'multi_check' || selectedCategory === 'multi_choice' || selectedCategory === 'multi_check_other' || selectedCategory === 'circle_select_many') ? '正確選項' : '標準答案'}
                          </span>
                          <input
                            className="flex-1 px-2 py-1 border border-gray-300 rounded"
                            value={selectedQuestion.answer ?? ''}
                            onChange={(e) => updateField(selectedIdx, 'answer', e.target.value)}
                            placeholder={selectedCategory === 'multi_choice' ? '例如：A,C' : (selectedCategory === 'multi_check' || selectedCategory === 'multi_check_other') ? '例如：①,③' : ''}
                          />
                        </div>
                      )}

                      {/* Bucket B: 參考答案 + 可接受答案 */}
                      {showAcceptableAnswers && (
                        <div className="space-y-2">
                          <div className="flex items-start gap-2">
                            <span className="text-gray-500 w-16 shrink-0 mt-1">參考答案</span>
                            <textarea rows={2} className="flex-1 px-2 py-1 border border-gray-300 rounded" value={selectedQuestion.referenceAnswer ?? ''} onChange={(e) => updateField(selectedIdx, 'referenceAnswer', e.target.value)} />
                          </div>
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-gray-500">可接受答案</span>
                              <button type="button" onClick={() => addAcceptableAnswer(selectedIdx)} className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 hover:bg-blue-200">+ 新增</button>
                            </div>
                            {(selectedQuestion.acceptableAnswers ?? []).map((ans, ansIdx) => (
                              <div key={ansIdx} className="flex items-center gap-2 mb-1">
                                <input className="flex-1 px-2 py-1 border border-gray-300 rounded" value={ans} onChange={(e) => updateAcceptableAnswer(selectedIdx, ansIdx, e.target.value)} />
                                <button type="button" onClick={() => removeAcceptableAnswer(selectedIdx, ansIdx)} className="p-1 text-gray-400 hover:text-red-500"><X className="w-3 h-3" /></button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Bucket C / D: 參考答案 + Rubric */}
                      {showRubric && (
                        <div className="space-y-2">
                          <div className="flex items-start gap-2">
                            <span className="text-gray-500 w-16 shrink-0 mt-1">參考答案</span>
                            <textarea rows={2} className="flex-1 px-2 py-1 border border-gray-300 rounded" value={selectedQuestion.referenceAnswer ?? ''} onChange={(e) => updateField(selectedIdx, 'referenceAnswer', e.target.value)} />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-gray-500">評分方式：</span>
                            <button type="button" onClick={() => switchRubricType(selectedIdx, 'multi-dimension')} className={`text-xs px-2 py-1 rounded ${selectedQuestion.rubricsDimensions ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>多維度</button>
                            <button type="button" onClick={() => switchRubricType(selectedIdx, '4-level')} className={`text-xs px-2 py-1 rounded ${selectedQuestion.rubric ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>4 級評價</button>
                          </div>
                          {selectedQuestion.rubricsDimensions && (
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-gray-500">評分維度</span>
                                <button type="button" onClick={() => addDimension(selectedIdx)} className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 hover:bg-blue-200">+ 新增維度</button>
                              </div>
                              {selectedQuestion.rubricsDimensions.map((dim, dIdx) => (
                                <div key={dIdx} className="mb-2 p-2 bg-gray-50 rounded border border-gray-200">
                                  <div className="flex items-center gap-2 mb-1">
                                    <input placeholder="維度名稱" className="flex-1 px-2 py-1 border border-gray-300 rounded" value={dim.name} onChange={(e) => updateDimension(selectedIdx, dIdx, 'name', e.target.value)} />
                                    {scoringMode !== 'unscored' && (
                                      <NumericInput className="w-14 px-2 py-1 border border-gray-300 rounded text-right" value={dim.maxScore} allowDecimal onChange={(v) => updateDimension(selectedIdx, dIdx, 'maxScore', v)} />
                                    )}
                                    <button type="button" onClick={() => removeDimension(selectedIdx, dIdx)} className="p-1 text-gray-400 hover:text-red-500"><X className="w-3 h-3" /></button>
                                  </div>
                                  <textarea rows={2} placeholder="評分標準" className="w-full px-2 py-1 border border-gray-300 rounded text-xs" value={dim.criteria ?? ''} onChange={(e) => updateDimension(selectedIdx, dIdx, 'criteria', e.target.value)} />
                                </div>
                              ))}
                              {scoringMode !== 'unscored' && (() => {
                                const dimSum = selectedQuestion.rubricsDimensions!.reduce((s, d) => s + (d.maxScore ?? 0), 0)
                                const qMax = selectedQuestion.maxScore ?? 0
                                if (dimSum !== qMax) {
                                  return (
                                    <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5 mt-1">
                                      <span className="shrink-0">⚠️</span>
                                      <span>維度加總 <b>{dimSum}</b> 分 ≠ 題目配分 <b>{qMax}</b> 分，請調整後才能儲存</span>
                                    </div>
                                  )
                                }
                                return null
                              })()}
                            </div>
                          )}
                          {selectedQuestion.rubric && (
                            <div className="space-y-1">
                              {selectedQuestion.rubric.levels.map((level, lIdx) => (
                                <div key={lIdx} className="flex items-center gap-2">
                                  <span className="w-10 text-gray-500 shrink-0">{level.label}</span>
                                  <input placeholder="評分標準" className="flex-1 px-2 py-1 border border-gray-300 rounded" value={level.criteria ?? ''} onChange={(e) => {
                                    setEditingKey((prev) => {
                                      if (!prev) return prev
                                      return { ...prev, questions: prev.questions.map((q, qi) => {
                                        if (qi !== selectedIdx || !q.rubric) return q
                                        const levels = q.rubric.levels.map((l, li) => li === lIdx ? { ...l, criteria: e.target.value } : l)
                                        return { ...q, rubric: { levels } }
                                      })}
                                    })
                                  }} />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-sm text-gray-400">請從左側選取題目</div>
                )}
              </div>
            </div>
          )}

          {/* Internal overlays */}
          {overlay === 'confirm_extract' && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-10">
              <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                  <h3 className="font-semibold text-gray-900 text-sm">確定送出 AI 解析？</h3>
                </div>
                <p className="text-xs text-gray-600 mb-4">此操作將消耗墨水，完成後現有標準答案將被更新。</p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setOverlay(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">取消</button>
                  <button type="button" onClick={() => void handleStartExtract()} className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">確認送出</button>
                </div>
              </div>
            </div>
          )}

          {overlay === 'confirm_save' && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-10">
              <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                  <h3 className="font-semibold text-gray-900 text-sm">注意</h3>
                </div>
                <p className="text-xs text-gray-600 mb-4">修改標準答案不會自動重新批改已批改的作業，請手動重新批改需要更正的作業。</p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setOverlay(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">取消</button>
                  <button type="button" onClick={() => void doSave()} className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">確認儲存</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50 shrink-0">
          {step === 'page_order' && (
            <>
              {items.length < initialPages.length && (
                <span className="text-xs text-gray-500 mr-auto">已移除 {initialPages.length - items.length} 頁，剩餘 {items.length} 頁</span>
              )}
              <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">取消</button>
              <button type="button" onClick={handleConfirmOrder} className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700">
                <Check className="w-4 h-4" /> 確認順序，送出解析
              </button>
            </>
          )}
          {step === 'results' && (
            <>
              <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">取消</button>
              <button type="button" onClick={handleSaveClick} disabled={isSaving || !editingKey} className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-60">
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {isSaving ? '儲存中…' : '確認標準答案'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Needed because hasMultiFillQuestions checks per-question
function hasMultiFillQuestions(q: AnswerKeyQuestion): boolean {
  return getEffectiveCategory(q) === 'multi_fill'
}
