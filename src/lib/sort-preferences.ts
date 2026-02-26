/**
 * 排序选项和偏好设置管理
 */

export type SortOption = 'time-desc' | 'time-asc' | 'name-asc' | 'name-desc'

const STORAGE_KEY_PREFIX = 'redpen-sort-preference'

/**
 * 获取指定页面的排序偏好
 */
export function getSortPreference(page: string): SortOption {
  try {
    const key = `${STORAGE_KEY_PREFIX}-${page}`
    const stored = localStorage.getItem(key)
    if (stored && isValidSortOption(stored)) {
      return stored as SortOption
    }
  } catch (e) {
    console.warn('Failed to read sort preference from localStorage:', e)
  }
  // 默认：时间降序（新→旧）
  return 'time-desc'
}

/**
 * 保存指定页面的排序偏好
 */
export function setSortPreference(page: string, option: SortOption): void {
  try {
    const key = `${STORAGE_KEY_PREFIX}-${page}`
    localStorage.setItem(key, option)
  } catch (e) {
    console.warn('Failed to save sort preference to localStorage:', e)
  }
}

/**
 * 验证是否为有效的排序选项
 */
function isValidSortOption(value: string): boolean {
  return ['time-desc', 'time-asc', 'name-asc', 'name-desc'].includes(value)
}

/**
 * 中文排序比较器（使用 Intl.Collator）
 */
const chineseCollator = new Intl.Collator('zh-Hans-CN', {
  sensitivity: 'base',
  numeric: true
})

/**
 * 排序班级列表
 */
export function sortClassrooms<T extends { name: string; updatedAt?: number }>(
  classrooms: T[],
  option: SortOption
): T[] {
  const sorted = [...classrooms]

  switch (option) {
    case 'time-desc':
      // 时间降序：新→旧（最新更新的在前）
      return sorted.sort((a, b) => {
        const timeA = a.updatedAt ?? 0
        const timeB = b.updatedAt ?? 0
        return timeB - timeA
      })

    case 'time-asc':
      // 时间升序：旧→新（最早更新的在前）
      return sorted.sort((a, b) => {
        const timeA = a.updatedAt ?? 0
        const timeB = b.updatedAt ?? 0
        return timeA - timeB
      })

    case 'name-asc':
      // 名称升序：A-Z（笔画排序）
      return sorted.sort((a, b) => chineseCollator.compare(a.name, b.name))

    case 'name-desc':
      // 名称降序：Z-A（笔画排序）
      return sorted.sort((a, b) => chineseCollator.compare(b.name, a.name))

    default:
      return sorted
  }
}

/**
 * 排序作业列表
 */
export function sortAssignments<T extends { title: string; updatedAt?: number }>(
  assignments: T[],
  option: SortOption
): T[] {
  const sorted = [...assignments]

  switch (option) {
    case 'time-desc':
      // 时间降序：新→旧
      return sorted.sort((a, b) => {
        const timeA = a.updatedAt ?? 0
        const timeB = b.updatedAt ?? 0
        return timeB - timeA
      })

    case 'time-asc':
      // 时间升序：旧→新
      return sorted.sort((a, b) => {
        const timeA = a.updatedAt ?? 0
        const timeB = b.updatedAt ?? 0
        return timeA - timeB
      })

    case 'name-asc':
      // 名称升序：A-Z（笔画排序）
      return sorted.sort((a, b) => chineseCollator.compare(a.title, b.title))

    case 'name-desc':
      // 名称降序：Z-A（笔画排序）
      return sorted.sort((a, b) => chineseCollator.compare(b.title, a.title))

    default:
      return sorted
  }
}

/**
 * 排序资料夹名称列表（按笔画排序）
 */
export function sortFolders(folders: string[]): string[] {
  return [...folders].sort((a, b) => chineseCollator.compare(a, b))
}
