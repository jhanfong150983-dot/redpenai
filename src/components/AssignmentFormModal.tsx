import { useState, useMemo } from 'react'
import {
  Loader, BookOpen, Settings, Trash2, Search, Folder, Check,
  CheckCircle2, Circle, FileText
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'

// ── Types ──────────────────────────────────────────────────────────────────

export interface GradingSettings {
  strictness: 'strict' | 'standard' | 'lenient'
  scoringMode: 'scored' | 'unscored'
  fractionRule: 'require_simplified' | 'allow_equivalent'
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
  initialAnswerKeyInfo?: { domain: string; questionCount: number; totalScore: number } | null
  // Options
  folders: string[]
  answerKeys: AnswerKeyOption[]
  // Current state
  isSubmitting?: boolean
  editAssignmentTitle?: string
  gradedCount?: number
}

const DEFAULT_SETTINGS: GradingSettings = {
  strictness: 'standard',
  scoringMode: 'scored',
  fractionRule: 'require_simplified',
  enPunctuationCheck: false,
  enPunctuationDeduction: 1,
  enWordOrderCheck: false,
  enWordOrderDeduction: 1,
}

// ── Step config ───────────────────────────────────────────────────────────

type AssignmentStep = 'basic' | 'answer_key' | 'rules'

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
    standard: { icon: '⚖️', label: '標準', desc: '接受同義詞和小差異，拒絕錯誤意思', badge: '預設' },
    lenient: { icon: '🌱', label: '寬鬆', desc: '核心概念對就給滿分，不扣細節分' },
  }[value]

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-xl border-2 p-3 text-left transition-all ${
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
  initialAnswerKeyInfo,
  folders,
  answerKeys,
  isSubmitting = false,
  editAssignmentTitle,
  gradedCount = 0,
}: AssignmentFormModalProps) {
  // ── Step state ──
  const [activeStep, setActiveStep] = useState<AssignmentStep>('basic')

  // ── Form state ──
  const [title, setTitle] = useState(initialTitle)
  const [folder] = useState(initialFolder)
  const [selectedAnswerKeyId, setSelectedAnswerKeyId] = useState('')
  const [settings, setSettings] = useState<GradingSettings>({ ...DEFAULT_SETTINGS, ...initialSettings })
  const [akSearch, setAkSearch] = useState('')
  const [studentUploadEnabled, setStudentUploadEnabled] = useState(initialStudentUploadEnabled ?? true)

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
      const grpKey = (ak as { folder?: string }).folder || ak.domain || '未分類'
      if (!groups.has(grpKey)) groups.set(grpKey, [])
      groups.get(grpKey)!.push(ak)
    }
    return Array.from(groups.entries())
      .map(([f, items]) => ({ folder: f, items: items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')) }))
      .sort((a, b) => a.folder.localeCompare(b.folder, 'zh-Hant'))
  }, [answerKeys, akSearch])

  const updateSetting = <K extends keyof GradingSettings>(key: K, value: GradingSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  // ── Step completion logic ──
  const isStepComplete = (step: AssignmentStep): boolean => {
    switch (step) {
      case 'basic': return title.trim() !== ''
      case 'answer_key': return mode === 'edit' || selectedAnswerKeyId !== ''
      case 'rules': return true // always complete (has defaults)
    }
  }

  const canSubmit = title.trim() !== '' && (mode === 'edit' || selectedAnswerKeyId !== '')

  const handleSubmit = async () => {
    await onSubmit({ title, folder, selectedAnswerKeyId, settings, studentUploadEnabled })
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
            <nav className="flex-1 py-2">
              {STEP_CONFIG.map((stepCfg) => {
                const isActive = activeStep === stepCfg.key
                const completed = isStepComplete(stepCfg.key)

                return (
                  <button
                    key={stepCfg.key}
                    type="button"
                    onClick={() => setActiveStep(stepCfg.key)}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors text-sm ${
                      isActive
                        ? 'bg-green-50 text-green-800 border-r-2 border-green-600'
                        : 'text-gray-700 hover:bg-gray-100'
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
                  </button>
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
                      作業標題 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="例如：114學年社會期中考"
                      autoFocus={mode === 'create'}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100"
                    />
                  </div>

                  {/* 學生繳交作業 — segmented control */}
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
                  </div>

                  {!title.trim() && (
                    <p className="text-xs text-amber-600">請填寫作業標題以繼續</p>
                  )}
                </div>
              )}

              {/* ══ Step 2: 選擇答案卷 ══ */}
              {activeStep === 'answer_key' && (
                <div className="p-6 space-y-5">
                  {/* 目前答案卷（編輯模式） */}
                  {mode === 'edit' && initialAnswerKeyInfo && (
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                      <p className="text-xs text-gray-500 mb-1">目前答案卷</p>
                      <p className="text-sm font-medium text-gray-900">
                        {initialAnswerKeyInfo.domain || '未設定領域'} · {initialAnswerKeyInfo.questionCount} 題 · 總分 {initialAnswerKeyInfo.totalScore}
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
                        placeholder="搜尋答案卷..."
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
                          <div className="flex items-center gap-1.5 px-4 py-1.5 bg-gray-50 border-b border-gray-100 sticky top-0">
                            <Folder className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{grpFolder}</span>
                          </div>
                          {items.map((ak) => {
                            const isSelected = selectedAnswerKeyId === ak.id
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
                                  <div className={`text-sm truncate ${isSelected ? 'text-green-800 font-medium' : 'text-gray-800'}`}>
                                    {ak.name}
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
                      {settings.scoringMode === 'scored' ? '顯示每題分數和總分' : '只顯示對錯符號'}
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
                        {settings.fractionRule === 'require_simplified' ? '2/4 判錯，必須寫 1/2' : '2/4 = 1/2 都算對'}
                      </p>
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

            {/* ── Footer ── */}
            <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-gray-200 bg-gray-50 shrink-0">
              <button
                type="button"
                disabled={!canSubmit || isSubmitting}
                onClick={() => void handleSubmit()}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                {isSubmitting ? '處理中…' : mode === 'create' ? '建立作業' : '儲存設定'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
