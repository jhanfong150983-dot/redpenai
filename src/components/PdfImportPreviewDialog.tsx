import { useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw, RotateCw, Trash2, X } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { NumericInput } from '@/components/NumericInput'
import Button from '@/components/ui/Button'

// ── 公開型別 ───────────────────────────────────────────────────────────────

export interface PdfImportPreviewFile {
  fileName: string
  blobs: Blob[]
  urls: string[]
}

export interface PdfImportPreviewStudent {
  id: string
  seatNumber: number
  name: string
}

export interface PdfImportPreviewResult {
  perStudent: Array<{
    student: PdfImportPreviewStudent
    pageBlobs: Blob[] // 已套用旋轉、按學生內順序排好
  }>
}

export interface PdfImportPreviewDialogProps {
  pdfFiles: PdfImportPreviewFile[]
  students: PdfImportPreviewStudent[]
  initialPagesPerStudent: number
  onConfirm: (result: PdfImportPreviewResult) => void | Promise<void>
  onCancel: () => void
  /** 旋轉執行用：傳一張 blob 跟角度，回傳旋轉好的 blob */
  rotateBlob: (blob: Blob, degrees: number) => Promise<Blob>
}

// ── 卡片 ───────────────────────────────────────────────────────────────────

interface SortableStudentPageCardProps {
  itemId: string
  url: string
  rotation: number
  positionInStudent: number
  originLabel: string
  onRotate: () => void
  onDelete: () => void
}

function SortableStudentPageCard({
  itemId,
  url,
  rotation,
  positionInStudent,
  originLabel,
  onRotate,
  onDelete,
}: SortableStudentPageCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: itemId })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.85 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative group w-32 ${isDragging ? 'shadow-2xl' : ''}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="border-2 border-slate-200 rounded-xl overflow-hidden cursor-grab active:cursor-grabbing bg-white hover:border-green-400 transition-colors"
      >
        <div className="bg-slate-50 px-2 py-1 text-[11px] text-slate-600 font-medium flex items-center justify-between gap-1">
          <span className="truncate" title={originLabel}>
            第 {positionInStudent + 1} 頁
          </span>
          {rotation !== 0 && (
            <span className="text-[10px] text-orange-600 font-semibold shrink-0">{rotation}°</span>
          )}
        </div>
        <div className="aspect-[3/4] bg-white overflow-hidden">
          <img
            src={url}
            alt={originLabel}
            className="w-full h-full object-contain"
            style={{ transform: `rotate(${rotation}deg)` }}
            draggable={false}
          />
        </div>
        <div className="bg-slate-50 px-2 py-0.5 text-[10px] text-slate-400 truncate" title={originLabel}>
          {originLabel}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRotate()
        }}
        className="absolute top-7 right-1 p-1 rounded-full bg-white/90 border border-slate-300 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-slate-100"
        title="旋轉 90°"
      >
        <RotateCw className="w-3 h-3 text-slate-600" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="absolute top-7 right-8 p-1 rounded-full bg-white/90 border border-slate-300 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50"
        title="刪除這頁"
      >
        <Trash2 className="w-3 h-3 text-red-500" />
      </button>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface PageRef {
  fileIdx: number
  pageIdx: number // 0-based 原始 PDF page index
}

// 泛型 interleave：把多個陣列依每組「chunkSize」交錯
function interleave<T>(arrays: T[][], chunkSizes: number[]): T[] {
  if (arrays.length === 0) return []
  if (arrays.length === 1) return arrays[0]
  const chunked = arrays.map((arr, i) => {
    const cs = Math.max(1, chunkSizes[i] ?? 1)
    const chunks: T[][] = []
    for (let j = 0; j < arr.length; j += cs) chunks.push(arr.slice(j, j + cs))
    return chunks
  })
  const maxChunks = Math.max(...chunked.map((c) => c.length))
  const result: T[] = []
  for (let ci = 0; ci < maxChunks; ci++) {
    for (const cs of chunked) {
      if (ci < cs.length) result.push(...cs[ci])
    }
  }
  return result
}

// ── 主元件 ─────────────────────────────────────────────────────────────────

export default function PdfImportPreviewDialog({
  pdfFiles,
  students,
  initialPagesPerStudent,
  onConfirm,
  onCancel,
  rotateBlob,
}: PdfImportPreviewDialogProps) {
  const isMultiPdf = pdfFiles.length > 1

  // 每張頁面的旋轉度數與刪除狀態：[fileIdx][pageIdx]
  const [rotations, setRotations] = useState<number[][]>(() =>
    pdfFiles.map((f) => new Array(f.blobs.length).fill(0)),
  )
  const [deleted, setDeleted] = useState<boolean[][]>(() =>
    pdfFiles.map((f) => new Array(f.blobs.length).fill(false)),
  )

  const [pagesPerStudent, setPagesPerStudent] = useState(
    Math.max(1, initialPagesPerStudent),
  )
  const [mergeMode, setMergeMode] = useState<'concat' | 'interleave'>('concat')
  const [perPdfPagesArray, setPerPdfPagesArray] = useState<number[]>(() =>
    pdfFiles.map(() => 1),
  )
  const [absentSeatNumbers, setAbsentSeatNumbers] = useState<Set<number>>(new Set())
  const [showAbsentPicker, setShowAbsentPicker] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // 每位學生內部頁序的 override：studentIdx → [positionInChunk, ...]
  const [studentInternalOrder, setStudentInternalOrder] = useState<Map<number, number[]>>(
    new Map(),
  )

  // 切片形狀改變時清空 internal order（避免套到不同尺寸的 chunk）。
  // togglePageDelete 已自行 clear，這裡管 pagesPerStudent / mergeMode / perPdfPagesArray
  useEffect(() => {
    setStudentInternalOrder(new Map())
  }, [pagesPerStudent, mergeMode, perPdfPagesArray])

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // ── 切片計算 ──────────────────────────────────────────────────────────

  const splitResult = useMemo(() => {
    const isInterleave = isMultiPdf && mergeMode === 'interleave'

    // 1. 每份 PDF 過濾刪除頁、保留 PageRef
    const refsByFile: PageRef[][] = pdfFiles.map((f, fi) =>
      f.blobs
        .map((_, pi) => ({ fileIdx: fi, pageIdx: pi }))
        .filter((ref) => !deleted[fi][ref.pageIdx]),
    )

    // 2. 合併
    const flatRefs: PageRef[] = isInterleave
      ? interleave(refsByFile, perPdfPagesArray)
      : refsByFile.flat()

    const pps = isInterleave
      ? perPdfPagesArray.reduce((s, n) => s + (n || 1), 0)
      : pagesPerStudent

    // 3. chunk
    const chunks: PageRef[][] = []
    for (let i = 0; i + pps <= flatRefs.length; i += pps) {
      chunks.push(flatRefs.slice(i, i + pps))
    }

    // 4. 學生分配
    const sortedStudents = [...students].sort((a, b) => a.seatNumber - b.seatNumber)
    const targetStudents = sortedStudents.filter((s) => !absentSeatNumbers.has(s.seatNumber))

    return {
      flatRefs,
      chunks,
      effectivePagesPerStudent: pps,
      sortedStudents,
      targetStudents,
      remainingPages: flatRefs.length - chunks.length * pps,
    }
  }, [
    pdfFiles,
    deleted,
    isMultiPdf,
    mergeMode,
    perPdfPagesArray,
    pagesPerStudent,
    students,
    absentSeatNumbers,
  ])

  const expectedStudentCount = splitResult.chunks.length
  const missingCount = Math.max(0, students.length - expectedStudentCount)
  const excessCount = Math.max(0, expectedStudentCount - students.length)
  const absentCountMatch = absentSeatNumbers.size === missingCount

  // 自動裁掉超過班上人數的 chunk（學生數不夠就只切到夠的份數）
  const usableChunkCount = Math.min(
    splitResult.chunks.length,
    splitResult.targetStudents.length,
  )

  const perPdfStudentCounts = useMemo(() => {
    if (!(isMultiPdf && mergeMode === 'interleave')) return [] as number[]
    return pdfFiles.map((f, i) => {
      const usable = f.blobs.filter((_, pi) => !deleted[i][pi]).length
      const cs = perPdfPagesArray[i] ?? 1
      return Math.floor(usable / cs)
    })
  }, [isMultiPdf, mergeMode, pdfFiles, deleted, perPdfPagesArray])

  const perPdfConsistent =
    perPdfStudentCounts.length === 0 ||
    perPdfStudentCounts.every((c) => c === perPdfStudentCounts[0])

  const canConfirm =
    confirmed &&
    !isSubmitting &&
    expectedStudentCount > 0 &&
    excessCount === 0 &&
    (missingCount === 0 || absentCountMatch) &&
    perPdfConsistent

  // ── Handlers: 旋轉 / 刪除 ──────────────────────────────────────────────

  const rotatePage = useCallback((fileIdx: number, pageIdx: number) => {
    setRotations((prev) => {
      const next = prev.map((arr) => arr.slice())
      next[fileIdx][pageIdx] = ((next[fileIdx][pageIdx] ?? 0) + 90) % 360
      return next
    })
  }, [])

  const togglePageDelete = useCallback((fileIdx: number, pageIdx: number) => {
    setDeleted((prev) => {
      const next = prev.map((arr) => arr.slice())
      next[fileIdx][pageIdx] = !next[fileIdx][pageIdx]
      return next
    })
    // 刪頁會影響切片、清掉舊的 internal order
    setStudentInternalOrder(new Map())
  }, [])

  const rotateAllPages = useCallback(() => {
    setRotations((prev) =>
      prev.map((arr, fi) =>
        arr.map((r, pi) => (deleted[fi][pi] ? r : (r + 90) % 360)),
      ),
    )
  }, [deleted])

  // 「每生第 N 頁旋轉」：對每個 chunk 的第 N 個位置旋轉
  const rotateNthPagePerStudent = useCallback(
    (n: number) => {
      // n is 0-based position within chunk
      setRotations((prev) => {
        const next = prev.map((arr) => arr.slice())
        for (let si = 0; si < usableChunkCount; si++) {
          const chunk = splitResult.chunks[si]
          const ref = chunk?.[n]
          if (!ref) continue
          next[ref.fileIdx][ref.pageIdx] =
            ((next[ref.fileIdx][ref.pageIdx] ?? 0) + 90) % 360
        }
        return next
      })
    },
    [splitResult.chunks, usableChunkCount],
  )

  // ── Handlers: 同學生內拖序 ────────────────────────────────────────────

  const handleDragEnd = useCallback(
    (studentIdx: number, chunk: PageRef[]) => (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const defaultOrder = chunk.map((_, i) => i)
      const currentOrder = studentInternalOrder.get(studentIdx) ?? defaultOrder
      const oldIndex = currentOrder.findIndex(
        (pos) => `s${studentIdx}-${pos}` === active.id,
      )
      const newIndex = currentOrder.findIndex(
        (pos) => `s${studentIdx}-${pos}` === over.id,
      )
      if (oldIndex === -1 || newIndex === -1) return
      const newOrder = arrayMove(currentOrder, oldIndex, newIndex)
      setStudentInternalOrder((prev) => {
        const next = new Map(prev)
        next.set(studentIdx, newOrder)
        return next
      })
    },
    [studentInternalOrder],
  )

  // ── 未交勾選 ──────────────────────────────────────────────────────────

  const toggleAbsent = (seatNumber: number) => {
    setAbsentSeatNumbers((prev) => {
      const next = new Set(prev)
      if (next.has(seatNumber)) {
        next.delete(seatNumber)
      } else {
        if (next.size >= missingCount) return prev
        next.add(seatNumber)
      }
      return next
    })
  }

  // ── 確認分割 ──────────────────────────────────────────────────────────

  // 取出合法的 internal order；若 stale（長度不符或 index 越界）就 fallback default
  const getValidInternalOrder = useCallback(
    (si: number, chunkSize: number): number[] => {
      const defaultOrder = Array.from({ length: chunkSize }, (_, i) => i)
      const stored = studentInternalOrder.get(si)
      if (!stored) return defaultOrder
      if (stored.length !== chunkSize) return defaultOrder
      if (stored.some((p) => p < 0 || p >= chunkSize)) return defaultOrder
      return stored
    },
    [studentInternalOrder],
  )

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return
    setIsSubmitting(true)
    try {
      const perStudent: PdfImportPreviewResult['perStudent'] = []
      for (let si = 0; si < usableChunkCount; si++) {
        const student = splitResult.targetStudents[si]
        const chunk = splitResult.chunks[si]
        if (!student || !chunk) continue
        const internalOrder = getValidInternalOrder(si, chunk.length)
        const pageBlobs = await Promise.all(
          internalOrder.map(async (pos) => {
            const ref = chunk[pos]
            const blob = pdfFiles[ref.fileIdx].blobs[ref.pageIdx]
            const rot = rotations[ref.fileIdx][ref.pageIdx] ?? 0
            return rot !== 0 ? await rotateBlob(blob, rot) : blob
          }),
        )
        perStudent.push({ student, pageBlobs })
      }
      await onConfirm({ perStudent })
    } finally {
      setIsSubmitting(false)
    }
  }, [
    canConfirm,
    usableChunkCount,
    splitResult.targetStudents,
    splitResult.chunks,
    getValidInternalOrder,
    pdfFiles,
    rotations,
    rotateBlob,
    onConfirm,
  ])

  // ── 渲染 ──────────────────────────────────────────────────────────────

  const handlePerPdfPageChange = (i: number, v: number) => {
    setPerPdfPagesArray((prev) => {
      const next = [...prev]
      next[i] = v
      return next
    })
  }

  const totalEffectivePages = splitResult.flatRefs.length

  return (
    <div className="fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-3 border-b border-slate-200 shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-gray-900">
              📂 PDF 預覽分配
              <span className="ml-2 text-sm font-normal text-slate-500">
                共 {pdfFiles.length} 份檔案、剩 {totalEffectivePages} 頁、預計分給{' '}
                {usableChunkCount} 位學生
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              直接調整設定、刪頁、旋轉，下方分組就是匯入後每位學生會看到的頁面。
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-2 rounded-full hover:bg-slate-100 shrink-0 self-start ml-2"
            aria-label="關閉"
          >
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        {/* 設定 + 批次操作 */}
        <div className="border-b border-slate-200 bg-slate-50/60 px-5 py-3 space-y-3 shrink-0">
          {/* 第 1 列：每生頁數 + 合併方式 */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {isMultiPdf && mergeMode === 'interleave' ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-700 font-medium">每份 PDF 每生頁數：</span>
                {pdfFiles.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1 text-xs text-slate-600">
                    <span className="truncate max-w-[120px]" title={f.fileName}>
                      {f.fileName}
                    </span>
                    <NumericInput
                      min={1}
                      max={8}
                      value={perPdfPagesArray[i] ?? 1}
                      onChange={(v) => handlePerPdfPageChange(i, typeof v === 'number' ? v : 1)}
                      className="w-12 px-1.5 py-0.5 border border-slate-300 rounded text-xs text-center"
                    />
                  </span>
                ))}
                <span className="text-xs text-slate-500">
                  → 每生 <strong>{splitResult.effectivePagesPerStudent}</strong> 頁
                </span>
              </div>
            ) : (
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <span className="font-medium">每位學生頁數：</span>
                <NumericInput
                  min={1}
                  max={8}
                  value={pagesPerStudent}
                  onChange={(v) => setPagesPerStudent(typeof v === 'number' ? v : 1)}
                  className="w-16 px-2 py-1 border border-slate-300 rounded text-sm text-center"
                />
              </label>
            )}

            {isMultiPdf && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-700 font-medium">合併方式：</span>
                <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="radio"
                    checked={mergeMode === 'concat'}
                    onChange={() => setMergeMode('concat')}
                    className="w-3.5 h-3.5 accent-green-600"
                  />
                  串接
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="radio"
                    checked={mergeMode === 'interleave'}
                    onChange={() => setMergeMode('interleave')}
                    className="w-3.5 h-3.5 accent-green-600"
                  />
                  交錯
                </label>
              </div>
            )}
          </div>

          {/* 第 2 列：未交、警示 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-slate-600">
              班上 {students.length} 人 · PDF 可分配{' '}
              <strong>{expectedStudentCount}</strong> 人
              {missingCount > 0 && (
                <span className="text-amber-700">
                  {' '}
                  → 缺 <strong>{missingCount}</strong> 人未交
                </span>
              )}
              {excessCount > 0 && (
                <span className="text-red-600"> ⚠ 頁數多 {excessCount} 人份</span>
              )}
            </span>
            {missingCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAbsentPicker((v) => !v)}
                className={`px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                  absentCountMatch
                    ? 'bg-green-50 border-green-300 text-green-700'
                    : 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
                }`}
              >
                勾選未交（{absentSeatNumbers.size}/{missingCount}）
              </button>
            )}
            {!perPdfConsistent && perPdfStudentCounts.length > 0 && (
              <span className="text-red-600">
                ⚠ 各 PDF 學生數不一致：
                {perPdfStudentCounts.map((c, i) => `${pdfFiles[i].fileName.slice(0, 8)}=${c}`).join('、')}
              </span>
            )}
          </div>

          {showAbsentPicker && missingCount > 0 && (
            <div className="border border-slate-200 rounded-lg p-2 bg-white max-h-32 overflow-y-auto">
              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-1">
                {splitResult.sortedStudents.map((s) => {
                  const isChecked = absentSeatNumbers.has(s.seatNumber)
                  const isFull = absentSeatNumbers.size >= missingCount
                  const isDisabled = !isChecked && isFull
                  return (
                    <label
                      key={s.id}
                      className={`flex items-center gap-1 px-1.5 py-1 rounded text-[11px] cursor-pointer transition-colors ${
                        isChecked
                          ? 'bg-red-50 text-red-700 border border-red-200'
                          : isDisabled
                            ? 'text-gray-300 cursor-not-allowed'
                            : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isDisabled}
                        onChange={() => toggleAbsent(s.seatNumber)}
                        className="w-3 h-3 accent-red-500"
                      />
                      <span className="font-medium">{s.seatNumber}</span>
                      <span className="truncate">{s.name}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {/* 第 3 列：批次旋轉 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-700 font-medium">批次旋轉：</span>
            <button
              type="button"
              onClick={rotateAllPages}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-white transition-colors"
              title="所有未刪除頁同步旋轉 90°"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              全部旋轉
            </button>
            {Array.from({ length: splitResult.effectivePagesPerStudent }).map((_, n) => (
              <button
                key={n}
                type="button"
                onClick={() => rotateNthPagePerStudent(n)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-white transition-colors"
                title={`所有學生的第 ${n + 1} 頁同步旋轉 90°`}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                每生第 {n + 1} 頁旋轉
              </button>
            ))}
          </div>
        </div>

        {/* 預覽區（學生分組） */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50 px-4 py-3">
          {expectedStudentCount === 0 && (
            <p className="text-center text-sm text-red-600 py-8">
              ⚠ 依目前設定無法分配任何學生，請調整每生頁數或檢查刪除頁
            </p>
          )}

          {/* 已分配的學生 */}
          {splitResult.targetStudents.slice(0, usableChunkCount).map((student, si) => {
            const chunk = splitResult.chunks[si]
            const internalOrder = getValidInternalOrder(si, chunk.length)

            return (
              <section
                key={student.id}
                className="bg-white rounded-xl border border-slate-200 px-3 py-2 mb-2"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                    {student.seatNumber}號
                  </span>
                  <span className="text-sm text-slate-700">{student.name}</span>
                </div>
                <DndContext
                  sensors={dndSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd(si, chunk)}
                >
                  <SortableContext
                    items={internalOrder.map((pos) => `s${si}-${pos}`)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="flex flex-wrap gap-2">
                      {internalOrder.map((pos, displayIdx) => {
                        const ref = chunk[pos]
                        if (!ref) return null
                        const file = pdfFiles[ref.fileIdx]
                        const rotation = rotations[ref.fileIdx][ref.pageIdx] ?? 0
                        const originLabel = isMultiPdf
                          ? `${file.fileName} 第 ${ref.pageIdx + 1} 頁`
                          : `原 PDF 第 ${ref.pageIdx + 1} 頁`
                        return (
                          <SortableStudentPageCard
                            key={`s${si}-${pos}`}
                            itemId={`s${si}-${pos}`}
                            url={file.urls[ref.pageIdx]}
                            rotation={rotation}
                            positionInStudent={displayIdx}
                            originLabel={originLabel}
                            onRotate={() => rotatePage(ref.fileIdx, ref.pageIdx)}
                            onDelete={() => togglePageDelete(ref.fileIdx, ref.pageIdx)}
                          />
                        )
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
              </section>
            )
          })}

          {/* 未交的學生（標灰）*/}
          {splitResult.sortedStudents
            .filter((s) => absentSeatNumbers.has(s.seatNumber))
            .map((student) => (
              <section
                key={`absent-${student.id}`}
                className="bg-slate-100 rounded-xl border border-dashed border-slate-300 px-3 py-2 mb-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-500 bg-slate-200 px-2 py-0.5 rounded">
                    {student.seatNumber}號
                  </span>
                  <span className="text-sm text-slate-500">{student.name}</span>
                  <span className="ml-2 text-xs text-slate-400 italic">未交</span>
                </div>
              </section>
            ))}

          {/* 剩餘未分配頁面 */}
          {splitResult.remainingPages > 0 && (
            <p className="text-xs text-amber-700 mt-2 pl-1">
              ⚠ 還有 {splitResult.remainingPages} 頁未滿一份（不足每生 {splitResult.effectivePagesPerStudent} 頁），不會被匯入。請刪掉多餘頁或調整每生頁數。
            </p>
          )}
          {usableChunkCount < expectedStudentCount && (
            <p className="text-xs text-red-600 mt-2 pl-1">
              ⚠ PDF 可分 {expectedStudentCount} 份，但扣掉未交後僅 {usableChunkCount} 位學生可分配；多出的 {expectedStudentCount - usableChunkCount} 份不會匯入。
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 shrink-0 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="w-4 h-4 accent-green-600"
            />
            <span className="text-sm text-slate-700">我已確認以上分配正確</span>
          </label>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleConfirm}
              disabled={!canConfirm}
            >
              {isSubmitting ? '處理中…' : '確認分割並匯入'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
