import { useState, useEffect, useCallback } from 'react'
import {
  Users,
  BookOpen,
  Sparkles,
  FileImage,
  ClipboardCheck,
  Shield,
  Droplet,
  Crown,
  BarChart3
} from 'lucide-react'
import ClassroomManagement from '@/pages/ClassroomManagement'
import AssignmentSetup from '@/pages/AssignmentSetup'
import AssignmentList from '@/pages/AssignmentList'
import GradingPage from '@/pages/GradingPage'
import AssignmentImport from '@/pages/AssignmentImport'
import AssignmentImportSelect from '@/pages/AssignmentImportSelect'
import AssignmentScanImport from '@/pages/AssignmentScanImport'
import CorrectionSelect from '@/pages/CorrectionSelect'
import CorrectionManagement from '@/pages/CorrectionManagement'
import Gradebook from '@/pages/Gradebook'
import AdminPanel from '@/pages/AdminPanel'
import InkTopUp from '@/pages/InkTopUp'
import AiReport from '@/pages/AiReport'
import LandingPage from '@/pages/LandingPage'
import { SyncIndicator } from '@/components'
import { checkWebPSupport } from '@/lib/webpSupport'
import { INK_BALANCE_EVENT, type InkBalanceDetail } from '@/lib/ink-events'
import '@/lib/debug-sync'
import { debugLog } from '@/lib/logger'
import { LEGAL_MODAL_EVENT, type LegalModalDetail } from '@/lib/legal-events'
import { TERMS_VERSION, PRIVACY_VERSION, REFUND_FEE_RATE } from '@/lib/legal'
import AdminUserDetail from '@/pages/AdminUserDetail'

type Page =
  | 'home'
  | 'classroom-management'
  | 'assignment-setup'
  | 'assignment-import-select'
  | 'assignment-scan'
  | 'grading-list'
  | 'grading'
  | 'gradebook'
  | 'assignment-import'
  | 'correction-select'
  | 'correction'
  | 'ai-report'
  | 'admin-panel'
  | 'admin-user-detail'
  | 'ink-topup'

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

function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [currentPage, setCurrentPage] = useState<Page>('home')
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string>('')
  const [selectedUserId, setSelectedUserId] = useState<string>('')
  const [isAiDisclaimerOpen, setIsAiDisclaimerOpen] = useState(false)
  const [isIpDisclaimerOpen, setIsIpDisclaimerOpen] = useState(false)
  const [isTermsOpen, setIsTermsOpen] = useState(false)
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false)
  const [urlPageHandled, setUrlPageHandled] = useState(false)
  const [hasPaidOrder, setHasPaidOrder] = useState(false)
  const [pendingInk, setPendingInk] = useState<PendingInkSummary>({
    count: 0,
    totalDrops: 0,
    amountTwd: 0
  })
  const inkBalance =
    auth.status === 'authenticated' ? auth.user.inkBalance ?? 0 : null

  const fetchAuth = useCallback(async () => {
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
        setAuth({ status: 'unauthenticated' })
        return
      }

      const data = await response.json()
      if (!data?.user?.id) {
        setAuth({ status: 'unauthenticated' })
        return
      }

      // 除錯：顯示資料來源
      if (data._debug) {
        console.log('📊 Auth 資料來源:', {
          profileLoaded: data._debug.profileLoaded,
          dataSource: data._debug.dataSource,
          timestamp: data._debug.timestamp ? new Date(data._debug.timestamp).toLocaleTimeString() : 'unknown'
        })
      }

      setAuth({
        status: 'authenticated',
        user: {
          ...data.user,
          role: (data.user.role || 'user').toLowerCase(),
          permissionTier: (data.user.permissionTier || 'basic').toLowerCase(),
          inkBalance: typeof data.user.inkBalance === 'number' ? data.user.inkBalance : 0
        }
      })
    } catch (error) {
      console.error('驗證登入狀態失敗', error)
      setAuth({ status: 'unauthenticated', error: '無法連線到伺服器' })
    }
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      })
    } catch (error) {
      console.error('登出失敗', error)
    } finally {
      setAuth({ status: 'unauthenticated' })
      setCurrentPage('home')
      setSelectedAssignmentId('')
    }
  }, [])

  useEffect(() => {
    void fetchAuth()
  }, [fetchAuth])

  useEffect(() => {
    const handleFocus = () => {
      void fetchAuth()
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [fetchAuth])

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

  const refundFeePercent = Math.round(REFUND_FEE_RATE * 1000) / 10
  const legalModals = (
    <>
      {isTermsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">服務條款</h2>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">隱私權政策</h2>
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

  useEffect(() => {
    if (urlPageHandled) return
    if (auth.status !== 'authenticated') return

    const params = new URLSearchParams(window.location.search)
    const pageParam = params.get('page')
    let nextPage: Page | null = null

    switch (pageParam) {
      case 'ink-topup':
        nextPage = 'ink-topup'
        break
      case 'admin-panel':
      case 'admin-orders':
      case 'admin-users':
      case 'admin-analytics':
      case 'admin-tags':
        nextPage = isAdmin ? 'admin-panel' : null
        break
      case 'gradebook':
        nextPage = canAccessTracking ? 'gradebook' : null
        break
      case 'correction':
      case 'correction-select':
        nextPage = canAccessTracking ? 'correction-select' : null
        break
      case 'ai-report':
        nextPage = canAccessTracking ? 'ai-report' : null
        break
      default:
        nextPage = null
    }

    if (nextPage) {
      setCurrentPage(nextPage)
    }

    if (pageParam) {
      params.delete('page')
      const query = params.toString()
      const url = query ? `${window.location.pathname}?${query}` : window.location.pathname
      window.history.replaceState({}, '', url)
    }

    setUrlPageHandled(true)
  }, [auth.status, canAccessTracking, isAdmin, urlPageHandled])

  if (auth.status === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-gray-600 text-sm">驗證登入狀態...</p>
        </div>
      </div>
    )
  }

  if (auth.status === 'unauthenticated') {
    return <LandingPage />
  }

  // 班級管理
  if (currentPage === 'classroom-management') {
    return (
      <ClassroomManagement onBack={() => setCurrentPage('home')} />
    )
  }

  // 作業管理
  if (currentPage === 'assignment-setup') {
    return (
      <AssignmentSetup
        onBack={() => setCurrentPage('home')}
        inkBalance={auth.user.inkBalance ?? 0}
        onRequireInkTopUp={() => setCurrentPage('ink-topup')}
      />
    )
  }

  // 作業匯入：選擇作業並決定匯入方式
  if (currentPage === 'assignment-import-select') {
    return (
      <AssignmentImportSelect
        onBack={() => setCurrentPage('home')}
        onSelectScanImport={(assignmentId) => {
          setSelectedAssignmentId(assignmentId)
          setCurrentPage('assignment-scan')
        }}
        onSelectBatchImport={(assignmentId) => {
          setSelectedAssignmentId(assignmentId)
          setCurrentPage('assignment-import')
        }}
      />
    )
  }

  // 掃描匯入
  if (currentPage === 'assignment-scan' && selectedAssignmentId) {
    return (
      <AssignmentScanImport
        assignmentId={selectedAssignmentId}
        onBack={() => setCurrentPage('assignment-import-select')}
        onUploadComplete={() => setCurrentPage('home')}
      />
    )
  }

  // AI 批改：作業列表
  if (currentPage === 'grading-list') {
    return (
      <AssignmentList
        onBack={() => setCurrentPage('home')}
        onSelectAssignment={(assignmentId) => {
          if (!ensureInkNonNegative()) return
          setSelectedAssignmentId(assignmentId)
          setCurrentPage('grading')
        }}
      />
    )
  }

  // 成績簿
  if (currentPage === 'gradebook') {
    if (!canAccessTracking) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 text-center space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
            <p className="text-sm text-gray-600">
              Pro 權限才可使用後續追蹤功能。
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
    return (<Gradebook onBack={() => setCurrentPage('home')} />)
  }

  if (currentPage === 'ai-report') {
    if (!canAccessTracking) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 text-center space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
            <p className="text-sm text-gray-600">
              Pro 權限才可使用 AI 學情報告。
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
    return (<AiReport onBack={() => setCurrentPage('home')} />)
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
      <AdminPanel
        onBack={() => setCurrentPage('home')}
        onNavigateToDetail={(userId) => {
          setSelectedUserId(userId)
          setCurrentPage('admin-user-detail')
        }}
      />
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
      <AdminUserDetail
        userId={selectedUserId}
        onBack={() => {
          setCurrentPage('admin-panel')
          setSelectedUserId('')
        }}
      />
    )
  }

  // 補充墨水
  if (currentPage === 'ink-topup') {
    return (
      <>
        <InkTopUp
          onBack={() => setCurrentPage('home')}
          currentBalance={auth.user.inkBalance ?? 0}
        />
        {legalModals}
      </>
    )
  }

  // AI 批改：單一作業批改介面
  if (currentPage === 'grading' && selectedAssignmentId) {
    return (
      <GradingPage
        assignmentId={selectedAssignmentId}
        onBack={() => setCurrentPage('grading-list')}
        onRequireInkTopUp={() => setCurrentPage('ink-topup')}
      />
    )
  }

  // 批次匯入（PDF／檔案）
  if (currentPage === 'assignment-import' && selectedAssignmentId) {
    return (
      <AssignmentImport
        assignmentId={selectedAssignmentId}
        onBack={() => setCurrentPage('assignment-import-select')}
        onUploadComplete={() => setCurrentPage('home')}
      />
    )
  }

  // 訂正管理：選擇作業
  if (currentPage === 'correction-select') {
    if (!canAccessTracking) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 text-center space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
            <p className="text-sm text-gray-600">
              Pro 權限才可使用後續追蹤功能。
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
      <CorrectionSelect
        onBack={() => setCurrentPage('home')}
        onSelectAssignment={(id) => {
          setSelectedAssignmentId(id)
          setCurrentPage('correction')
        }}
      />
    )
  }

  // 訂正管理：看板
  if (currentPage === 'correction' && selectedAssignmentId) {
    if (!canAccessTracking) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 text-center space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">權限不足</h2>
            <p className="text-sm text-gray-600">
              Pro 權限才可使用後續追蹤功能。
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
      <CorrectionManagement
        assignmentId={selectedAssignmentId}
        onBack={() => setCurrentPage('correction-select')}
      />
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="w-full max-w-5xl bg-white rounded-2xl shadow-xl p-8">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-8 gap-4">
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="RedPen AI logo"
              className="w-[100px] h-[100px] object-contain"
            />
            <h1 className="text-3xl font-bold text-gray-900">RedPen AI</h1>
          </div>
          <div className="flex items-center gap-3 justify-between md:justify-end">
            <div className="text-right">
              <p className="text-xs text-gray-500">已登入</p>
              <p className="text-sm font-semibold text-gray-800">
                {auth.user.name || auth.user.email}
              </p>
              <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] ${
                    isAdmin
                      ? 'bg-slate-100 text-slate-600'
                      : isProTier
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  權限：
                  {isAdmin ? (
                    '管理者'
                  ) : isProTier ? (
                    <span className="inline-flex items-center gap-1">
                      <Crown className="w-3.5 h-3.5 text-amber-500" />
                      Pro
                    </span>
                  ) : (
                    'Basic'
                  )}
                </span>
                <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-100 text-amber-700">
                  可用：{auth.user.inkBalance ?? 0} 滴
                </span>
                {pendingInk.totalDrops > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-50 text-amber-700">
                    待入帳：{pendingInk.totalDrops} 滴
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setCurrentPage('ink-topup')}
              className="px-3 py-2 text-xs font-semibold rounded-lg border border-sky-200 text-sky-700 hover:border-sky-300 hover:text-sky-800 transition-colors inline-flex items-center gap-2"
            >
              <Droplet className="w-4 h-4" />
              補充墨水
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setCurrentPage('admin-panel')}
                className="px-3 py-2 text-xs font-semibold rounded-lg border border-purple-200 text-purple-700 hover:border-purple-300 hover:text-purple-800 transition-colors inline-flex items-center gap-2"
              >
                <Shield className="w-4 h-4" />
                管理者面板
              </button>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="px-4 py-2 text-xs font-semibold rounded-lg border border-gray-200 text-gray-600 hover:border-red-300 hover:text-red-600 transition-colors"
            >
              登出
            </button>
          </div>
        </div>

        <div className="mb-6">
          <SyncIndicator />
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* 區塊A：作業流程 */}
          <div className="p-6 rounded-2xl border border-gray-200 bg-gray-50/80">
            <h2 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
              作業流程
            </h2>
            <div className="space-y-3">
              <button
                onClick={() => setCurrentPage('classroom-management')}
                className="w-full flex items-center justify-between px-4 py-3 bg-white rounded-xl border border-gray-200 hover:border-blue-400 transition-colors"
              >
                <span className="flex items-center gap-2 text-gray-800 font-medium">
                  <Users className="w-5 h-5 text-blue-600" />
                  班級管理
                </span>
                <span className="text-xs text-gray-500">建立班級與學生</span>
              </button>
              <button
                onClick={() => setCurrentPage('assignment-setup')}
                className="w-full flex items-center justify-between px-4 py-3 bg-white rounded-xl border border-gray-200 hover:border-green-400 transition-colors"
              >
                <span className="flex items-center gap-2 text-gray-800 font-medium">
                  <BookOpen className="w-5 h-5 text-green-600" />
                  作業管理
                </span>
                <span className="text-xs text-gray-500">建立作業題目與答案</span>
              </button>
              <button
                onClick={() => setCurrentPage('assignment-import-select')}
                className="w-full flex items-center justify-between px-4 py-3 bg-white rounded-xl border border-gray-200 hover:border-indigo-400 transition-colors"
              >
                <span className="flex items-center gap-2 text-gray-800 font-medium">
                  <FileImage className="w-5 h-5 text-indigo-600" />
                  作業匯入
                </span>
                <span className="text-xs text-gray-500">掃描或批次匯入</span>
              </button>
              <button
                onClick={() => {
                  if (!ensureInkNonNegative()) return
                  setCurrentPage('grading-list')
                }}
                className="w-full flex items-center justify-between px-4 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-xl hover:from-purple-700 hover:to-pink-700 transition-colors"
              >
                <span className="flex items-center gap-2 font-medium">
                  <Sparkles className="w-5 h-5" />
                  AI 批改
                </span>
                <span className="text-xs text-white/80">執行批改並調整分數</span>
              </button>
            </div>
          </div>

          {/* 區塊B：後續追蹤 */}
          <div className="p-6 rounded-2xl border border-gray-200 bg-gray-50/80">
            <h2 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-orange-500 inline-block" />
              後續追蹤
            </h2>
            <div className="space-y-3">
              <button
                onClick={() => {
                  if (canAccessTracking) {
                    setCurrentPage('correction-select')
                  }
                }}
                disabled={!canAccessTracking}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${
                  canAccessTracking
                    ? 'bg-white border-gray-200 hover:border-orange-400'
                    : 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                <span
                  className={`flex items-center gap-2 font-medium ${
                    canAccessTracking ? 'text-gray-800' : 'text-gray-400'
                  }`}
                >
                  <ClipboardCheck
                    className={`w-5 h-5 ${
                      canAccessTracking ? 'text-orange-600' : 'text-gray-300'
                    }`}
                  />
                  訂正管理
                </span>
                <span className="text-xs text-gray-500">
                  {canAccessTracking
                    ? '發訂正單 / 列印 / 模板批改'
                    : '需要 Pro 權限'}
                </span>
              </button>
              <button
                onClick={() => {
                  if (canAccessTracking) {
                    setCurrentPage('gradebook')
                  }
                }}
                disabled={!canAccessTracking}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${
                  canAccessTracking
                    ? 'bg-white border-gray-200 hover:border-emerald-400'
                    : 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                <span
                  className={`flex items-center gap-2 font-medium ${
                    canAccessTracking ? 'text-gray-800' : 'text-gray-400'
                  }`}
                >
                  <Sparkles
                    className={`w-5 h-5 ${
                      canAccessTracking ? 'text-emerald-600' : 'text-gray-300'
                    }`}
                  />
                  成績管理
                </span>
                <span className="text-xs text-gray-500">
                  {canAccessTracking ? '查詢成績與匯出' : '需要 Pro 權限'}
                </span>
              </button>
              <button
                onClick={() => {
                  if (canAccessTracking) {
                    setCurrentPage('ai-report')
                  }
                }}
                disabled={!canAccessTracking}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${
                  canAccessTracking
                    ? 'bg-white border-gray-200 hover:border-amber-400'
                    : 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                <span
                  className={`flex items-center gap-2 font-medium ${
                    canAccessTracking ? 'text-gray-800' : 'text-gray-400'
                  }`}
                >
                  <BarChart3
                    className={`w-5 h-5 ${
                      canAccessTracking ? 'text-amber-600' : 'text-gray-300'
                    }`}
                  />
                  AI 學情報告
                </span>
                <span className="text-xs text-gray-500">
                  {canAccessTracking ? '學習狀況與能力分析' : '需要 Pro 權限'}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* 法律聲明與政策 */}
        <div className="mt-6 p-4 bg-gray-50 rounded-lg text-sm text-gray-600">
          <p className="font-semibold mb-2">法律聲明與政策</p>
          <p>
            本網站內容包含 AI 生成資訊。使用本網站即表示您已閱讀並同意{' '}
            <button
              type="button"
              onClick={() => setIsAiDisclaimerOpen(true)}
              className="text-blue-600 underline underline-offset-2 hover:text-blue-700"
            >
              AI 使用免責聲明
            </button>
            、{' '}
            <button
              type="button"
              onClick={() => setIsIpDisclaimerOpen(true)}
              className="text-blue-600 underline underline-offset-2 hover:text-blue-700"
            >
              著作權聲明
            </button>
            、{' '}
            <button
              type="button"
              onClick={() => setIsTermsOpen(true)}
              className="text-blue-600 underline underline-offset-2 hover:text-blue-700"
            >
              服務條款
            </button>
            及{' '}
            <button
              type="button"
              onClick={() => setIsPrivacyOpen(true)}
              className="text-blue-600 underline underline-offset-2 hover:text-blue-700"
            >
              隱私權政策
            </button>
            。
          </p>
          <p className="mt-2 text-gray-500">
            聯絡資訊 授權合作信箱：jhanfong150983@gmail.com 專線：0981-716-650
          </p>
          <p className="mt-2 text-gray-400">
            Copyright © 2026黃政昱. All Rights Reserved.
          </p>
        </div>
      </div>

      {isAiDisclaimerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">
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

export default App
