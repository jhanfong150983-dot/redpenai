import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
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
  RotateCw, Check, X, AlertTriangle, Loader2, ChevronRight, Crop, Plus, Trash2,
  FileUp, Lock, CheckCircle2, Circle, Upload
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import { convertPdfToImages, getFileType, fileToBlob } from '@/lib/pdfToImage'
import { compressImageFile } from '@/lib/imageCompression'
import type { AnswerKey, AnswerKeyQuestion, QuestionCategory, QuestionCategoryType, Rubric } from '@/lib/db'

// ─── shared constants ──────────────────────────────────────────────────────

const CATEGORY_TO_TYPE: Record<QuestionCategory, QuestionCategoryType> = {
  single_choice: 1, multi_choice: 2, single_check: 1, true_false: 1,
  fill_blank: 1, fill_variants: 2, multi_check: 2, multi_check_other: 2,
  calculation: 3, word_problem: 3, short_answer: 3, map_fill: 2,
  multi_fill: 1, map_draw: 3, diagram_draw: 3, diagram_color: 3, matching: 1,
}

const CATEGORY_LABELS: Record<QuestionCategory, string> = {
  single_choice: '單選選擇', multi_choice: '多��選擇', single_check: '單選勾選',
  true_false: '是非題', fill_blank: '填充題', fill_variants: '填充題（多元）',
  multi_check: '多選勾選', multi_check_other: '多選勾選（含其他）',
  calculation: '計算題', word_problem: '應用題', short_answer: '簡答題',
  map_fill: '填圖題', multi_fill: '多項填入', map_draw: '繪圖題',
  diagram_draw: '圖表繪製題', diagram_color: '塗色題', matching: '連連看',
}

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

function hasMultiFillQuestions(q: AnswerKeyQuestion): boolean {
  return getEffectiveCategory(q) === 'multi_fill'
}

const rubricLabels = ['優秀', '良好', '尚可', '待努力'] as const

function buildDefaultRubric(maxScore: number): Rubric {
  const s = Math.max(1, Math.round(maxScore))
  const r = [
    { label: '優秀', min: Math.max(1, Math.ceil(s * 0.9)), max: s },
    { label: '��好', min: Math.max(1, Math.ceil(s * 0.7)), max: Math.max(1, Math.ceil(s * 0.9) - 1) },
    { label: '尚可', min: Math.max(1, Math.ceil(s * 0.5)), max: Math.max(1, Math.ceil(s * 0.7) - 1) },
    { label: '待努力', min: 1, max: Math.max(1, Math.ceil(s * 0.5) - 1) },
  ]
  return { levels: r.map((l, i) => ({ ...l, label: rubricLabels[i], criteria: '' })) }
}

// ─── page order types ──��──────────────────────────��────────────────────────

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

// ─── types ─────────────��────────────────────────────────────────────────────

type UnifiedStep = 'metadata' | 'upload_order' | 'extracting' | 'editing'

const STEP_CONFIG: { key: UnifiedStep; label: string; shortLabel: string }[] = [
  { key: 'metadata', label: '基本資料', shortLabel: '①' },
  { key: 'upload_order', label: '上傳答案', shortLabel: '②' },
  { key: 'extracting', label: 'AI 解析', shortLabel: '③' },
  { key: 'editing', label: '題目編輯', shortLabel: '④' },
]

interface NormalizedBbox { x: number; y: number; w: number; h: number }

export interface AnswerKeyUnifiedModalProps {
  open: boolean
  onClose: () => void
  onExtract: (
    orderedBlobs: Array<{ index: number; url: string; blob: Blob }>,
    onProgress: (msg: string) => void,
    context: { domain: string; docType: 'worksheet' | 'exam' }
  ) => Promise<{ answerKey: AnswerKey; imageBlobs: Blob[]; notice: string | null }>
  onSave: (answerKey: AnswerKey, imageBlobs: Blob[], metadata: {
    title: string; domain: string; docType: 'worksheet' | 'exam'
    folder: string; answerSheetMode: 'with_questions' | 'answer_only'
    questionBookletBlobs: Blob[]
  }) => Promise<void>
  // Edit mode data
  editMode?: boolean
  initialTitle?: string
  initialDomain?: string
  initialDocType?: 'worksheet' | 'exam'
  initialFolder?: string
  initialAnswerSheetMode?: 'with_questions' | 'answer_only'
  initialAnswerKey?: AnswerKey | null
  initialAnswerSheetImages?: Blob[]
  scoringMode?: 'scored' | 'unscored'
  hasGradedSubmissions?: boolean
  // Options
  domainOptions?: string[]
}

// ─── main component ───────────────────────���────────────────────────────────

export default function AnswerKeyUnifiedModal({
  open,
  onClose,
  onExtract,
  onSave,
  editMode = false,
  initialTitle = '',
  initialDomain = '',
  initialDocType = 'worksheet',
  initialFolder = '',
  initialAnswerSheetMode = 'with_questions',
  initialAnswerKey = null,
  initialAnswerSheetImages = [],
  scoringMode = 'scored',
  hasGradedSubmissions = false,
  domainOptions = ['數學', '國語（測試中）', '社會', '自然', '英語', '其他'],
}: AnswerKeyUnifiedModalProps) {

  // ── step state machine ────────────────────────────────────────────────────
  const [activeStep, setActiveStep] = useState<UnifiedStep>(editMode ? 'editing' : 'metadata')
  const [completedSteps, setCompletedSteps] = useState<Set<UnifiedStep>>(
    () => editMode ? new Set<UnifiedStep>(['metadata', 'upload_order', 'extracting', 'editing']) : new Set()
  )

  const isStepUnlocked = useCallback((step: UnifiedStep): boolean => {
    const idx = STEP_CONFIG.findIndex(s => s.key === step)
    if (idx === 0) return true
    // All previous steps must be completed
    for (let i = 0; i < idx; i++) {
      if (!completedSteps.has(STEP_CONFIG[i].key)) return false
    }
    return true
  }, [completedSteps])

  // Edit mode: steps 1-3 are read-only (viewable but not editable)
  const isStepReadOnly = useCallback((step: UnifiedStep): boolean => {
    if (!editMode) return false
    return step !== 'editing'
  }, [editMode])

  const markComplete = useCallback((step: UnifiedStep) => {
    setCompletedSteps(prev => new Set([...prev, step]))
  }, [])

  const resetFromStep = useCallback((step: UnifiedStep) => {
    const idx = STEP_CONFIG.findIndex(s => s.key === step)
    setCompletedSteps(prev => {
      const next = new Set(prev)
      // Remove completion for this step and all subsequent steps
      for (let i = idx; i < STEP_CONFIG.length; i++) {
        next.delete(STEP_CONFIG[i].key)
      }
      return next
    })
  }, [])

  const allComplete = useMemo(() =>
    STEP_CONFIG.every(s => completedSteps.has(s.key)),
    [completedSteps]
  )

  // ── Step 1: metadata state ────────���───────────────────────────────────────
  const [title, setTitle] = useState(initialTitle)
  const [domain, setDomain] = useState(initialDomain)
  const [docType, setDocType] = useState<'worksheet' | 'exam'>(initialDocType)
  const [folder] = useState(initialFolder)
  const [answerSheetMode, setAnswerSheetMode] = useState<'with_questions' | 'answer_only'>(initialAnswerSheetMode)
  const [questionBookletBlobs, setQuestionBookletBlobs] = useState<Blob[]>([])

  const metadataValid = title.trim() !== '' && domain !== ''

  // Auto-complete/uncomplete metadata step
  useEffect(() => {
    if (metadataValid && !completedSteps.has('metadata')) {
      markComplete('metadata')
    } else if (!metadataValid && completedSteps.has('metadata')) {
      resetFromStep('metadata')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadataValid])

  // ── Step 2: upload + page order state ─────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isProcessingFiles, setIsProcessingFiles] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [uploadedPages, setUploadedPages] = useState<Array<{ index: number; url: string; blob: Blob }>>([])
  const [pageItems, setPageItems] = useState<PageItem[]>([])

  // Init page items from uploaded pages
  useEffect(() => {
    setPageItems(uploadedPages.map((p) => ({
      id: `page-${p.index}`,
      originalIndex: p.index,
      url: p.url,
      rotation: 0,
    })))
  }, [uploadedPages])

  // Edit mode: if we have initial answer sheet images, use them
  useEffect(() => {
    if (editMode && initialAnswerSheetImages.length > 0 && uploadedPages.length === 0) {
      const pages = initialAnswerSheetImages.map((blob, i) => ({
        index: i,
        blob,
        url: URL.createObjectURL(blob),
      }))
      setUploadedPages(pages)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, initialAnswerSheetImages])

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    e.target.value = ''
    setFileError(null)
    setIsProcessingFiles(true)
    try {
      const blobs: Blob[] = []
      for (const file of files) {
        const ft = getFileType(file)
        if (ft === 'pdf') { blobs.push(...await convertPdfToImages(file, { scale: 1.5, quality: 0.7 })) }
        else if (ft === 'image') { blobs.push(await fileToBlob(file)) }
        else { setFileError(`不支援的檔案格式：${file.name}`); return }
      }
      if (blobs.length === 0) { setFileError('沒有可用的圖片'); return }
      const compressed = await Promise.all(blobs.map((b) => compressImageFile(b, { maxWidth: 1800, quality: 0.8 })))
      // Clean up old URLs
      uploadedPages.forEach(p => URL.revokeObjectURL(p.url))
      const pages = compressed.map((blob, i) => ({ index: i, blob, url: URL.createObjectURL(blob) }))
      setUploadedPages(pages)
      // Reset extraction and editing since we have new images
      resetFromStep('upload_order')
      setEditingKey(null)
      setExtractedImageBlobs([])
    } catch (err) {
      setFileError(err instanceof Error ? err.message : '檔案處理失敗')
    } finally {
      setIsProcessingFiles(false)
    }
  }

  const addFileInputRef = useRef<HTMLInputElement>(null)

  const handleAddFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    e.target.value = ''
    setFileError(null)
    setIsProcessingFiles(true)
    try {
      const blobs: Blob[] = []
      for (const file of files) {
        const ft = getFileType(file)
        if (ft === 'pdf') { blobs.push(...await convertPdfToImages(file, { scale: 1.5, quality: 0.7 })) }
        else if (ft === 'image') { blobs.push(await fileToBlob(file)) }
        else { setFileError(`不支援的檔案格式：${file.name}`); return }
      }
      if (blobs.length === 0) { setFileError('沒有可用的圖片'); return }
      const compressed = await Promise.all(blobs.map((b) => compressImageFile(b, { maxWidth: 1800, quality: 0.8 })))
      const startIdx = uploadedPages.length
      const newPages = compressed.map((blob, i) => ({ index: startIdx + i, blob, url: URL.createObjectURL(blob) }))
      setUploadedPages(prev => [...prev, ...newPages])
      // Reset downstream steps since pages changed
      resetFromStep('upload_order')
      setEditingKey(null)
      setExtractedImageBlobs([])
    } catch (err) {
      setFileError(err instanceof Error ? err.message : '檔案處理失敗')
    } finally {
      setIsProcessingFiles(false)
    }
  }

  const handleDeleteAllPages = () => {
    uploadedPages.forEach(p => URL.revokeObjectURL(p.url))
    setUploadedPages([])
    setPageItems([])
    resetFromStep('upload_order')
    setEditingKey(null)
    setExtractedImageBlobs([])
  }

  const handleConfirmPageOrder = () => {
    if (pageItems.length === 0) return
    markComplete('upload_order')
    setActiveStep('extracting')
  }

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setPageItems((prev) => {
        const oldIdx = prev.findIndex((i) => i.id === active.id)
        const newIdx = prev.findIndex((i) => i.id === over.id)
        return arrayMove(prev, oldIdx, newIdx)
      })
    }
  }, [])

  const handleRotateOne = useCallback((id: string) => {
    setPageItems((prev) => prev.map((item) => item.id === id ? { ...item, rotation: (item.rotation + 90) % 360 } : item))
  }, [])

  const handleDeletePage = useCallback((id: string) => {
    setPageItems((prev) => {
      const next = prev.filter((item) => item.id !== id)
      if (next.length === 0) {
        // Last page deleted — also clean up uploaded pages
        uploadedPages.forEach(p => URL.revokeObjectURL(p.url))
        setUploadedPages([])
        resetFromStep('upload_order')
        setEditingKey(null)
        setExtractedImageBlobs([])
      }
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadedPages])

  // When page items change (reorder/rotate/delete), reset upload_order completion if it was set
  // Skip reset when update comes from post-extraction sync
  const prevPageItemsRef = useRef(pageItems)
  const skipPageResetRef = useRef(false)
  useEffect(() => {
    if (skipPageResetRef.current) {
      skipPageResetRef.current = false
      prevPageItemsRef.current = pageItems
      return
    }
    if (prevPageItemsRef.current !== pageItems && completedSteps.has('upload_order')) {
      if (prevPageItemsRef.current.length > 0) {
        resetFromStep('upload_order')
      }
    }
    prevPageItemsRef.current = pageItems
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageItems])

  // ── Step 3: extraction state ───────────────────���──────────────────────────
  const [isExtracting, setIsExtracting] = useState(false)
  const [extractionMsg, setExtractionMsg] = useState('準備中…')
  const [extractError, setExtractError] = useState<string | null>(null)
  const [extractedImageBlobs, setExtractedImageBlobs] = useState<Blob[]>(
    initialAnswerSheetImages.length > 0 ? [...initialAnswerSheetImages] : []
  )
  const [notice, setNotice] = useState<string | null>(null)

  const handleStartExtract = async () => {
    setIsExtracting(true)
    setExtractError(null)
    setExtractionMsg('準備中…')
    try {
      const orderedBlobs = pageItems.map((item, newIdx) => {
        const orig = uploadedPages.find((p) => p.index === item.originalIndex)!
        return { index: newIdx, url: orig.url, blob: orig.blob, rotation: item.rotation }
      })

      // Apply rotation + perspective correction
      setExtractionMsg('校正圖片角度…')
      try {
        const [{ rotateImageBlob }, { correctPerspective }] = await Promise.all([
          import('../lib/imageCompression'),
          import('../lib/perspectiveCorrection')
        ])
        await Promise.all(orderedBlobs.map(async (item) => {
          if (item.rotation !== 0) {
            item.blob = await rotateImageBlob(item.blob, item.rotation)
          }
          const oldUrl = item.url
          item.blob = await correctPerspective(item.blob)
          URL.revokeObjectURL(oldUrl)
          item.url = URL.createObjectURL(item.blob)
        }))
      } catch (err) {
        console.warn('[UnifiedModal] perspective correction failed, using originals:', err)
      }

      const effectiveDomain = domain === '國語（測試中）' ? '國語' : domain
      const { answerKey, imageBlobs: blobs, notice: n } = await onExtract(orderedBlobs, setExtractionMsg, { domain: effectiveDomain, docType })
      setEditingKey(answerKey)
      setExtractedImageBlobs(blobs)
      setNotice(n)
      setSelectedIdx(0)
      // Update uploadedPages with corrected images so Step 2 preview stays valid
      skipPageResetRef.current = true
      const correctedPages = blobs.map((blob, i) => ({
        index: i, blob, url: URL.createObjectURL(blob),
      }))
      setUploadedPages(correctedPages)
      markComplete('extracting')
      markComplete('editing') // editing is auto-unlocked, consider complete by default
      setActiveStep('editing')
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsExtracting(false)
    }
  }

  // ─�� Step 4: editing state ──────────��──────────────────────────────────────
  const [editingKey, setEditingKey] = useState<AnswerKey | null>(initialAnswerKey)
  const [selectedIdx, setSelectedIdx] = useState(0)

  // bbox drawing state
  const [isDrawingBbox, setIsDrawingBbox] = useState(false)
  const [bboxDraft, setBboxDraft] = useState<NormalizedBbox | null>(null)
  const bboxDrawStart = useRef<{ x: number; y: number } | null>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const [imageObjUrl, setImageObjUrl] = useState<string | null>(null)
  const [manualCropUrl, setManualCropUrl] = useState<string | null>(null)

  // Image URL for selected question
  useEffect(() => {
    const q = editingKey?.questions[selectedIdx]
    const pageIdx = q?.pageIndex ?? Math.max(0, (parseInt(String(q?.id ?? '').split('-')[0], 10) || 1) - 1)
    const blob = extractedImageBlobs[pageIdx] ?? extractedImageBlobs[0] ?? null
    if (!blob) { setImageObjUrl(null); return }
    const url = URL.createObjectURL(blob)
    setImageObjUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [extractedImageBlobs, selectedIdx, editingKey])

  // Reset drawing mode when switching questions
  useEffect(() => { setIsDrawingBbox(false); setManualCropUrl(null) }, [selectedIdx])

  // Canvas crop
  useEffect(() => {
    const selectedQuestion = editingKey?.questions[selectedIdx] ?? null
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
      canvas.width = sw; canvas.height = sh
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
      if (!cancelled) setManualCropUrl(canvas.toDataURL('image/jpeg', 0.92))
    }
    img.src = imageObjUrl
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bboxDraft, editingKey?.questions[selectedIdx]?.referenceBbox, imageObjUrl])

  // Question editing helpers
  const updateField = (idx: number, field: keyof AnswerKeyQuestion, value: unknown) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => i === idx ? { ...q, [field]: value } : q) }
    })
  }

  const removeQuestion = (idx: number) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.filter((_, i) => i !== idx) }
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
        const ans = [...(q.acceptableAnswers ?? [])]; ans[ansIdx] = value
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
        return { ...q, rubricsDimensions: [...(q.rubricsDimensions ?? []), { name: '', criteria: '', maxScore: 1 }], rubric: undefined }
      })}
    })
  }

  const updateDimension = (qIdx: number, dIdx: number, field: string, value: unknown) => {
    setEditingKey((prev) => {
      if (!prev) return prev
      return { ...prev, questions: prev.questions.map((q, i) => {
        if (i !== qIdx) return q
        return { ...q, rubricsDimensions: (q.rubricsDimensions ?? []).map((d, j) => j === dIdx ? { ...d, [field]: value } : d) }
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

  // Bbox drawing handlers
  const getNormalizedCoords = (e: React.MouseEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const container = imageContainerRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) }
  }

  const handleBboxMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawingBbox) return
    const coords = getNormalizedCoords(e); if (!coords) return
    bboxDrawStart.current = coords
    setBboxDraft({ x: coords.x, y: coords.y, w: 0, h: 0 })
    e.preventDefault()
  }

  const handleBboxMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawingBbox || !bboxDrawStart.current) return
    const coords = getNormalizedCoords(e); if (!coords) return
    const start = bboxDrawStart.current
    setBboxDraft({ x: Math.min(start.x, coords.x), y: Math.min(start.y, coords.y), w: Math.abs(coords.x - start.x), h: Math.abs(coords.y - start.y) })
  }

  const handleBboxMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawingBbox || !bboxDrawStart.current) return
    const coords = getNormalizedCoords(e)
    if (!coords || !bboxDraft || bboxDraft.w < 0.01 || bboxDraft.h < 0.01) {
      setBboxDraft(null); bboxDrawStart.current = null; return
    }
    const finalBbox = { x: Math.min(bboxDrawStart.current.x, coords.x), y: Math.min(bboxDrawStart.current.y, coords.y), w: Math.abs(coords.x - bboxDrawStart.current.x), h: Math.abs(coords.y - bboxDrawStart.current.y) }
    updateField(selectedIdx, 'referenceBbox', finalBbox)
    setBboxDraft(null); bboxDrawStart.current = null; setIsDrawingBbox(false)
  }

  // ── derived editing state ──
  const selectedQuestion = editingKey?.questions[selectedIdx] ?? null
  const selectedCategory = selectedQuestion ? getEffectiveCategory(selectedQuestion) : 'fill_blank'
  const selectedType = CATEGORY_TO_TYPE[selectedCategory] ?? 2
  const activeBbox: NormalizedBbox | null = bboxDraft ?? selectedQuestion?.referenceBbox ?? selectedQuestion?.answerBbox ?? null
  const bboxIsAiDetected = !bboxDraft && !selectedQuestion?.referenceBbox && !!selectedQuestion?.answerBbox

  // ── save ────────────────────────────────────────��─────────────────────────
  const [isSaving, setIsSaving] = useState(false)
  const [confirmOverlay, setConfirmOverlay] = useState<null | 'save'>(null)

  const handleSaveClick = () => {
    if (hasGradedSubmissions) {
      setConfirmOverlay('save')
    } else {
      void doSave()
    }
  }

  const doSave = async () => {
    if (!editingKey) return
    // Validate dimension sums
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
    setConfirmOverlay(null)
    setIsSaving(true)
    try {
      const updatedKey: AnswerKey = {
        ...editingKey,
        totalScore: editingKey.questions.reduce((s, q) => s + (q.maxScore ?? 0), 0),
      }
      const domainValue = domain === '國語（測試中）' ? '國語' : (domain || '其他')
      await onSave(updatedKey, extractedImageBlobs, {
        title: title.trim(),
        domain: domainValue,
        docType,
        folder,
        answerSheetMode,
        questionBookletBlobs,
      })
    } finally {
      setIsSaving(false)
    }
  }

  // ── cleanup ────────────────────────────────────���──────────────────────────
  useEffect(() => {
    return () => {
      uploadedPages.forEach(p => URL.revokeObjectURL(p.url))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── render ────────────���───────────────────────────────────────────────────
  if (!open) return null

  const effectiveDomain = domain === '國語（測試中）' ? '���語' : domain

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-[960px] h-[640px] flex flex-col overflow-hidden relative">

        {/* ── Main content: sidebar + content ── */}
        <div className="flex-1 flex overflow-hidden min-h-0">

          {/* Left Step Bar */}
          <div className="w-52 bg-gray-50 border-r border-gray-200 flex flex-col shrink-0">
            <div className="px-4 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">
                {editMode ? '編輯答案卷' : '新增答案卷'}
              </h2>
            </div>
            <nav className="flex-1 py-2">
              {STEP_CONFIG.map((stepCfg) => {
                const isActive = activeStep === stepCfg.key
                const isCompleted = completedSteps.has(stepCfg.key)
                const unlocked = isStepUnlocked(stepCfg.key)
                const readOnly = isStepReadOnly(stepCfg.key)

                return (
                  <button
                    key={stepCfg.key}
                    type="button"
                    disabled={!unlocked}
                    onClick={() => unlocked && setActiveStep(stepCfg.key)}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors text-sm ${
                      isActive
                        ? readOnly
                          ? 'bg-gray-100 text-gray-700 border-r-2 border-gray-400'
                          : 'bg-green-50 text-green-800 border-r-2 border-green-600'
                        : unlocked
                          ? 'text-gray-700 hover:bg-gray-100'
                          : 'text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    {/* Step icon */}
                    {isCompleted ? (
                      <CheckCircle2 className={`w-5 h-5 shrink-0 ${isActive && !readOnly ? 'text-green-600' : 'text-green-500'}`} />
                    ) : !unlocked ? (
                      <Lock className="w-5 h-5 shrink-0 text-gray-300" />
                    ) : (
                      <Circle className={`w-5 h-5 shrink-0 ${isActive ? 'text-green-600' : 'text-gray-400'}`} />
                    )}
                    <div className="flex flex-col">
                      <span className={`font-medium ${isActive && !readOnly ? 'text-green-800' : ''}`}>
                        {stepCfg.label}
                      </span>
                      {readOnly && (
                        <span className="text-[10px] text-gray-400">僅供瀏覽</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </nav>
            {/* Close button at bottom of sidebar */}
            <div className="px-4 py-3 border-t border-gray-200">
              <button
                type="button"
                onClick={onClose}
                className="w-full text-sm text-gray-500 hover:text-gray-700 py-1.5"
              >
                取消
              </button>
            </div>
          </div>

          {/* Right Content Area */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Content */}
            <div className="flex-1 overflow-y-auto">

              {/* ══ Step 1: 基本資料 ══ */}
              {activeStep === 'metadata' && (
                <div className="p-6 pb-8 space-y-8 max-w-lg">
                  {editMode && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-500">
                      <Lock className="w-3.5 h-3.5 shrink-0" />
                      <span>編輯模式下基本資料僅供瀏覽，如需修改請建立新答案卷</span>
                    </div>
                  )}
                  {/* 答案卷名稱 */}
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">
                      答案卷名稱 {!editMode && <span className="text-red-500">*</span>}
                    </label>
                    {editMode ? (
                      <p className="text-sm text-gray-700 px-3 py-2.5 bg-gray-50 rounded-lg border border-gray-200">{title || '—'}</p>
                    ) : (
                      <input
                        type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                        placeholder="例如：數習P.42-43" autoFocus
                        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                      />
                    )}
                  </div>

                  {/* 領域 */}
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">
                      領域 {!editMode && <span className="text-red-500">*</span>}
                    </label>
                    {editMode ? (
                      <p className="text-sm text-gray-700 px-3 py-2.5 bg-gray-50 rounded-lg border border-gray-200">{domain || '—'}</p>
                    ) : (
                      <select
                        value={domain} onChange={(e) => setDomain(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-green-400 focus:outline-none"
                      >
                        <option value="">請選擇</option>
                        {domainOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    )}
                  </div>

                  {/* 類型 — segmented control */}
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">類型</label>
                    {editMode ? (
                      <p className="text-sm text-gray-700 px-3 py-2.5 bg-gray-50 rounded-lg border border-gray-200">{docType === 'worksheet' ? '習作' : '考卷'}</p>
                    ) : (
                      <>
                        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                          <button
                            type="button"
                            onClick={() => setDocType('worksheet')}
                            className={`px-5 py-2 text-sm font-medium transition-colors ${
                              docType === 'worksheet'
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            習作
                          </button>
                          <button
                            type="button"
                            onClick={() => setDocType('exam')}
                            className={`px-5 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                              docType === 'exam'
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            考卷
                          </button>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">影響 AI 解析時的題號排序策略</p>
                      </>
                    )}
                  </div>

                  {/* 答案卷模式 — segmented control */}
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">答案卷模式</label>
                    {editMode ? (
                      <p className="text-sm text-gray-700 px-3 py-2.5 bg-gray-50 rounded-lg border border-gray-200">{answerSheetMode === 'with_questions' ? '帶題目' : '純答案卷（題本分開）'}</p>
                    ) : (
                      <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setAnswerSheetMode('with_questions')}
                          className={`px-5 py-2 text-sm font-medium transition-colors ${
                            answerSheetMode === 'with_questions'
                              ? 'bg-green-600 text-white'
                              : 'bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          帶題目
                        </button>
                        <button
                          type="button"
                          onClick={() => setAnswerSheetMode('answer_only')}
                          className={`px-5 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                            answerSheetMode === 'answer_only'
                              ? 'bg-green-600 text-white'
                              : 'bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          純答案卷（題本分開）
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 題本上傳（純答案卷模式，僅新建） */}
                  {!editMode && answerSheetMode === 'answer_only' && (
                    <div>
                      <label className="block text-base font-semibold text-gray-800 mb-1">
                        上傳題本
                      </label>
                      <p className="text-xs text-slate-500 mb-2">學生看到的題目頁面，用於錯誤解說</p>
                      <input
                        type="file" accept="image/*,.pdf" multiple
                        onChange={async (e) => {
                          const files = Array.from(e.target.files || [])
                          if (files.length === 0) return
                          const blobs: Blob[] = []
                          for (const file of files) {
                            if (file.type === 'application/pdf') {
                              const pages = await convertPdfToImages(file)
                              blobs.push(...pages)
                            } else {
                              blobs.push(file)
                            }
                          }
                          setQuestionBookletBlobs(blobs)
                        }}
                        className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
                      />
                      {questionBookletBlobs.length > 0 && (
                        <p className="mt-1 text-xs text-green-600">已選取 {questionBookletBlobs.length} 頁題本圖</p>
                      )}
                    </div>
                  )}

                  {/* 提示 */}
                  {!editMode && !metadataValid && (
                    <p className="text-xs text-amber-600">請填寫名稱和領域以繼續下一步</p>
                  )}
                </div>
              )}

              {/* ══ Step 2: 上傳答案 ══ */}
              {activeStep === 'upload_order' && (
                <div className="p-4 flex flex-col h-full">
                  {editMode ? (
                    /* ── Edit mode: read-only view ── */
                    <>
                      <div className="mb-4 shrink-0 flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-500">
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        <span>編輯模式下僅供瀏覽，如需重新上傳請建立新答案卷</span>
                      </div>
                      {pageItems.length > 0 ? (
                        <>
                          <div className="mb-3 text-sm text-gray-600">共 {pageItems.length} 頁</div>
                          <div className="flex-1 min-h-0 overflow-y-auto">
                            <div
                              className="grid gap-4"
                              style={{ gridTemplateColumns: `repeat(${Math.min(pageItems.length, 2)}, minmax(0, 1fr))` }}
                            >
                              {pageItems.map((item) => (
                                <div key={item.id} className="border-2 border-gray-200 rounded-xl overflow-hidden bg-white flex flex-col">
                                  <div className="bg-gray-50 px-2 py-1.5 text-xs text-gray-600 font-medium shrink-0">
                                    第 {item.originalIndex + 1} 頁
                                  </div>
                                  <div className="flex-1 bg-white overflow-hidden flex items-center justify-center">
                                    <img src={item.url} alt={`第 ${item.originalIndex + 1} 頁`} className="w-full h-full object-contain" draggable={false} />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
                          無圖片資料
                        </div>
                      )}
                    </>
                  ) : (
                    /* ── Create mode: full upload + reorder ── */
                    <>
                      {/* Upload area */}
                      <div className="mb-4 shrink-0">
                        <input ref={fileInputRef} type="file" accept="image/*,.pdf" multiple className="hidden" onChange={handleFileChange} />
                        <input ref={addFileInputRef} type="file" accept="image/*,.pdf" multiple className="hidden" onChange={handleAddFiles} />
                        {pageItems.length === 0 ? (
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isProcessingFiles}
                            className="w-full border-2 border-dashed border-gray-300 rounded-xl py-12 flex flex-col items-center gap-3 text-gray-500 hover:border-green-400 hover:text-green-600 hover:bg-green-50/30 transition-colors"
                          >
                            {isProcessingFiles ? (
                              <Loader2 className="w-8 h-8 animate-spin" />
                            ) : (
                              <Upload className="w-8 h-8" />
                            )}
                            <span className="text-sm font-medium">
                              {isProcessingFiles ? '處理中…' : '點擊上傳答案卷圖片或 PDF'}
                            </span>
                            <span className="text-xs text-gray-400">支援多檔上傳</span>
                          </button>
                        ) : (
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-600">共 {pageItems.length} 頁，拖曳調整順序</span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => addFileInputRef.current?.click()}
                                disabled={isProcessingFiles}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                              >
                                {isProcessingFiles ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                新增檔案
                              </button>
                              <button
                                type="button"
                                onClick={handleDeleteAllPages}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" /> 全部刪除
                              </button>
                            </div>
                          </div>
                        )}
                        {fileError && (
                          <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{fileError}</div>
                        )}
                      </div>

                      {/* Page order grid */}
                      {pageItems.length > 0 && (
                        <div className="flex-1 min-h-0 overflow-y-auto">
                          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                            <SortableContext items={pageItems.map((i) => i.id)} strategy={rectSortingStrategy}>
                              <div
                                className="grid gap-4"
                                style={{ gridTemplateColumns: `repeat(${Math.min(pageItems.length, 2)}, minmax(0, 1fr))` }}
                              >
                                {pageItems.map((item) => (
                                  <SortablePageCard key={item.id} item={item} onRotate={handleRotateOne} onDelete={handleDeletePage} canDelete />
                                ))}
                              </div>
                            </SortableContext>
                          </DndContext>
                        </div>
                      )}
                    </>
                  )}

                  {/* Confirm button */}
                  {pageItems.length > 0 && !completedSteps.has('upload_order') && (
                    <div className="mt-4 flex justify-end shrink-0">
                      <button
                        type="button"
                        onClick={handleConfirmPageOrder}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
                      >
                        <Check className="w-4 h-4" /> 確認順序
                      </button>
                    </div>
                  )}
                  {completedSteps.has('upload_order') && pageItems.length > 0 && (
                    <div className="mt-4 flex items-center gap-2 text-sm text-green-600 shrink-0">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>頁面順序已確認</span>
                    </div>
                  )}
                </div>
              )}

              {/* ══ Step 3: AI 解析 ══ */}
              {activeStep === 'extracting' && (
                <div className="p-6 flex flex-col items-center justify-center h-full">
                  {editMode ? (
                    /* ── Edit mode: read-only ── */
                    <div className="text-center space-y-4">
                      <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto">
                        <CheckCircle2 className="w-8 h-8 text-green-500" />
                      </div>
                      <div>
                        <h3 className="text-base font-semibold text-gray-900 mb-1">AI 解析已完成</h3>
                        <p className="text-sm text-gray-500">
                          共 {editingKey?.questions.length ?? 0} 題
                        </p>
                      </div>
                      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-500">
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        <span>如需重新解析請建立新答案卷</span>
                      </div>
                    </div>
                  ) : (
                    /* ── Create mode ── */
                    <>
                      {!isExtracting && !completedSteps.has('extracting') && (
                        <div className="text-center space-y-4">
                          <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mx-auto">
                            <FileUp className="w-8 h-8 text-green-600" />
                          </div>
                          <div>
                            <h3 className="text-base font-semibold text-gray-900 mb-1">準備送出 AI 解析</h3>
                            <p className="text-sm text-gray-500">共 {pageItems.length} 頁答案卷圖片</p>
                            <p className="text-xs text-amber-600 mt-2">此操作將消耗墨水，完成後現有標準答案將被更新</p>
                          </div>
                          {extractError && (
                            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{extractError}</div>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleStartExtract()}
                            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
                          >
                            <Check className="w-4 h-4" /> 確認送出解析
                          </button>
                        </div>
                      )}
                      {isExtracting && (
                        <div className="text-center space-y-4">
                          <Loader2 className="w-10 h-10 text-green-600 animate-spin mx-auto" />
                          <p className="text-sm text-gray-600">{extractionMsg}</p>
                        </div>
                      )}
                      {completedSteps.has('extracting') && !isExtracting && (
                        <div className="text-center space-y-4">
                          <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mx-auto">
                            <CheckCircle2 className="w-8 h-8 text-green-600" />
                          </div>
                          <div>
                            <h3 className="text-base font-semibold text-gray-900 mb-1">AI 解析完成</h3>
                            <p className="text-sm text-gray-500">
                              已解析 {editingKey?.questions.length ?? 0} 題
                              {notice && <span className="text-amber-600 ml-2">{notice}</span>}
                            </p>
                          </div>
                          <div className="flex items-center justify-center gap-3">
                            <button
                              type="button"
                              onClick={() => void handleStartExtract()}
                              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                            >
                              重新解析
                            </button>
                            <button
                              type="button"
                              onClick={() => setActiveStep('editing')}
                              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
                            >
                              前往編輯題目 <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ══ Step 4: 題目編輯 ���═ */}
              {activeStep === 'editing' && editingKey && (
                <div className="flex h-full overflow-hidden">
                  {/* Question list sidebar */}
                  <div className="w-48 border-r border-gray-200 flex flex-col shrink-0 min-h-0">
                    <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between shrink-0">
                      <span className="text-xs font-medium text-gray-500">共 {editingKey.questions.length} 題</span>
                      <button type="button" onClick={addQuestion} className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-green-600" title="新增題目">
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto py-1">
                      {editingKey.questions.map((q, idx) => {
                        const cat = getEffectiveCategory(q)
                        const vocabWarn = hasVocabFillWarning(q, effectiveDomain)
                        const multiFillWarn = hasMultiFillQuestions(q)
                        const PLACEHOLDER_ANSWERS = ['?', '？', '未知', 'unknown', 'N/A']
                        const ans = (q.answer ?? '').trim()
                        const ref = (q.referenceAnswer ?? '').trim()
                        const answerMissing = (!ans || PLACEHOLDER_ANSWERS.includes(ans)) && (!ref || PLACEHOLDER_ANSWERS.includes(ref))
                          && cat !== 'short_answer' && cat !== 'word_problem' && cat !== 'calculation'
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
                                  <span className={`shrink-0 text-[10px] tabular-nums ${q.maxScore <= 0 ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>
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
                      <div className="px-3 py-2 border-t border-gray-100 text-xs text-gray-500 shrink-0">
                        總分 {editingKey.questions.reduce((s, q) => s + (q.maxScore ?? 0), 0)} 分
                      </div>
                    )}
                  </div>

                  {/* Question editing panel */}
                  <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                    {selectedQuestion ? (
                      <>
                        {/* Image preview */}
                        <div className="shrink-0 border-b border-gray-100 p-3 bg-gray-50">
                          {(manualCropUrl || selectedQuestion.cropImageUrl || selectedQuestion.cropImagePath) && !isDrawingBbox ? (
                            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden flex items-center justify-center h-36">
                              <img
                                src={manualCropUrl ?? selectedQuestion.cropImageUrl ?? `/api/storage/download?assignmentId=${encodeURIComponent(selectedQuestion.cropImagePath!.split('/')[1])}&cropPath=${encodeURIComponent(selectedQuestion.cropImagePath!)}`}
                                alt="答案區截圖" className="max-w-full max-h-full object-contain pointer-events-none" draggable={false}
                              />
                            </div>
                          ) : (
                            <div className="w-full flex justify-center rounded-lg border border-gray-200 bg-white overflow-hidden h-36">
                              <div
                                ref={imageContainerRef}
                                className={`relative inline-block max-h-36 ${isDrawingBbox ? 'cursor-crosshair' : 'cursor-default'}`}
                                onMouseDown={handleBboxMouseDown}
                                onMouseMove={handleBboxMouseMove}
                                onMouseUp={handleBboxMouseUp}
                              >
                                {imageObjUrl ? (
                                  <img src={imageObjUrl} alt="答案卷" className="block max-w-full max-h-36 pointer-events-none" draggable={false} />
                                ) : (
                                  <div className="flex items-center justify-center h-24 w-48 text-gray-400 text-xs">尚無圖片</div>
                                )}
                                {activeBbox && imageObjUrl && (
                                  <div
                                    className={`absolute border-2 pointer-events-none ${bboxIsAiDetected ? 'border-blue-500 bg-blue-500/10' : 'border-green-500 bg-green-500/10'}`}
                                    style={{ left: `${activeBbox.x * 100}%`, top: `${activeBbox.y * 100}%`, width: `${activeBbox.w * 100}%`, height: `${activeBbox.h * 100}%` }}
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
                              <span className="text-xs text-gray-400">尚未框選</span>
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
                              <span className="text-gray-500">題型</span>
                              <select
                                className={`w-full px-2 py-1 border border-gray-300 rounded ${hasGradedSubmissions ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-white'}`}
                                value={selectedCategory}
                                disabled={hasGradedSubmissions}
                                onChange={(e) => updateField(selectedIdx, 'questionCategory', e.target.value as QuestionCategory)}
                              >
                                {(Object.entries(CATEGORY_LABELS) as [QuestionCategory, string][]).map(([cat, label]) => (
                                  <option key={cat} value={cat}>{label}</option>
                                ))}
                              </select>
                              {hasGradedSubmissions && <span className="text-[10px] text-amber-600">已有批改，無法更改題型</span>}
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

                          {/* Type 1: answer */}
                          {selectedType === 1 && (
                            <div className="flex items-center gap-2">
                              <span className="text-gray-500 w-16 shrink-0">標準答案</span>
                              <input className="flex-1 px-2 py-1 border border-gray-300 rounded" value={selectedQuestion.answer ?? ''} onChange={(e) => updateField(selectedIdx, 'answer', e.target.value)} />
                            </div>
                          )}

                          {/* Type 2: reference + acceptable */}
                          {selectedType === 2 && (
                            <div className="space-y-2">
                              {(selectedCategory === 'multi_check' || selectedCategory === 'multi_choice' || selectedCategory === 'multi_check_other') ? (
                                <>
                                  <div className="flex items-center gap-2">
                                    <span className="text-gray-500 w-16 shrink-0">正確選項</span>
                                    <input className="flex-1 px-2 py-1 border border-gray-300 rounded" value={selectedQuestion.answer ?? ''} onChange={(e) => updateField(selectedIdx, 'answer', e.target.value)} placeholder={selectedCategory === 'multi_choice' ? '例如：A,C' : '例如：①,③'} />
                                  </div>
                                  {selectedCategory === 'multi_check_other' && (
                                    <div className="flex items-start gap-2">
                                      <span className="text-gray-500 w-16 shrink-0 mt-1">其他（參考）</span>
                                      <textarea rows={2} className="flex-1 px-2 py-1 border border-gray-300 rounded" value={selectedQuestion.referenceAnswer ?? ''} onChange={(e) => updateField(selectedIdx, 'referenceAnswer', e.target.value)} placeholder="其他欄的參考答案（選填）" />
                                    </div>
                                  )}
                                </>
                              ) : (
                                <>
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
                                </>
                              )}
                            </div>
                          )}

                          {/* Type 3: reference + rubrics */}
                          {selectedType === 3 && (
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
                      <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
                        {editingKey.questions.length === 0 ? '尚無題目，點擊左上角 + 新增' : '請從左側選取���目'}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Step 4 empty state when no editing key */}
              {activeStep === 'editing' && !editingKey && (
                <div className="p-6 flex flex-col items-center justify-center h-full text-gray-400 text-sm">
                  請先完成 AI 解析
                </div>
              )}
            </div>

            {/* ── Footer ── */}
            <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-gray-200 bg-gray-50 shrink-0">
              {editingKey && activeStep === 'editing' && (
                <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 mr-auto">
                  你可以相信 AI，但你一定要認真檢查
                </span>
              )}
              <button
                type="button"
                onClick={handleSaveClick}
                disabled={!allComplete || isSaving || !editingKey}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {isSaving ? '儲存中…' : '儲存答案卷'}
              </button>
            </div>
          </div>
        </div>

        {/* ── Confirm save overlay (for hasGradedSubmissions) ── */}
        {confirmOverlay === 'save' && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-10 rounded-2xl">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                <h3 className="font-semibold text-gray-900 text-sm">注意</h3>
              </div>
              <p className="text-xs text-gray-600 mb-4">修改標準答案不會自動重新批改已批改的作業，請手動重新批改需要更正的作業。</p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmOverlay(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">取消</button>
                <button type="button" onClick={() => void doSave()} className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">確認儲存</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
