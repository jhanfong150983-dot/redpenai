const DEBUG_STORAGE_KEY = 'rp-debug'

const isDebugEnabled = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage?.getItem(DEBUG_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export const debugLog = (...args: unknown[]) => {
  if (isDebugEnabled()) {
    console.log(...args)
  }
}

export const infoLog = (...args: unknown[]) => {
  console.log(...args)
}

export const warnLog = (...args: unknown[]) => {
  console.warn(...args)
}

export const errorLog = (...args: unknown[]) => {
  console.error(...args)
}

export const isDebugLoggingEnabled = isDebugEnabled
