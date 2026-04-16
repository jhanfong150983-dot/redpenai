import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  CopyCheck,
  FileImage,
  Loader,
  RotateCw,
  Settings,
  Users,
  X,
} from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { NumericInput } from '@/components/NumericInput'
import { db, generateId, getCurrentTimestamp } from '@/lib/db'
import type { Assignment, Student, Submission } from '@/lib/db'
import { requestSync, waitForSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import {
  convertPdfToImages,
  getDefaultImageFormat,
  getFileType,
  sortFilesByNumber
} from '@/lib/pdfToImage'
import { blobToBase64, compressToTargetBytes, rotateImageBlob } from '@/lib/imageCompression'
import { safeToBlobWithFallback } from '@/lib/canvasToBlob'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from '@/lib/blob-storage'

// 目標檔案大小上限（1.5MB）
const TARGET_MAX_BYTES = 1.9 * 1024 * 1024

// ── 可排序頁面卡片 ────────────────────────────────────────────────────────────

function SortablePreviewCard({
  page,
  rotation,
  position,
  onRotate
}: {
  page: PagePreview
  rotation: number
  position: number
  onRotate: (index: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `page-${page.index}`
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : 1
  }

  return (
    <div ref={setNodeRef} style={style} className={`relative group ${isDragging ? 'shadow-2xl' : ''}`}>
      <div
        {...attributes}
        {...listeners}
        className="border-2 border-gray-200 rounded-xl overflow-hidden cursor-grab active:cursor-grabbing bg-white hover:border-green-400 transition-colors"
      >
        <div className="bg-gray-50 px-3 py-1.5 text-xs text-gray-600 font-medium flex items-center justify-between">
          <span>第 {position + 1} 頁</span>
          {rotation !== 0 && (
            <span className="text-[10px] text-orange-600 font-semibold">{rotation}°</span>
          )}
        </div>
        <div className="aspect-[3/4] bg-white overflow-hidden">
          <img
            src={page.url}
            alt={`第 ${position + 1} 頁`}
            className="w-full h-full object-contain transition-transform"
            style={{ transform: `rotate(${rotation}deg)` }}
            draggable={false}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRotate(page.index) }}
        className="absolute top-9 right-1 p-1.5 rounded-full bg-white/90 border border-gray-300 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-gray-100"
        title="旋轉 90°"
      >
        <RotateCw className="w-3.5 h-3.5 text-gray-600" />
      </button>
    </div>
  )
}

function PagePreviewSortable({
  pages,
  rotations,
  onRotate,
  onReorder
}: {
  pages: PagePreview[]
  rotations: Map<number, number>
  onRotate: (pageIndex: number) => void
  onReorder: (newOrder: number[]) => void
}) {
  const [items, setItems] = useState(() => pages.map((p) => p.index))

  // 當外部 pages 變更（切換學生）時同步重設
  useEffect(() => {
    setItems(pages.map((p) => p.index))
  }, [pages])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setItems((prev) => {
        const oldIndex = prev.findIndex((id) => `page-${id}` === active.id)
        const newIndex = prev.findIndex((id) => `page-${id}` === over.id)
        const next = arrayMove(prev, oldIndex, newIndex)
        onReorder(next)
        return next
      })
    }
  }, [onReorder])

  const pageByIndex = useMemo(() => {
    const m = new Map<number, PagePreview>()
    pages.forEach((p) => m.set(p.index, p))
    return m
  }, [pages])

  const cols = pages.length === 1 ? 'grid-cols-1' : pages.length === 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map((id) => `page-${id}`)} strategy={rectSortingStrategy}>
        <div className={`grid ${cols} gap-3`}>
          {items.map((pageIndex, position) => {
            const page = pageByIndex.get(pageIndex)
            if (!page) return null
            return (
              <SortablePreviewCard
                key={pageIndex}
                page={page}
                rotation={rotations.get(pageIndex) ?? 0}
                position={position}
                onRotate={onRotate}
              />
            )
          })}
        </div>
      </SortableContext>
    </DndContext>
  )
}

interface AssignmentImportProps {
  assignmentId: string
  onBack?: () => void
  onUploadComplete?: () => void
  embedded?: boolean
}

interface PagePreview {
  index: number // 0-based
  url: string
  blob: Blob
}

interface MappingRow {
  fromIndex: number
  toIndex: number
  seatNumber: number
  studentId: string
  name: string
}

function loadImgElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片載入失敗')) }
    img.src = url
  })
}

async function mergePageBlobs(pageBlobs: Blob[]): Promise<{ blob: Blob; pageBreaks: number[] }> {
  if (pageBlobs.length === 1) return { blob: pageBlobs[0], pageBreaks: [] }

  // 用 <img> 載入：瀏覽器會自動套用 EXIF 旋轉，取得正確的顯示尺寸
  const imgs = await Promise.all(pageBlobs.map(loadImgElement))
  const targetWidth = Math.max(...imgs.map((img) => img.naturalWidth))
  // 每張圖縮放到同一寬度，各自保持原始長寬比
  const scaledHeights = imgs.map((img) =>
    Math.round((targetWidth / img.naturalWidth) * img.naturalHeight)
  )
  const totalHeight = scaledHeights.reduce((sum, h) => sum + h, 0)

  // Canvas 尺寸保護：避免超過瀏覽器上限
  const MAX_CANVAS_SIDE = 16384
  if (targetWidth > MAX_CANVAS_SIDE || totalHeight > MAX_CANVAS_SIDE) {
    throw new Error(`合併後圖片尺寸過大（${targetWidth}x${totalHeight}），請改為每位學生 1 頁或降低解析度`)
  }

  // 計算頁面邊界（累積高度比例，不含最後一頁）
  const pageBreaks: number[] = []
  let cumulative = 0
  for (let i = 0; i < scaledHeights.length - 1; i++) {
    cumulative += scaledHeights[i]
    pageBreaks.push(parseFloat((cumulative / totalHeight).toFixed(4)))
  }

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = totalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('無法建立畫布')

  let offsetY = 0
  imgs.forEach((img, i) => {
    ctx.drawImage(img, 0, offsetY, targetWidth, scaledHeights[i])
    offsetY += scaledHeights[i]
  })

  // 使用統一的輸出格式（Safari 用 JPEG，其他用 WebP）
  const outputFormat = getDefaultImageFormat()
  const merged = await safeToBlobWithFallback(canvas, {
    format: outputFormat,
    quality: 0.85
  })

  return { blob: merged, pageBreaks }
}

/**
 * 壓縮圖片到目標大小（先縮尺寸、再降 quality）
 * 用於確保合併後的長圖不超過 1.5MB
 */
export default function AssignmentImport({
  assignmentId,
  onBack,
  onUploadComplete,
  embedded = false
}: AssignmentImportProps) {
  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [students, setStudents] = useState<Student[]>([])
  const avoidBlobStorage = shouldAvoidIndexedDbBlob()

  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [fileName, setFileName] = useState<string>('')
  const [pages, setPages] = useState<PagePreview[]>([])
  const [isUploading, setIsUploading] = useState(false)

  // 多 PDF 合併相關狀態
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  const [showMergeConfirm, setShowMergeConfirm] = useState(false)
  const [isMerging, setIsMerging] = useState(false)

  const [pagesPerStudent, setPagesPerStudent] = useState(1)
  const [startSeat, setStartSeat] = useState(1)
  const [absentSeatsInput, setAbsentSeatsInput] = useState('')
  const [mappings, setMappings] = useState<MappingRow[]>([])
  const [selectedMappingIndex, setSelectedMappingIndex] = useState(0)
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [phase, setPhase] = useState<'select' | 'edit-mapping'>('select')

  // 每頁的旋轉角度（0 / 90 / 180 / 270）
  const [pageRotations, setPageRotations] = useState<Map<number, number>>(new Map())
  // 每位學生的自訂頁序（studentId → 頁面 index 陣列）
  const [studentPageOrders, setStudentPageOrders] = useState<Map<string, number[]>>(new Map())

  // 計算班級中缺少的座號（跳號）
  const missingSeatNumbers = useMemo(() => {
    if (students.length === 0) return []

    const existingSeats = new Set(students.map(s => s.seatNumber))
    const minSeat = Math.min(...students.map(s => s.seatNumber))
    const maxSeat = Math.max(...students.map(s => s.seatNumber))

    const missing: number[] = []
    for (let i = minSeat; i <= maxSeat; i++) {
      if (!existingSeats.has(i)) {
        missing.push(i)
      }
    }
    return missing
  }, [students])

  const missingSeatSet = useMemo(() => new Set(missingSeatNumbers), [missingSeatNumbers])

  // 清理 URL 物件，防止 memory leak
  useEffect(() => {
    return () => {
      pages.forEach(p => URL.revokeObjectURL(p.url))
    }
  }, [pages])

  // 載入作業與班級、學生資料
  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const assignmentData = await db.assignments.get(assignmentId)
        if (!assignmentData) {
          throw new Error('找不到這份作業')
        }
        setAssignment(assignmentData)

        const classroomData = await db.classrooms.get(
          assignmentData.classroomId
        )
        if (!classroomData) {
          throw new Error('找不到對應的班級')
        }

        const studentsData = await db.students
          .where('classroomId')
          .equals(assignmentData.classroomId)
          .sortBy('seatNumber')
        setStudents(studentsData)
      } catch (e) {
        console.error(e)
        setError(e instanceof Error ? e.message : '載入資料失敗')
      } finally {
        setIsLoading(false)
      }
    }

    void load()
  }, [assignmentId])

  // 解析缺考座號
  const absentSet = useMemo(() => {
    return new Set(
      absentSeatsInput
        .split(/[,\s，、]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && /^\d+$/.test(s))
        .map((s) => Number.parseInt(s, 10))
    )
  }, [absentSeatsInput])

  const targetStudents = useMemo(() => {
    return students
      .filter(
        (s) =>
          s.seatNumber >= startSeat &&
          !absentSet.has(s.seatNumber) &&
          !missingSeatSet.has(s.seatNumber)
      )
      .sort((a, b) => a.seatNumber - b.seatNumber)
  }, [students, startSeat, absentSet, missingSeatSet])

  const targetStudentCount = targetStudents.length
  const assignedStudentCount = mappings.length
  const missingStudentCount = Math.max(targetStudentCount - assignedStudentCount, 0)

  // 自動配對：當 pages、pagesPerStudent、startSeat 或 absentSet 變化時
  useEffect(() => {
    if (pages.length === 0 || students.length === 0) {
      return
    }
    if (phase !== 'edit-mapping') return

    // 延遲一下讓 state 更新完成
    const timer = setTimeout(() => {
      handleAutoMap()
    }, 100)
    return () => clearTimeout(timer)
  }, [
    pages.length,
    pagesPerStudent,
    startSeat,
    absentSeatsInput,
    students.length,
    missingSeatNumbers.length,
    phase
  ])

  // 智能檢測缺考座號
  const absentSeatHint = useMemo(() => {
    if (pages.length === 0 || students.length === 0 || pagesPerStudent <= 0) {
      return null
    }

    const totalPages = pages.length
    const mappedPages = mappings.reduce((sum, m) => sum + (m.toIndex - m.fromIndex + 1), 0)
    const unmappedPages = totalPages - mappedPages
    const unmappedCopies = Math.floor(unmappedPages / pagesPerStudent)

    if (missingStudentCount > 0) {
      return {
        type: 'missing' as const,
        count: missingStudentCount,
        message: `供 ${totalPages} 頁，每位學生 ${pagesPerStudent} 頁，預計 ${targetStudentCount} 位學生，已分配 ${assignedStudentCount} 位，少了 ${missingStudentCount} 位，代表部分學生未交，請填寫未交座號（必填 ${missingStudentCount} 位）`
      }
    }

    if (unmappedCopies > targetStudentCount) {
      const extraCount = unmappedCopies - targetStudentCount
      return {
        type: 'extra' as const,
        count: extraCount,
        message: `供 ${totalPages} 頁，每位學生 ${pagesPerStudent} 頁，未分配 ${unmappedCopies} 份，學生數 ${targetStudentCount} 人。代表多 ${extraCount} 份，作業份數與學生人數不符，請再次確認。`
      }
    }

    return null
  }, [
    pages.length,
    students.length,
    pagesPerStudent,
    mappings,
    targetStudents,
    targetStudentCount,
    assignedStudentCount,
    missingStudentCount
  ])

  const selectedMapping = mappings[selectedMappingIndex] ?? null

  const pagesInSelectedRange = useMemo(() => {
    if (!selectedMapping) return []
    const customOrder = studentPageOrders.get(selectedMapping.studentId)
    if (customOrder) {
      return customOrder.map((idx) => pages.find((p) => p.index === idx)!).filter(Boolean)
    }
    return pages.filter((p) => p.index >= selectedMapping.fromIndex && p.index <= selectedMapping.toIndex)
  }, [selectedMapping, pages, studentPageOrders])

  const unusedPages = useMemo(() => {
    const used = new Set<number>()
    mappings.forEach((m) => {
      for (let i = m.fromIndex; i <= m.toIndex; i += 1) used.add(i)
    })
    return pages.filter((p) => !used.has(p.index))
  }, [pages, mappings])

  // 只有在有未分配頁面時才禁用按鈕，缺少學生作業時應該可以點擊（會彈出對話框）
  // isSaving 單獨處理，不顯示「無法匯入」警告
  const hasValidationErrors = unusedPages.length > 0
  const isConfirmDisabled = isSaving || hasValidationErrors

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = event.target.files
    if (!files || files.length === 0) return

    setError(null)
    setIsUploading(true)
    setPages([])
    setMappings([])
    setSelectedMappingIndex(0)
    setPhase('select')

    try {
      // 轉換為陣列並驗證檔案類型
      let fileArray = Array.from(files)
      for (const file of fileArray) {
        const type = getFileType(file)
        if (type !== 'pdf') {
          throw new Error(`檔案 "${file.name}" 不是 PDF 格式。僅支援 PDF 檔案。`)
        }
      }

      // 智能排序：按照檔案名稱中的數字排序
      fileArray = sortFilesByNumber(fileArray)
      console.log('📂 檔案已按數字排序:', fileArray.map(f => f.name))

      // 如果選擇多個 PDF,顯示合併確認介面
      if (fileArray.length > 1) {
        setUploadedFiles(fileArray)
        setShowMergeConfirm(true)
        setIsUploading(false)
        return
      }

      // 單一 PDF 的情況,直接處理
      const first = fileArray[0]
      await processSinglePdf(first)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '處理檔案失敗')
      setIsUploading(false)
    }
  }

  const processSinglePdf = async (file: File) => {
    setFileName(file.name)

    const blobs = await convertPdfToImages(file)

    const previews: PagePreview[] = blobs.map((blob, idx) => ({
      index: idx,
      blob,
      url: URL.createObjectURL(blob)
    }))

    setPages(previews)
    setPageRotations(new Map())
    setStudentPageOrders(new Map())
    setPhase('edit-mapping')
    setIsUploading(false)
  }

  const handleMergeConfirm = async () => {
    if (uploadedFiles.length === 0) return

    setIsMerging(true)
    setShowMergeConfirm(false)
    setError(null)

    try {
      console.log(`開始串接 ${uploadedFiles.length} 個 PDF 檔案`)

      // 直接串接所有 PDF 的頁面，不做真正的 merge
      const allBlobs: Blob[] = []
      for (const f of uploadedFiles) {
        console.log(`處理: ${f.name}`)
        // eslint-disable-next-line no-await-in-loop
        const blobs = await convertPdfToImages(f) // 用 pdfToImage 的預設護欄
        allBlobs.push(...blobs)
      }

      const previews: PagePreview[] = allBlobs.map((blob, idx) => ({
        index: idx,
        blob,
        url: URL.createObjectURL(blob)
      }))

      setPages(previews)
      setPageRotations(new Map())
      setStudentPageOrders(new Map())
      setPhase('edit-mapping')
      setFileName(`已串接 ${uploadedFiles.length} 個 PDF（共 ${previews.length} 頁）`)
      setUploadedFiles([])

      console.log(`串接完成，共 ${previews.length} 頁`)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '處理 PDF 失敗')
      setShowMergeConfirm(true) // 返回合併確認介面
    } finally {
      setIsMerging(false)
    }
  }

  const handleMergeCancel = () => {
    setShowMergeConfirm(false)
    setUploadedFiles([])
    setIsUploading(false)
  }

  // ── 旋轉與換序 ────────────────────────────────────────────────────────────

  const handleRotatePage = useCallback((pageIndex: number) => {
    setPageRotations((prev) => {
      const next = new Map(prev)
      next.set(pageIndex, ((prev.get(pageIndex) ?? 0) + 90) % 360)
      return next
    })
  }, [])

  const handleRotateAll = useCallback(() => {
    setPageRotations((prev) => {
      const next = new Map(prev)
      // 取得所有頁面 index
      setPages((currentPages) => {
        for (const p of currentPages) {
          next.set(p.index, ((prev.get(p.index) ?? 0) + 90) % 360)
        }
        return currentPages
      })
      return next
    })
  }, [])

  // 取得某位學生的頁面（套用自訂順序）
  const getStudentPages = useCallback((mapping: MappingRow): PagePreview[] => {
    const customOrder = studentPageOrders.get(mapping.studentId)
    if (customOrder) {
      return customOrder.map((idx) => pages.find((p) => p.index === idx)!).filter(Boolean)
    }
    return pages.filter((p) => p.index >= mapping.fromIndex && p.index <= mapping.toIndex)
  }, [pages, studentPageOrders])

  // 套用目前學生的順序 + 旋轉樣式到所有學生
  const handleApplyToAll = useCallback(() => {
    if (!selectedMapping) return
    const sourcePages = getStudentPages(selectedMapping)
    const sourceCount = sourcePages.length

    setStudentPageOrders((prevOrders) => {
      const next = new Map(prevOrders)
      setPageRotations((prevRots) => {
        const nextRots = new Map(prevRots)
        for (const mapping of mappings) {
          if (mapping.studentId === selectedMapping.studentId) continue
          const targetPages = pages.filter(
            (p) => p.index >= mapping.fromIndex && p.index <= mapping.toIndex
          )
          if (targetPages.length !== sourceCount) continue

          // 套用同樣的相對順序
          const sourceDefaultPages = pages.filter(
            (p) => p.index >= selectedMapping.fromIndex && p.index <= selectedMapping.toIndex
          )
          const newOrder = sourcePages.map((sp) => {
            const relativeOffset = sourceDefaultPages.findIndex((dp) => dp.index === sp.index)
            return targetPages[relativeOffset]?.index ?? sp.index
          }).filter((idx): idx is number => idx !== undefined)
          next.set(mapping.studentId, newOrder)

          // 套用同樣的旋轉
          sourcePages.forEach((sp, i) => {
            const rot = prevRots.get(sp.index) ?? 0
            if (targetPages[i]) nextRots.set(targetPages[i].index, rot)
          })
        }
        return nextRots
      })
      return next
    })
  }, [selectedMapping, getStudentPages, mappings, pages])

  const handleAutoMap = () => {
    if (pages.length === 0) {
      setError('請先上傳 PDF 檔案')
      return
    }
    if (!students.length) {
      setError('此班級尚未有學生名單')
      return
    }
    // 驗證每位學生頁數和起始頁號
    const pagesNum = Number(pagesPerStudent)
    const startNum = Number(startSeat)
    if (!Number.isFinite(pagesNum) || pagesNum < 1) {
      setError('請填寫有效的每位學生頁數')
      return
    }
    if (!Number.isFinite(startNum) || startNum < 1) {
      setError('請填寫有效的起始頁號')
      return
    }

    setError(null)

    const result: MappingRow[] = []
    let pageIndex = 0

    console.log('🎯 開始自動配對:', {
      totalPages: pages.length,
      pagesPerStudent: pagesNum,
      targetStudents: targetStudents.length,
      startSeat: startNum
    })

    for (const stu of targetStudents) {
      if (pageIndex >= pages.length) break

      const fromIndex = pageIndex
      const toIndex = Math.min(
        pageIndex + pagesPerStudent - 1,
        pages.length - 1
      )

      result.push({
        fromIndex,
        toIndex,
        seatNumber: stu.seatNumber,
        studentId: stu.id,
        name: stu.name
      })

      pageIndex += pagesPerStudent
    }

    console.log('✅ 自動配對完成:', {
      mappedStudents: result.length,
      usedPages: pageIndex,
      unusedPages: pages.length - pageIndex
    })

    setMappings(result)
    setSelectedMappingIndex(0)
  }

  const handleSaveMappings = async () => {
    if (!assignment) {
      setError('找不到這份作業')
      return
    }
    if (mappings.length === 0) {
      setError('請先產生配對結果')
      return
    }

    // 檢查作業份數與學生人數是否匹配
    const totalPages = pages.length
    const mappedPages = mappings.reduce((sum, m) => sum + (m.toIndex - m.fromIndex + 1), 0)
    const unmappedPages = totalPages - mappedPages
    const unmappedCopies = Math.floor(unmappedPages / pagesPerStudent)

    if (missingStudentCount > 0) {
      const message = `供 ${totalPages} 頁，每位學生 ${pagesPerStudent} 頁，預計 ${targetStudentCount} 位學生，已分配 ${assignedStudentCount} 位，少了 ${missingStudentCount} 位，代表部分學生未交，請填寫未交座號（必填 ${missingStudentCount} 位）。`
      const input = prompt(
        message + '\n\n請輸入未交座號（用逗號分隔，例如：3, 5, 12）：'
      )
      if (input === null) {
        return
      }

      setAbsentSeatsInput(input)
      setError('請重新檢查配對結果後再次點擊確認匯入')
      return
    }

    if (unmappedCopies > targetStudentCount) {
      const extraCount = unmappedCopies - targetStudentCount
      const confirmed = confirm(
        `供 ${totalPages} 頁，每位學生 ${pagesPerStudent} 頁，未分配 ${unmappedCopies} 份，學生數 ${targetStudentCount} 人。\n\n代表多 ${extraCount} 份，作業份數與學生人數不符。\n\n是否仍要繼續匯入？`
      )
      if (!confirmed) {
        return
      }
    }

    // 送出前確認
    const orientationConfirmed = confirm(
      `❗ 送出前請確認：\n\n• 所有頁面方向是否正確？\n• 頁面順序是否正確？\n• 圖片不可以倒置或歪斜\n• 否則可能影響 AI 辨識結果\n\n確認要送出嗎？`
    )
    if (!orientationConfirmed) {
      return
    }

    setError(null)
    setIsSaving(true)

    try {
      let successCount = 0

      for (const mapping of mappings) {
        // 取得頁面（套用自訂順序）
        const orderedPages = getStudentPages(mapping)
        if (orderedPages.length === 0) continue

        // 套用旋轉到每頁 blob
        const pageBlobs = await Promise.all(
          orderedPages.map(async (p) => {
            const rot = pageRotations.get(p.index) ?? 0
            return rot !== 0 ? rotateImageBlob(p.blob, rot) : p.blob
          })
        )

        if (pageBlobs.length === 0) continue

        const mergeResult = pageBlobs.length === 1
          ? { blob: pageBlobs[0], pageBreaks: [] as number[] }
          : await mergePageBlobs(pageBlobs)
        let imageBlob = mergeResult.blob
        const pageBreaks = mergeResult.pageBreaks

        // 壓縮到目標大小（1.9MB）：先縮尺寸、再降 quality
        // 單頁保留更高解析度（2300）提升放大檢視清晰度
        // 合併長圖用較高寬度（1900）在清晰度與大小間取得平衡
        const compressMaxWidth = pageBlobs.length === 1 ? 2300 : 1900
        imageBlob = await compressToTargetBytes(imageBlob, TARGET_MAX_BYTES, { maxWidth: compressMaxWidth })

        // 產生縮圖（用於 Grid 顯示，提升效能）
        const thumbnailBlob = await compressToTargetBytes(
          imageBlob,
          50 * 1024, // 50KB 上限
          { maxWidth: 400 }  // 400px 寬度
        )
        const thumbnailBase64 = await blobToBase64(thumbnailBlob)

        const existingSubmissions = await db.submissions
          .where('assignmentId')
          .equals(assignment.id)
          .and((sub) => sub.studentId === mapping.studentId)
          .toArray()

        if (existingSubmissions.length > 0) {
          console.log('🗑️ [PDF匯入] 發現舊作業，準備刪除:', {
            studentId: mapping.studentId,
            count: existingSubmissions.length,
            oldIds: existingSubmissions.map(s => s.id)
          })
        }

        const existingIds = existingSubmissions.map((sub) => sub.id)
        await queueDeleteMany('submissions', existingIds)

        for (const oldSub of existingSubmissions) {
          console.log('🗑️ [PDF匯入] 刪除本地舊作業:', {
            id: oldSub.id,
            hadGradingData: !!(oldSub.score || oldSub.feedback || oldSub.gradingResult),
            score: oldSub.score,
            feedback: oldSub.feedback,
            hasGradingResult: !!oldSub.gradingResult
          })
          await db.answerExtractionCorrections.where('submissionId').equals(oldSub.id).delete()
          await db.submissions.delete(oldSub.id)
        }

        if (existingSubmissions.length > 0) {
          console.log('✅ [PDF匯入] 舊作業已清除，批改資料已清空')
        }

        const imageBase64 = await blobToBase64(imageBlob)
        const submission: Submission = {
          id: generateId(),
          assignmentId: assignment.id,
          studentId: mapping.studentId,
          status: 'scanned',
          imageBase64,
          ...(avoidBlobStorage ? {} : { imageBlob }),
          // 新增縮圖欄位
          thumbnailBase64,
          ...(avoidBlobStorage ? {} : { thumbnailBlob }),
          ...(pageBreaks.length > 0 ? { pageBreaks } : {}),
          createdAt: getCurrentTimestamp()
        }

        console.log('📝 [PDF匯入] 建立新作業:', {
          id: submission.id,
          assignmentId: assignment.id,
          studentId: mapping.studentId,
          status: 'scanned',
          imageSize: `${(imageBase64.length / 1024).toFixed(2)} KB`,
          hasBlob: !!submission.imageBlob
        })

        try {
          await db.submissions.add(submission)
          console.log('✅ [PDF匯入] 新作業已加入本地資料庫')

          // 驗證插入成功
          const verify = await db.submissions.get(submission.id)
          console.log('🔍 [PDF匯入] 驗證插入結果:', {
            found: !!verify,
            id: verify?.id,
            status: verify?.status,
            hasBlob: !!verify?.imageBlob,
            hasBase64: !!verify?.imageBase64
          })
        } catch (error) {
          if (!avoidBlobStorage && isIndexedDbBlobError(error)) {
            console.warn('⚠️ [PDF匯入] Blob 儲存失敗，改用 Base64')
            const submissionWithoutBlob: Submission = {
              id: submission.id,
              assignmentId: submission.assignmentId,
              studentId: submission.studentId,
              status: submission.status,
              imageBase64: submission.imageBase64,
              createdAt: submission.createdAt
            }
            await db.submissions.add(submissionWithoutBlob)
            console.log('✅ [PDF匯入] 新作業已加入本地資料庫 (無 Blob)')

            // 驗證插入成功
            const verify = await db.submissions.get(submission.id)
            console.log('🔍 [PDF匯入] 驗證插入結果 (無Blob):', {
              found: !!verify,
              id: verify?.id,
              status: verify?.status,
              hasBase64: !!verify?.imageBase64
            })
          } else {
            throw error
          }
        }
        successCount += 1
      }

      if (successCount > 0) {
        console.log('⏰ [PDF匯入] 觸發同步並等待完成...')

        // 先設置監聯器，再觸發同步，避免錯過事件
        // 設定 30 秒超時，避免無限等待（離線或同步失敗時）
        const syncPromise = waitForSync(30000)
        requestSync(true)

        try {
          // 等待同步完成（30 秒超時）
          await syncPromise
          console.log('✅ [PDF匯入] 同步已完成')
          alert(`已成功建立 ${successCount} 份作業並同步到雲端`)
        } catch (error) {
          console.warn('⚠️ [PDF匯入] 同步失敗:', error)
          alert(`已建立 ${successCount} 份作業，但同步失敗`)
        }

        console.log('🏠 [PDF匯入] 跳回首頁')
        onUploadComplete?.()
      } else {
        alert('沒有建立任何作業')
      }
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '配對結果寫入失敗')
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}>
        <div className="text-center">
          <Loader className="w-12 h-12 text-purple-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`${embedded ? 'bg-white p-0' : 'min-h-screen bg-white p-4'}`}>
      <div className={`${embedded ? 'max-w-none mx-0 pt-0' : 'max-w-6xl mx-auto pt-6'}`}>
        {onBack && (
          <button
            onClick={onBack}
            className="mb-4 inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            返回作業列表
          </button>
        )}

        {/* 標題 */}
        <div
          className={`mb-4 flex items-center justify-between ${
            embedded
              ? 'border-b border-slate-200 pb-3'
              : 'bg-white rounded-xl border border-slate-200 p-5'
          }`}
        >
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold text-gray-900">
              作業匯入：{assignment?.title}
            </h1>
          </div>
        </div>

        {!assignment?.answerKey && (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            尚未設定標準答案，無法進行 AI 批改。
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-sm text-red-700 rounded-xl">
            {error}
          </div>
        )}

        {/* 1. 檔案上傳 + 自動配對設定 */}
        <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 md:p-5">
          <div className="grid gap-5 text-sm md:grid-cols-3">
            <div className="md:col-span-1">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                上傳 PDF 檔案
              </label>
              <input
                type="file"
                accept="application/pdf"
                multiple
                onChange={handleFileChange}
                disabled={isUploading || isMerging}
                className="block w-full text-xs text-gray-700
                  file:mr-2 file:px-3 file:py-2 file:border-0
                  file:text-xs file:font-semibold
                  file:bg-green-50 file:text-green-700
                  hover:file:bg-green-100"
              />
              <p className="text-xs text-gray-500 mt-1">
                <span className="font-medium">可選擇單一或多個 PDF:</span><br />
                • 單一 PDF: 自動分頁配對<br />
                • 多個 PDF: 會先合併後分頁
              </p>
              <p className="text-xs text-gray-400 mt-1">
                檔案大小限制：每頁壓縮後需小於 1.5 MB
              </p>
              {isUploading && (
                <div className="mt-2 flex items-center gap-2 text-xs text-indigo-600">
                  <Loader className="w-4 h-4 animate-spin" />
                  <span>處理 PDF 中，請稍候...</span>
                </div>
              )}
              {isMerging && (
                <div className="mt-2 flex items-center gap-2 text-xs text-emerald-600">
                  <Loader className="w-4 h-4 animate-spin" />
                  <span>處理多個 PDF 中，請稍候...</span>
                </div>
              )}
              {!isUploading && !isMerging && fileName && (
                <p className="mt-1 text-xs text-gray-500">已選擇：{fileName}</p>
              )}
              {!isUploading && !isMerging && pages.length > 0 && (
                <p className="mt-1 text-xs text-gray-500">
                  已拆出 {pages.length} 頁影像
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center gap-2 mb-2">
                <Settings className="w-4 h-4 text-gray-600" />
                <span className="text-xs font-semibold text-gray-700">
                  自動配對設定
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <label className="block text-[11px] font-medium text-gray-600 mb-1">
                    每位學生頁數
                  </label>
                  <NumericInput
                    min={1}
                    max={4}
                    value={pagesPerStudent}
                    onChange={(v) => setPagesPerStudent(typeof v === 'number' ? v : (v === '' ? ('' as unknown as number) : 1))}
                    className="w-full px-2 py-1 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-gray-600 mb-1">
                    起始頁號
                  </label>
                  <NumericInput
                    min={1}
                    max={200}
                    value={startSeat}
                    onChange={(v) => setStartSeat(typeof v === 'number' ? v : (v === '' ? ('' as unknown as number) : 1))}
                    className="w-full px-2 py-1 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  />
                </div>
              </div>

              {/* 顯示班級中缺少的座號 */}
              {missingSeatNumbers.length > 0 && (
                <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-xs text-blue-800 font-medium mb-1">
                    班級中缺少的座號：
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {missingSeatNumbers.map(seat => (
                      <span
                        key={seat}
                        className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs"
                      >
                        {seat}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-blue-600 mt-1">
                    這些座號在班級管理中不存在，系統會自動跳過。
                  </p>
                </div>
              )}
            </div>

            <div className="text-xs text-gray-500">
              <p>
                建議先將紙本考卷依座號大致排序後再掃描。
                上傳 PDF 後會自動配對，請在下方檢查每位學生的分配結果。
              </p>
            </div>
          </div>
        </div>

        {/* 2. 左右分欄：左側學生列表 + 右側預覽 */}
        {phase === 'edit-mapping' && mappings.length > 0 && (
          <div className="grid lg:grid-cols-[350px_1fr] gap-4 mb-6">
            {/* 左側：學生選單 */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 md:p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  學生列表
                </h2>
                <span className="text-xs text-gray-500">
                  {mappings.length} / {students.length} 人
                </span>
              </div>

              <div className="max-h-[600px] overflow-y-auto space-y-1">
                {mappings.map((m, idx) => (
                  <button
                    key={`${m.seatNumber}-${m.studentId}`}
                    type="button"
                    onClick={() => setSelectedMappingIndex(idx)}
                    className={`w-full px-3 py-2.5 rounded-lg text-left transition-colors ${
                      idx === selectedMappingIndex
                        ? 'bg-green-50 border-2 border-green-500'
                        : 'bg-gray-50 border-2 border-transparent hover:bg-gray-100'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className={`text-sm font-semibold ${
                          idx === selectedMappingIndex ? 'text-green-900' : 'text-gray-900'
                        }`}>
                          {m.seatNumber} 號
                        </span>
                        <span className={`ml-2 text-sm ${
                          idx === selectedMappingIndex ? 'text-green-700' : 'text-gray-700'
                        }`}>
                          {m.name}
                        </span>
                      </div>
                      <span className={`text-xs ${
                        idx === selectedMappingIndex ? 'text-green-600' : 'text-gray-500'
                      }`}>
                        第 {m.fromIndex + 1}
                        {m.toIndex === m.fromIndex ? '' : `–${m.toIndex + 1}`} 頁
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              {/* 確認匯入按鈕 */}
              <div className="mt-4 pt-4 border-t border-gray-200">
                {/* 提示：缺少學生作業 */}
                {!isConfirmDisabled && missingStudentCount > 0 && (
                  <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-xs font-semibold text-blue-800 mb-1">ℹ️ 作業份數不足</p>
                    <p className="text-xs text-blue-700">
                      缺少 {missingStudentCount} 位學生的作業。點擊「確認匯入」後，系統會詢問缺交座號。
                    </p>
                  </div>
                )}

                {/* 除錯資訊：顯示為什麼按鈕被禁用（不在儲存中時才顯示） */}
                {hasValidationErrors && !isSaving && (
                  <div className="mb-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <p className="text-xs font-semibold text-yellow-800 mb-2">⚠️ 無法匯入，請先解決以下問題：</p>
                    <ul className="text-xs text-yellow-700 space-y-1">
                      {unusedPages.length > 0 && (
                        <li>• 尚有 {unusedPages.length} 頁未分配給任何學生（請調整「每位學生頁數」或「起始座號」）</li>
                      )}
                    </ul>
                  </div>
                )}

                {unusedPages.length > 0 && absentSeatHint?.type === 'extra' && (
                  <p className="text-xs text-red-600 mb-2">
                    ⚠️ 尚有 {unusedPages.length} 頁未分配
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleSaveMappings}
                  disabled={isConfirmDisabled}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isSaving ? (
                    <>
                      <Loader className="w-4 h-4 animate-spin" />
                      寫入中...
                    </>
                  ) : (
                    '確認匯入'
                  )}
                </button>
              </div>
            </div>

            {/* 右側：頁面預覽（可旋轉、拖曳換序） */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 md:p-5 flex flex-col gap-3 min-h-[320px]">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-gray-700">頁面預覽</h2>
              {selectedMapping && pagesInSelectedRange.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRotateAll}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    全部旋轉
                  </button>
                  {mappings.length > 1 && (
                    <button
                      type="button"
                      onClick={handleApplyToAll}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
                    >
                      <CopyCheck className="w-3.5 h-3.5" />
                      套用到全部學生
                    </button>
                  )}
                </div>
              )}
            </div>

            {selectedMapping && pagesInSelectedRange.length > 0 ? (
              <PagePreviewSortable
                pages={pagesInSelectedRange}
                rotations={pageRotations}
                onRotate={handleRotatePage}
                onReorder={(newOrder) => {
                  setStudentPageOrders((prev) => {
                    const next = new Map(prev)
                    next.set(selectedMapping.studentId, newOrder)
                    return next
                  })
                }}
              />
            ) : (
              <div className="flex-1 border border-dashed border-gray-200 rounded-xl flex items-center justify-center bg-slate-50 min-h-[200px]">
                <div className="text-xs text-gray-400 flex flex-col items-center gap-1">
                  <FileImage className="w-5 h-5" />
                  <span>尚未產生配對結果</span>
                </div>
              </div>
            )}
          </div>
          </div>
        )}

      </div>

      {isPreviewModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden">
            <div className="flex items-start justify-between px-4 py-3 border-b border-gray-200">
              <div>
                <p className="text-xs text-gray-500">頁面預覽</p>
                {selectedMapping ? (
                  <>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {selectedMapping.seatNumber} 號 · {selectedMapping.name}
                    </h3>
                    <p className="text-xs text-gray-500">
                      頁碼：第 {selectedMapping.fromIndex + 1}
                      {selectedMapping.toIndex === selectedMapping.fromIndex
                        ? ''
                        : `–${selectedMapping.toIndex + 1}`}
                      頁
                    </p>
                  </>
                ) : (
                  <h3 className="text-lg font-semibold text-gray-900">尚未選擇配對</h3>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsPreviewModalOpen(false)}
                  className="p-2 rounded-full hover:bg-gray-100 text-gray-500"
                  aria-label="關閉"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 bg-gray-50 overflow-y-auto max-h-[85vh]">
              {!selectedMapping || pagesInSelectedRange.length === 0 ? (
                <p className="text-sm text-gray-500">尚未產生配對結果。</p>
              ) : (
                <div className="grid sm:grid-cols-1 md:grid-cols-2 gap-4">
                  {pagesInSelectedRange.map((p) => (
                    <div
                      key={p.index}
                      className="bg-white rounded-xl border border-gray-200 shadow-md overflow-hidden"
                    >
                      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                        <p className="text-sm font-medium text-gray-700">
                          第 {p.index + 1} 頁 · 配對給 {selectedMapping.seatNumber} 號
                        </p>
                      </div>
                      <div className="bg-white flex items-center justify-center p-4 overflow-hidden">
                        <img
                          src={p.url}
                          alt={`第 ${p.index + 1} 頁預覽`}
                          className="max-h-[75vh] w-full object-contain bg-white"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 合併確認對話框 */}
      {showMergeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">
                合併 PDF 檔案
              </h2>
              <button
                type="button"
                onClick={handleMergeCancel}
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
                aria-label="關閉"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>

            <div className="px-5 py-4 overflow-y-auto max-h-[calc(85vh-140px)]">
              <div className="mb-4">
                <p className="text-sm text-gray-700 mb-2">
                  您已選擇 <span className="font-semibold text-indigo-600">{uploadedFiles.length}</span> 個 PDF 檔案。
                </p>
                <p className="text-sm text-gray-600 mb-1">
                  系統已自動按照<span className="font-semibold text-emerald-600">檔案名稱中的數字</span>排序，將按以下順序合併：
                </p>
                <p className="text-xs text-gray-500">
                  （例如：1.pdf → 2.pdf → 10.pdf → 11.pdf）
                </p>
              </div>

              <div className="space-y-2">
                {uploadedFiles.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200"
                  >
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 font-semibold text-sm">
                      {index + 1}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">{file.name}</p>
                      <p className="text-xs text-gray-500">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                    <FileImage className="w-5 h-5 text-gray-400" />
                  </div>
                ))}
              </div>

              <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                <p className="text-xs text-emerald-700">
                  <span className="font-semibold">✨ 智能排序：</span>
                  系統已自動按照檔案名稱中的數字排序（支援 1.pdf、座號01.pdf、scan_003.pdf 等格式）。
                  如果順序不正確，請確保檔案名稱包含正確的數字。
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={handleMergeCancel}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleMergeConfirm}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
              >
                確認合併
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

