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
  Lock, CheckCircle2, Circle, Upload
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import Button from '@/components/ui/Button'
import AnswerSheetModeSelector from '@/components/AnswerSheetModeSelector'
import { shouldAutoFocusOnDesktop } from '@/hooks/useAutoFocusOnDesktop'
import { convertPdfToImages, getFileType, fileToBlob } from '@/lib/pdfToImage'
import { compressImageFile } from '@/lib/imageCompression'
import type { AnswerKey, AnswerKeyQuestion, QuestionCategory, Rubric } from '@/lib/db'
import { QUESTION_CATEGORY_TO_BUCKET, QUESTION_CATEGORY_LABELS as CATEGORY_LABELS } from '@/lib/db'

function getEffectiveCategory(q: AnswerKeyQuestion): QuestionCategory {
  if (q.questionCategory) return q.questionCategory
  // 舊資料 fallback：依 type 推 questionCategory（type=1→fill_blank, 2→fill_variants, 3→short_answer）
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
      <button type="button" onClick={(e) => { e.stopPropagation(); onRotate(item.id) }} aria-label="旋轉 90 度" className="absolute top-9 right-1 p-1.5 rounded-full bg-white/90 border border-gray-300 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-gray-100" title="旋轉 90°">
        <RotateCw className="w-3.5 h-3.5 text-gray-600" />
      </button>
      {canDelete && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(item.id) }} aria-label="刪除此頁" className="absolute top-9 left-1 p-1.5 rounded-full bg-white/90 border border-red-300 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50" title="刪除此頁">
          <Trash2 className="w-3.5 h-3.5 text-red-500" />
        </button>
      )}
    </div>
  )
}

// ─── types ─────────────��────────────────────────────────────────────────────

type UnifiedStep = 'metadata' | 'extract' | 'editing'

const STEP_CONFIG: { key: UnifiedStep; label: string; shortLabel: string }[] = [
  { key: 'metadata', label: '基本資料', shortLabel: '①' },
  { key: 'extract', label: 'AI 解析', shortLabel: '②' },
  { key: 'editing', label: '題目編輯', shortLabel: '③' },
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
    () => editMode ? new Set<UnifiedStep>(['metadata', 'extract', 'editing']) : new Set()
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
  // docType UI 已移除（AI 直接從圖片視覺判斷雙欄/單欄）；保留變數供 sync 與 onExtract 傳遞
  const [docType] = useState<'worksheet' | 'exam'>(initialDocType)
  const [folder] = useState(initialFolder)
  const [answerSheetMode, setAnswerSheetMode] = useState<'with_questions' | 'answer_only'>(initialAnswerSheetMode)

  const metadataValid = title.trim() !== '' && domain !== ''

  // Auto-complete/uncomplete metadata step (skip in edit mode — steps are pre-completed)
  useEffect(() => {
    if (editMode) return
    if (metadataValid && !completedSteps.has('metadata')) {
      markComplete('metadata')
    } else if (!metadataValid && completedSteps.has('metadata')) {
      resetFromStep('metadata')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadataValid, editMode])

  // ── Step 2: upload + page order state ─────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isProcessingFiles, setIsProcessingFiles] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [uploadedPages, setUploadedPages] = useState<Array<{ index: number; url: string; blob: Blob }>>([])
  const [pageItems, setPageItems] = useState<PageItem[]>([])

  // ── Step 2 (answer_only only): 題本上傳 + 排序狀態 ────────────────────────
  const bookletFileInputRef = useRef<HTMLInputElement>(null)
  const bookletAddFileInputRef = useRef<HTMLInputElement>(null)
  const [isProcessingBooklet, setIsProcessingBooklet] = useState(false)
  const [bookletFileError, setBookletFileError] = useState<string | null>(null)
  const [bookletPages, setBookletPages] = useState<Array<{ index: number; url: string; blob: Blob }>>([])
  const [bookletPageItems, setBookletPageItems] = useState<PageItem[]>([])

  useEffect(() => {
    setBookletPageItems(bookletPages.map((p) => ({
      id: `booklet-page-${p.index}`,
      originalIndex: p.index,
      url: p.url,
      rotation: 0,
    })))
  }, [bookletPages])

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
      resetFromStep('extract')
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
      resetFromStep('extract')
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
    resetFromStep('extract')
    setEditingKey(null)
    setExtractedImageBlobs([])
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
        resetFromStep('extract')
        setEditingKey(null)
        setExtractedImageBlobs([])
      }
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadedPages])

  // ── 題本 (booklet) upload handlers — 純答案卷模式專用 ───────────────────
  const ingestBookletFiles = async (files: File[], appendMode = false) => {
    if (files.length === 0) return
    setBookletFileError(null)
    setIsProcessingBooklet(true)
    try {
      const blobs: Blob[] = []
      for (const file of files) {
        const ft = getFileType(file)
        if (ft === 'pdf') { blobs.push(...await convertPdfToImages(file, { scale: 1.5, quality: 0.7 })) }
        else if (ft === 'image') { blobs.push(await fileToBlob(file)) }
        else { setBookletFileError(`不支援的檔案格式：${file.name}`); return }
      }
      if (blobs.length === 0) { setBookletFileError('沒有可用的圖片'); return }
      const compressed = await Promise.all(blobs.map((b) => compressImageFile(b, { maxWidth: 1800, quality: 0.8 })))
      if (appendMode) {
        const startIdx = bookletPages.length
        const newPages = compressed.map((blob, i) => ({ index: startIdx + i, blob, url: URL.createObjectURL(blob) }))
        setBookletPages(prev => [...prev, ...newPages])
      } else {
        bookletPages.forEach(p => URL.revokeObjectURL(p.url))
        const pages = compressed.map((blob, i) => ({ index: i, blob, url: URL.createObjectURL(blob) }))
        setBookletPages(pages)
      }
    } catch (err) {
      setBookletFileError(err instanceof Error ? err.message : '檔案處理失敗')
    } finally {
      setIsProcessingBooklet(false)
    }
  }

  const handleBookletFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    await ingestBookletFiles(files, false)
  }

  const handleBookletAddFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    await ingestBookletFiles(files, true)
  }

  const handleBookletDeleteAll = () => {
    bookletPages.forEach(p => URL.revokeObjectURL(p.url))
    setBookletPages([])
    setBookletPageItems([])
  }

  const handleBookletDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setBookletPageItems((prev) => {
        const oldIdx = prev.findIndex((i) => i.id === active.id)
        const newIdx = prev.findIndex((i) => i.id === over.id)
        return arrayMove(prev, oldIdx, newIdx)
      })
    }
  }, [])

  const handleBookletRotateOne = useCallback((id: string) => {
    setBookletPageItems((prev) => prev.map((item) => item.id === id ? { ...item, rotation: (item.rotation + 90) % 360 } : item))
  }, [])

  const handleBookletDeletePage = useCallback((id: string) => {
    setBookletPageItems((prev) => {
      const next = prev.filter((item) => item.id !== id)
      if (next.length === 0) {
        bookletPages.forEach(p => URL.revokeObjectURL(p.url))
        setBookletPages([])
      }
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookletPages])

  // 切換到 with_questions 模式時清空題本（避免殘留）
  useEffect(() => {
    if (answerSheetMode === 'with_questions' && bookletPages.length > 0) {
      bookletPages.forEach(p => URL.revokeObjectURL(p.url))
      setBookletPages([])
      setBookletPageItems([])
      setBookletFileError(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerSheetMode])

  // When page items change (reorder/rotate/delete), reset upload_order completion if it was set
  // Skip reset when update comes from post-extraction sync
  const prevPageItemsRef = useRef(pageItems)
  const skipPageResetRef = useRef(false)
  useEffect(() => {
    if (editMode || skipPageResetRef.current) {
      skipPageResetRef.current = false
      prevPageItemsRef.current = pageItems
      return
    }
    if (prevPageItemsRef.current !== pageItems && completedSteps.has('extract')) {
      if (prevPageItemsRef.current.length > 0) {
        resetFromStep('extract')
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

  // Edit mode: 父層非同步從 Storage 下載答案卷圖後，把 prop 同步進編輯預覽用的 state
  useEffect(() => {
    if (!editMode) return
    if (initialAnswerSheetImages.length === 0) return
    if (extractedImageBlobs.length > 0) return
    setExtractedImageBlobs([...initialAnswerSheetImages])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, initialAnswerSheetImages])

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
      const total = orderedBlobs.length
      setExtractionMsg(`校正圖片角度 (0/${total})…`)
      try {
        const [{ rotateImageBlob }, { correctPerspective }] = await Promise.all([
          import('../lib/imageCompression'),
          import('../lib/perspectiveCorrection')
        ])
        let done = 0
        await Promise.all(orderedBlobs.map(async (item) => {
          if (item.rotation !== 0) {
            item.blob = await rotateImageBlob(item.blob, item.rotation)
          }
          const oldUrl = item.url
          item.blob = await correctPerspective(item.blob)
          URL.revokeObjectURL(oldUrl)
          item.url = URL.createObjectURL(item.blob)
          done += 1
          setExtractionMsg(`校正圖片角度 (${done}/${total})…`)
        }))
      } catch (err) {
        console.warn('[UnifiedModal] perspective correction failed, using originals:', err)
      }
      setExtractionMsg('擷取答案中，請稍候…')

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
      markComplete('extract')
      markComplete('editing') // editing is auto-unlocked, consider complete by default
      // 解析成功 → 自動跳到題目編輯，不停留在中間畫面
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
  const selectedBucket = QUESTION_CATEGORY_TO_BUCKET[selectedCategory] ?? 'A'
  // UI 模式（依 bucket 顯示對應欄位）：
  // A = answer 標準答案、B = reference + acceptable、C = reference + rubric、D = answer + reference + rubric
  const showAnswerField = selectedBucket === 'A' || selectedBucket === 'D'
  const showAcceptableAnswers = selectedBucket === 'B'
  const showRubric = selectedBucket === 'C' || selectedBucket === 'D'
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

      // 產出題本最終 blobs：依 bookletPageItems 排序並套用 rotation
      let finalBookletBlobs: Blob[] = []
      if (answerSheetMode === 'answer_only' && bookletPageItems.length > 0) {
        const orderedBookletBlobs = bookletPageItems.map((item) => {
          const orig = bookletPages.find((p) => p.index === item.originalIndex)!
          return { blob: orig.blob, rotation: item.rotation }
        })
        try {
          const { rotateImageBlob } = await import('../lib/imageCompression')
          finalBookletBlobs = await Promise.all(orderedBookletBlobs.map(async ({ blob, rotation }) =>
            rotation !== 0 ? await rotateImageBlob(blob, rotation) : blob
          ))
        } catch (err) {
          console.warn('[UnifiedModal] booklet rotation failed, using originals:', err)
          finalBookletBlobs = orderedBookletBlobs.map(({ blob }) => blob)
        }
      }

      await onSave(updatedKey, extractedImageBlobs, {
        title: title.trim(),
        domain: domainValue,
        docType,
        folder,
        answerSheetMode,
        questionBookletBlobs: finalBookletBlobs,
      })
    } finally {
      setIsSaving(false)
    }
  }

  // ── cleanup ────────────────────────────────────���──────────────────────────
  useEffect(() => {
    return () => {
      uploadedPages.forEach(p => URL.revokeObjectURL(p.url))
      bookletPages.forEach(p => URL.revokeObjectURL(p.url))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── footer dispatcher ─────────────────────────────────────────────────────
  // 主按鈕的文案 / 動作 / disabled 狀態都依 activeStep 決定，所有「下一步」按鈕統一在此。
  const primary: { label: string; disabled: boolean; loading?: boolean; icon?: React.ReactNode } = (() => {
    if (activeStep === 'metadata') {
      return { label: '下一步', disabled: !editMode && !metadataValid, icon: <ChevronRight className="w-4 h-4" /> }
    }
    if (activeStep === 'extract') {
      if (editMode) {
        return { label: '下一步：題目編輯', disabled: false, icon: <ChevronRight className="w-4 h-4" /> }
      }
      if (isExtracting) {
        return { label: '解析中…', disabled: true, loading: true }
      }
      // 從 ③ 退回（已解析過、editingKey 仍在、頁面沒變動）→ 純導航；否則送 AI
      const goingBackFromEdit = completedSteps.has('extract') && editingKey
      if (goingBackFromEdit) {
        return { label: '下一步：題目編輯', disabled: false, icon: <ChevronRight className="w-4 h-4" /> }
      }
      return { label: '確認送出解析', disabled: pageItems.length === 0, icon: <Check className="w-4 h-4" /> }
    }
    // editing
    return {
      label: isSaving ? '儲存中…' : '儲存答案卷',
      disabled: !allComplete || isSaving || !editingKey,
      loading: isSaving,
      icon: <Check className="w-4 h-4" />,
    }
  })()

  const handlePrimaryAction = () => {
    if (activeStep === 'metadata') {
      setActiveStep('extract')
      return
    }
    if (activeStep === 'extract') {
      if (editMode) { setActiveStep('editing'); return }
      if (isExtracting) return
      const goingBackFromEdit = completedSteps.has('extract') && editingKey
      if (goingBackFromEdit) { setActiveStep('editing'); return }
      void handleStartExtract()
      return
    }
    handleSaveClick()
  }

  const handleBack = () => {
    if (activeStep === 'extract') { setActiveStep('metadata'); return }
    if (activeStep === 'editing') { setActiveStep('extract'); return }
  }

  // ── render ────────────────────────────────────────────────────────────────
  if (!open) return null

  const effectiveDomain = domain === '國語（測試中）' ? '國語' : domain

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[120] p-4">
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
            {/* 流程清單為純文字，導航全交由 footer 主按鈕（樣式保留） */}
            <nav className="flex-1 py-2">
              {STEP_CONFIG.map((stepCfg) => {
                const isActive = activeStep === stepCfg.key
                const isCompleted = completedSteps.has(stepCfg.key)
                const unlocked = isStepUnlocked(stepCfg.key)
                const readOnly = isStepReadOnly(stepCfg.key)

                return (
                  <div
                    key={stepCfg.key}
                    aria-current={isActive ? 'step' : undefined}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 text-sm select-none ${
                      isActive
                        ? readOnly
                          ? 'bg-gray-100 text-gray-700 border-r-2 border-gray-400'
                          : 'bg-green-50 text-green-800 border-r-2 border-green-600'
                        : unlocked
                          ? 'text-gray-700'
                          : 'text-gray-400'
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
                  </div>
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
                        placeholder="例如：數習P.42-43" autoFocus={shouldAutoFocusOnDesktop()}
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

                  {/* 答案卷模式 — 卡片式選擇器 */}
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">答案卷模式</label>
                    {editMode ? (
                      <p className="text-sm text-gray-700 px-3 py-2.5 bg-gray-50 rounded-lg border border-gray-200">{answerSheetMode === 'with_questions' ? '一般模式（題目帶答案）' : '答案卷模式（題本分開）'}</p>
                    ) : (
                      <AnswerSheetModeSelector
                        value={answerSheetMode}
                        onChange={setAnswerSheetMode}
                      />
                    )}
                  </div>

                  {/* 提示 */}
                  {!editMode && !metadataValid && (
                    <p className="text-xs text-amber-600">請填寫名稱和領域以繼續下一步</p>
                  )}
                </div>
              )}

              {/* ══ Step 2: AI 解析（合併原 上傳答案 + AI 解析） ══ */}
              {activeStep === 'extract' && !isExtracting && (
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
                    <div className="flex flex-col gap-6">
                      {/* ── 答案卷區塊（永遠顯示） ── */}
                      <section className="rounded-xl border border-rose-200 bg-rose-50/30 p-4">
                        <div className="flex items-baseline justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold text-rose-900">📑 答案卷</h3>
                            <span className="text-[11px] px-1.5 py-0.5 bg-rose-100 text-rose-700 rounded font-medium">必傳</span>
                            <span className="text-xs text-gray-500">— 你自己寫好標準答案的版本</span>
                          </div>
                        </div>
                        <input ref={fileInputRef} type="file" accept="image/*,.pdf" multiple className="hidden" onChange={handleFileChange} />
                        <input ref={addFileInputRef} type="file" accept="image/*,.pdf" multiple className="hidden" onChange={handleAddFiles} />
                        {pageItems.length === 0 ? (
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isProcessingFiles}
                            className="w-full border-2 border-dashed border-rose-300 rounded-xl py-10 flex flex-col items-center gap-3 text-rose-500 hover:border-rose-400 hover:bg-rose-50/60 transition-colors bg-white"
                          >
                            {isProcessingFiles ? (
                              <Loader2 className="w-8 h-8 animate-spin" />
                            ) : (
                              <Upload className="w-8 h-8" />
                            )}
                            <span className="text-sm font-medium">
                              {isProcessingFiles ? '處理中…' : '點擊上傳答案卷圖片或 PDF'}
                            </span>
                            <span className="text-xs text-rose-400/80">支援多檔上傳</span>
                          </button>
                        ) : (
                          <div className="flex items-center justify-between mb-3">
                            <span className="text-sm text-gray-600">共 {pageItems.length} 頁，拖曳調整順序</span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => addFileInputRef.current?.click()}
                                disabled={isProcessingFiles}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                              >
                                {isProcessingFiles ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                新增檔案
                              </button>
                              <button
                                type="button"
                                onClick={handleDeleteAllPages}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" /> 全部刪除
                              </button>
                            </div>
                          </div>
                        )}
                        {fileError && (
                          <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{fileError}</div>
                        )}

                        {pageItems.length > 0 && (
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
                        )}
                      </section>

                      {/* ── 題本區塊（僅 answer_only 模式顯示） ── */}
                      {answerSheetMode === 'answer_only' && (
                        <section className="rounded-xl border border-blue-200 bg-blue-50/30 p-4">
                          <div className="flex items-baseline justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <h3 className="text-sm font-semibold text-blue-900">📚 題本</h3>
                              <span className="text-[11px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">建議上傳</span>
                              <span className="text-xs text-gray-500">— 學生看的乾淨題目卷</span>
                            </div>
                          </div>
                          <input ref={bookletFileInputRef} type="file" accept="image/*,.pdf" multiple className="hidden" onChange={handleBookletFileChange} />
                          <input ref={bookletAddFileInputRef} type="file" accept="image/*,.pdf" multiple className="hidden" onChange={handleBookletAddFiles} />
                          {bookletPageItems.length === 0 ? (
                            <button
                              type="button"
                              onClick={() => bookletFileInputRef.current?.click()}
                              disabled={isProcessingBooklet}
                              className="w-full border-2 border-dashed border-blue-300 rounded-xl py-10 flex flex-col items-center gap-3 text-blue-500 hover:border-blue-400 hover:bg-blue-50/60 transition-colors bg-white"
                            >
                              {isProcessingBooklet ? (
                                <Loader2 className="w-8 h-8 animate-spin" />
                              ) : (
                                <Upload className="w-8 h-8" />
                              )}
                              <span className="text-sm font-medium">
                                {isProcessingBooklet ? '處理中…' : '點擊上傳題本圖片或 PDF'}
                              </span>
                              <span className="text-xs text-blue-400/80">支援多檔上傳</span>
                            </button>
                          ) : (
                            <div className="flex items-center justify-between mb-3">
                              <span className="text-sm text-gray-600">共 {bookletPageItems.length} 頁，拖曳調整順序</span>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => bookletAddFileInputRef.current?.click()}
                                  disabled={isProcessingBooklet}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                                >
                                  {isProcessingBooklet ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                  新增檔案
                                </button>
                                <button
                                  type="button"
                                  onClick={handleBookletDeleteAll}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" /> 全部刪除
                                </button>
                              </div>
                            </div>
                          )}
                          {bookletFileError && (
                            <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{bookletFileError}</div>
                          )}

                          {bookletPageItems.length > 0 && (
                            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleBookletDragEnd}>
                              <SortableContext items={bookletPageItems.map((i) => i.id)} strategy={rectSortingStrategy}>
                                <div
                                  className="grid gap-4"
                                  style={{ gridTemplateColumns: `repeat(${Math.min(bookletPageItems.length, 2)}, minmax(0, 1fr))` }}
                                >
                                  {bookletPageItems.map((item) => (
                                    <SortablePageCard key={item.id} item={item} onRotate={handleBookletRotateOne} onDelete={handleBookletDeletePage} canDelete />
                                  ))}
                                </div>
                              </SortableContext>
                            </DndContext>
                          )}

                          <div className="mt-3 px-3 py-2 bg-amber-50 border-l-2 border-amber-400 rounded text-xs text-amber-800">
                            💡 不上傳題本仍可批改與計分，但學生端只會收到「答案不正確，請仔細思考」這類通用引導，且無法產出領域診斷報告。
                          </div>
                        </section>
                      )}
                    </div>
                  )}

                  {/* 已解析狀態：從 ③ 退回時顯示「重新解析」secondary（不改頁面也想重做用） */}
                  {!editMode && completedSteps.has('extract') && editingKey && pageItems.length > 0 && (
                    <div className="mt-4 flex items-center justify-between text-sm text-green-700 shrink-0 px-3 py-2 bg-green-50 border border-green-200 rounded-lg">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>已解析 {editingKey.questions.length} 題</span>
                        {notice && <span className="text-amber-600">{notice}</span>}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleStartExtract()}
                        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        重新解析
                      </button>
                    </div>
                  )}
                  {extractError && (
                    <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 shrink-0">{extractError}</div>
                  )}
                </div>
              )}

              {/* Step 2 解析中 sub-state */}
              {activeStep === 'extract' && isExtracting && (
                <div className="p-6 flex flex-col items-center justify-center h-full">
                  <Loader2 className="w-10 h-10 text-green-600 animate-spin mx-auto" />
                  <p className="mt-4 text-sm text-gray-600">{extractionMsg}</p>
                </div>
              )}


              {/* ══ Step 4: 題目編輯 ���═ */}
              {activeStep === 'editing' && editingKey && (
                <div className="flex h-full overflow-hidden">
                  {/* Question list sidebar */}
                  <div className="w-48 border-r border-gray-200 flex flex-col shrink-0 min-h-0">
                    <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between shrink-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-medium text-gray-500">共 {editingKey.questions.length} 題</span>
                        {(() => {
                          const PLACEHOLDER_ANSWERS = ['?', '？', '未知', 'unknown', 'N/A']
                          const missingCount = editingKey.questions.filter(q => {
                            const a = (q.answer ?? '').trim()
                            const r = (q.referenceAnswer ?? '').trim()
                            return (!a || PLACEHOLDER_ANSWERS.includes(a)) && (!r || PLACEHOLDER_ANSWERS.includes(r))
                          }).length
                          if (missingCount === 0) return null
                          return (
                            <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-semibold tabular-nums" title="AI 沒填答案的題數">
                              {missingCount} 缺答
                            </span>
                          )
                        })()}
                      </div>
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
                        // AI 漏填答案就警示（含 short_answer / word_problem / calculation —
                        // 這三類也必填 answer 或 referenceAnswer）
                        const answerMissing = (!ans || PLACEHOLDER_ANSWERS.includes(ans))
                          && (!ref || PLACEHOLDER_ANSWERS.includes(ref))
                        const hasWarn = vocabWarn || multiFillWarn || answerMissing
                        const isSelected = idx === selectedIdx
                        return (
                          <button
                            key={q.id ?? idx}
                            type="button"
                            onClick={() => setSelectedIdx(idx)}
                            className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-start gap-2 ${answerMissing ? 'border-l-4 border-red-500' : ''} ${
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
                            <button type="button" onClick={() => removeQuestion(selectedIdx)} aria-label="刪除此題" className="mt-4 p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500">
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
                                    <button type="button" onClick={() => removeAcceptableAnswer(selectedIdx, ansIdx)} aria-label="移除此答案" className="p-1 text-gray-400 hover:text-red-500"><X className="w-3 h-3" /></button>
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
                                        <button type="button" onClick={() => removeDimension(selectedIdx, dIdx)} aria-label="移除此維度" className="p-1 text-gray-400 hover:text-red-500"><X className="w-3 h-3" /></button>
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

            {/* ── Footer：上一步 + 主按鈕（dispatcher） ── */}
            <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-200 bg-gray-50 shrink-0">
              {/* 上一步：metadata 隱藏；解析中也隱藏避免 race */}
              {activeStep !== 'metadata' && !(activeStep === 'extract' && isExtracting) && (
                <Button type="button" variant="outline" onClick={handleBack}>
                  上一步
                </Button>
              )}

              {/* 中間 hint 區（保留原有的 編輯 step 警告） */}
              {editingKey && activeStep === 'editing' && (
                <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                  你可以相信 AI，但你一定要認真檢查
                </span>
              )}

              {/* 主按鈕（右下角，文案與動作隨 step 變化） */}
              <Button
                type="button"
                variant="primary"
                onClick={handlePrimaryAction}
                disabled={primary.disabled}
                className="ml-auto"
              >
                {primary.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : primary.icon}
                {primary.label}
              </Button>
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
                <Button type="button" variant="outline" onClick={() => setConfirmOverlay(null)}>取消</Button>
                <Button type="button" variant="primary" onClick={() => void doSave()}>確認儲存</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
