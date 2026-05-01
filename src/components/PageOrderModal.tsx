import { useState, useCallback } from 'react'
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
import { RotateCw, Check, X } from 'lucide-react'
import Button from '@/components/ui/Button'

interface PageItem {
  id: string
  originalIndex: number
  url: string
  rotation: number
}

interface PageOrderModalProps {
  pages: Array<{ index: number; url: string; blob: Blob }>
  onConfirm: (order: number[], rotations: Map<number, number>) => void
  onCancel: () => void
}

function SortablePageCard({
  item,
  onRotate
}: {
  item: PageItem
  onRotate: (id: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: item.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : 1
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative group ${isDragging ? 'shadow-2xl' : ''}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="border-2 border-gray-200 rounded-xl overflow-hidden cursor-grab active:cursor-grabbing bg-white hover:border-green-400 transition-colors"
      >
        <div className="bg-gray-50 px-2 py-1.5 text-xs text-gray-600 font-medium flex items-center justify-between">
          <span>第 {item.originalIndex + 1} 頁</span>
          {item.rotation !== 0 && (
            <span className="text-[10px] text-orange-600 font-semibold">
              {item.rotation}°
            </span>
          )}
        </div>
        <div className="aspect-[3/4] bg-white overflow-hidden">
          <img
            src={item.url}
            alt={`第 ${item.originalIndex + 1} 頁`}
            className="w-full h-full object-contain transition-transform"
            style={{ transform: `rotate(${item.rotation}deg)` }}
            draggable={false}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRotate(item.id)
        }}
        className="absolute top-9 right-1 p-1.5 rounded-full bg-white/90 border border-gray-300 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-gray-100"
        title="旋轉 90°"
      >
        <RotateCw className="w-3.5 h-3.5 text-gray-600" />
      </button>
    </div>
  )
}

export default function PageOrderModal({
  pages,
  onConfirm,
  onCancel
}: PageOrderModalProps) {
  const [items, setItems] = useState<PageItem[]>(() =>
    pages.map((p) => ({
      id: `page-${p.index}`,
      originalIndex: p.index,
      url: p.url,
      rotation: 0
    }))
  )

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setItems((prev) => {
        const oldIndex = prev.findIndex((i) => i.id === active.id)
        const newIndex = prev.findIndex((i) => i.id === over.id)
        return arrayMove(prev, oldIndex, newIndex)
      })
    }
  }, [])

  const handleRotateOne = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? { ...item, rotation: (item.rotation + 90) % 360 }
          : item
      )
    )
  }, [])

  const handleRotateAll = useCallback(() => {
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        rotation: (item.rotation + 90) % 360
      }))
    )
  }, [])

  const handleConfirm = () => {
    const order = items.map((i) => i.originalIndex)
    const rotations = new Map<number, number>()
    for (const item of items) {
      if (item.rotation !== 0) {
        rotations.set(item.originalIndex, item.rotation)
      }
    }
    onConfirm(order, rotations)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              調整頁面順序
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              拖曳調整頁面順序，點擊旋轉按鈕調整方向。共 {items.length} 頁。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRotateAll}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              <RotateCw className="w-3.5 h-3.5" />
              全部旋轉
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              aria-label="取消"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-4">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={items.map((i) => i.id)}
              strategy={rectSortingStrategy}
            >
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
                {items.map((item) => (
                  <SortablePageCard
                    key={item.id}
                    item={item}
                    onRotate={handleRotateOne}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-200 bg-gray-50">
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" variant="primary" onClick={handleConfirm}>
            <Check className="w-4 h-4" />
            確認順序
          </Button>
        </div>
      </div>
    </div>
  )
}
