import { useRef, useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft,
  Loader,
  Save,
  Eye,
  RotateCcw,
  RefreshCw,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  AlertCircle
} from 'lucide-react'
import { loadReportHeaderSettings, saveReportHeaderSettings, type ReportHeaderSettings } from '@/lib/parentReport'
import { NumericInput } from '@/components/NumericInput'
import { requestSync } from '@/lib/sync-events'

interface Campus1Binding {
  account: string
  dsns: string
  displayName?: string
  roleType?: string
}

interface TeacherPreferencesProps {
  onBack?: () => void
  embedded?: boolean
  campus1Binding?: Campus1Binding
  campus1Bindings?: Campus1Binding[]
}

interface Preferences {
  student_portal_enabled: boolean
  show_score_to_students: boolean
  max_correction_attempts: number
  correction_dispatch_mode: 'manual' | 'auto'
  student_feedback_visibility: 'status_only' | 'score_only' | 'score_reason' | 'full'
}

function ToggleSwitch({
  checked,
  onChange,
  disabled = false
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-sky-600' : 'bg-slate-300'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

function SectionCard({
  title,
  icon: Icon,
  children
}: {
  title: string
  icon: React.ElementType
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-5 w-5 text-slate-500" />
        <h2 className="text-base font-bold text-slate-800">{title}</h2>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

function SettingRow({
  label,
  description,
  children
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-800">{label}</p>
        {description && (
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const FEEDBACK_VISIBILITY_OPTIONS: Array<{
  value: Preferences['student_feedback_visibility']
  label: string
  description: string
}> = [
  { value: 'status_only', label: '僅狀態', description: '學生只看到已批改/未批改' },
  { value: 'score_only', label: '狀態＋分數', description: '學生可看分數' },
  { value: 'score_reason', label: '狀態＋分數＋錯因', description: '推薦：讓學生了解錯在哪' },
  { value: 'full', label: '完整回饋', description: '顯示所有批改內容' }
]

const DEFAULT_PREFS: Preferences = {
  student_portal_enabled: true,
  show_score_to_students: false,
  max_correction_attempts: 3,
  correction_dispatch_mode: 'manual',
  student_feedback_visibility: 'score_reason'
}

export default function TeacherPreferences({
  onBack,
  embedded = false,
  campus1Binding,
  campus1Bindings
}: TeacherPreferencesProps) {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  // 哪一個 dsns 正在同步（同時只允許一校同步，避免併發）
  const [syncingDsns, setSyncingDsns] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 同步結果訊息以 dsns 為 key，各校獨立顯示
  const [campus1SyncMessages, setCampus1SyncMessages] = useState<
    Record<string, { type: 'success' | 'error'; text: string }>
  >({})
  const [saveSuccess, setSaveSuccess] = useState(false)

  // 老師可能任教多校 → 優先用 campus1Bindings 清單，退回單一 campus1Binding。
  // 完全中學「一人多部」(同 account、不同 dsns) 會有多列身分；同步端點以 dsns 為單位，
  // 故同一 dsns 只保留一列，避免重複按鈕 / React key 衝突。
  const syncBindings: Campus1Binding[] = (() => {
    const raw = (
      campus1Bindings && campus1Bindings.length
        ? campus1Bindings
        : campus1Binding
          ? [campus1Binding]
          : []
    ).filter((b) => b && b.dsns)
    const seen = new Set<string>()
    return raw.filter((b) => {
      if (seen.has(b.dsns)) return false
      seen.add(b.dsns)
      return true
    })
  })()

  const loadPreferences = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/data/teacher-preferences', {
        credentials: 'include'
      })
      if (!res.ok) throw new Error('讀取失敗')
      const data = await res.json()
      const p = data.preferences
      setPrefs({
        student_portal_enabled: p.student_portal_enabled ?? DEFAULT_PREFS.student_portal_enabled,
        show_score_to_students: p.show_score_to_students ?? DEFAULT_PREFS.show_score_to_students,
        max_correction_attempts: p.max_correction_attempts ?? DEFAULT_PREFS.max_correction_attempts,
        correction_dispatch_mode: p.correction_dispatch_mode ?? DEFAULT_PREFS.correction_dispatch_mode,
        student_feedback_visibility: p.student_feedback_visibility ?? DEFAULT_PREFS.student_feedback_visibility
      })
    } catch {
      setError('無法讀取設定，請稍後再試')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPreferences()
  }, [loadPreferences])

  const handleSave = async () => {
    if (isSaving) return
    setIsSaving(true)
    setError(null)
    setSaveSuccess(false)
    try {
      const res = await fetch('/api/data/teacher-preferences', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentPortalEnabled: prefs.student_portal_enabled,
          showScoreToStudents: prefs.show_score_to_students,
          maxCorrectionAttempts: prefs.max_correction_attempts,
          correctionDispatchMode: prefs.correction_dispatch_mode,
          studentFeedbackVisibility: prefs.student_feedback_visibility
        })
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '儲存失敗')
      }
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗，請稍後再試')
    } finally {
      setIsSaving(false)
    }
  }

  const handleCampus1Sync = async (rawDsns: string) => {
    if (syncingDsns) return
    const dsns = String(rawDsns || '').trim()
    if (!dsns) {
      setCampus1SyncMessages((prev) => ({
        ...prev,
        ['']: { type: 'error', text: '找不到 1Campus dsns，請重新綁定後再試' }
      }))
      return
    }

    setCampus1SyncMessages((prev) => {
      const next = { ...prev }
      delete next[dsns]
      return next
    })
    setSyncingDsns(dsns)
    try {
      const res = await fetch('/api/data/1campus-classroom-sync', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dsns })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.error || '1Campus 同步失敗')
      }

      const synced = Number(data?.synced ?? 0)
      const total = Number(data?.total ?? 0)
      setCampus1SyncMessages((prev) => ({
        ...prev,
        [dsns]: { type: 'success', text: `同步完成：${synced}/${total} 班` }
      }))
      requestSync(true)
    } catch (err) {
      setCampus1SyncMessages((prev) => ({
        ...prev,
        [dsns]: {
          type: 'error',
          text: err instanceof Error ? err.message : '1Campus 同步失敗'
        }
      }))
    } finally {
      setSyncingDsns(null)
    }
  }

  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className={embedded ? 'bg-white p-0' : 'min-h-screen bg-white p-4'}>
      <div className={embedded ? 'max-w-none mx-0 pt-0' : 'max-w-2xl mx-auto pt-8'}>
        {onBack && !embedded && (
          <button
            type="button"
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
            返回首頁
          </button>
        )}

        {/* 標題區 */}
        <div className="mb-4 border-b border-slate-200 pb-3">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold text-gray-900">偏好設定</h1>
            {isLoading && (
              <Loader className="h-5 w-5 animate-spin text-slate-400" />
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader className="h-8 w-8 animate-spin text-slate-300" />
          </div>
        ) : (
          <div className="space-y-4">

            {/* 1. 學生端顯示分數 */}
            <SectionCard title="學生端設定" icon={Eye}>
              <SettingRow
                label="顯示分數給學生"
                description="學生進入批改連結時是否可看到分數"
              >
                <ToggleSwitch
                  checked={prefs.show_score_to_students}
                  onChange={(v) => set('show_score_to_students', v)}
                />
              </SettingRow>
              <div className="border-t border-slate-100 pt-4">
                <p className="mb-3 text-sm font-medium text-slate-800">學生可見內容等級</p>
                <div className="space-y-2">
                  {FEEDBACK_VISIBILITY_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                        prefs.student_feedback_visibility === opt.value
                          ? 'border-sky-300 bg-sky-50'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="student_feedback_visibility"
                        value={opt.value}
                        checked={prefs.student_feedback_visibility === opt.value}
                        onChange={() => set('student_feedback_visibility', opt.value)}
                        className="mt-0.5 accent-sky-600"
                      />
                      <div>
                        <p className="text-sm font-medium text-slate-800">{opt.label}</p>
                        <p className="text-xs text-slate-500">{opt.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </SectionCard>

            {/* 2. 訂正設定 */}
            <SectionCard title="訂正設定" icon={RotateCcw}>
              <SettingRow
                label="訂正派發模式"
                description="批改後是否自動派發訂正，或由老師手動發送"
              >
                <select
                  value={prefs.correction_dispatch_mode}
                  onChange={(e) =>
                    set('correction_dispatch_mode', e.target.value as Preferences['correction_dispatch_mode'])
                  }
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                >
                  <option value="manual">手動派發</option>
                  <option value="auto">批改後自動派發</option>
                </select>
              </SettingRow>
              <SettingRow
                label="訂正次數上限"
                description="每位學生最多可訂正幾次（1–10）"
              >
                <NumericInput
                  value={prefs.max_correction_attempts}
                  min={1}
                  max={10}
                  onChange={(v) => {
                    const n = typeof v === 'number' ? v : parseInt(String(v), 10)
                    if (Number.isFinite(n)) set('max_correction_attempts', n)
                  }}
                  className="w-20 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-center text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                />
              </SettingRow>
            </SectionCard>

            {syncBindings.length > 0 && (
              <SectionCard title="1Campus 同步" icon={RefreshCw}>
                {syncBindings.map((binding, index) => {
                  const msg = campus1SyncMessages[binding.dsns]
                  const isThisSyncing = syncingDsns === binding.dsns
                  const multi = syncBindings.length > 1
                  return (
                    <div
                      key={binding.dsns}
                      className={
                        index > 0
                          ? 'space-y-2 border-t border-slate-100 pt-4'
                          : 'space-y-2'
                      }
                    >
                      <SettingRow
                        label={
                          multi
                            ? `同步「${binding.displayName || binding.dsns}」班級與學生`
                            : '立即同步班級與學生'
                        }
                        description={`來源：${binding.dsns}`}
                      >
                        <button
                          type="button"
                          onClick={() => handleCampus1Sync(binding.dsns)}
                          disabled={!!syncingDsns}
                          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isThisSyncing ? (
                            <Loader className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          {isThisSyncing ? '同步中…' : '立即同步 1Campus'}
                        </button>
                      </SettingRow>
                      {msg && (
                        <div
                          className={`rounded-lg border px-3 py-2 text-sm ${
                            msg.type === 'success'
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                              : 'border-red-200 bg-red-50 text-red-700'
                          }`}
                        >
                          {msg.text}
                        </div>
                      )}
                    </div>
                  )
                })}
              </SectionCard>
            )}

            {/* 家長報告設定（localStorage、本機保留、與上方 server 設定分開即時儲存） */}
            <ParentReportSettings />

            {/* 儲存按鈕 */}
            <div className="flex items-center justify-end gap-3 pb-8">
              {saveSuccess && (
                <span className="flex items-center gap-1.5 text-sm text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                  已儲存
                </span>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? (
                  <Loader className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {isSaving ? '儲存中…' : '儲存設定'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// 家長報告抬頭設定（校名/校徽/老師）——本機即時儲存（localStorage），供學情報告「家長報告」分頁一鍵套用。
function ParentReportSettings() {
  const [v, setV] = useState<ReportHeaderSettings>(loadReportHeaderSettings())
  const [saved, setSaved] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState('')

  const update = (patch: Partial<ReportHeaderSettings>) => {
    const next = { ...v, ...patch }
    setV(next)
    saveReportHeaderSettings(next)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }
  const onPickCrest = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { setErr('校徽圖片請小於 2MB'); return }
    setErr('')
    const reader = new FileReader()
    reader.onload = () => update({ crestDataUrl: typeof reader.result === 'string' ? reader.result : undefined })
    reader.readAsDataURL(file)
  }

  return (
    <SectionCard title="家長報告設定" icon={FileText}>
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-800">學校名稱</label>
          <input
            value={v.schoolName}
            onChange={(e) => update({ schoolName: e.target.value })}
            placeholder="例：○○私立高級中學附設國中部"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
          />
          <p className="mt-1 text-xs text-slate-400">顯示在家長報告的抬頭。</p>
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mb-1.5 block text-sm font-medium text-slate-800">任課老師（選填）</label>
            <input
              value={v.teacherName ?? ''}
              onChange={(e) => update({ teacherName: e.target.value })}
              placeholder="例：林○○"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-800">校徽（選填）</label>
            <div className="flex items-center gap-2">
              {v.crestDataUrl
                ? <img src={v.crestDataUrl} alt="校徽" className="h-10 w-10 rounded border border-slate-200 object-contain" />
                : <div className="flex h-10 w-10 items-center justify-center rounded border border-dashed border-slate-300 text-slate-300"><ImageIcon className="h-4 w-4" /></div>}
              <button type="button" onClick={() => fileRef.current?.click()} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                {v.crestDataUrl ? '更換' : '上傳'}
              </button>
              {v.crestDataUrl && <button type="button" onClick={() => update({ crestDataUrl: undefined })} className="text-sm text-slate-400 hover:text-slate-600">移除</button>}
              <input ref={fileRef} type="file" accept="image/*" onChange={onPickCrest} className="hidden" />
            </div>
          </div>
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex items-center gap-2 text-xs text-slate-400">
          {saved ? <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" />已儲存</span> : <span>修改會自動儲存於本機。</span>}
        </div>
      </div>
    </SectionCard>
  )
}
