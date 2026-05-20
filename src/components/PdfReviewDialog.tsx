import { useMemo } from 'react'
import { RotateCw, RotateCcw, Trash2, Undo2, X } from 'lucide-react'
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
import Button from '@/components/ui/Button'

// ── PDF 校稿頁面狀態 ───────────────────────────────────────────────────────

export interface PdfReviewFile {
  fileName: string
  totalPages: number
  pageUrls: string[]      // 原始 index → blob URL
  rotations: number[]     // 原始 index → 旋轉角度
  deleted: boolean[]      // 原始 index → 是否已刪
  order: number[]         // 當前顯示順序的原始 index 陣列（含已刪頁）
}

// ── 卡片 ───────────────────────────────────────────────────────────────────

function SortableReviewCard({
  pageIndex,
  url,
  rotation,
  position,
  deleted,
  onRotate,
  onToggleDelete,
}: {
  pageIndex: number
  url: string
  rotation: number
  position: number
  deleted: boolean
  onRotate: (idx: number) => void
  onToggleDelete: (idx: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `pr-${pageIndex}` })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className={`relative group ${isDragging ? 'shadow-2xl' : ''}`}>
      <div
        {...attributes}
        {...listeners}
        className={`border-2 rounded-xl overflow-hidden bg-white transition-colors ${
          deleted
            ? 'border-red-200 cursor-default'
            : 'border-slate-200 cursor-grab active:cursor-grabbing hover:border-green-400'
        }`}
      >
        <div className="bg-slate-50 px-3 py-1.5 text-xs text-slate-600 font-medium flex items-center justify-between gap-1">
          <span className={`truncate ${deleted ? 'line-through text-slate-400' : ''}`}>
            {deleted
              ? `原第 ${pageIndex + 1} 頁`
              : position === pageIndex
                ? `第 ${position + 1} 頁`
                : `第 ${position + 1} 頁（原 ${pageIndex + 1}）`}
          </span>
          {!deleted && rotation !== 0 && (
            <span className="text-[10px] text-orange-600 font-semibold shrink-0">{rotation}°</span>
          )}
        </div>
        <div className={`aspect-[3/4] bg-white overflow-hidden ${deleted ? 'opacity-30' : ''}`}>
          <img
            src={url}
            alt={`第 ${pageIndex + 1} 頁`}
            className="w-full h-full object-contain transition-transform"
            style={{ transform: `rotate(${rotation}deg)` }}
            draggable={false}
          />
        </div>
        {deleted && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="bg-red-500/90 text-white text-xs font-semibold px-3 py-1 rounded-full">已刪除</span>
          </div>
        )}
      </div>

      {/* hover 操作鈕 */}
      {!deleted && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRotate(pageIndex)
          }}
          className="absolute top-9 right-1 p-1.5 rounded-full bg-white/90 border border-slate-300 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-slate-100"
          title="旋轉 90°"
        >
          <RotateCw className="w-3.5 h-3.5 text-slate-600" />
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleDelete(pageIndex)
        }}
        className={`absolute top-9 right-9 p-1.5 rounded-full border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity ${
          deleted
            ? 'bg-amber-50 border-amber-300 hover:bg-amber-100'
            : 'bg-white/90 border-slate-300 hover:bg-red-50'
        }`}
        title={deleted ? '復原' : '刪除這頁'}
      >
        {deleted ? (
          <Undo2 className="w-3.5 h-3.5 text-amber-700" />
        ) : (
          <Trash2 className="w-3.5 h-3.5 text-red-500" />
        )}
      </button>
    </div>
  )
}

// ── Dialog ─────────────────────────────────────────────────────────────────

export interface PdfReviewDialogProps {
  files: PdfReviewFile[]
  selectedFileIndex: number
  onSelectFileIndex: (i: number) => void
  onRotate: (fileIdx: number, pageIdx: number) => void
  onRotateAll: (fileIdx: number) => void
  // 依「目前顯示位置」（扣掉已刪除頁後的 1-based position）的奇偶批次旋轉
  onRotateByParity: (fileIdx: number, parity: 'odd' | 'even') => void
  onToggleDelete: (fileIdx: number, pageIdx: number) => void
  onReorder: (fileIdx: number, newOrder: number[]) => void
  onConfirm: () => void
  onCancel: () => void
}

export default function PdfReviewDialog({
  files,
  selectedFileIndex,
  onSelectFileIndex,
  onRotate,
  onRotateAll,
  onRotateByParity,
  onToggleDelete,
  onReorder,
  onConfirm,
  onCancel,
}: PdfReviewDialogProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const current = files[selectedFileIndex]
  const hasMultiple = files.length > 1

  const remainingByFile = useMemo(
    () => files.map((f) => f.order.filter((i) => !f.deleted[i]).length),
    [files],
  )
  const totalRemaining = remainingByFile.reduce((a, b) => a + b, 0)

  // 計算「位置編號」（已刪除頁不算）— 即使 current 為 undefined 也要呼叫 hook
  const positionMap = useMemo(() => {
    const map = new Map<number, number>()
    if (!current) return map
    let pos = 0
    for (const idx of current.order) {
      if (!current.deleted[idx]) {
        map.set(idx, pos)
        pos++
      }
    }
    return map
  }, [current])

  if (!current) return null

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      const oldIndex = current.order.findIndex((id) => `pr-${id}` === active.id)
      const newIndex = current.order.findIndex((id) => `pr-${id}` === over.id)
      const newOrder = arrayMove(current.order, oldIndex, newIndex)
      onReorder(selectedFileIndex, newOrder)
    }
  }

  const currentRemaining = remainingByFile[selectedFileIndex] ?? 0
  const canConfirm = totalRemaining > 0

  return (
    <div className="fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-3 border-b border-slate-200 shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-gray-900">
              整份 PDF 校稿
              <span className="ml-2 text-sm font-normal text-slate-500">
                可刪除錯誤頁、拖曳調順序、旋轉
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              校稿完成後再進入學生切片分配。共 {files.length} 份檔案、剩餘 {totalRemaining} 頁。
            </p>
            {hasMultiple && (
              <div className="flex gap-1 mt-2 overflow-x-auto pb-1">
                {files.map((f, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onSelectFileIndex(i)}
                    className={`shrink-0 px-3 py-1 rounded-lg text-xs font-medium transition-colors max-w-[200px] ${
                      selectedFileIndex === i
                        ? 'bg-indigo-100 text-indigo-700'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                    title={f.fileName}
                  >
                    <span className="truncate inline-block max-w-[160px] align-bottom">{f.fileName}</span>
                    <span className="ml-1 text-[10px] text-slate-400">
                      ({remainingByFile[i]}/{f.totalPages})
                    </span>
                  </button>
                ))}
              </div>
            )}
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

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50 p-4">
          <p className="text-xs text-slate-400 mb-3 text-center">
            拖曳卡片調整順序 · 點右上角旋轉 / 刪除（hover 顯示）
          </p>
          {currentRemaining === 0 && (
            <p className="text-xs text-red-600 text-center mb-3">
              ⚠ 這份 PDF 所有頁面都已刪除
            </p>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={current.order.map((id) => `pr-${id}`)}
              strategy={rectSortingStrategy}
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {current.order.map((pageIdx) => (
                  <SortableReviewCard
                    key={pageIdx}
                    pageIndex={pageIdx}
                    url={current.pageUrls[pageIdx]}
                    rotation={current.rotations[pageIdx] ?? 0}
                    position={positionMap.get(pageIdx) ?? 0}
                    deleted={current.deleted[pageIdx] ?? false}
                    onRotate={(idx) => onRotate(selectedFileIndex, idx)}
                    onToggleDelete={(idx) => onToggleDelete(selectedFileIndex, idx)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 shrink-0 gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => onRotateAll(selectedFileIndex)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              title="這份 PDF 所有頁同步旋轉 90°"
            >
              <RotateCcw className="w-4 h-4" />
              全部旋轉
            </button>
            <button
              type="button"
              onClick={() => onRotateByParity(selectedFileIndex, 'odd')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              title="原 PDF 中奇數頁（1、3、5…）旋轉 90°，依原始頁碼判斷、不受刪頁或拖序影響"
            >
              <RotateCcw className="w-4 h-4" />
              原 1、3、5… 頁旋轉
            </button>
            <button
              type="button"
              onClick={() => onRotateByParity(selectedFileIndex, 'even')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              title="原 PDF 中偶數頁（2、4、6…）旋轉 90°，依原始頁碼判斷、不受刪頁或拖序影響"
            >
              <RotateCcw className="w-4 h-4" />
              原 2、4、6… 頁旋轉
            </button>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button type="button" variant="primary" onClick={onConfirm} disabled={!canConfirm}>
              下一步
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
