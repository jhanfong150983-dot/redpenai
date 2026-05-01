import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import {
  Users,
  Sparkles,
  Shield,
  Droplet,
  Crown,
  BarChart3,
  LayoutDashboard,
  // FilePlus2,
  BookOpen,
  FileText,
  SlidersHorizontal,
  ChevronDown,
  AlertTriangle,
  Link as LinkIcon,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ── Lazy-loaded page components ──
const ClassroomManagement = lazy(() => import('@/pages/ClassroomManagement'))
const AssignmentSetup = lazy(() => import('@/pages/AssignmentSetup'))
const AnswerBank = lazy(() => import('@/pages/AnswerBank'))
const AssignmentList = lazy(() => import('@/pages/AssignmentList'))
const GradingPage = lazy(() => import('@/pages/GradingPage'))
const AssignmentImport = lazy(() => import('@/pages/AssignmentImport'))
const AssignmentImportSelect = lazy(() => import('@/pages/AssignmentImportSelect'))
const AssignmentScanImport = lazy(() => import('@/pages/AssignmentScanImport'))
const UnifiedImportPage = lazy(() => import('@/pages/UnifiedImportPage'))
const CorrectionSelect = lazy(() => import('@/pages/CorrectionSelect'))
const CorrectionManagement = lazy(() => import('@/pages/CorrectionManagement'))
const Gradebook = lazy(() => import('@/pages/Gradebook'))
const StudentPortal = lazy(() => import('@/pages/StudentPortal'))
const AdminPanel = lazy(() => import('@/pages/AdminPanel'))
const InkTopUp = lazy(() => import('@/pages/InkTopUp'))
const AiReport = lazy(() => import('@/pages/AiReport'))
const LandingPage = lazy(() => import('@/pages/LandingPage'))
const AdminUserDetail = lazy(() => import('@/pages/AdminUserDetail'))
const TeacherPreferences = lazy(() => import('@/pages/TeacherPreferences'))

import SyncIndicator from '@/components/SyncIndicator'
import Button from '@/components/ui/Button'
import GlobalSyncBar from '@/components/GlobalSyncBar'
import ErrorBoundary from '@/components/ErrorBoundary'
import { checkWebPSupport } from '@/lib/webpSupport'
import { INK_BALANCE_EVENT, type InkBalanceDetail } from '@/lib/ink-events'
import { buildApiUrl } from '@/lib/api-base'
import {
  requestSync,
  SYNC_COMPLETE_EVENT_NAME,
  type SyncCompleteDetail
} from '@/lib/sync-events'
import '@/lib/debug-sync'
import { debugLog } from '@/lib/logger'
import { LEGAL_MODAL_EVENT, type LegalModalDetail } from '@/lib/legal-events'
import { TERMS_VERSION, PRIVACY_VERSION, REFUND_FEE_RATE } from '@/lib/legal'
import {
  db,
  type Classroom,
  type Student,
  type Submission
} from '@/lib/db'

type Page =
  | 'home'
  | 'classroom-management'
  | 'assignment-setup'
  | 'answer-bank'
  | 'assignment-import-select'
  | 'assignment-scan'
  | 'grading-list'
  | 'grading'
  | 'batch-grading'
  | 'gradebook'
  | 'assignment-import'
  | 'unified-import'
  | 'correction-select'
  | 'correction'
  | 'ai-report'
  | 'admin-panel'
  | 'admin-user-detail'
  | 'ink-topup'
  | 'teacher-preferences'

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated'; error?: string }
  | {
      status: 'authenticated'
      user: {
        id: string
        email: string
        name?: string
        avatarUrl?: string
        role?: string
        permissionTier?: string
        inkBalance?: number
        student?: {
          id: string
          classroomId: string
          seatNumber: number
          name: string
          ownerId: string
          email?: string | null
        }
        students?: Array<{
          id: string
          classroomId: string
          seatNumber: number
          name: string
          ownerId: string
          email?: string | null
        }>
        campus1Binding?: {
          account: string
          dsns: string
          displayName?: string
          roleType?: string
        }
        studentLookupStatus?: 'ok' | 'user_not_found' | 'system_error'
      }
    }
type InkOrderSummary = {
  status?: string | null
  drops?: number | null
  bonus_drops?: number | null
  amount_twd?: number | null
}
type PendingInkSummary = {
  count: number
  totalDrops: number
  amountTwd: number
}

type HomeOverviewSummary = {
  totalAssignments: number
  assignmentsWithoutUploads: number
  uploadedSubmissions: number
  gradedSubmissions: number
  pendingGradingSubmissions: number
}

type AssignmentWorkflowStatus =
  | 'missing-answer-key'
  | 'missing-submission'
  | 'pending-grading'
  | 'pending-dispatch'
  | 'correction-followup'
  | 'completed'

type HomeOverviewItem = {
  id: string
  title: string
  classroomId: string
  classroomName: string
  totalStudents: number
  uploadedCount: number
  gradedCount: number
  pendingGradingCount: number
  correctionCount: number
  pendingCorrectionSeatNumbers: number[]
  hasAnswerKey: boolean
  workflowStatus: AssignmentWorkflowStatus
  workflowPriority: number
  progressPercent: number
  completedSeatNumbers: number[]
  incompleteSeatNumbers: number[]
  ungradedSeatNumbers: number[]
  notSubmittedSeatNumbers: number[]
}

type HomeNavItem = {
  key: string
  label: string
  description: string
  icon: LucideIcon
  onClick: () => void
  disabled?: boolean
  badge?: string
}

type HomeNavSection = {
  title: string
  items: HomeNavItem[]
}

type LoginEntryMode = 'teacher' | 'student'

const LOGIN_ENTRY_STORAGE_KEY = 'redpen-login-entry'
const CURRENT_USER_ID_KEY = 'redpen-current-user-id'
const INITIAL_SYNCED_KEY = 'redpen-initial-synced'

const normalizeLoginEntry = (value: unknown): LoginEntryMode | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'teacher' || normalized === 'student') return normalized
  return null
}

const OVERVIEW_VISIBLE_STEP = 3
const INITIAL_SYNC_TIMEOUT_MS = 8000

// Stage 2 路由：currentPage ↔ URL ?page= 雙向同步
// 'home' 用無 ?page= 表示；其他 Page 值直接作為 URL slug
const URL_SYNCABLE_PAGES: readonly Page[] = [
  'classroom-management',
  'assignment-setup',
  'answer-bank',
  'assignment-import-select',
  'assignment-scan',
  'grading-list',
  'grading',
  'batch-grading',
  'gradebook',
  'assignment-import',
  'unified-import',
  'correction-select',
  'correction',
  'ai-report',
  'admin-panel',
  'admin-user-detail',
  'ink-topup',
  'teacher-preferences'
]

// 舊書籤相容：別名 → 規範化 Page
const PAGE_PARAM_ALIASES: Record<string, Page> = {
  'classroom': 'classroom-management',
  'admin-orders': 'admin-panel',
  'admin-users': 'admin-panel',
  'admin-analytics': 'admin-panel',
  'admin-tags': 'admin-panel'
}

// path-based URL 對應表（其他頁面繼續用 ?page=xxx）
// Stage 3：ink-topup / teacher-preferences / admin-panel
// Stage 4：answer-bank / classroom-management / gradebook / ai-report
// Stage 5：grading-list / correction-select / assignment-import-select
const PAGE_PATH_MAP: Partial<Record<Page, string>> = {
  'ink-topup': '/ink-topup',
  'teacher-preferences': '/preferences',
  'admin-panel': '/admin',
  'answer-bank': '/answer-bank',
  'classroom-management': '/classroom',
  'gradebook': '/gradebook',
  'ai-report': '/ai-report',
  'grading-list': '/grading-list',
  'correction-select': '/correction-select',
  'assignment-import-select': '/import-select'
}

const PATH_PAGE_MAP: Record<string, Page> = {
  '/ink-topup': 'ink-topup',
  '/preferences': 'teacher-preferences',
  '/admin': 'admin-panel',
  '/answer-bank': 'answer-bank',
  '/classroom': 'classroom-management',
  '/gradebook': 'gradebook',
  '/ai-report': 'ai-report',
  '/grading-list': 'grading-list',
  '/correction-select': 'correction-select',
  '/import-select': 'assignment-import-select'
}

const parseUrlPageParam = (raw: string | null | undefined): Page | null => {
  if (!raw) return 'home'
  const trimmed = raw.trim()
  if (!trimmed) return 'home'
  if (PAGE_PARAM_ALIASES[trimmed]) return PAGE_PARAM_ALIASES[trimmed]
  if ((URL_SYNCABLE_PAGES as readonly string[]).includes(trimmed)) return trimmed as Page
  return null
}

// Stage 6：帶 ID 的路徑前綴對應（/grading/:id、/import/:id、/correction/:id）
const PARAMETERIZED_PATH_PREFIXES: Array<{ prefix: string; page: Page }> = [
  { prefix: '/grading/', page: 'grading' },
  { prefix: '/import/', page: 'unified-import' },
  { prefix: '/correction/', page: 'correction' }
]

// 沒有 ID 時的 fallback：grading→grading-list 等
const PAGE_FALLBACK_WITHOUT_ID: Partial<Record<Page, Page>> = {
  'grading': 'grading-list',
  'unified-import': 'assignment-import-select',
  'correction': 'correction-select'
}

type ParsedLocation = { page: Page | null; assignmentId?: string }

// Stage 3：解析整個 location（先看 pathname 是否為 path-based，再 fallback 到 ?page=）
// Stage 6：擴充支援 /grading/:id、/import/:id、/correction/:id
const parseCurrentPageFromLocation = (): ParsedLocation => {
  if (typeof window === 'undefined') return { page: 'home' }
  const pathname = window.location.pathname
  if (PATH_PAGE_MAP[pathname]) return { page: PATH_PAGE_MAP[pathname] }
  for (const { prefix, page } of PARAMETERIZED_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      const id = pathname.slice(prefix.length).split('/')[0]
      if (id) return { page, assignmentId: decodeURIComponent(id) }
    }
  }
  if (pathname === '/') {
    const params = new URLSearchParams(window.location.search)
    return { page: parseUrlPageParam(params.get('page')) }
  }
  return { page: null }
}

const writeCurrentPageToUrl = (
  page: Page,
  assignmentId: string | undefined,
  action: 'push' | 'replace' = 'push'
): void => {
  if (typeof window === 'undefined') return

  // 帶 ID 的頁面但沒有 ID → 回退到 list 頁
  if (PAGE_FALLBACK_WITHOUT_ID[page] && !assignmentId) {
    return writeCurrentPageToUrl(PAGE_FALLBACK_WITHOUT_ID[page]!, undefined, action)
  }

  const currentPathname = window.location.pathname
  const currentSearch = window.location.search
  const params = new URLSearchParams(currentSearch)
  params.delete('page')

  let targetPathname: string
  if (assignmentId && (page === 'grading' || page === 'unified-import' || page === 'correction')) {
    const prefix = page === 'grading' ? '/grading' : page === 'unified-import' ? '/import' : '/correction'
    targetPathname = `${prefix}/${encodeURIComponent(assignmentId)}`
  } else if (PAGE_PATH_MAP[page]) {
    targetPathname = PAGE_PATH_MAP[page]!
  } else if (page === 'home') {
    targetPathname = '/'
  } else {
    // 其他頁面：用 ?page=xxx 並回到根路徑
    targetPathname = '/'
    params.set('page', page)
  }

  const query = params.toString()
  const targetUrl = query ? `${targetPathname}?${query}` : targetPathname
  const currentUrl = currentPathname + currentSearch
  if (currentUrl === targetUrl) return
  if (action === 'push') {
    window.history.pushState({}, '', targetUrl)
  } else {
    window.history.replaceState({}, '', targetUrl)
  }
}

// 模組頂層即時偵測：若 URL 帶有 1Campus SSO 參數，加上旗標阻擋
// fetchAuth 變更 auth state，避免在跳轉前閃過 LandingPage
const _initParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
const _initCode = _initParams?.get('code')?.trim() || ''
const _initDsns = _initParams?.get('dsns')?.trim() || ''
const _isSsoEntry = !!(_initCode && _initDsns && /^[a-zA-Z0-9.\-]+$/.test(_initDsns) && !_initDsns.includes('..'))

function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [loginEntry, setLoginEntry] = useState<LoginEntryMode | null>(null)
  const [currentPage, setCurrentPage] = useState<Page>('home')
  const [gradingPagePhase, setGradingPagePhase] = useState<string>('idle')
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string>('')
  const [batchAssignmentIds, setBatchAssignmentIds] = useState<string[]>([])
  const [gradingSelectedClassroomId, setGradingSelectedClassroomId] = useState<string>('')
  const [gradingSelectedFolder, setGradingSelectedFolder] = useState<string>('')
  const [importSelectedClassroomId, setImportSelectedClassroomId] = useState<string>('')
  const [importSelectedFolder, setImportSelectedFolder] = useState<string>('')
  const [selectedUserId, setSelectedUserId] = useState<string>('')
  const [isAiDisclaimerOpen, setIsAiDisclaimerOpen] = useState(false)
  const [isIpDisclaimerOpen, setIsIpDisclaimerOpen] = useState(false)
  const [isTermsOpen, setIsTermsOpen] = useState(false)
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false)
  const [urlPageHandled, setUrlPageHandled] = useState(false)
  const [hasPaidOrder, setHasPaidOrder] = useState(false)
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
  const [homeOverviewLoading, setHomeOverviewLoading] = useState(true)
  const [homeOverviewSummary, setHomeOverviewSummary] = useState<HomeOverviewSummary>({
    totalAssignments: 0,
    assignmentsWithoutUploads: 0,
    uploadedSubmissions: 0,
    gradedSubmissions: 0,
    pendingGradingSubmissions: 0
  })
  const [homeOverviewItems, setHomeOverviewItems] = useState<HomeOverviewItem[]>([])
  const [visibleOverviewCount, setVisibleOverviewCount] = useState(
    OVERVIEW_VISIBLE_STEP
  )
  const [isCameraCaptureMode, setIsCameraCaptureMode] = useState(false)
  const [isInitialSyncing, setIsInitialSyncing] = useState(false)
  const [initialSyncError, setInitialSyncError] = useState<string | null>(null)
  const [initialSyncRetryNonce, setInitialSyncRetryNonce] = useState(0)
  const [pendingInk, setPendingInk] = useState<PendingInkSummary>({
    count: 0,
    totalDrops: 0,
    amountTwd: 0
  })
  const [ssoPendingSync, setSsoPendingSync] = useState<{
    dsns: string
  } | null>(null)
  const [ssoOAuthDenied, setSsoOAuthDenied] = useState(false)
  const userMenuRef = useRef<HTMLDivElement | null>(null)
  const ssoRedirectingRef = useRef(_isSsoEntry)
  const inkBalance =
    auth.status === 'authenticated' ? auth.user.inkBalance ?? 0 : null

  const fetchAuth = useCallback(async () => {
    // SSO 重導中（1Campus code+dsns or 等待跳轉），跳過驗證避免無意義 401
    if (ssoRedirectingRef.current) return
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'include',
        // 強制不使用快取，確保每次都取得最新資料
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      })
      if (!response.ok) {
        setAuth(prev => prev.status === 'unauthenticated' ? prev : { status: 'unauthenticated' })
        return
      }

      const data = await response.json()
      if (!data?.user?.id) {
        setAuth(prev => prev.status === 'unauthenticated' ? prev : { status: 'unauthenticated' })
        return
      }

      // 偵測使用者切換：若登入的是不同帳號，先清空本地資料庫避免資料混用
      const storedUserId = window.localStorage.getItem(CURRENT_USER_ID_KEY)
      if (storedUserId && storedUserId !== data.user.id) {
        console.log('🔄 偵測到使用者切換，清空本地資料庫…')
        try {
          await db.delete()
          await db.open()
          console.log('✅ 本地資料庫已清空')
        } catch (err) {
          console.error('❌ 清空本地資料庫失敗', err)
        }
      }
      window.localStorage.setItem(CURRENT_USER_ID_KEY, data.user.id)

      // 除錯：顯示資料來源
      if (data._debug) {
        console.log('📊 Auth 資料來源:', {
          profileLoaded: data._debug.profileLoaded,
          dataSource: data._debug.dataSource,
          timestamp: data._debug.timestamp ? new Date(data._debug.timestamp).toLocaleTimeString() : 'unknown'
        })
      }

      setAuth((prev) => {
        const existingBalance = prev.status === 'authenticated' ? prev.user.inkBalance ?? 0 : 0
        const resolvedBalance = typeof data.user.inkBalance === 'number' ? data.user.inkBalance : existingBalance
        return {
          status: 'authenticated',
          user: {
            ...data.user,
            role: (data.user.role || 'user').toLowerCase(),
            permissionTier: (data.user.permissionTier || 'basic').toLowerCase(),
            inkBalance: resolvedBalance
          }
        }
      })
    } catch (error) {
      console.error('驗證登入狀態失敗', error)
      setAuth(prev => prev.status === 'unauthenticated' ? prev : { status: 'unauthenticated', error: '無法連線到伺服器' })
    }
  }, [])

  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const handleLogout = useCallback(async () => {
    setIsLoggingOut(true)
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      })
    } catch (error) {
      console.error('登出失敗', error)
    }
    try {
      await db.delete()
      console.log('✅ 登出：本地資料庫已清空')
    } catch (err) {
      console.error('❌ 登出時清空本地資料庫失敗', err)
    }
    // 清空所有 Service Worker 快取，釋放儲存配額（避免 QuotaExceededError）
    if ('caches' in window) {
      try {
        const cacheNames = await caches.keys()
        await Promise.all(cacheNames.map((name) => caches.delete(name)))
        console.log('✅ 登出：Service Worker 快取已清空')
      } catch (err) {
        console.error('❌ 清空 SW 快取失敗', err)
      }
    }
    window.localStorage.removeItem(LOGIN_ENTRY_STORAGE_KEY)
    window.localStorage.removeItem(CURRENT_USER_ID_KEY)
    window.localStorage.removeItem(INITIAL_SYNCED_KEY)
    // 清除 1Campus 自動同步的 session flag，讓重新登入時能再次觸發
    try {
      const keys = Object.keys(window.sessionStorage)
      keys.forEach((k) => {
        if (k.startsWith('campus1_auto_sync_')) window.sessionStorage.removeItem(k)
      })
    } catch { /* ignore */ }
    // reload 確保 Dexie singleton 重新初始化，避免 DB 連線狀態殘留
    window.location.href = '/'
  }, [])

  const retryInitialSync = useCallback(() => {
    setInitialSyncError(null)
    setInitialSyncRetryNonce((prev) => prev + 1)
    requestSync(true)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const params = new URLSearchParams(window.location.search)
    const entryFromQuery = normalizeLoginEntry(params.get('entry'))
    const entryFromStorage = normalizeLoginEntry(
      window.localStorage.getItem(LOGIN_ENTRY_STORAGE_KEY)
    )
    const nextEntry = entryFromQuery ?? entryFromStorage ?? null

    setLoginEntry(nextEntry)
    if (nextEntry) {
      window.localStorage.setItem(LOGIN_ENTRY_STORAGE_KEY, nextEntry)
    } else {
      window.localStorage.removeItem(LOGIN_ENTRY_STORAGE_KEY)
    }

    if (entryFromQuery) {
      params.delete('entry')
      const query = params.toString()
      const url = query
        ? `${window.location.pathname}?${query}`
        : window.location.pathname
      window.history.replaceState({}, '', url)
    }
  }, [])

  // SSO 入口偵測：1Campus 帶 ?code=XXX&dsns=YYY 進入，或處理後端 SSO 回傳參數
  useEffect(() => {
    if (typeof window === 'undefined') return

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')?.trim() || ''
    const dsns = params.get('dsns')?.trim() || ''

    // 1Campus 入口：有 code + dsns，且 dsns 格式合法 → 導向後端 SSO handler
    if (code && dsns && /^[a-zA-Z0-9.\-]+$/.test(dsns) && !dsns.includes('..')) {
      ssoRedirectingRef.current = true
      const redirectUrl = buildApiUrl(
        `/api/auth/1campus?code=${encodeURIComponent(code)}&dsns=${encodeURIComponent(dsns)}`
      )
      window.location.replace(redirectUrl)
      return
    }

    // 後端 SSO 完成後回傳的參數
    const ssoError = params.get('sso_error')?.trim() || ''
    const ssoWarning = params.get('sso_warning')?.trim() || ''
    const ssoProvider = params.get('sso_provider')?.trim() || ''
    const ssoSync = params.get('sso_sync') === '1'
    const ssoDsns = params.get('sso_dsns')?.trim() || ''

    const hasSsoParams = !!(ssoError || ssoWarning || ssoProvider || ssoSync)
    if (!hasSsoParams) return

    // OAuth 授權被拒絕（Phase 1 已登入，不影響 auth 狀態，只顯示提醒）
    if (ssoWarning === 'oauth_denied') {
      setSsoOAuthDenied(true)
    }

    if (ssoError) {
      const errorMessages: Record<string, string> = {
        invalid_params: '登入參數無效，請重新從 1Campus 進入',
        identity_failed: '無法驗證您的 1Campus 身份，請重新嘗試',
        unsupported_role: '目前僅支援教師或學生帳號登入',
        session_failed: '登入失敗，請重新嘗試',
        create_user_failed: '建立帳號失敗，請聯絡管理員',
        oauth_error: 'OAuth 授權失敗，請重新嘗試',
        system_busy: '系統暫時忙碌中，請稍後再試'
      }
      setAuth({
        status: 'unauthenticated',
        error: errorMessages[ssoError] || '登入失敗，請重新嘗試'
      })
    }

    if (ssoSync && ssoDsns) {
      setSsoPendingSync({ dsns: ssoDsns })
    }

    // 清除 URL 中的 SSO 參數
    params.delete('sso_error')
    params.delete('sso_warning')
    params.delete('sso_provider')
    params.delete('sso_sync')
    params.delete('sso_dsns')
    params.delete('sso_teacher_id')
    const query = params.toString()
    const cleanUrl = query
      ? `${window.location.pathname}?${query}`
      : window.location.pathname
    window.history.replaceState({}, '', cleanUrl)
  }, [])

  // 登入後觸發 1Campus 班級同步（背景執行，失敗不影響 UI）
  // 來源 1：SSO 登入後帶 sso_sync=1 → ssoPendingSync
  // 來源 2：Google 登入但已有 campus1Binding → 自動觸發
  useEffect(() => {
    if (auth.status !== 'authenticated') return

    // 優先處理 SSO 顯式同步請求
    if (ssoPendingSync) {
      const { dsns } = ssoPendingSync
      setSsoPendingSync(null)
      window.sessionStorage.setItem(`campus1_auto_sync_${auth.user.id}`, '1')

      console.log('[SSO] 觸發班級同步 dsns=', dsns)
      void fetch('/api/data/1campus-classroom-sync', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dsns })
      }).then((res) => {
        console.log('[SSO] 班級同步 HTTP', res.status)
        return res.json().then((data) => {
          console.log('[SSO] 班級同步結果:', data)
          requestSync(true)
        }).catch(() => requestSync(true))
      }).catch((err) => {
        console.warn('[SSO] 班級同步失敗（不影響登入）:', err)
      })
      return
    }

    // Google 登入但已有 1Campus 綁定 → 自動同步（僅老師帳號）
    const binding = auth.user.campus1Binding
    if (binding?.dsns && binding.roleType === 'teacher') {
      // 避免重複同步：同一 session 只觸發一次
      const syncKey = `campus1_auto_sync_${auth.user.id}`
      if (window.sessionStorage.getItem(syncKey)) return
      window.sessionStorage.setItem(syncKey, '1')

      console.log('[AUTO-SYNC] Google 登入偵測到 1Campus 綁定，自動同步 dsns=', binding.dsns)
      void fetch('/api/data/1campus-classroom-sync', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dsns: binding.dsns })
      }).then((res) => {
        console.log('[AUTO-SYNC] 班級同步 HTTP', res.status)
        return res.json().then((data) => {
          console.log('[AUTO-SYNC] 班級同步結果:', data)
          requestSync(true)
        }).catch(() => requestSync(true))
      }).catch((err) => {
        console.warn('[AUTO-SYNC] 班級同步失敗（不影響使用）:', err)
      })
    }
  }, [auth.status, ssoPendingSync])

  useEffect(() => {
    void fetchAuth()
  }, [fetchAuth])

  // focus 節流：tab 回到前景時重新驗證，但至少間隔 5 分鐘才重打 API
  const lastFetchAuthRef = useRef(0)
  useEffect(() => {
    const FOCUS_THROTTLE_MS = 5 * 60 * 1000 // 5 分鐘
    const handleFocus = () => {
      const now = Date.now()
      if (now - lastFetchAuthRef.current < FOCUS_THROTTLE_MS) return
      lastFetchAuthRef.current = now
      void fetchAuth()
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [fetchAuth])

  const initialSyncAuthRole =
    auth.status === 'authenticated' ? (auth.user.role || '').toLowerCase() : ''
  const initialSyncStudentId =
    auth.status === 'authenticated' ? auth.user.student?.id || '' : ''

  // 初次同步 loading：登入後若無同步紀錄，顯示 loading 直到第一次同步完成
  useEffect(() => {
    if (auth.status !== 'authenticated') {
      setIsInitialSyncing(false)
      setInitialSyncError(null)
      return
    }
    const isStudentEntry = loginEntry === 'student'
    const hasStudentRole = initialSyncAuthRole === 'student'
    const hasStudentLink = Boolean(initialSyncStudentId)

    // 學生流程不依賴本地同步，避免等待 SYNC_COMPLETE 造成卡住
    if (isStudentEntry || hasStudentRole || hasStudentLink) {
      setIsInitialSyncing(false)
      setInitialSyncError(null)
      window.localStorage.setItem(INITIAL_SYNCED_KEY, '1')
      return
    }

    if (window.localStorage.getItem(INITIAL_SYNCED_KEY)) {
      setIsInitialSyncing(false)
      setInitialSyncError(null)
      // 每次重新登入都觸發一次非阻擋式同步，確保跨裝置資料是最新的
      //（不顯示 loading spinner，但背景拉取最新雲端資料）
      requestSync()
      return
    }

    setIsInitialSyncing(true)
    setInitialSyncError(null)
    let isActive = true

    const settleSuccess = () => {
      if (!isActive) return
      setIsInitialSyncing(false)
      setInitialSyncError(null)
      window.localStorage.setItem(INITIAL_SYNCED_KEY, '1')
    }

    const handler = (event: Event) => {
      if (!isActive) return
      const detail = (event as CustomEvent<SyncCompleteDetail>).detail
      if (detail?.success) {
        settleSuccess()
        return
      }

      if (detail?.blocked) {
        setInitialSyncError('首次同步被阻擋（401/403），請按「重新抓取資料」。若仍失敗請重新登入。')
        return
      }

      if (detail?.error) {
        setInitialSyncError(`首次同步失敗：${detail.error}`)
        return
      }

      if (detail?.skipped) {
        setInitialSyncError('目前離線或同步被略過，請連線後按「重新抓取資料」。')
      }
    }

    const timeoutId = window.setTimeout(() => {
      if (!isActive) return
      setInitialSyncError((prev) =>
        prev || '首次同步超時，請按「重新抓取資料」。'
      )
    }, INITIAL_SYNC_TIMEOUT_MS)

    window.addEventListener(SYNC_COMPLETE_EVENT_NAME, handler)
    requestSync(true)

    return () => {
      isActive = false
      window.clearTimeout(timeoutId)
      window.removeEventListener(SYNC_COMPLETE_EVENT_NAME, handler)
    }
  }, [
    auth.status,
    loginEntry,
    initialSyncAuthRole,
    initialSyncStudentId,
    initialSyncRetryNonce
  ])

  // 應用啟動時檢測 WebP 支持（用於平板Chrome兼容性）
  useEffect(() => {
    checkWebPSupport().then((supported) => {
      debugLog('📱 設備信息:')
      debugLog(`  User Agent: ${navigator.userAgent}`)
      debugLog(`  🎨 WebP 編碼支持: ${supported ? '是 ✅' : '否 ❌ (將使用 JPEG fallback)'}`)
      debugLog(`  螢幕尺寸: ${window.innerWidth}x${window.innerHeight}`)
      debugLog(
        `  設備類型: ${window.innerWidth < 768 ? '手機/平板' : '桌面'}`
      )
    })
  }, [])

  useEffect(() => {
    const handleInkBalance = (event: Event) => {
      const detail = (event as CustomEvent<InkBalanceDetail>).detail
      console.log('[App] 收到墨水餘額事件:', detail)
      if (!detail || !Number.isFinite(detail.inkBalance)) return
      setAuth((prev) => {
        if (prev.status !== 'authenticated') return prev
        console.log('[App] 更新墨水餘額:', prev.user.inkBalance, '->', detail.inkBalance)
        return {
          ...prev,
          user: {
            ...prev.user,
            inkBalance: detail.inkBalance
          }
        }
      })
    }

    window.addEventListener(INK_BALANCE_EVENT, handleInkBalance)
    return () => window.removeEventListener(INK_BALANCE_EVENT, handleInkBalance)
  }, [])

  useEffect(() => {
    if (auth.status !== 'authenticated') {
      setHasPaidOrder(false)
      setPendingInk({ count: 0, totalDrops: 0, amountTwd: 0 })
      return
    }

    let isActive = true
    const checkPaidOrders = async () => {
      try {
        const response = await fetch('/api/ink/orders', { credentials: 'include' })
        if (!response.ok) return
        const data = await response.json()
        const orders: InkOrderSummary[] = Array.isArray(data?.orders)
          ? data.orders
          : []
        const paid = orders.some(
          (order) => String(order?.status || '').toLowerCase() === 'paid'
        )
        const pendingFromApi = data?.pending
        const pendingFallback = orders.filter(
          (order) => String(order?.status || '').toLowerCase() === 'pending'
        )
        const pendingCount =
          typeof pendingFromApi?.count === 'number'
            ? pendingFromApi.count
            : pendingFallback.length
        const pendingTotalDrops =
          typeof pendingFromApi?.totalDrops === 'number'
            ? pendingFromApi.totalDrops
            : pendingFallback.reduce((sum, order) => {
                const drops = Number(order?.drops) || 0
                const bonus =
                  typeof order?.bonus_drops === 'number' ? order.bonus_drops : 0
                return sum + drops + bonus
              }, 0)
        const pendingAmountTwd =
          typeof pendingFromApi?.amountTwd === 'number'
            ? pendingFromApi.amountTwd
            : pendingFallback.reduce(
                (sum, order) => sum + (Number(order?.amount_twd) || 0),
                0
              )
        if (isActive) {
          setHasPaidOrder(paid)
          setPendingInk({
            count: pendingCount,
            totalDrops: pendingTotalDrops,
            amountTwd: pendingAmountTwd
          })
        }
      } catch {
        // ignore
      }
    }

    void checkPaidOrders()
    return () => {
      isActive = false
    }
  }, [auth.status, inkBalance])

  useEffect(() => {
    const handleLegalModal = (event: Event) => {
      const detail = (event as CustomEvent<LegalModalDetail>).detail
      if (!detail?.kind) return
      if (detail.kind === 'terms') {
        setIsTermsOpen(true)
      } else if (detail.kind === 'privacy') {
        setIsPrivacyOpen(true)
      }
    }

    window.addEventListener(LEGAL_MODAL_EVENT, handleLegalModal)
    return () => window.removeEventListener(LEGAL_MODAL_EVENT, handleLegalModal)
  }, [])

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (!userMenuRef.current) return
      if (!userMenuRef.current.contains(event.target as Node)) {
        setIsUserMenuOpen(false)
      }
    }

    window.addEventListener('mousedown', handleOutsideClick)
    return () => window.removeEventListener('mousedown', handleOutsideClick)
  }, [])

  useEffect(() => {
    if (currentPage !== 'home') {
      setIsUserMenuOpen(false)
    }
  }, [currentPage])

  const refundFeePercent = Math.round(REFUND_FEE_RATE * 1000) / 10
  const legalModals = (
    <>
      {isTermsOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="terms-dialog-title">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 id="terms-dialog-title" className="text-base font-semibold text-gray-900">服務條款</h2>
                <p className="text-xs text-gray-500 mt-1">版本：{TERMS_VERSION}</p>
              </div>
              <button
                type="button"
                onClick={() => setIsTermsOpen(false)}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
                aria-label="關閉"
              >
                X
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-gray-700 space-y-3 overflow-y-auto max-h-[75vh] leading-relaxed">
              <p>
                <span className="font-semibold">一、服務內容</span>
                <br />
                本平台提供 AI 作業批改與相關教學管理功能，並採點數制扣抵服務費用。
              </p>
              <p>
                <span className="font-semibold">二、數位內容與七日鑑賞期</span>
                <br />
                本服務屬於數位內容／線上服務，使用者於付款前勾選同意後始提供服務，
                依法排除七日鑑賞期。
              </p>
              <p>
                <span className="font-semibold">三、點數與退款政策</span>
                <br />
                已使用點數不予退費；未使用點數得申請退費，並將扣除
                {refundFeePercent}% 手續費。
                <br />
                贈送點數不具退款價值且不可折現，退款計算以「購買點數」為準，
                系統視為先扣購買點數，再扣贈送點數。
              </p>
              <p>
                <span className="font-semibold">四、付款與訂單</span>
                <br />
                本平台目前僅提供綠界付款。交易完成後，系統將依訂單內容自動加點。
              </p>
              <p>
                <span className="font-semibold">五、使用規範</span>
                <br />
                使用者應遵守法律法規，不得上傳或處理違法、侵權或不當內容。
              </p>
              <p>
                <span className="font-semibold">六、服務限制與免責</span>
                <br />
                AI 批改結果僅供參考，使用者應自行判斷並承擔使用後果。
              </p>
              <p>
                <span className="font-semibold">七、聯絡方式</span>
                <br />
                如需協助，請「聯絡我們」信箱： jhanfong150983@gmail.com；電話：09-8171-6650
              </p>
            </div>
          </div>
        </div>
      )}

      {isPrivacyOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="privacy-dialog-title">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 id="privacy-dialog-title" className="text-base font-semibold text-gray-900">隱私權政策</h2>
                <p className="text-xs text-gray-500 mt-1">版本：{PRIVACY_VERSION}</p>
              </div>
              <button
                type="button"
                onClick={() => setIsPrivacyOpen(false)}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
                aria-label="關閉"
              >
                X
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-gray-700 space-y-3 overflow-y-auto max-h-[75vh] leading-relaxed">
              <p>
                <span className="font-semibold">一、蒐集資訊</span>
                <br />
                我們可能蒐集使用者帳號資訊（Email、姓名）、作業內容（文字或影像）、
                批改結果、操作紀錄與必要的技術資訊（如瀏覽器與裝置資訊）。
                <br />
                付款資訊由第三方金流（綠界）處理，本平台不儲存信用卡資料。
              </p>
              <p>
                <span className="font-semibold">二、使用目的</span>
                <br />
                蒐集之資料僅用於提供 AI 批改服務、帳務處理、客服支援、系統安全與合法合規。
              </p>
              <p>
                <span className="font-semibold">三、第三方服務</span>
                <br />
                作業內容會傳送至 Google Gemini API 進行運算，我們不會另行將資料
                用於其他商業用途。是否用於模型訓練以 Google API 條款為準。
              </p>
              <p>
                <span className="font-semibold">四、保存期限</span>
                <br />
                我們僅在提供服務與法令要求之期間內保存資料，逾期將進行刪除或匿名化處理。
              </p>
              <p>
                <span className="font-semibold">五、您的權利</span>
                <br />
                您可要求查詢、補充、更正或刪除個人資料；如需協助請透過下列聯絡方式與我們聯繫。
              </p>
              <p>
                <span className="font-semibold">六、資料安全</span>
                <br />
                我們採取合理的技術與管理措施保護資料安全，但無法保證絕對不受任何風險影響。
              </p>
              <p>
                <span className="font-semibold">七、聯絡方式</span>
                <br />
                如有隱私相關問題，請「聯絡我們」信箱： jhanfong150983@gmail.com；電話：09-8171-6650
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )

  const isAdmin =
    auth.status === 'authenticated' && auth.user.role === 'admin'
  const hasStudentContext =
    auth.status === 'authenticated' && Boolean(auth.user.student?.id)
  const viewMode =
    auth.status !== 'authenticated'
      ? 'guest'
      : loginEntry === 'student'
        ? hasStudentContext
          ? 'student'
          : 'student-unlinked'
        : loginEntry === 'teacher'
          ? 'teacher'
          : auth.user.role === 'student'
            ? 'student'
            : 'teacher'
  const isStudent = viewMode === 'student'

  useEffect(() => {
    if (!isStudent && currentPage !== 'assignment-scan' && currentPage !== 'unified-import' && isCameraCaptureMode) {
      setIsCameraCaptureMode(false)
    }
  }, [currentPage, isCameraCaptureMode, isStudent])

  const isProTier =
    auth.status === 'authenticated' &&
    (auth.user.permissionTier === 'advanced' || hasPaidOrder)
  const canAccessTracking =
    auth.status === 'authenticated' &&
    (isProTier || isAdmin)
  const ensureInkNonNegative = useCallback(() => {
    if (auth.status !== 'authenticated') return false
    const balance = typeof auth.user.inkBalance === 'number' ? auth.user.inkBalance : 0
    if (balance < 0) {
      const shouldTopUp = window.confirm(
        '目前墨水為負值，請先補充墨水後再使用 AI 批改。是否前往補充墨水？'
      )
      if (shouldTopUp) {
        setCurrentPage('ink-topup')
      }
      return false
    }
    return true
  }, [auth, setCurrentPage])

  const loadHomeOverview = useCallback(async () => {
    setHomeOverviewLoading(true)
    try {
      const [assignments, classrooms, students, submissions] = await Promise.all([
        db.assignments.toArray(),
        db.classrooms.toArray(),
        db.students.toArray(),
        db.submissions.toArray()
      ])

      const classroomMap = new Map<string, Classroom>(
        classrooms.map((classroom) => [classroom.id, classroom])
      )
      const studentCountByClassroom = new Map<string, number>()
      const studentSeatById = new Map<string, number>()
      const studentsByClassroom = new Map<string, Student[]>()
      students.forEach((student) => {
        const current = studentCountByClassroom.get(student.classroomId) ?? 0
        studentCountByClassroom.set(student.classroomId, current + 1)
        if (student.seatNumber) studentSeatById.set(student.id, student.seatNumber)
        const list = studentsByClassroom.get(student.classroomId) ?? []
        list.push(student)
        studentsByClassroom.set(student.classroomId, list)
      })

      const submissionsByAssignment = new Map<string, Submission[]>()
      submissions.forEach((submission) => {
        const list = submissionsByAssignment.get(submission.assignmentId) ?? []
        list.push(submission)
        submissionsByAssignment.set(submission.assignmentId, list)
      })

      // Fetch server-side assignment_student_state for accurate correction status
      // (local submissions.correctionCount is stale and never reflects correction_passed)
      const ACTIVE_CORRECTION_STATUSES = new Set([
        'correction_required', 'correction_in_progress',
        'correction_pending_review', 'correction_failed'
      ])
      let serverStatesByAssignment = new Map<string, Map<string, string>>()
      try {
        const assignmentIds = assignments.map((a) => a.id).join(',')
        const stateRes = await fetch(
          `/api/data/assignment-state-summary?assignmentIds=${encodeURIComponent(assignmentIds)}`,
          { credentials: 'include', cache: 'no-store' }
        )
        if (stateRes.ok) {
          const stateData = (await stateRes.json()) as {
            byAssignment: Record<string, { studentId: string; status: string }[]>
          }
          for (const [aId, rows] of Object.entries(stateData.byAssignment)) {
            const map = new Map<string, string>()
            for (const row of rows) map.set(row.studentId, row.status)
            serverStatesByAssignment.set(aId, map)
          }
        }
      } catch {
        // Non-fatal: fall back to local-only logic
      }

      const overviewItems = assignments
        .map<HomeOverviewItem>((assignment) => {
          const relatedSubmissions = submissionsByAssignment.get(assignment.id) ?? []
          // 匯入/已批改/待批改只計算原始作頁，不含訂正作頁
          const originalSubmissions = relatedSubmissions.filter(
            (submission) => submission.source !== 'student_correction'
          )
          const uploadedCount = originalSubmissions.filter(
            (submission) => submission.status !== 'missing'
          ).length
          const gradedCount = originalSubmissions.filter(
            (submission) => submission.status === 'graded'
          ).length
          const pendingGradingCount = originalSubmissions.filter(
            (submission) =>
              submission.status === 'scanned' || submission.status === 'synced'
          ).length
          const totalStudents =
            studentCountByClassroom.get(assignment.classroomId) ?? 0
          const denominator = Math.max(uploadedCount, totalStudents)
          const progressPercent =
            denominator > 0
              ? Math.round((gradedCount / denominator) * 100)
              : 0
          const classroomStudents = studentsByClassroom.get(assignment.classroomId) ?? []
          // Sort ascending by updatedAt so the latest submission wins in the Map
          const sortedSubmissions = [...relatedSubmissions].sort(
            (a, b) => (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt)
          )
          const submissionByStudentId = new Map(
            sortedSubmissions.map((s) => [s.studentId, s])
          )
          const serverStates = serverStatesByAssignment.get(assignment.id)

          const completedSeatNumbers: number[] = []
          const incompleteSeatNumbers: number[] = []
          const ungradedSeatNumbers: number[] = []
          const notSubmittedSeatNumbers: number[] = []
          for (const student of classroomStudents) {
            const seat = student.seatNumber
            if (!seat) continue
            const serverStatus = serverStates?.get(student.id)
            // correction_passed → fully done regardless of local submission data
            if (serverStatus === 'correction_passed') {
              completedSeatNumbers.push(seat)
              continue
            }
            // Active correction states → student is still in correction workflow
            if (serverStatus && ACTIVE_CORRECTION_STATUSES.has(serverStatus)) {
              incompleteSeatNumbers.push(seat)
              continue
            }
            // Fall back to local submission for non-correction states
            const sub = submissionByStudentId.get(student.id)
            if (!sub || sub.status === 'missing') {
              notSubmittedSeatNumbers.push(seat)
            } else if (sub.status === 'scanned' || sub.status === 'synced') {
              ungradedSeatNumbers.push(seat)
            } else if (sub.status === 'graded') {
              const mistakesCount = sub.gradingResult?.mistakes?.length ?? sub.mistakesCount ?? 0
              // 訂正批改若 score=0 且 mistakes=[] 代表照片無效（空白/拍錯），仍視為未完成
              const isFailedCorrection =
                sub.source === 'student_correction' && mistakesCount === 0 && (sub.score ?? 0) === 0
              const hasMistakes = mistakesCount > 0 || isFailedCorrection
              if (hasMistakes) incompleteSeatNumbers.push(seat)
              else completedSeatNumbers.push(seat)
            }
          }
          completedSeatNumbers.sort((a, b) => a - b)
          incompleteSeatNumbers.sort((a, b) => a - b)
          ungradedSeatNumbers.sort((a, b) => a - b)
          notSubmittedSeatNumbers.sort((a, b) => a - b)

          // correctionCount and pendingCorrectionSeatNumbers from server state
          const correctionStudents = serverStates
            ? classroomStudents.filter((s) => {
                const st = serverStates.get(s.id)
                return st !== undefined && ACTIVE_CORRECTION_STATUSES.has(st)
              })
            : []
          const correctionCount = correctionStudents.length
          const pendingCorrectionSeatNumbers = correctionStudents
            .map((s) => studentSeatById.get(s.id) ?? 0)
            .filter((seat) => seat > 0)
            .sort((a, b) => a - b)

          const hasAnswerKey = Boolean(assignment.answerKey)
          let workflowStatus: AssignmentWorkflowStatus = 'completed'
          let workflowPriority = 9
          if (!hasAnswerKey) {
            workflowStatus = 'missing-answer-key'
            workflowPriority = 1
          } else if (uploadedCount === 0) {
            workflowStatus = 'missing-submission'
            workflowPriority = 2
          } else if (pendingGradingCount > 0) {
            workflowStatus = 'pending-grading'
            workflowPriority = 3
          } else if (correctionCount === 0 && incompleteSeatNumbers.length > 0) {
            workflowStatus = 'pending-dispatch'
            workflowPriority = 4
          } else if (correctionCount > 0) {
            workflowStatus = 'correction-followup'
            workflowPriority = 5
          }

          return {
            id: assignment.id,
            title: assignment.title || '未命名作業',
            classroomId: assignment.classroomId,
            classroomName:
              classroomMap.get(assignment.classroomId)?.name ?? '未知班級',
            totalStudents,
            uploadedCount,
            gradedCount,
            pendingGradingCount,
            correctionCount,
            pendingCorrectionSeatNumbers,
            hasAnswerKey,
            workflowStatus,
            workflowPriority,
            progressPercent,
            completedSeatNumbers,
            incompleteSeatNumbers,
            ungradedSeatNumbers,
            notSubmittedSeatNumbers
          }
        })
        .sort((a, b) => a.workflowPriority - b.workflowPriority)

      const uploadedSubmissions = overviewItems.reduce(
        (sum, item) => sum + item.uploadedCount,
        0
      )
      const gradedSubmissions = overviewItems.reduce(
        (sum, item) => sum + item.gradedCount,
        0
      )
      const pendingGradingSubmissions = overviewItems.reduce(
        (sum, item) => sum + item.pendingGradingCount,
        0
      )
      const assignmentsWithoutUploads = overviewItems.filter(
        (item) => item.uploadedCount === 0
      ).length

      const summary: HomeOverviewSummary = {
        totalAssignments: overviewItems.length,
        assignmentsWithoutUploads,
        uploadedSubmissions,
        gradedSubmissions,
        pendingGradingSubmissions
      }

      setHomeOverviewSummary(summary)
      setHomeOverviewItems(overviewItems)
    } catch (error) {
      console.error('載入作業總覽失敗', error)
    } finally {
      setHomeOverviewLoading(false)
    }
  }, [])

  // Stage 2 路由：登入完成後從 URL 還原 currentPage（含舊書籤別名 + 權限閘）
  // Stage 3 起：parseCurrentPageFromLocation 同時支援 path-based URL（/ink-topup 等）
  // Stage 6 起：支援 /grading/:id、/import/:id、/correction/:id 帶 ID 的路徑
  useEffect(() => {
    if (urlPageHandled) return
    if (auth.status !== 'authenticated') return

    const parsed = parseCurrentPageFromLocation()
    const parsedPage = parsed.page

    let nextPage: Page = 'home'
    let nextAssignmentId: string | undefined
    if (parsedPage && parsedPage !== 'home') {
      const needsTracking: Page[] = ['gradebook', 'correction', 'correction-select', 'ai-report']
      const needsAdmin: Page[] = ['admin-panel', 'admin-user-detail']
      if (needsTracking.includes(parsedPage) && !canAccessTracking) {
        nextPage = 'home'
      } else if (needsAdmin.includes(parsedPage) && !isAdmin) {
        nextPage = 'home'
      } else if (PAGE_FALLBACK_WITHOUT_ID[parsedPage] && !parsed.assignmentId) {
        // /grading 沒 ID 等 → 退回 list 頁
        nextPage = PAGE_FALLBACK_WITHOUT_ID[parsedPage]!
      } else {
        nextPage = parsedPage
        nextAssignmentId = parsed.assignmentId
      }
    }

    if (nextPage !== 'home') {
      setCurrentPage(nextPage)
    }
    if (nextAssignmentId) {
      setSelectedAssignmentId(nextAssignmentId)
    }
    // 規範化 URL（別名 → 規範值；不合法/無權限 → 清空），用 replaceState 避免污染歷史
    writeCurrentPageToUrl(nextPage, nextAssignmentId, 'replace')

    setUrlPageHandled(true)
  }, [auth.status, canAccessTracking, isAdmin, urlPageHandled])

  // currentPage 變動時，將狀態 push 到 URL（讓返回鍵能用）
  // Stage 6 起：grading / unified-import / correction 多帶 selectedAssignmentId
  useEffect(() => {
    if (!urlPageHandled) return
    if (auth.status !== 'authenticated') return
    const id = (currentPage === 'grading' || currentPage === 'unified-import' || currentPage === 'correction')
      ? selectedAssignmentId || undefined
      : undefined
    writeCurrentPageToUrl(currentPage, id, 'push')
  }, [currentPage, selectedAssignmentId, urlPageHandled, auth.status])

  // popstate 監聽（瀏覽器返回/前進鍵）+ 守 Phase A awaiting_review
  useEffect(() => {
    if (!urlPageHandled) return
    if (auth.status !== 'authenticated') return

    const handlePopstate = () => {
      const parsed = parseCurrentPageFromLocation()
      let target: Page = parsed.page ?? 'home'
      let targetAssignmentId = parsed.assignmentId
      // 帶 ID 但沒有 ID（極少發生）→ 退回 list 頁
      if (PAGE_FALLBACK_WITHOUT_ID[target] && !targetAssignmentId) {
        target = PAGE_FALLBACK_WITHOUT_ID[target]!
        targetAssignmentId = undefined
      }
      if (target === currentPage && (targetAssignmentId ?? '') === (selectedAssignmentId || '')) return

      // 權限閘：URL 偽造試圖跳到無權限頁，把 URL 還原回 currentPage
      const needsTracking: Page[] = ['gradebook', 'correction', 'correction-select', 'ai-report']
      const needsAdmin: Page[] = ['admin-panel', 'admin-user-detail']
      if ((needsTracking.includes(target) && !canAccessTracking)
        || (needsAdmin.includes(target) && !isAdmin)) {
        const currentId = (currentPage === 'grading' || currentPage === 'unified-import' || currentPage === 'correction')
          ? selectedAssignmentId || undefined
          : undefined
        writeCurrentPageToUrl(currentPage, currentId, 'push')
        return
      }

      // 守門：Phase A 一致性審查未提交，離開要確認
      if ((currentPage === 'grading' || currentPage === 'batch-grading')
        && gradingPagePhase === 'awaiting_review') {
        const confirmed = window.confirm(
          '一致性審查尚未提交批改。\n\nPhase A 已完成並產生費用，離開後本次費用仍會結算。\n\n確定要離開批改頁面嗎？'
        )
        if (!confirmed) {
          // 使用者取消離開，把 URL 推回 currentPage
          const currentId = currentPage === 'grading' ? selectedAssignmentId || undefined : undefined
          writeCurrentPageToUrl(currentPage, currentId, 'push')
          return
        }
      }

      if (targetAssignmentId) {
        setSelectedAssignmentId(targetAssignmentId)
      }
      setCurrentPage(target)
    }

    window.addEventListener('popstate', handlePopstate)
    return () => window.removeEventListener('popstate', handlePopstate)
  }, [urlPageHandled, auth.status, currentPage, selectedAssignmentId, canAccessTracking, isAdmin, gradingPagePhase])

  // Stage 6：beforeunload 守門 — Phase A awaiting_review 時，按 F5 / 關分頁 / 改網址都會跳瀏覽器原生離開警告
  useEffect(() => {
    if ((currentPage !== 'grading' && currentPage !== 'batch-grading') || gradingPagePhase !== 'awaiting_review') return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // 部分瀏覽器需要設 returnValue 才會跳警告
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [currentPage, gradingPagePhase])

  useEffect(() => {
    if (auth.status !== 'authenticated') return
    if (currentPage !== 'home') return
    void loadHomeOverview()
  }, [auth.status, currentPage, loadHomeOverview])

  // 每次同步完成後，如果在首頁就重新載入概覽數據
  useEffect(() => {
    if (auth.status !== 'authenticated') return
    if (currentPage !== 'home') return

    const handleSyncComplete = () => {
      void loadHomeOverview()
    }
    window.addEventListener(SYNC_COMPLETE_EVENT_NAME, handleSyncComplete)
    return () => window.removeEventListener(SYNC_COMPLETE_EVENT_NAME, handleSyncComplete)
  }, [auth.status, currentPage, loadHomeOverview])

  useEffect(() => {
    if (currentPage !== 'home') return
    setVisibleOverviewCount(OVERVIEW_VISIBLE_STEP)
  }, [currentPage])

  useEffect(() => {
    if (auth.status !== 'authenticated') return
    if (!isUserMenuOpen) return
    void loadHomeOverview()
  }, [auth.status, isUserMenuOpen, loadHomeOverview])

  if (auth.status === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-gray-600 text-sm">驗證登入狀態…</p>
        </div>
      </div>
    )
  }

  if (auth.status === 'unauthenticated') {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      }>
        <LandingPage />
      </Suspense>
    )
  }

  if (isInitialSyncing) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center px-4">
          <div className="mb-4">
            <SyncIndicator key={`initial-sync-${initialSyncRetryNonce}`} autoSync={true} />
          </div>
          {!initialSyncError ? (
            <>
              <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-gray-600 text-sm">正在載入資料…</p>
            </>
          ) : (
            <>
              <p className="text-red-600 text-sm font-medium mb-3">{initialSyncError}</p>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={retryInitialSync}
                  className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
                >
                  重新抓取資料
                </button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isLoggingOut}
                  onClick={handleLogout}
                >
                  {isLoggingOut ? '登出中…' : '重新登入'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  if (viewMode === 'student-unlinked') {
    const userEmail = auth.status === 'authenticated' ? (auth.user.email ?? '') : ''
    const isCampus1SsoStudent = userEmail.startsWith('campus1.') && userEmail.includes('@')
    const campus1Dsns = isCampus1SsoStudent ? userEmail.slice(userEmail.indexOf('@') + 1) : ''
    const campus1BackUrl = campus1Dsns ? `https://${campus1Dsns}` : ''
    const lookupStatus = auth.status === 'authenticated' ? auth.user.studentLookupStatus : undefined
    const isSystemError = lookupStatus === 'system_error'

    const handleUnlinkedBack = async () => {
      await handleLogout()
      if (campus1BackUrl) {
        window.location.href = campus1BackUrl
      }
    }

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4">
        <div className="mx-auto mt-16 w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900">
            {isSystemError ? '系統暫時忙碌' : '尚未有班級'}
          </h1>
          <p className="mt-3 text-sm text-slate-600">
            {isSystemError
              ? '系統正忙碌中，請稍後再試。'
              : isCampus1SsoStudent
                ? '你尚未被老師加入班級，請向老師確認後，再從 1Campus 重新登入。'
                : '你尚未被老師加入班級，請向老師確認。'}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            {isSystemError ? (
              <button
                type="button"
                onClick={() => void fetchAuth()}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
              >
                重試
              </button>
            ) : (
              <button
                type="button"
                onClick={handleUnlinkedBack}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
              >
                {isCampus1SsoStudent ? '返回 1Campus' : '返回登入'}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }


  // 管理者面板 (整合所有管理功能)
  if (currentPage === 'admin-panel') {
    if (!isAdmin) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 text-center space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
            <p className="text-sm text-gray-600">
              只有管理者可以進入此頁面。
            </p>
            <button
              type="button"
              onClick={() => setCurrentPage('home')}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              返回首頁
            </button>
          </div>
        </div>
      )
    }
    return (
      <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>}>
        <AdminPanel
          onBack={() => setCurrentPage('home')}
          onNavigateToDetail={(userId) => {
            setSelectedUserId(userId)
            setCurrentPage('admin-user-detail')
          }}
        />
      </Suspense>
    )
  }

  // 管理者 - 使用者詳細資訊
  if (currentPage === 'admin-user-detail') {
    if (!isAdmin) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 text-center space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
            <p className="text-sm text-gray-600">
              只有管理者可以進入此頁面。
            </p>
            <button
              type="button"
              onClick={() => setCurrentPage('home')}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              返回首頁
            </button>
          </div>
        </div>
      )
    }

    if (!selectedUserId) {
      setCurrentPage('admin-panel')
      return null
    }

    return (
      <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>}>
        <AdminUserDetail
          userId={selectedUserId}
          onBack={() => {
            setCurrentPage('admin-panel')
            setSelectedUserId('')
          }}
        />
      </Suspense>
    )
  }

  // 補充墨水
  if (currentPage === 'ink-topup') {
    return (
      <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>}>
        <InkTopUp
          onBack={() => setCurrentPage('home')}
          currentBalance={auth.user.inkBalance ?? 0}
        />
        {legalModals}
      </Suspense>
    )
  }

  const permissionLabel = isAdmin ? '管理者' : isProTier ? 'Pro' : 'Basic'
  const userDisplayName = isStudent
    ? auth.user.student?.name || auth.user.name || auth.user.email
    : auth.user.name || auth.user.email
  const userInitial = userDisplayName.trim().charAt(0).toUpperCase() || 'U'
  const todoOverviewItems = homeOverviewItems.filter(
    (item) => item.workflowStatus !== 'completed'
  )
  const visibleOverviewItems = todoOverviewItems.slice(0, visibleOverviewCount)
  const hasMoreOverviewItems = todoOverviewItems.length > visibleOverviewCount
  const remainingOverviewItems = Math.max(
    todoOverviewItems.length - visibleOverviewCount,
    0
  )

  const isNavItemActive = (key: string): boolean => {
    switch (key) {
      case 'overview': return currentPage === 'home'
      case 'answer-bank': return currentPage === 'answer-bank'
      case 'assignment-setup': return currentPage === 'assignment-setup'
      case 'grading-flow': return ['grading-list', 'grading', 'assignment-import-select', 'assignment-import', 'assignment-scan', 'unified-import', 'correction-select', 'correction'].includes(currentPage)
      case 'gradebook': return currentPage === 'gradebook'
      case 'report': return false
      case 'classroom-management': return currentPage === 'classroom-management'
      case 'preferences': return currentPage === 'teacher-preferences'
      default: return false
    }
  }

  const confirmLeaveGrading = () => {
    if ((currentPage !== 'grading' && currentPage !== 'batch-grading') || gradingPagePhase !== 'awaiting_review') return true
    return window.confirm(
      '一致性審查尚未提交批改。\n\nPhase A 已完成並產生費用，離開後本次費用仍會結算。\n\n確定要離開批改頁面嗎？'
    )
  }

  const openAssignmentSetup = () => {
    if (!confirmLeaveGrading()) return
    setCurrentPage('assignment-setup')
  }
  const openOverview = () => {
    if (!confirmLeaveGrading()) return
    setCurrentPage('home')
  }
  const openGrading = () => {
    if (!confirmLeaveGrading()) return
    if (!ensureInkNonNegative()) return
    setCurrentPage('grading-list')
  }
  const openGradebook = () => {
    if (!confirmLeaveGrading()) return
    if (!canAccessTracking) return
    setCurrentPage('gradebook')
  }
  const openAiReport = () => {
    if (!confirmLeaveGrading()) return
    if (!canAccessTracking) return
    setCurrentPage('ai-report')
  }
  const openPreferences = () => {
    if (!confirmLeaveGrading()) return
    setIsUserMenuOpen(false)
    setCurrentPage('teacher-preferences')
  }
  const openClassroomManagement = () => {
    if (!confirmLeaveGrading()) return
    setCurrentPage('classroom-management')
  }
  const openAssignmentFromOverview = (item: HomeOverviewItem) => {
    if (!ensureInkNonNegative()) return
    if (item.workflowStatus === 'pending-grading') {
      setSelectedAssignmentId(item.id)
      setCurrentPage('grading')
    } else if (item.workflowStatus === 'pending-dispatch' || item.workflowStatus === 'correction-followup') {
      setSelectedAssignmentId(item.id)
      setCurrentPage('correction')
    } else {
      // missing-answer-key / missing-submission：至少預選班級
      setGradingSelectedClassroomId(item.classroomId)
      setCurrentPage('grading-list')
    }
  }

  const homeNavSections: HomeNavSection[] = [
    {
      title: '常用功能',
      items: [
        {
          key: 'overview',
          label: '作業總覽',
          description: '查看待辦與批改進度',
          icon: LayoutDashboard,
          onClick: openOverview
        },
        {
          key: 'answer-bank',
          label: '建立答案',
          description: '管理答案卷，可跨班級使用',
          icon: BookOpen,
          onClick: () => { if (!confirmLeaveGrading()) return; setCurrentPage('answer-bank') }
        },
        // {
        //   key: 'assignment-setup',
        //   label: '作業建立',
        //   description: '建立作業題目與答案卷',
        //   icon: FilePlus2,
        //   onClick: openAssignmentSetup
        // },
        {
          key: 'grading-flow',
          label: '作業批改',
          description: '蒐集作業、AI 批改與訂正流程',
          icon: Sparkles,
          onClick: openGrading
        }
      ]
    },
    {
      title: '成果分析',
      items: [
        {
          key: 'gradebook',
          label: '成績統計',
          description: '查看成績與學習表現趨勢',
          icon: BarChart3,
          onClick: openGradebook,
          disabled: !canAccessTracking,
          badge: canAccessTracking ? undefined : 'Pro'
        },
        {
          key: 'report',
          label: '學情報告',
          description: 'AI 分析弱點與教學建議',
          icon: FileText,
          onClick: openAiReport,
          disabled: !canAccessTracking,
          badge: canAccessTracking ? undefined : 'Pro'
        }
      ]
    },
    {
      title: '系統設定',
      items: [
        {
          key: 'classroom-management',
          label: '班級管理',
          description: '管理班級、座位與學生名單',
          icon: Users,
          onClick: openClassroomManagement
        },
        {
          key: 'preferences',
          label: '偏好設定',
          description: '開啟帳號資訊、權限與墨水設定',
          icon: SlidersHorizontal,
          onClick: openPreferences
        }
      ]
    }
  ]

  return (
    <div className="min-h-screen bg-[#f7f7f5]">
      <GlobalSyncBar />
      <div className="mx-auto flex h-screen w-full max-w-[1280px] flex-col">
        {!isCameraCaptureMode && (
          <header className="sticky top-0 z-[110] border-b border-slate-200 bg-[#f7f7f5]/95 px-4 py-2 backdrop-blur md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <img
                src="/logo.png"
                alt="RedPen AI logo"
                className="h-12 w-12 object-contain mix-blend-multiply md:h-14 md:w-14"
              />
              <div>
                <h1 className="text-lg font-semibold text-slate-900 md:text-xl">RedPen AI</h1>
                <p className="text-xs text-slate-500">教師批改小幫手</p>
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2 md:gap-3">
              <span className="inline-flex h-11 shrink-0 items-center rounded-lg border border-slate-200 bg-white px-3 shadow-sm">
                <SyncIndicator autoSync={true} />
              </span>
              {!isStudent && (
                <span className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 shadow-sm">
                  <Droplet className="h-4 w-4 text-amber-500" />
                  <span className="font-semibold tabular-nums text-amber-700">
                    {auth.user.inkBalance ?? 0}
                  </span>
                </span>
              )}
              <div ref={userMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsUserMenuOpen((prev) => !prev)}
                  className="inline-flex h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 text-left shadow-sm transition-colors hover:border-slate-300"
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-slate-700">
                    {userInitial}
                  </span>
                  <span className="hidden max-w-[140px] truncate text-sm font-medium text-slate-700 sm:block">
                    {userDisplayName}
                  </span>
                  <ChevronDown className="h-4 w-4 text-slate-500" />
                </button>
                {isUserMenuOpen && (
                  <div className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-100 px-4 py-3">
                      <p className="truncate text-sm font-semibold text-slate-900">{userDisplayName}</p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <p className="truncate text-xs text-slate-500">{auth.user.email}</p>
                        {auth.user.campus1Binding && (
                          <span className="shrink-0 inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">已綁定1campus</span>
                        )}
                      </div>
                    </div>
                    {!isStudent && (
                      <div className="space-y-2 px-4 py-3 text-xs text-slate-600">
                        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                          <span>權限</span>
                          <span className="inline-flex items-center gap-1 font-semibold text-slate-700">
                            {permissionLabel === 'Pro' && (
                              <Crown className="h-3.5 w-3.5 text-amber-500" />
                            )}
                            {permissionLabel}
                          </span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                          <span>墨水</span>
                          <span className="font-semibold tabular-nums text-amber-700">
                            {auth.user.inkBalance ?? 0} 滴
                          </span>
                        </div>
                        {pendingInk.totalDrops > 0 && (
                          <div className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-amber-700">
                            <span>待入帳</span>
                            <span className="font-semibold tabular-nums">{pendingInk.totalDrops} 滴</span>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="space-y-2 border-t border-slate-100 px-4 py-3">
                      {!isStudent && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsUserMenuOpen(false)
                            setCurrentPage('ink-topup')
                          }}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-700"
                        >
                          <Droplet className="h-4 w-4" />
                          補充墨水
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsUserMenuOpen(false)
                            setCurrentPage('admin-panel')
                          }}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-purple-200 px-3 py-2 text-sm font-semibold text-purple-700 transition-colors hover:border-purple-300 hover:text-purple-800"
                        >
                          <Shield className="h-4 w-4" />
                          管理者面板
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isLoggingOut}
                        onClick={handleLogout}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 transition-colors duration-200 hover:border-red-300 hover:text-red-600 active:scale-95 disabled:opacity-70 disabled:cursor-wait"
                      >
                        {isLoggingOut ? '登出中…' : '登出'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          </header>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden border-x border-slate-200 bg-white shadow-[0_2px_10px_rgba(15,23,42,0.06)]">
          {!isStudent && (
            <aside className="border-b border-slate-200 bg-[#F7F8FA] lg:w-[260px] lg:shrink-0 lg:border-b-0 lg:border-r">
              <div className="h-full overflow-y-auto p-4 md:p-5">
                {homeNavSections.map((section, sectionIndex) => (
                  <section
                    key={section.title}
                    className={sectionIndex === 0 ? '' : 'mt-5 border-t border-slate-200 pt-5'}
                  >
                    <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      {section.title}
                    </h2>
                    <div className="space-y-0">
                      {section.items.map((item) => {
                        const Icon = item.icon
                        const active = isNavItemActive(item.key)
                        return (
                          <button
                            key={item.key}
                            type="button"
                            onClick={item.onClick}
                            disabled={item.disabled}
                            className={`group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition ${
                              item.disabled
                                ? 'cursor-not-allowed text-slate-400'
                                : active
                                  ? 'bg-sky-50 text-sky-700'
                                  : 'text-slate-700 hover:bg-slate-200/55'
                            }`}
                          >
                            <span
                              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded ${
                                item.disabled
                                  ? 'bg-slate-200 text-slate-400'
                                  : active
                                    ? 'bg-sky-100 text-sky-600'
                                    : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              <Icon className="h-5 w-5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-base font-semibold">
                                {item.label}
                              </span>
                            </span>
                            {item.badge && (
                              <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                                {item.badge}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </aside>
          )}

          <main className="flex min-h-0 flex-1 flex-col bg-[#FFFFFF]">
            {/* 方案 1：OAuth 授權被拒絕提示 / 方案 3：campus1 虛擬 email 持續提醒 */}
            {!isStudent && auth.status === 'authenticated' && (() => {
              const email = auth.user.email ?? ''
              const isCampus1Email = email.startsWith('campus1.') && email.includes('@')
              const dsns = isCampus1Email
                ? email.slice(email.indexOf('@') + 1)
                : auth.user.campus1Binding?.dsns || ''
              const oauthRetryUrl = dsns
                ? buildApiUrl(`/api/auth/1campus?__step=oauth&dsns=${encodeURIComponent(dsns)}`)
                : ''

              // 方案 1：剛從 1Campus OAuth 拒絕回來
              if (ssoOAuthDenied) {
                return (
                  <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
                    <span className="flex-1">
                      您剛才未授權 Google 帳號綁定。綁定後可整合您在不同平台的資料，建議立即完成。
                    </span>
                    {oauthRetryUrl && (
                      <a
                        href={oauthRetryUrl}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-700"
                      >
                        <LinkIcon className="h-3.5 w-3.5" />
                        重新授權
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => setSsoOAuthDenied(false)}
                      className="shrink-0 rounded p-1 text-amber-400 hover:bg-amber-100 hover:text-amber-600"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )
              }

              // 方案 3：持續提醒 — email 仍是 campus1.* 虛擬 email
              if (isCampus1Email && oauthRetryUrl) {
                return (
                  <div className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                    <LinkIcon className="h-5 w-5 shrink-0 text-blue-500" />
                    <span className="flex-1">
                      您的帳號尚未綁定 Google，目前使用虛擬信箱登入。綁定後可整合資料並使用完整功能。
                    </span>
                    <a
                      href={oauthRetryUrl}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
                    >
                      <LinkIcon className="h-3.5 w-3.5" />
                      立即綁定
                    </a>
                  </div>
                )
              }

              return null
            })()}
            <div className={`flex-1 overflow-y-scroll ${isStudent ? '' : 'px-4 py-4 md:px-6 md:py-5'}`}>
              <Suspense fallback={
                <div className="flex items-center justify-center py-20">
                  <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              }>
              {isStudent ? (
                <StudentPortal onCaptureModeChange={setIsCameraCaptureMode} />
              ) : currentPage === 'answer-bank' ? (
                <AnswerBank
                  embedded
                  onBack={() => setCurrentPage('home')}
                  inkBalance={auth.user.inkBalance ?? 0}
                  onRequireInkTopUp={() => setCurrentPage('ink-topup')}
                />
              ) : currentPage === 'assignment-setup' ? (
                <AssignmentSetup
                  embedded
                  onBack={() => setCurrentPage('home')}
                  inkBalance={auth.user.inkBalance ?? 0}
                  onRequireInkTopUp={() => setCurrentPage('ink-topup')}
                />
              ) : currentPage === 'classroom-management' ? (
                <ClassroomManagement embedded onBack={() => setCurrentPage('home')} />
              ) : currentPage === 'assignment-import-select' ? (
                <AssignmentImportSelect
                  embedded
                  onBack={() => setCurrentPage('home')}
                  initialClassroomId={importSelectedClassroomId}
                  initialFolder={importSelectedFolder}
                  onClassroomChange={setImportSelectedClassroomId}
                  onFolderChange={setImportSelectedFolder}
                  onSelectScanImport={(assignmentId) => {
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('unified-import')
                  }}
                  onSelectBatchImport={(assignmentId) => {
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('unified-import')
                  }}
                />
              ) : currentPage === 'assignment-import' && selectedAssignmentId ? (
                <AssignmentImport
                  embedded
                  assignmentId={selectedAssignmentId}
                  onBack={() => {
                    setSelectedAssignmentId('')
                    setCurrentPage('grading')
                  }}
                  onUploadComplete={() => setCurrentPage('grading')}
                />
              ) : currentPage === 'unified-import' && selectedAssignmentId ? (
                <UnifiedImportPage
                  embedded
                  assignmentId={selectedAssignmentId}
                  onBack={() => {
                    setSelectedAssignmentId('')
                    setCurrentPage('grading-list')
                  }}
                  onUploadComplete={() => setCurrentPage('grading')}
                  onCaptureModeChange={setIsCameraCaptureMode}
                />
              ) : currentPage === 'grading-list' ? (
                <AssignmentList
                  embedded
                  initialClassroomId={gradingSelectedClassroomId}
                  initialFolder={gradingSelectedFolder}
                  onClassroomChange={setGradingSelectedClassroomId}
                  onFolderChange={setGradingSelectedFolder}
                  onSelectScanImport={(assignmentId) => {
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('unified-import')
                  }}
                  onSelectBatchImport={(assignmentId) => {
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('unified-import')
                  }}
                  onSelectAssignment={(assignmentId) => {
                    if (!ensureInkNonNegative()) return
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('grading')
                  }}
                  onSelectCorrection={(assignmentId) => {
                    if (!canAccessTracking) return
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('correction')
                  }}
                  onStartBatchGrading={(ids) => {
                    if (!ensureInkNonNegative()) return
                    setBatchAssignmentIds(ids)
                    setCurrentPage('batch-grading')
                  }}
                  canUseCorrection={canAccessTracking}
                />
              ) : currentPage === 'batch-grading' && batchAssignmentIds.length > 0 ? (
                <GradingPage
                  embedded
                  assignmentId={batchAssignmentIds[0]}
                  batchAssignmentIds={batchAssignmentIds}
                  onBack={() => {
                    if (!confirmLeaveGrading()) return
                    setBatchAssignmentIds([])
                    setCurrentPage('grading-list')
                  }}
                  onRequireInkTopUp={() => setCurrentPage('ink-topup')}
                  onGradingPhaseChange={setGradingPagePhase}
                />
              ) : currentPage === 'grading' && selectedAssignmentId ? (
                <GradingPage
                  embedded
                  assignmentId={selectedAssignmentId}
                  onBack={() => {
                    if (!confirmLeaveGrading()) return
                    setCurrentPage('grading-list')
                  }}
                  onRequireInkTopUp={() => setCurrentPage('ink-topup')}
                  onGradingPhaseChange={setGradingPagePhase}
                />
              ) : currentPage === 'grading' ? (
                <AssignmentList
                  embedded
                  initialClassroomId={gradingSelectedClassroomId}
                  initialFolder={gradingSelectedFolder}
                  onClassroomChange={setGradingSelectedClassroomId}
                  onFolderChange={setGradingSelectedFolder}
                  onSelectScanImport={(assignmentId) => {
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('unified-import')
                  }}
                  onSelectBatchImport={(assignmentId) => {
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('unified-import')
                  }}
                  onSelectAssignment={(assignmentId) => {
                    if (!ensureInkNonNegative()) return
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('grading')
                  }}
                  onSelectCorrection={(assignmentId) => {
                    if (!canAccessTracking) return
                    setSelectedAssignmentId(assignmentId)
                    setCurrentPage('correction')
                  }}
                  onStartBatchGrading={(ids) => {
                    if (!ensureInkNonNegative()) return
                    setBatchAssignmentIds(ids)
                    setCurrentPage('batch-grading')
                  }}
                  canUseCorrection={canAccessTracking}
                />
              ) : currentPage === 'correction-select' ? (
                canAccessTracking ? (
                  <CorrectionSelect
                    embedded
                    onBack={() => setCurrentPage('home')}
                    onSelectAssignment={(id) => {
                      setSelectedAssignmentId(id)
                      setCurrentPage('correction')
                    }}
                  />
                ) : (
                  <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center">
                    <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
                    <p className="mt-2 text-sm text-gray-600">
                      Pro 權限才可使用後續追蹤功能。
                    </p>
                    <button
                      type="button"
                      onClick={() => setCurrentPage('home')}
                      className="mt-4 inline-flex rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
                    >
                      返回首頁
                    </button>
                  </div>
                )
              ) : currentPage === 'correction' ? (
                canAccessTracking ? (
                  selectedAssignmentId ? (
                    <CorrectionManagement
                      embedded
                      assignmentId={selectedAssignmentId}
                      onBack={() => setCurrentPage('grading-list')}
                    />
                  ) : (
                    <CorrectionSelect
                      embedded
                      onBack={() => setCurrentPage('home')}
                      onSelectAssignment={(id) => {
                        setSelectedAssignmentId(id)
                        setCurrentPage('correction')
                      }}
                    />
                  )
                ) : (
                  <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center">
                    <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
                    <p className="mt-2 text-sm text-gray-600">
                      Pro 權限才可使用後續追蹤功能。
                    </p>
                    <button
                      type="button"
                      onClick={() => setCurrentPage('home')}
                      className="mt-4 inline-flex rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
                    >
                      返回首頁
                    </button>
                  </div>
                )
              ) : currentPage === 'gradebook' ? (
                canAccessTracking ? (
                  <Gradebook embedded onBack={() => setCurrentPage('home')} />
                ) : (
                  <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center">
                    <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
                    <p className="mt-2 text-sm text-gray-600">
                      Pro 權限才可使用後續追蹤功能。
                    </p>
                    <button
                      type="button"
                      onClick={() => setCurrentPage('home')}
                      className="mt-4 inline-flex rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
                    >
                      返回首頁
                    </button>
                  </div>
                )
              ) : currentPage === 'ai-report' ? (
                canAccessTracking ? (
                  <AiReport embedded onBack={() => setCurrentPage('home')} />
                ) : (
                  <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center">
                    <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
                    <p className="mt-2 text-sm text-gray-600">
                      Pro 權限才可使用 AI 學情報告。
                    </p>
                    <button
                      type="button"
                      onClick={() => setCurrentPage('home')}
                      className="mt-4 inline-flex rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
                    >
                      返回首頁
                    </button>
                  </div>
                )
              ) : currentPage === 'teacher-preferences' ? (
                <TeacherPreferences
                  embedded
                  onBack={() => setCurrentPage('home')}
                  campus1Binding={auth.user.campus1Binding}
                />
              ) : currentPage === 'assignment-scan' && selectedAssignmentId ? (
                <AssignmentScanImport
                  embedded
                  assignmentId={selectedAssignmentId}
                  onBack={() => {
                    setSelectedAssignmentId('')
                    setCurrentPage('grading')
                  }}
                  onUploadComplete={() => setCurrentPage('grading')}
                  onCaptureModeChange={setIsCameraCaptureMode}
                />
              ) : (
                <>
                  <section>
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
                      <h1 className="text-2xl font-semibold text-gray-900">作業總覽</h1>
                      <button
                        type="button"
                        onClick={() => void loadHomeOverview()}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-800"
                      >
                        重新整理
                      </button>
                    </div>

                    <div className="mt-4 grid gap-0 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="px-2 py-3 xl:border-r xl:border-slate-200">
                        <p className="text-[11px] text-slate-500">總作業數</p>
                        {homeOverviewLoading ? (
                          <div className="mt-2 h-9 w-16 animate-pulse rounded bg-slate-100" />
                        ) : (
                          <p className="mt-1 text-3xl font-bold tracking-tight text-sky-700 md:text-4xl">
                            {homeOverviewSummary.totalAssignments}
                          </p>
                        )}
                      </div>
                      <div className="px-2 py-3 xl:border-r xl:border-slate-200">
                        <p className="text-[11px] text-slate-500">待匯入作業</p>
                        {homeOverviewLoading ? (
                          <div className="mt-2 h-9 w-16 animate-pulse rounded bg-slate-100" />
                        ) : (
                          <p className="mt-1 text-3xl font-bold tracking-tight text-sky-700 md:text-4xl">
                            {homeOverviewSummary.assignmentsWithoutUploads}
                          </p>
                        )}
                      </div>
                      <div className="px-2 py-3 xl:border-r xl:border-slate-200">
                        <p className="text-[11px] text-slate-500">待批改份數</p>
                        {homeOverviewLoading ? (
                          <div className="mt-2 h-9 w-16 animate-pulse rounded bg-slate-100" />
                        ) : (
                          <p className="mt-1 text-3xl font-bold tracking-tight text-sky-700 md:text-4xl">
                            {homeOverviewSummary.pendingGradingSubmissions}
                          </p>
                        )}
                      </div>
                      <div className="px-2 py-3">
                        <p className="text-[11px] text-slate-500">批改完成率</p>
                        {homeOverviewLoading ? (
                          <div className="mt-2 h-9 w-16 animate-pulse rounded bg-slate-100" />
                        ) : (
                          <p className="mt-1 text-3xl font-bold tracking-tight text-sky-700 md:text-4xl">
                            {homeOverviewSummary.uploadedSubmissions > 0
                              ? `${Math.round(
                                  (homeOverviewSummary.gradedSubmissions /
                                    homeOverviewSummary.uploadedSubmissions) *
                                    100
                                )}%`
                              : '0%'}
                          </p>
                        )}
                      </div>
                    </div>
                  </section>

                  <div className="mt-5">
                    <section className="pt-2">
                      <div className="mb-2 flex items-center justify-between">
                        <h3 className="text-base font-semibold text-slate-900">待辦作業</h3>
                        <span className="text-xs text-slate-500">依狀態優先排序</span>
                      </div>

                      {homeOverviewLoading ? (
                        <div className="space-y-3">
                          {Array.from({ length: 3 }).map((_, index) => (
                            <div
                              key={`loading-row-${index}`}
                              className="h-16 animate-pulse bg-slate-50/70"
                            />
                          ))}
                        </div>
                      ) : todoOverviewItems.length === 0 ? (
                        <div className="bg-slate-50/60 px-4 py-8 text-center">
                          <p className="text-sm text-slate-600">目前沒有待辦作業。</p>
                          <button
                            type="button"
                            onClick={openAssignmentSetup}
                            className="mt-3 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
                          >
                            前往作業建立
                          </button>
                        </div>
                      ) : (
                        <div>
                          <div className="divide-y divide-slate-200/80">
                            {visibleOverviewItems.map((item) => {
                              let actionLabel = '檢視批改'
                              let statusLabel = '已完成'
                              let statusClassName = 'text-slate-500'

                              if (item.workflowStatus === 'missing-answer-key') {
                                actionLabel = '先補答案卷'
                                statusLabel = '待補答案卷'
                                statusClassName = 'text-rose-700'
                              } else if (item.workflowStatus === 'missing-submission') {
                                actionLabel = '匯入作答'
                                statusLabel = '待匯入作答'
                                statusClassName = 'text-sky-700'
                              } else if (item.workflowStatus === 'pending-grading') {
                                actionLabel = '繼續批改'
                                statusLabel = '待批改'
                                statusClassName = 'text-amber-700'
                              } else if (item.workflowStatus === 'pending-dispatch') {
                                actionLabel = '去派發訂正'
                                statusLabel = '待派發訂正'
                                statusClassName = 'text-orange-600'
                              } else if (item.workflowStatus === 'correction-followup') {
                                actionLabel = '檢視批改'
                                statusLabel = '待追蹤訂正'
                                statusClassName = 'text-violet-700'
                              }

                              return (
                                <div
                                  key={item.id}
                                  className="px-2 py-3"
                                >
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-base font-semibold tracking-tight text-slate-950">
                                        {item.title}
                                      </p>
                                      <p className="mt-1 text-xs text-slate-500">
                                        {item.classroomName} · 學生 {item.totalStudents} 人 · 狀態：
                                        <span className={`ml-1 font-semibold ${statusClassName}`}>
                                          {statusLabel}
                                        </span>
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => openAssignmentFromOverview(item)}
                                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
                                    >
                                      {actionLabel}
                                    </button>
                                  </div>
                                  <div className="mt-3">
                                    <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
                                      <span>批改進度 {item.progressPercent}%</span>
                                      <span>
                                        匯入 {item.uploadedCount} / 已批改 {item.gradedCount} / 待批改{' '}
                                        {item.pendingGradingCount}
                                      </span>
                                    </div>
                                    <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                                      <div
                                        className="h-full rounded-full bg-sky-500 transition-[width]"
                                        style={{ width: `${item.progressPercent}%` }}
                                      />
                                    </div>
                                  </div>
                                  {item.gradedCount >= 1 && (
                                    <div className="mt-2 space-y-0.5 text-[11px] text-slate-500">
                                      {item.incompleteSeatNumbers.length > 0 && (
                                        <div>
                                          <span className="font-medium text-amber-700">未完成：</span>
                                          {item.incompleteSeatNumbers.join('、')}
                                        </div>
                                      )}
                                      {item.ungradedSeatNumbers.length > 0 && (
                                        <div>
                                          <span className="font-medium text-sky-700">未批改：</span>
                                          {item.ungradedSeatNumbers.join('、')}
                                        </div>
                                      )}
                                      {item.notSubmittedSeatNumbers.length > 0 && (
                                        <div>
                                          <span className="font-medium text-slate-500">未繳交：</span>
                                          {item.notSubmittedSeatNumbers.join('、')}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                          {hasMoreOverviewItems && (
                            <div className="px-2 pt-3">
                              <button
                                type="button"
                                onClick={() =>
                                  setVisibleOverviewCount(
                                    (prev) => prev + OVERVIEW_VISIBLE_STEP
                                  )
                                }
                                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
                              >
                                看更多（再顯示 {Math.min(OVERVIEW_VISIBLE_STEP, remainingOverviewItems)} 筆）
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </section>
                  </div>
                </>
              )}

            </Suspense>
            </div>
          </main>
        </div>

        {!isCameraCaptureMode && (
          <footer className="sticky bottom-0 z-20 shrink-0 border-t border-slate-200 bg-[#f7f7f5]/95 px-3 py-1 text-[10px] leading-4 text-slate-600 backdrop-blur md:px-6">
            <div className="overflow-x-auto">
              <div className="ml-auto min-w-max flex items-center justify-end gap-3 whitespace-nowrap text-right">
                <button
                  type="button"
                  onClick={() => setIsAiDisclaimerOpen(true)}
                  className="text-sky-700 underline underline-offset-2 hover:text-sky-800"
                >
                  AI 免責
                </button>
                <button
                  type="button"
                  onClick={() => setIsIpDisclaimerOpen(true)}
                  className="text-sky-700 underline underline-offset-2 hover:text-sky-800"
                >
                  著作權聲明
                </button>
                <button
                  type="button"
                  onClick={() => setIsTermsOpen(true)}
                  className="text-sky-700 underline underline-offset-2 hover:text-sky-800"
                >
                  服務條款
                </button>
                <button
                  type="button"
                  onClick={() => setIsPrivacyOpen(true)}
                  className="text-sky-700 underline underline-offset-2 hover:text-sky-800"
                >
                  隱私權政策
                </button>
                <span className="text-slate-300">|</span>
                <span className="text-slate-500">jhanfong150983@gmail.com</span>
                <span className="text-slate-300">|</span>
                <span className="text-slate-500">0981-716-650</span>
                <span className="text-slate-300">|</span>
                <span className="text-slate-400">Copyright © 2026黃政昱</span>
              </div>
            </div>
          </footer>
        )}
      </div>

      {isAiDisclaimerOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="ai-disclaimer-title">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 id="ai-disclaimer-title" className="text-base font-semibold text-gray-900">
                免責聲明及 AI 生成內容著作權聲明
              </h2>
              <button
                type="button"
                onClick={() => setIsAiDisclaimerOpen(false)}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
                aria-label="關閉"
              >
                X
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-gray-700 space-y-3 overflow-y-auto max-h-[75vh] leading-relaxed">
              <p>
                <span className="font-semibold">一、免責聲明</span>
                <br />
                本網站部分內容與功能由生成式人工智慧（Generative AI）技術自動生成。雖本網站致力提供正確且有價值之資訊，惟 AI 生成內容可能不完整、不準確或非最新資訊，僅供參考。使用者應自行核實並審慎使用，並對使用結果負責。本網站及其運營方對於使用或信賴 AI 生成內容所生之任何爭議、損失或損害，不承擔任何法律責任。
              </p>
              <p>
                生成式 AI 之回應或內容不構成專業建議、法律意見或權威性答案，使用者應依實際情況另行取得獨立之法律意見或其他專業意見。
              </p>
              <p>
                生成式 AI 具有技術限制，可能產生不妥適或不符合需求之結果，本網站無法保證其完整性、適用性或一致性。
              </p>
              <p>
                <span className="font-semibold">二、AI 生成內容著作權聲明</span>
                <br />
                本網站所使用之生成式 AI 係基於公共訓練資料與開放技術開發，AI 生成內容具自動產出特性，本網站無法對其內容進行完整之第三方智慧財產權檢查或控管，亦無法保證使用者得對該等內容主張著作權或其他智慧財產權利。
              </p>
              <p>
                AI 生成內容可能無意間模仿或引用既有資料或作品。若發現可能侵害第三方著作權或其他權利之情形，請立即通知本網站，本網站將儘速處理並移除相關內容。
              </p>
              <p>
                <span className="font-semibold">三、使用者責任</span>
                <br />
                使用者在本網站所創建或傳輸之任何內容，應遵守相關法律法規並不得侵害他人權利。
              </p>
              <p>
                使用者使用 AI 生成內容進行轉載、分享或商業使用時，應自行取得必要授權或許可；因違反法令或不當使用所致之任何損害，本網站不負任何責任。
              </p>
              <p>
                <span className="font-semibold">四、條款修訂</span>
                <br />
                本網站保留隨時修改本聲明之權利，使用者應定期查閱以了解最新內容。
              </p>
            </div>
          </div>
        </div>
      )}

      {isIpDisclaimerOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="ip-disclaimer-title">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 id="ip-disclaimer-title" className="text-base font-semibold text-gray-900">
                網站智慧財產權聲明
              </h2>
              <button
                type="button"
                onClick={() => setIsIpDisclaimerOpen(false)}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
                aria-label="關閉"
              >
                X
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-gray-700 space-y-3 overflow-y-auto max-h-[75vh] leading-relaxed">
              <p>
                除另有標示外，本網站之商標、標誌、介面設計、文字、圖像、影音、程式碼、資料庫及其他內容之智慧財產權，均屬本網站或其權利人所有。
              </p>
              <p>
                未經事前書面同意，任何人不得以任何形式重製、改作、散布、公開傳輸、展示、出版或作商業使用；僅限於合法且必要之個人瀏覽或學習用途之合理使用，不構成授權。
              </p>
            </div>
          </div>
        </div>
      )}
      {legalModals}
    </div>
  )
}

function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

export default AppWithErrorBoundary
