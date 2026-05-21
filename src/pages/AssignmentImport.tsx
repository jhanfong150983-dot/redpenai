import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  CopyCheck,
  FileImage,
  Loader,
  RotateCw,
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
import { db, generateId, getCurrentTimestamp } from '@/lib/db'
import type { Assignment, Student, Submission } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import {
  convertPdfToImages,
  getFileType,
  getPdfFirstPageAndCount,
  sortFilesByNumber
} from '@/lib/pdfToImage'
import { blobToBase64, compressToTargetBytes, rotateImageBlob } from '@/lib/imageCompression'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from '@/lib/blob-storage'
import ImportConfigDialog, { type PdfFileInfo, interleavePdfPages } from '@/components/ImportConfigDialog'
import { mergePageBlobs } from '@/lib/image-merge'

// 目標檔案大小上限：3 MB（對齊學生端 useSync 的 4 MB base64 上限，留 0.5 MB buffer 給 Vercel 4.5 MB 邊界）
// 2026-05-14 從 1.9 MB 拉到 3 MB——答案卷是 AI 批改的真理依據，不該壓得比學生卷還兇
const TARGET_MAX_BYTES = 3 * 1024 * 1024

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

// ImportConfigDialog, PdfFileInfo, interleavePdfPages extracted to @/components/ImportConfigDialog.tsx

// ── 主元件 ────────────────────────────────────────────────────────────────────

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

// mergePageBlobs and loadImgElement extracted to @/lib/image-merge.ts

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

  const [isMerging, setIsMerging] = useState(false)

  // 匯入設定對話框
  const [showImportConfig, setShowImportConfig] = useState(false)
  const [pdfFilesInfo, setPdfFilesInfo] = useState<PdfFileInfo[]>([])
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false)
  const [configMergeMode, setConfigMergeMode] = useState<'concat' | 'interleave'>('concat')
  const [configPagesPerStudentPerPdf, setConfigPagesPerStudentPerPdf] = useState(1)
  const [configPerPdfPagesArray, setConfigPerPdfPagesArray] = useState<number[]>([])
  const [configPagesPerStudent, setConfigPagesPerStudent] = useState(1)
  const [configStartPage, setConfigStartPage] = useState(1)
  const [configEndPage, setConfigEndPage] = useState(999)
  const [, setConfigMaxPage] = useState(999)
  const [configPerPdfPageRanges, setConfigPerPdfPageRanges] = useState<Array<{ startPage: number; endPage: number }>>([])
  const [configConfirmed, setConfigConfirmed] = useState(false)
  const [configAbsentSeatNumbers, setConfigAbsentSeatNumbers] = useState<Set<number>>(new Set())

  const [pagesPerStudent, setPagesPerStudent] = useState(1)
  const [startSeat] = useState(1)
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
          throw new Error('找不到這份作業，可能已被刪除。請返回列表重新選擇。')
        }
        setAssignment(assignmentData)

        const classroomData = await db.classrooms.get(
          assignmentData.classroomId
        )
        if (!classroomData) {
          throw new Error('找不到對應的班級，請先到「班級管理」確認班級存在')
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
    setIsLoadingPreviews(true)
    setPages([])
    setMappings([])
    setSelectedMappingIndex(0)
    setPhase('select')

    try {
      let fileArray = Array.from(files)
      for (const file of fileArray) {
        if (getFileType(file) !== 'pdf') {
          throw new Error(`檔案 "${file.name}" 不是 PDF 格式。僅支援 PDF 檔案。`)
        }
      }

      fileArray = sortFilesByNumber(fileArray)
      console.log('📂 檔案已按數字排序:', fileArray.map((f) => f.name))

      // 載入每個 PDF 的第一頁預覽 + 頁數
      const infos: PdfFileInfo[] = []
      for (const file of fileArray) {
        // eslint-disable-next-line no-await-in-loop
        const { blob, pageCount } = await getPdfFirstPageAndCount(file)
        infos.push({ file, pageCount, firstPageUrl: URL.createObjectURL(blob) })
      }

      const maxPage = Math.max(...infos.map((i) => i.pageCount))
      setConfigMaxPage(maxPage)
      setConfigEndPage(maxPage)
      setConfigStartPage(1)
      setConfigMergeMode('concat')
      setConfigPagesPerStudent(pagesPerStudent)
      setConfigPagesPerStudentPerPdf(1)
      setConfigConfirmed(false)
      setConfigPerPdfPageRanges(infos.map((info) => ({ startPage: 1, endPage: info.pageCount })))
      setPdfFilesInfo(infos)
      setShowImportConfig(true)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '處理檔案失敗')
    } finally {
      setIsLoadingPreviews(false)
      setIsUploading(false)
    }
  }

  const handleImportCancel = () => {
    pdfFilesInfo.forEach((info) => URL.revokeObjectURL(info.firstPageUrl))
    setPdfFilesInfo([])
    setShowImportConfig(false)
    setIsUploading(false)
  }

  const handleImportConfirm = async () => {
    const fileArray = pdfFilesInfo.map((i) => i.file)
    if (fileArray.length === 0) return

    // 清理預覽 URL
    pdfFilesInfo.forEach((info) => URL.revokeObjectURL(info.firstPageUrl))
    setPdfFilesInfo([])
    setShowImportConfig(false)
    setIsMerging(true)
    setError(null)

    try {
      console.log(`開始處理 ${fileArray.length} 個 PDF 檔案`)

      // 轉換所有 PDF 並套用頁數範圍
      const allPdfPages: Blob[][] = []
      for (let fi = 0; fi < fileArray.length; fi++) {
        const file = fileArray[fi]
        console.log(`處理: ${file.name}`)
        // eslint-disable-next-line no-await-in-loop
        const blobs = await convertPdfToImages(file)
        const pdfRange = configPerPdfPageRanges[fi]
        const effectiveStart = pdfRange ? Math.max(1, pdfRange.startPage) : configStartPage
        const effectiveEnd = pdfRange ? Math.min(blobs.length, pdfRange.endPage) : configEndPage
        const filtered = blobs.slice(effectiveStart - 1, effectiveEnd)
        allPdfPages.push(filtered)
      }

      let allBlobs: Blob[]
      let effectivePagesPerStudent: number

      if (fileArray.length > 1 && configMergeMode === 'interleave') {
        allBlobs = interleavePdfPages(allPdfPages, configPagesPerStudentPerPdf)
        effectivePagesPerStudent = configPagesPerStudentPerPdf * fileArray.length
        console.log(`交錯合併完成，每位學生 ${effectivePagesPerStudent} 頁，共 ${allBlobs.length} 頁`)
      } else {
        allBlobs = allPdfPages.flat()
        effectivePagesPerStudent = configPagesPerStudent
        console.log(`串接完成，每位學生 ${effectivePagesPerStudent} 頁，共 ${allBlobs.length} 頁`)
      }

      setPagesPerStudent(effectivePagesPerStudent)

      const previews: PagePreview[] = allBlobs.map((blob, idx) => ({
        index: idx,
        blob,
        url: URL.createObjectURL(blob)
      }))

      setPages(previews)
      setPageRotations(new Map())
      setStudentPageOrders(new Map())
      setPhase('edit-mapping')

      if (fileArray.length === 1) {
        setFileName(fileArray[0].name)
      } else {
        const modeLabel = configMergeMode === 'interleave' ? '交錯' : '串接'
        setFileName(`已${modeLabel} ${fileArray.length} 個 PDF（共 ${previews.length} 頁）`)
      }
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '處理 PDF 失敗')
    } finally {
      setIsMerging(false)
    }
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

  // 套用到全部學生後的回饋訊息
  const [applyFeedback, setApplyFeedback] = useState<string | null>(null)

  // 套用目前學生的順序 + 旋轉樣式到所有學生
  const handleApplyToAll = useCallback(() => {
    if (!selectedMapping) return
    const sourcePages = getStudentPages(selectedMapping)
    const sourceCount = sourcePages.length
    const sourceDefaultPages = pages.filter(
      (p) => p.index >= selectedMapping.fromIndex && p.index <= selectedMapping.toIndex
    )

    // 先把兩個 Map 都算好，再一起 set（不能巢狀呼叫 setState）
    const newOrders = new Map(studentPageOrders)
    const newRotations = new Map(pageRotations)
    let appliedCount = 0

    for (const mapping of mappings) {
      if (mapping.studentId === selectedMapping.studentId) continue
      const targetPages = pages.filter(
        (p) => p.index >= mapping.fromIndex && p.index <= mapping.toIndex
      )
      if (targetPages.length !== sourceCount) continue

      // 套用相對順序：計算目標學生在新順序下的 page index 陣列
      const orderedTargetIndices = sourcePages.map((sp) => {
        const relativeOffset = sourceDefaultPages.findIndex((dp) => dp.index === sp.index)
        return targetPages[relativeOffset]?.index
      }).filter((idx): idx is number => idx !== undefined)
      newOrders.set(mapping.studentId, orderedTargetIndices)

      // 套用旋轉：依「新順序的第 i 個位置」對應，而非預設順序
      sourcePages.forEach((sp, i) => {
        const rot = pageRotations.get(sp.index) ?? 0
        const targetIdx = orderedTargetIndices[i]
        if (targetIdx !== undefined) newRotations.set(targetIdx, rot)
      })

      appliedCount++
    }

    setStudentPageOrders(newOrders)
    setPageRotations(newRotations)

    // 顯示回饋訊息 2 秒
    setApplyFeedback(`已套用到 ${appliedCount} 位學生`)
    setTimeout(() => setApplyFeedback(null), 2000)
  }, [selectedMapping, getStudentPages, mappings, pages, studentPageOrders, pageRotations])

  const handleAutoMap = () => {
    if (pages.length === 0) {
      setError('請先上傳 PDF 檔案')
      return
    }
    if (!students.length) {
      setError('此班級尚未有學生名單，請先到「班級管理」加入學生')
      return
    }
    // 驗證每位學生頁數和起始頁號
    const pagesNum = Number(pagesPerStudent)
    const startNum = Number(startSeat)
    if (!Number.isFinite(pagesNum) || pagesNum < 1) {
      setError('每位學生頁數須為大於 0 的整數')
      return
    }
    if (!Number.isFinite(startNum) || startNum < 1) {
      setError('起始頁號須為大於 0 的整數')
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
      setError('找不到這份作業，可能已被刪除。請返回列表重新選擇。')
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

        // AssignmentImport 只接受 PDF（input accept="application/pdf"），無相機透視問題，
        // 跳過 correctPerspectiveMultiple 省 N × Gemini detect_corners API call。
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
          source: 'teacher_scan',
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
          hasBlob: !!submission.imageBlob,
          pageBlobCount: pageBlobs.length,
          pageBreaks,
          hasPageBreaks: pageBreaks.length > 0
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
        alert(`已成功建立 ${successCount} 份作業`)
        requestSync(true)
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
          <p className="text-gray-600">載入中…</p>
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

        {/* 1. 檔案上傳 */}
        <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 md:p-5">
          <div className="text-sm">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              上傳 PDF 檔案
            </label>
            <input
              type="file"
              accept="application/pdf"
              multiple
              onChange={handleFileChange}
              disabled={isUploading || isLoadingPreviews || isMerging}
              className="block w-full text-xs text-gray-700
                file:mr-2 file:px-3 file:py-2 file:border-0
                file:text-xs file:font-semibold
                file:bg-green-50 file:text-green-700
                hover:file:bg-green-100"
            />
            <p className="text-xs text-gray-500 mt-1">
              可選擇單一或多個 PDF，上傳後會跳出設定對話框進行確認。
            </p>
            {(isUploading || isLoadingPreviews) && (
              <div className="mt-2 flex items-center gap-2 text-xs text-indigo-600">
                <Loader className="w-4 h-4 animate-spin" />
                <span>載入 PDF 預覽中，請稍候…</span>
              </div>
            )}
            {isMerging && (
              <div className="mt-2 flex items-center gap-2 text-xs text-emerald-600">
                <Loader className="w-4 h-4 animate-spin" />
                <span>處理 PDF 中，請稍候…</span>
              </div>
            )}
            {!isUploading && !isLoadingPreviews && !isMerging && fileName && (
              <p className="mt-1 text-xs text-gray-500">已匯入：{fileName}</p>
            )}
            {!isUploading && !isLoadingPreviews && !isMerging && pages.length > 0 && (
              <p className="mt-1 text-xs text-gray-500">
                已拆出 {pages.length} 頁影像，每位學生 {pagesPerStudent} 頁
              </p>
            )}
            {/* 顯示班級中缺少的座號 */}
            {missingSeatNumbers.length > 0 && (
              <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs text-blue-800 font-medium mb-1">
                  班級中缺少的座號：
                </p>
                <div className="flex flex-wrap gap-1">
                  {missingSeatNumbers.map((seat) => (
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
                      寫入中…
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
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleApplyToAll}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
                      >
                        <CopyCheck className="w-3.5 h-3.5" />
                        套用到全部學生
                      </button>
                      {applyFeedback && (
                        <span className="text-xs font-medium text-green-700 bg-green-100 px-2 py-1 rounded-lg animate-fade-in">
                          ✓ {applyFeedback}
                        </span>
                      )}
                    </div>
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
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[120] p-4">
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

      {/* 匯入設定對話框 */}
      {showImportConfig && (
        <ImportConfigDialog
          files={pdfFilesInfo}
          mergeMode={configMergeMode}
          onMergeModeChange={setConfigMergeMode}
          pagesPerStudentPerPdf={configPagesPerStudentPerPdf}
          onPagesPerStudentPerPdfChange={setConfigPagesPerStudentPerPdf}
          perPdfPagesArray={configPerPdfPagesArray}
          onPerPdfPagesArrayChange={setConfigPerPdfPagesArray}
          pagesPerStudent={configPagesPerStudent}
          onPagesPerStudentChange={setConfigPagesPerStudent}
          students={[]}
          absentSeatNumbers={configAbsentSeatNumbers}
          onAbsentSeatNumbersChange={setConfigAbsentSeatNumbers}
          confirmed={configConfirmed}
          onConfirmedChange={setConfigConfirmed}
          onConfirm={handleImportConfirm}
          onCancel={handleImportCancel}
        />
      )}
    </div>
  )
}

