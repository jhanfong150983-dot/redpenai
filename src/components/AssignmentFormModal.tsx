import { useState, useMemo, useEffect } from 'react'
import {
  Loader, BookOpen, Settings, Trash2, Search, Folder, Check,
  CheckCircle2, Circle, FileText, ChevronRight, Users
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import Button from '@/components/ui/Button'
import { shouldAutoFocusOnDesktop } from '@/hooks/useAutoFocusOnDesktop'

// ── Types ──────────────────────────────────────────────────────────────────

export interface GradingSettings {
  strictness: 'strict' | 'standard' | 'lenient'
  scoringMode: 'scored' | 'unscored'
  fractionRule: 'require_simplified' | 'allow_equivalent'
  multiCheckRule: 'deduct' | 'all_or_nothing' | 'partial' | 'partial_strict'
  unitErrorRule: 'zero' | 'half' | 'deduct'
  unitErrorDeduction: number
  processCreditRule: 'none' | 'half' | 'deduct'
  processCreditDeduction: number
  enPunctuationCheck: boolean
  enPunctuationDeduction: number
  enWordOrderCheck: boolean
  enWordOrderDeduction: number
}

// Modal 內部使用的表單型態：必填欄位允許 null（老師沒選時為 null）。
// 提交時會驗證所有必填欄位非 null 後才觸發 onSubmit，因此 onSubmit 拿到的是非 null 的 GradingSettings。
type FormSettings = {
  strictness: 'strict' | 'standard' | 'lenient' | null
  scoringMode: 'scored' | 'unscored' | null
  fractionRule: 'require_simplified' | 'allow_equivalent' | null
  multiCheckRule: 'deduct' | 'all_or_nothing' | 'partial' | 'partial_strict'
  unitErrorRule: 'zero' | 'half' | 'deduct'
  unitErrorDeduction: number
  processCreditRule: 'none' | 'half' | 'deduct'
  processCreditDeduction: number
  enPunctuationCheck: boolean
  enPunctuationDeduction: number
  enWordOrderCheck: boolean
  enWordOrderDeduction: number
}

export interface AssignmentFormData {
  title: string
  folder: string
  selectedAnswerKeyId: string
  settings: GradingSettings
  studentUploadEnabled: boolean
  // 2026-06-02 學生自助 AI 批改（預設關閉，老師主動打開才生效）
  allowStudentAiGrading: boolean
  studentAiGradingLimit: number
}

interface AnswerKeyOption {
  id: string
  name: string
  domain?: string
  folder?: string
  answerKey?: { questions: unknown[]; totalScore?: number }
  pageOrientations?: ('portrait' | 'landscape')[]
}

interface AssignmentFormModalProps {
  mode: 'create' | 'edit'
  open: boolean
  onClose: () => void
  onSubmit: (data: AssignmentFormData) => Promise<void>
  onDelete?: () => void
  // Initial values
  initialTitle?: string
  initialFolder?: string
  initialDomain?: string
  initialSettings?: Partial<GradingSettings>
  initialStudentUploadEnabled?: boolean
  initialAllowStudentAiGrading?: boolean
  initialStudentAiGradingLimit?: number
  initialAnswerKeyInfo?: { name?: string; domain: string; questionCount: number; totalScore: number } | null
  /** 2026-08-03:目前綁定的答案卷 id。清單上標「使用中」,不預選——預選會誤觸「換卷=清批改」。 */
  currentAnswerKeyId?: string
  // Options
  folders: string[]
  answerKeys: AnswerKeyOption[]
  // Current state
  isSubmitting?: boolean
  editAssignmentTitle?: string
  gradedCount?: number
  // 2026-07-30 行政端考卷建立重用此 modal:考卷無「學生繳交/自助批改」概念,整塊隱藏
  //(隱藏時 submit 帶預設值 false;教師端不受影響)
  hideStudentOptions?: boolean
  // 行政端文案:標題 label 改「考卷名稱」等;不傳=教師端原文案
  titleLabel?: string
  titlePlaceholder?: string
  // 2026-07-31 行政端考卷:第四步「選擇班級」——內容與勾選狀態由呼叫端管理,
  // modal 只負責步驟導航與提交閘門(ready=false 不可送出)。不傳=教師端三步不變。
  classStep?: {
    label?: string
    content: React.ReactNode
    ready: boolean
    submitLabel?: string
  }
}

// 表單初始值：必填欄位預設 null，老師必須自行選擇（避免不知不覺套到沒檢查過的預設值）
const DEFAULT_FORM_SETTINGS: FormSettings = {
  strictness: null,
  scoringMode: null,
  fractionRule: null,
  multiCheckRule: 'deduct',
  unitErrorRule: 'zero',
  unitErrorDeduction: 1,
  processCreditRule: 'none',
  processCreditDeduction: 1,
  enPunctuationCheck: false,
  enPunctuationDeduction: 1,
  enWordOrderCheck: false,
  enWordOrderDeduction: 1,
}

// ── Step config ───────────────────────────────────────────────────────────

type AssignmentStep = 'basic' | 'answer_key' | 'rules' | 'classes'

const STEP_CONFIG: { key: AssignmentStep; label: string; icon: typeof BookOpen }[] = [
  { key: 'basic', label: '基本資料', icon: BookOpen },
  { key: 'answer_key', label: '選擇答案卷', icon: FileText },
  { key: 'rules', label: '批改規則', icon: Settings },
]

// ── Strictness Card ────────────────────────────────────────────────────────

function StrictnessCard({
  value, selected, onClick
}: {
  value: 'strict' | 'standard' | 'lenient'
  selected: boolean
  onClick: () => void
}) {
  const config = {
    strict: { icon: '🔒', label: '嚴格', desc: '每個維度嚴格評分，逐項加總' },
    standard: { icon: '⚖️', label: '標準', desc: '接受同義詞和小差異，拒絕錯誤意思', badge: '建議' },
    lenient: { icon: '🌱', label: '寬鬆', desc: '核心概念對就給滿分，不扣細節分' },
  }[value]

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-xl border-2 p-3 text-left transition-colors ${
        selected
          ? 'border-green-500 bg-green-50 shadow-sm'
          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{config.icon}</span>
        <span className={`text-sm font-semibold ${selected ? 'text-green-700' : 'text-gray-700'}`}>
          {config.label}
        </span>
        {config.badge && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">
            {config.badge}
          </span>
        )}
      </div>
      <p className="text-[11px] text-gray-500 leading-tight">{config.desc}</p>
    </button>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function AssignmentFormModal({
  mode,
  open,
  onClose,
  onSubmit,
  onDelete,
  initialTitle = '',
  initialFolder = '',
  initialDomain,
  initialSettings,
  initialStudentUploadEnabled,
  initialAllowStudentAiGrading,
  initialStudentAiGradingLimit,
  initialAnswerKeyInfo,
  currentAnswerKeyId,
  folders,
  answerKeys,
  isSubmitting = false,
  editAssignmentTitle,
  gradedCount = 0,
  hideStudentOptions = false,
  titleLabel,
  titlePlaceholder,
  classStep,
}: AssignmentFormModalProps) {
  // ── Step state ──
  const [activeStep, setActiveStep] = useState<AssignmentStep>('basic')

  // ── Form state ──
  const [title, setTitle] = useState(initialTitle)
  const [folder, setFolder] = useState(initialFolder)
  const [selectedAnswerKeyId, setSelectedAnswerKeyId] = useState('')
  // 編輯模式：initialSettings 帶入既有作業的值（非 null）→ 全欄位都已選妥
  // 新增模式：initialSettings undefined → 必填欄位 null，等老師選
  const [settings, setSettings] = useState<FormSettings>({
    strictness: initialSettings?.strictness ?? null,
    scoringMode: initialSettings?.scoringMode ?? null,
    fractionRule: initialSettings?.fractionRule ?? null,
    multiCheckRule: initialSettings?.multiCheckRule ?? 'deduct',
    unitErrorRule: initialSettings?.unitErrorRule ?? 'zero',
    unitErrorDeduction: initialSettings?.unitErrorDeduction ?? 1,
    processCreditRule: initialSettings?.processCreditRule ?? 'none',
    processCreditDeduction: initialSettings?.processCreditDeduction ?? 1,
    enPunctuationCheck: initialSettings?.enPunctuationCheck ?? DEFAULT_FORM_SETTINGS.enPunctuationCheck,
    enPunctuationDeduction: initialSettings?.enPunctuationDeduction ?? DEFAULT_FORM_SETTINGS.enPunctuationDeduction,
    enWordOrderCheck: initialSettings?.enWordOrderCheck ?? DEFAULT_FORM_SETTINGS.enWordOrderCheck,
    enWordOrderDeduction: initialSettings?.enWordOrderDeduction ?? DEFAULT_FORM_SETTINGS.enWordOrderDeduction,
  })
  const [akSearch, setAkSearch] = useState('')
  const [studentUploadEnabled, setStudentUploadEnabled] = useState(initialStudentUploadEnabled ?? true)
  // 2026-06-02 學生自助 AI 批改：預設「不允許」，老師主動開
  const [allowStudentAiGrading, setAllowStudentAiGrading] = useState(initialAllowStudentAiGrading ?? false)
  const [studentAiGradingLimit, setStudentAiGradingLimit] = useState(
    Math.min(10, Math.max(1, initialStudentAiGradingLimit ?? 1))
  )

  // 2026-06-19: 本 Modal 常駐（!open 時 return null、不卸載），useState 初始值只在首次掛載生效。
  //   重開時會殘留上一次的輸入（例如剛建完 402 作業、立刻開 403 會看到 402 的最後一步/標題）。
  //   →「open 轉 true」時，把所有表單狀態重設為當前 props 的初始值（與上方 useState 初始化一致）。
  //   只依賴 [open]，避免 initialSettings 等物件每次 render 換 identity 造成編輯途中被重設。
  useEffect(() => {
    if (!open) return
    setActiveStep('basic')
    setTitle(initialTitle)
    setFolder(initialFolder)
    setSelectedAnswerKeyId('')
    setSettings({
      strictness: initialSettings?.strictness ?? null,
      scoringMode: initialSettings?.scoringMode ?? null,
      fractionRule: initialSettings?.fractionRule ?? null,
    multiCheckRule: initialSettings?.multiCheckRule ?? 'deduct',
      unitErrorRule: initialSettings?.unitErrorRule ?? 'zero',
      unitErrorDeduction: initialSettings?.unitErrorDeduction ?? 1,
      processCreditRule: initialSettings?.processCreditRule ?? 'none',
      processCreditDeduction: initialSettings?.processCreditDeduction ?? 1,
      enPunctuationCheck: initialSettings?.enPunctuationCheck ?? DEFAULT_FORM_SETTINGS.enPunctuationCheck,
      enPunctuationDeduction: initialSettings?.enPunctuationDeduction ?? DEFAULT_FORM_SETTINGS.enPunctuationDeduction,
      enWordOrderCheck: initialSettings?.enWordOrderCheck ?? DEFAULT_FORM_SETTINGS.enWordOrderCheck,
      enWordOrderDeduction: initialSettings?.enWordOrderDeduction ?? DEFAULT_FORM_SETTINGS.enWordOrderDeduction,
    })
    setAkSearch('')
    setStudentUploadEnabled(initialStudentUploadEnabled ?? true)
    setAllowStudentAiGrading(initialAllowStudentAiGrading ?? false)
    setStudentAiGradingLimit(Math.min(10, Math.max(1, initialStudentAiGradingLimit ?? 1)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const selectedAK = answerKeys.find((ak) => ak.id === selectedAnswerKeyId)
  const domain = selectedAK?.domain || initialDomain || ''

  // 從答案卷自動取得頁數和方向
  const akPageCount = useMemo(() => {
    const questions = selectedAK?.answerKey?.questions as Array<{ id?: string }> | undefined
    if (!questions?.length) return 1
    let maxPrefix = 1
    for (const q of questions) {
      const id = typeof q?.id === 'string' ? q.id : ''
      const prefix = parseInt(id.split('-')[0], 10)
      if (Number.isFinite(prefix) && prefix > maxPrefix) maxPrefix = prefix
    }
    return maxPrefix
  }, [selectedAK])

  const akOrientations = useMemo(() => {
    if (selectedAK?.pageOrientations?.length) return selectedAK.pageOrientations
    return Array.from({ length: akPageCount }, () => 'portrait' as const)
  }, [selectedAK, akPageCount])

  void folders // kept for future use

  // Group answer keys by folder
  const groupedAnswerKeys = useMemo(() => {
    const searchLower = akSearch.toLowerCase().trim()
    const filtered = searchLower
      ? answerKeys.filter((ak) =>
          ak.name.toLowerCase().includes(searchLower) ||
          (ak.domain || '').toLowerCase().includes(searchLower)
        )
      : answerKeys

    const groups = new Map<string, AnswerKeyOption[]>()
    for (const ak of filtered) {
      // 只用老師自己建立的資料夾分組，不再 fallback 到領域
      const grpKey = (ak as { folder?: string }).folder || '未分類'
      if (!groups.has(grpKey)) groups.set(grpKey, [])
      groups.get(grpKey)!.push(ak)
    }
    return Array.from(groups.entries())
      .map(([f, items]) => ({ folder: f, items: items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')) }))
      .sort((a, b) => {
        // 「未分類」永遠排到最後，其他資料夾依名稱排序
        if (a.folder === '未分類') return 1
        if (b.folder === '未分類') return -1
        return a.folder.localeCompare(b.folder, 'zh-Hant')
      })
  }, [answerKeys, akSearch])

  const updateSetting = <K extends keyof FormSettings>(key: K, value: FormSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  // ── Step completion logic ──
  // 必填規則欄位都選妥才算完成；數學領域多一個 fractionRule 必填
  const requiredRulesSet =
    settings.strictness !== null &&
    settings.scoringMode !== null &&
    (domain !== '數學' || settings.fractionRule !== null)

  const isStepComplete = (step: AssignmentStep): boolean => {
    switch (step) {
      case 'basic': return title.trim() !== ''
      case 'answer_key': return mode === 'edit' || selectedAnswerKeyId !== ''
      case 'rules': return requiredRulesSet
      case 'classes': return !!classStep?.ready
    }
  }

  const steps = classStep
    ? [...STEP_CONFIG, { key: 'classes' as AssignmentStep, label: classStep.label ?? '選擇班級', icon: Users }]
    : STEP_CONFIG

  const canSubmit =
    title.trim() !== '' &&
    (mode === 'edit' || selectedAnswerKeyId !== '') &&
    requiredRulesSet

  const handleSubmit = async () => {
    if (!requiredRulesSet) return // 安全閘門（理論上 canSubmit 已擋）
    await onSubmit({
      title,
      folder,
      selectedAnswerKeyId,
      // requiredRulesSet 確保以下 cast 安全
      settings: settings as GradingSettings,
      studentUploadEnabled,
      // 不開放繳交時自批一律關（學生根本沒卷可批）
      allowStudentAiGrading: studentUploadEnabled ? allowStudentAiGrading : false,
      studentAiGradingLimit,
    })
  }

  // ── footer dispatcher ─────────────────────────────────────────────────────
  // 主按鈕的文案 / 動作 / disabled 狀態都依 activeStep 決定，所有「下一步」按鈕統一在此。
  const isCreate = mode === 'create'
  const primary: { label: string; disabled: boolean; loading?: boolean; icon?: React.ReactNode } = (() => {
    if (activeStep === 'basic') {
      return { label: '下一步', disabled: !title.trim(), icon: <ChevronRight className="w-4 h-4" /> }
    }
    if (activeStep === 'answer_key') {
      return {
        label: '下一步',
        disabled: isCreate && selectedAnswerKeyId === '',
        icon: <ChevronRight className="w-4 h-4" />,
      }
    }
    if (activeStep === 'rules') {
      if (classStep) {
        return { label: '下一步', disabled: !canSubmit, icon: <ChevronRight className="w-4 h-4" /> }
      }
      return {
        label: isSubmitting ? '處理中…' : isCreate ? '建立作業' : '儲存設定',
        disabled: !canSubmit || isSubmitting,
        loading: isSubmitting,
        icon: <Check className="w-4 h-4" />,
      }
    }
    // classes(行政端考卷第四步)
    return {
      label: isSubmitting ? '處理中…' : classStep?.submitLabel ?? '建立考卷',
      disabled: !canSubmit || !classStep?.ready || isSubmitting,
      loading: isSubmitting,
      icon: <Check className="w-4 h-4" />,
    }
  })()

  const handlePrimaryAction = () => {
    if (activeStep === 'basic') { setActiveStep('answer_key'); return }
    if (activeStep === 'answer_key') { setActiveStep('rules'); return }
    if (activeStep === 'rules' && classStep) { setActiveStep('classes'); return }
    void handleSubmit()
  }

  const handleBack = () => {
    if (activeStep === 'classes') { setActiveStep('rules'); return }
    if (activeStep === 'rules') { setActiveStep('answer_key'); return }
    if (activeStep === 'answer_key') { setActiveStep('basic'); return }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-[900px] h-[580px] flex flex-col overflow-hidden relative">

        {/* ── Main content: sidebar + content ── */}
        <div className="flex-1 flex overflow-hidden min-h-0">

          {/* Left Step Bar */}
          <div className="w-52 bg-gray-50 border-r border-gray-200 flex flex-col shrink-0">
            <div className="px-4 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">
                {mode === 'create' ? '新增作業' : '作業設定'}
              </h2>
              {mode === 'edit' && editAssignmentTitle && (
                <p className="text-xs text-gray-500 mt-0.5 truncate">{editAssignmentTitle}</p>
              )}
            </div>
            {/* 流程清單為純文字，導航全交由 footer 主按鈕（樣式保留） */}
            <nav className="flex-1 py-2">
              {steps.map((stepCfg) => {
                const isActive = activeStep === stepCfg.key
                const completed = isStepComplete(stepCfg.key)

                return (
                  <div
                    key={stepCfg.key}
                    aria-current={isActive ? 'step' : undefined}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 text-sm select-none ${
                      isActive
                        ? 'bg-green-50 text-green-800 border-r-2 border-green-600'
                        : 'text-gray-700'
                    }`}
                  >
                    {completed ? (
                      <CheckCircle2 className={`w-5 h-5 shrink-0 ${isActive ? 'text-green-600' : 'text-green-500'}`} />
                    ) : (
                      <Circle className={`w-5 h-5 shrink-0 ${isActive ? 'text-green-600' : 'text-gray-400'}`} />
                    )}
                    <span className={`font-medium ${isActive ? 'text-green-800' : ''}`}>
                      {stepCfg.label}
                    </span>
                  </div>
                )
              })}
            </nav>
            {/* Bottom actions */}
            <div className="px-4 py-3 border-t border-gray-200 space-y-2">
              {mode === 'edit' && onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={isSubmitting}
                  className="w-full flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  刪除作業
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="w-full text-sm text-gray-500 hover:text-gray-700 py-1.5"
              >
                取消
              </button>
            </div>
          </div>

          {/* Right Content Area */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <div className="flex-1 overflow-y-auto">

              {/* ══ Step 1: 基本資料 ══ */}
              {activeStep === 'basic' && (
                <div className="p-6 pb-8 space-y-8 max-w-lg">
                  {/* 作業標題 */}
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">
                      {titleLabel ?? '作業標題'} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder={titlePlaceholder ?? '例如：114學年社會期中考'}
                      autoFocus={mode === 'create' && shouldAutoFocusOnDesktop()}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                    />
                  </div>

                  {/* 學生繳交作業 — segmented control(行政端考卷模式整塊隱藏) */}
                  {!hideStudentOptions && (
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">學生繳交作業</label>
                    <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setStudentUploadEnabled(true)}
                        className={`px-5 py-2 text-sm font-medium transition-colors ${
                          studentUploadEnabled
                            ? 'bg-green-600 text-white'
                            : 'bg-white text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        開放學生繳交
                      </button>
                      <button
                        type="button"
                        onClick={() => setStudentUploadEnabled(false)}
                        className={`px-5 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                          !studentUploadEnabled
                            ? 'bg-green-600 text-white'
                            : 'bg-white text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        不開放
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {studentUploadEnabled ? '學生可拍照上傳作業' : '老師自行上傳批改'}
                    </p>
                    {/* 拍攝規則提示 */}
                    {studentUploadEnabled && selectedAK && (
                      <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs text-blue-700">
                        學生需上傳 {akPageCount} 頁照片（{akOrientations.map((o, i) => `第${i + 1}頁${o === 'portrait' ? '直拍' : '橫拍'}`).join('、')}）
                      </div>
                    )}

                    {/* 2026-06-02 學生自助 AI 批改（僅開放繳交時顯示，預設不允許） */}
                    {studentUploadEnabled && (
                      <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50/60 px-4 py-3">
                        <label className="block text-sm font-semibold text-gray-800 mb-2">學生自助 AI 批改</label>
                        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                          <button
                            type="button"
                            onClick={() => setAllowStudentAiGrading(true)}
                            className={`px-5 py-2 text-sm font-medium transition-colors ${
                              allowStudentAiGrading
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            允許
                          </button>
                          <button
                            type="button"
                            onClick={() => setAllowStudentAiGrading(false)}
                            className={`px-5 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                              !allowStudentAiGrading
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            不允許
                          </button>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          學生上傳後可自己跑 AI 批改（含複核），費用記在老師帳上。
                        </p>
                        {allowStudentAiGrading && (
                          <div className="mt-3 flex items-center gap-2 text-sm text-gray-700">
                            <span>每位學生可自助批改</span>
                            <input
                              type="number"
                              min={1}
                              max={10}
                              value={studentAiGradingLimit}
                              onChange={(e) => {
                                const n = parseInt(e.target.value, 10)
                                setStudentAiGradingLimit(Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 1)
                              }}
                              className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                            />
                            <span>次（跑完才算一次）</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  )}

                  {!title.trim() && (
                    <p className="text-xs text-amber-600">請填寫{titleLabel ?? '作業標題'}以繼續</p>
                  )}
                </div>
              )}

              {/* ══ Step 4(行政端考卷): 選擇班級 ══ */}
              {activeStep === 'classes' && classStep && (
                <div className="p-6 space-y-4">{classStep.content}</div>
              )}

              {/* ══ Step 2: 選擇答案卷 ══ */}
              {activeStep === 'answer_key' && (
                <div className="p-6 space-y-5">
                  {/* 目前答案卷（編輯模式） */}
                  {mode === 'edit' && initialAnswerKeyInfo && (
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                      <p className="text-xs text-gray-500 mb-1">目前答案卷</p>
                      <p className="text-sm font-medium text-gray-900">
                        {initialAnswerKeyInfo.name && <>{initialAnswerKeyInfo.name} · </>}{initialAnswerKeyInfo.domain || '未設定領域'} · {initialAnswerKeyInfo.questionCount} 題 · 總分 {initialAnswerKeyInfo.totalScore}
                      </p>
                    </div>
                  )}

                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">
                      {mode === 'create' ? '選擇答案卷' : '更換答案卷（選填）'}
                      {mode === 'create' && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    {/* 搜尋框 */}
                    <div className="relative mb-3">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        value={akSearch}
                        onChange={(e) => setAkSearch(e.target.value)}
                        placeholder="搜尋答案卷…"
                        className="w-full rounded-lg border border-gray-300 pl-9 pr-4 py-2.5 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                      />
                    </div>
                    {/* 答案卷列表 */}
                    <div className="rounded-lg border border-gray-200 max-h-72 overflow-y-auto">
                      {mode === 'edit' && (
                        <button
                          type="button"
                          onClick={() => setSelectedAnswerKeyId('')}
                          className={`w-full text-left px-4 py-2.5 text-sm border-b border-gray-100 transition-colors ${
                            !selectedAnswerKeyId ? 'bg-green-50 text-green-700 font-medium' : 'hover:bg-gray-50 text-gray-600'
                          }`}
                        >
                          不更換
                        </button>
                      )}
                      {groupedAnswerKeys.length === 0 && (
                        <div className="px-4 py-8 text-center text-sm text-gray-400">
                          {akSearch ? '找不到符合的答案卷' : '尚無答案卷'}
                        </div>
                      )}
                      {groupedAnswerKeys.map(({ folder: grpFolder, items }) => (
                        <div key={grpFolder}>
                          <div className="flex items-center gap-2 px-4 py-2 bg-gray-100 border-b border-gray-200 sticky top-0">
                            <Folder className="w-4 h-4 text-gray-600" />
                            <span className="text-base font-bold text-gray-800">{grpFolder}</span>
                          </div>
                          {items.map((ak) => {
                            const isSelected = selectedAnswerKeyId === ak.id
                            const isCurrent = !!currentAnswerKeyId && ak.id === currentAnswerKeyId
                            return (
                              <button
                                key={ak.id}
                                type="button"
                                onClick={() => setSelectedAnswerKeyId(isSelected ? '' : ak.id)}
                                className={`w-full text-left px-4 py-2.5 border-b border-gray-50 transition-colors flex items-center gap-3 ${
                                  isSelected ? 'bg-green-50' : 'hover:bg-gray-50'
                                }`}
                              >
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                                  isSelected ? 'border-green-500 bg-green-500' : 'border-gray-300'
                                }`}>
                                  {isSelected && <Check className="w-3 h-3 text-white" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className={`flex items-center gap-1.5 text-sm ${isSelected ? 'text-green-800 font-medium' : 'text-gray-800'}`}>
                                    <span className="truncate">{ak.name}</span>
                                    {isCurrent && (
                                      <span className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                                        使用中
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-gray-400">
                                    {ak.domain || '未設定領域'} · {ak.answerKey?.questions?.length ?? 0} 題
                                    {ak.answerKey?.totalScore ? ` · ${ak.answerKey.totalScore} 分` : ''}
                                  </div>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                    {mode === 'edit' && selectedAK && gradedCount > 0 && (
                      <p className="mt-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        更換答案卷將清除 {gradedCount} 份批改結果，需重新批改
                      </p>
                    )}
                  </div>

                  {mode === 'create' && !selectedAnswerKeyId && (
                    <p className="text-xs text-amber-600">請選擇答案卷以繼續</p>
                  )}
                </div>
              )}

              {/* ══ Step 3: 批改規則 ══ */}
              {activeStep === 'rules' && (
                <div className="p-6 space-y-8">
                  {/* 計分方式 */}
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">計分方式</label>
                    <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => updateSetting('scoringMode', 'scored')}
                        className={`px-5 py-2 text-sm font-medium transition-colors ${
                          settings.scoringMode === 'scored'
                            ? 'bg-green-600 text-white'
                            : 'bg-white text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        計分
                      </button>
                      <button
                        type="button"
                        onClick={() => updateSetting('scoringMode', 'unscored')}
                        className={`px-5 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                          settings.scoringMode === 'unscored'
                            ? 'bg-green-600 text-white'
                            : 'bg-white text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        不計分
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {settings.scoringMode === null
                        ? '請選擇計分方式'
                        : settings.scoringMode === 'scored' ? '顯示每題分數和總分' : '只顯示對錯符號'}
                    </p>
                  </div>

                  {/* 問答題嚴謹度 */}
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-3">問答題嚴謹度</label>
                    <div className="flex gap-3">
                      <StrictnessCard value="strict" selected={settings.strictness === 'strict'} onClick={() => updateSetting('strictness', 'strict')} />
                      <StrictnessCard value="standard" selected={settings.strictness === 'standard'} onClick={() => updateSetting('strictness', 'standard')} />
                      <StrictnessCard value="lenient" selected={settings.strictness === 'lenient'} onClick={() => updateSetting('strictness', 'lenient')} />
                    </div>
                    {settings.strictness === null && (
                      <p className="mt-2 text-xs text-slate-500">請選擇問答題嚴謹度</p>
                    )}
                  </div>

                  {/* 2026-08-15 多選題計分（user 拍板 B 案）：原本 AI 自行「答對一個給一半」，
                      答案卷裡沒有這條規則 → 不同批次可能給不同分。改成正式設定、老師改得動。 */}
                  <div>
                    <label className="block text-base font-semibold text-gray-800 mb-2">多選題計分</label>
                    <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                      {([
                        ['deduct', '按比例扣分'],
                        ['all_or_nothing', '全對才給分'],
                        ['partial', '答對幾個給幾分'],
                      ] as const).map(([val, label], i) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => updateSetting('multiCheckRule', val)}
                          className={`px-4 py-2 text-sm font-medium transition-colors ${i > 0 ? 'border-l border-gray-300' : ''} ${
                            settings.multiCheckRule === val ? 'bg-green-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {settings.multiCheckRule === 'deduct'
                        ? '每漏選或誤選一個，扣滿分÷正解數、下限 0。正解 1,3（2 分）：只選 1 → 1 分、選 3,4 → 0 分；正解 1,3,4（15 分）：漏一個 → 10 分'
                        : settings.multiCheckRule === 'all_or_nothing'
                          ? '正解 1,3；只要不完全相同 → 0 分'
                          : '正解 1,3（2 分）：滿分 × 選對數/正解數，誤選不倒扣。選 3,4 → 1 分'}
                    </p>
                  </div>

                  {/* 領域專屬規則 */}
                  {domain === '數學' && (
                    <div>
                      <label className="block text-base font-semibold text-gray-800 mb-2">數學專屬規則</label>
                      <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => updateSetting('fractionRule', 'require_simplified')}
                          className={`px-4 py-2 text-sm font-medium transition-colors ${
                            settings.fractionRule === 'require_simplified'
                              ? 'bg-green-600 text-white'
                              : 'bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          必須最簡分數
                        </button>
                        <button
                          type="button"
                          onClick={() => updateSetting('fractionRule', 'allow_equivalent')}
                          className={`px-4 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                            settings.fractionRule === 'allow_equivalent'
                              ? 'bg-green-600 text-white'
                              : 'bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          接受等值分數
                        </button>
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        {settings.fractionRule === null
                          ? '請選擇分數規則'
                          : settings.fractionRule === 'require_simplified' ? '2/4 判錯，必須寫 1/2' : '2/4 = 1/2 都算對'}
                      </p>
                      {/* 2026-07-15 單位錯誤計分（user 拍板留給老師設定） */}
                      <div className="mt-4">
                        <label className="block text-sm font-semibold text-gray-800 mb-2">單位錯誤計分</label>
                        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                          <button
                            type="button"
                            onClick={() => updateSetting('unitErrorRule', 'zero')}
                            className={`px-4 py-2 text-sm font-medium transition-colors ${
                              settings.unitErrorRule === 'zero'
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            整題 0 分
                          </button>
                          <button
                            type="button"
                            onClick={() => updateSetting('unitErrorRule', 'half')}
                            className={`px-4 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                              settings.unitErrorRule === 'half'
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            給一半分數
                          </button>
                          <button
                            type="button"
                            onClick={() => updateSetting('unitErrorRule', 'deduct')}
                            className={`px-4 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                              settings.unitErrorRule === 'deduct'
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            扣固定分數
                          </button>
                        </div>
                        {settings.unitErrorRule === 'deduct' && (
                          <div className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                            <span>每題單位錯扣</span>
                            <input
                              type="number"
                              min={0.5}
                              max={20}
                              step={0.5}
                              value={settings.unitErrorDeduction}
                              onChange={(e) => updateSetting('unitErrorDeduction', Math.max(0.5, Math.min(20, Number(e.target.value) || 1)))}
                              className="w-20 px-2 py-1 rounded border border-gray-300 text-center focus:outline-none focus:ring-2 focus:ring-green-300"
                            />
                            <span>分（扣到該題 0 分為止）</span>
                          </div>
                        )}
                        <p className="mt-2 text-xs text-slate-500">
                          {settings.unitErrorRule === 'zero'
                            ? '數值對但單位錯（如 477.28 cm² vs 477.28 m²）→ 整題 0 分'
                            : settings.unitErrorRule === 'half'
                              ? '數值對但單位錯或缺單位 → 給該題一半分數；數值錯仍 0 分'
                              : `數值對但單位錯或缺單位 → 該題扣 ${settings.unitErrorDeduction} 分；數值錯仍 0 分`}
                        </p>
                      </div>
                      {/* 2026-07-16 應用題過程分（user 拍板：答案錯但過程對→AI 看手寫過程窄判定、依此給部分分） */}
                      <div className="mt-4">
                        <label className="block text-sm font-semibold text-gray-800 mb-2">應用題過程分</label>
                        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                          <button
                            type="button"
                            onClick={() => updateSetting('processCreditRule', 'none')}
                            className={`px-4 py-2 text-sm font-medium transition-colors ${
                              settings.processCreditRule === 'none'
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            不給分
                          </button>
                          <button
                            type="button"
                            onClick={() => updateSetting('processCreditRule', 'half')}
                            className={`px-4 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                              settings.processCreditRule === 'half'
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            給一半分數
                          </button>
                          <button
                            type="button"
                            onClick={() => updateSetting('processCreditRule', 'deduct')}
                            className={`px-4 py-2 text-sm font-medium border-l border-gray-300 transition-colors ${
                              settings.processCreditRule === 'deduct'
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-600 hover:bg-gray-50'
                            }`}
                          >
                            扣固定分數
                          </button>
                        </div>
                        {settings.processCreditRule === 'deduct' && (
                          <div className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                            <span>過程對但答案錯，每題扣</span>
                            <input
                              type="number"
                              min={0.5}
                              max={20}
                              step={0.5}
                              value={settings.processCreditDeduction}
                              onChange={(e) => updateSetting('processCreditDeduction', Math.max(0.5, Math.min(20, Number(e.target.value) || 1)))}
                              className="w-20 px-2 py-1 rounded border border-gray-300 text-center focus:outline-none focus:ring-2 focus:ring-green-300"
                            />
                            <span>分（扣到該題 0 分為止）</span>
                          </div>
                        )}
                        <p className="mt-2 text-xs text-slate-500">
                          {settings.processCreditRule === 'none'
                            ? '應用題最終答案錯 → 整題 0 分（不看過程）'
                            : `最終答案錯時 AI 會檢視手寫計算過程：列式與過程正確、僅最後算錯/抄錯 → ${settings.processCreditRule === 'half' ? '給該題一半分數' : `該題扣 ${settings.processCreditDeduction} 分`}；過程本身有錯仍 0 分`}
                        </p>
                      </div>
                    </div>
                  )}

                  {domain === '英語' && (
                    <div>
                      <label className="block text-base font-semibold text-gray-800 mb-3">英語專屬規則</label>
                      <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={settings.enPunctuationCheck}
                            onChange={(e) => updateSetting('enPunctuationCheck', e.target.checked)}
                            className="w-4 h-4 accent-green-600 shrink-0"
                          />
                          <div className="flex-1">
                            <span className="text-sm text-gray-700">標點符號檢查</span>
                            {settings.enPunctuationCheck && (
                              <span className="text-xs text-gray-500 ml-2">
                                每錯扣{' '}
                                <NumericInput
                                  min={1} max={5}
                                  value={settings.enPunctuationDeduction}
                                  onChange={(v) => updateSetting('enPunctuationDeduction', typeof v === 'number' ? v : 1)}
                                  className="inline-block w-12 px-1 py-0.5 border border-gray-300 rounded text-center text-xs"
                                />{' '}分
                              </span>
                            )}
                          </div>
                        </label>
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={settings.enWordOrderCheck}
                            onChange={(e) => updateSetting('enWordOrderCheck', e.target.checked)}
                            className="w-4 h-4 accent-green-600 shrink-0"
                          />
                          <div className="flex-1">
                            <span className="text-sm text-gray-700">單字順序 / 缺漏檢查</span>
                            {settings.enWordOrderCheck && (
                              <span className="text-xs text-gray-500 ml-2">
                                每錯扣{' '}
                                <NumericInput
                                  min={1} max={5}
                                  value={settings.enWordOrderDeduction}
                                  onChange={(v) => updateSetting('enWordOrderDeduction', typeof v === 'number' ? v : 1)}
                                  className="inline-block w-12 px-1 py-0.5 border border-gray-300 rounded text-center text-xs"
                                />{' '}分
                              </span>
                            )}
                          </div>
                        </label>
                      </div>
                    </div>
                  )}

                  {!domain && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
                      選擇答案卷後，會根據領域顯示專屬批改規則
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Footer：上一步 + 主按鈕（dispatcher） ── */}
            <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-200 bg-gray-50 shrink-0">
              {/* 上一步：basic 隱藏 */}
              {activeStep !== 'basic' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleBack}
                  disabled={isSubmitting}
                >
                  上一步
                </Button>
              )}

              {/* 主按鈕（右下角，文案與動作隨 step 變化） */}
              <Button
                type="button"
                variant="primary"
                onClick={handlePrimaryAction}
                disabled={primary.disabled}
                className="ml-auto"
              >
                {primary.loading ? <Loader className="w-4 h-4 animate-spin" /> : primary.icon}
                {primary.label}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
