import { dispatchInkBalance } from './ink-events'

const INK_SESSION_STORAGE_KEY = 'rp-ink-session-id'
const INK_SESSION_EXPIRES_KEY = 'rp-ink-session-expires-at'

let cachedInkSessionId: string | null = null
let cachedInkSessionExpiresAt: number | null = null

function readStoredInkSessionId() {
  if (typeof window === 'undefined') return null
  return window.sessionStorage.getItem(INK_SESSION_STORAGE_KEY)
}

function readStoredInkSessionExpiresAt(): number | null {
  if (typeof window === 'undefined') return null
  const v = window.sessionStorage.getItem(INK_SESSION_EXPIRES_KEY)
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

export function getInkSessionId() {
  if (cachedInkSessionId !== null) return cachedInkSessionId
  const stored = readStoredInkSessionId()
  cachedInkSessionId = stored || null
  return cachedInkSessionId
}

export function getInkSessionExpiresAt(): number | null {
  if (cachedInkSessionExpiresAt !== null) return cachedInkSessionExpiresAt
  const stored = readStoredInkSessionExpiresAt()
  cachedInkSessionExpiresAt = stored
  return cachedInkSessionExpiresAt
}

export function setInkSessionId(sessionId: string | null) {
  cachedInkSessionId = sessionId
  if (typeof window === 'undefined') return
  if (sessionId) {
    window.sessionStorage.setItem(INK_SESSION_STORAGE_KEY, sessionId)
  } else {
    window.sessionStorage.removeItem(INK_SESSION_STORAGE_KEY)
  }
}

function setInkSessionExpiresAt(expiresAt: number | null) {
  cachedInkSessionExpiresAt = expiresAt
  if (typeof window === 'undefined') return
  if (expiresAt) {
    window.sessionStorage.setItem(INK_SESSION_EXPIRES_KEY, String(expiresAt))
  } else {
    window.sessionStorage.removeItem(INK_SESSION_EXPIRES_KEY)
  }
}

/**
 * 從 API 取得最新的墨水餘額並派發事件更新 UI
 */
export async function refreshInkBalance(): Promise<number | null> {
  try {
    const response = await fetch('/api/auth/me', {
      credentials: 'include',
      cache: 'no-cache',
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    })
    if (!response.ok) return null
    const data = await response.json()
    const balance = data?.user?.inkBalance
    if (typeof balance === 'number' && Number.isFinite(balance)) {
      console.log('[ink-session] 從 API 刷新墨水餘額:', balance)
      dispatchInkBalance(balance)
      return balance
    }
  } catch (error) {
    console.warn('[ink-session] 刷新墨水餘額失敗:', error)
  }
  return null
}

export async function startInkSession() {
  const response = await fetch('/api/ink/sessions?action=start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({})
  })

  let data: any = null
  try {
    data = await response.json()
  } catch {
    data = {}
  }

  if (!response.ok) {
    setInkSessionId(null)
    const message = data?.error || '無法建立批改會話'
    throw new Error(message)
  }

  const sessionId =
    typeof data?.sessionId === 'string' ? data.sessionId.trim() : ''
  if (!sessionId) {
    setInkSessionId(null)
    throw new Error('無法建立批改會話')
  }

  setInkSessionId(sessionId)
  
  // 儲存過期時間
  if (data?.expiresAt) {
    const expiresAtMs = Date.parse(data.expiresAt) || Number(data.expiresAt) || null
    if (expiresAtMs) {
      setInkSessionExpiresAt(expiresAtMs)
    }
  }
  
  return { sessionId, expiresAt: data?.expiresAt }
}

export async function closeInkSession(sessionId?: string | null) {
  const id = sessionId || getInkSessionId()
  if (!id) return null
  let inkSummary: {
    chargedPoints?: number
    balanceBefore?: number | null
    balanceAfter?: number | null
    applied?: boolean
  } | null = null
  let balanceDispatched = false

  try {
    const response = await fetch('/api/ink/sessions?action=close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sessionId: id })
    })
    let data: any = null
    try {
      data = await response.json()
    } catch {
      data = {}
    }
    if (response.ok) {
      inkSummary = data?.ink ?? null
      const updatedBalance = Number(data?.ink?.balanceAfter)
      if (Number.isFinite(updatedBalance)) {
        // 確保事件被派發
        console.log('[ink-session] 派發墨水餘額更新:', updatedBalance)
        dispatchInkBalance(updatedBalance)
        balanceDispatched = true
      }
    } else {
      console.warn('[ink-session] 關閉會話失敗:', data?.error || response.status)
    }
  } catch (error) {
    console.warn('Ink session close failed:', error)
  } finally {
    setInkSessionId(null)
    setInkSessionExpiresAt(null)  // 清除過期時間
  }

  // 如果沒有成功派發餘額更新，嘗試從 API 刷新
  if (!balanceDispatched) {
    console.log('[ink-session] 未收到 balanceAfter，嘗試從 API 刷新')
    await refreshInkBalance()
  }

  return inkSummary
}

/**
 * 確保 Ink Session 有效且未過期
 * - 若無 session 或已過期（< 60秒），自動建立新 session
 * - 若 session 有效，直接返回
 */
export async function ensureInkSessionFresh(): Promise<{ sessionId: string; expiresAt: number | null }> {
  const id = getInkSessionId()
  const exp = getInkSessionExpiresAt()
  const now = Date.now()

  // 沒有 session 或過期時間不明 → 建立新 session
  if (!id || !exp) {
    console.log('[ink-session] 無有效 session，建立新 session')
    const result = await startInkSession()
    return { 
      sessionId: result.sessionId, 
      expiresAt: result.expiresAt ? Date.parse(result.expiresAt) : null 
    }
  }

  // 剩餘時間 < 60 秒 → 關閉舊的並建立新 session
  if (exp - now < 60_000) {
    console.log('[ink-session] Session 即將過期，續期中...')
    await closeInkSession(id)
    const result = await startInkSession()
    return { 
      sessionId: result.sessionId, 
      expiresAt: result.expiresAt ? Date.parse(result.expiresAt) : null 
    }
  }

  // Session 有效
  return { sessionId: id, expiresAt: exp }
}
