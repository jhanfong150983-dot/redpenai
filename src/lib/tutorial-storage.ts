/**
 * 引导式教学进度存储管理
 * 使用 localStorage 记录用户的教学完成状态
 */

const STORAGE_KEY_PREFIX = 'redpen-tutorial'

/**
 * 检查是否为首次使用指定页面
 * @param page 页面标识（classroom, assignment, import, grading）
 */
export function isFirstTimeUser(page: string): boolean {
  try {
    const key = `${STORAGE_KEY_PREFIX}-${page}-completed`
    const completed = localStorage.getItem(key)
    return completed !== 'true'
  } catch (e) {
    console.warn('Failed to read tutorial status from localStorage:', e)
    return false // 如果读取失败，不显示教学
  }
}

/**
 * 标记指定页面的教学已完成
 * @param page 页面标识
 */
export function markTutorialComplete(page: string): void {
  try {
    const key = `${STORAGE_KEY_PREFIX}-${page}-completed`
    localStorage.setItem(key, 'true')
  } catch (e) {
    console.warn('Failed to save tutorial completion to localStorage:', e)
  }
}

/**
 * 重置教学状态（用于通过 ? 图标重新查看教学）
 * @param page 页面标识
 */
export function resetTutorial(page: string): void {
  try {
    const key = `${STORAGE_KEY_PREFIX}-${page}-completed`
    localStorage.removeItem(key)

    // 同时清除进度
    const progressKey = `${STORAGE_KEY_PREFIX}-${page}-progress`
    localStorage.removeItem(progressKey)
  } catch (e) {
    console.warn('Failed to reset tutorial status:', e)
  }
}

/**
 * 保存当前教学进度
 * @param page 页面标识
 * @param step 当前步骤索引
 */
export function saveTutorialProgress(page: string, step: number): void {
  try {
    const key = `${STORAGE_KEY_PREFIX}-${page}-progress`
    localStorage.setItem(key, step.toString())
  } catch (e) {
    console.warn('Failed to save tutorial progress:', e)
  }
}

/**
 * 获取当前教学进度
 * @param page 页面标识
 * @returns 当前步骤索引，如果没有保存则返回 0
 */
export function getTutorialProgress(page: string): number {
  try {
    const key = `${STORAGE_KEY_PREFIX}-${page}-progress`
    const progress = localStorage.getItem(key)
    if (progress) {
      const step = parseInt(progress, 10)
      return isNaN(step) ? 0 : step
    }
    return 0
  } catch (e) {
    console.warn('Failed to read tutorial progress:', e)
    return 0
  }
}
