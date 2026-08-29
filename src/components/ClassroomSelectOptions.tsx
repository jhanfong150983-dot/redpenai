// 2026-08-29 班級下拉共用 options：依 folder（學年度）分 <optgroup>、組內按班名排序。
//   只產 <option>/<optgroup> 子節點，塞進各頁自己的 <select>（樣式/placeholder 由呼叫端保留）。
import { useMemo } from 'react'
import { groupClassroomsByFolder, UNGROUPED_FOLDER_LABEL } from '@/lib/classroom-order'

export interface ClassroomOptionItem {
  id: string
  name?: string
  folder?: string | null
}

export function ClassroomSelectOptions({ classrooms }: { classrooms: ClassroomOptionItem[] }) {
  const groups = useMemo(() => groupClassroomsByFolder(classrooms), [classrooms])

  const renderOptions = (items: ClassroomOptionItem[]) =>
    items.map((c) => (
      <option key={c.id} value={c.id}>
        {c.name || '未命名班級'}
      </option>
    ))

  // 全部同一資料夾（或都未分類）就不顯示區塊標題，維持原本的平鋪樣子
  if (groups.length === 1 && groups[0].label === UNGROUPED_FOLDER_LABEL) {
    return <>{renderOptions(groups[0].classrooms)}</>
  }

  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {renderOptions(g.classrooms)}
        </optgroup>
      ))}
    </>
  )
}
