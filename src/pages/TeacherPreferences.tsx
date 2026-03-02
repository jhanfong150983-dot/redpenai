import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft,
  Loader,
  Save,
  Bell,
  Eye,
  RotateCcw,
  Volume2,
  CheckCircle2,
  AlertCircle
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'

interface TeacherPreferencesProps {
  onBack?: () => void
  embedded?: boolean
}

interface NotificationEvents {
  submission_uploaded: boolean
  grading_completed: boolean
  correction_dispatched: boolean
  correction_submitted: boolean
  correction_limit_reached: boolean
  correction_due_reminder: boolean
}

interface Preferences {
  student_portal_enabled: boolean
  show_score_to_students: boolean
  max_correction_attempts: number
  notification_enabled: boolean
  notification_channel: 'in_app' | 'email' | 'both' | 'none'
  notification_events: NotificationEvents
  correction_dispatch_mode: 'manual' | 'auto'
  student_feedback_visibility: 'status_only' | 'score_only' | 'score_reason' | 'full'
  notification_digest: 'instant' | 'daily'
  quiet_hours_enabled: boolean
  quiet_hours_start: string
  quiet_hours_end: string
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

const NOTIFICATION_EVENT_LABELS: Record<keyof NotificationEvents, string> = {
  submission_uploaded: '新繳交',
  grading_completed: '批改完成',
  correction_dispatched: '訂正已派發',
  correction_submitted: '訂正已送出',
  correction_limit_reached: '訂正次數用盡',
  correction_due_reminder: '截止提醒'
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

const CHANNEL_OPTIONS: Array<{
  value: Preferences['notification_channel']
  label: string
  disabled?: boolean
}> = [
  { value: 'in_app', label: '站內通知' },
  { value: 'email', label: 'Email（即將推出）', disabled: true },
  { value: 'both', label: '站內＋Email（即將推出）', disabled: true },
  { value: 'none', label: '關閉' }
]

const DEFAULT_PREFS: Preferences = {
  student_portal_enabled: true,
  show_score_to_students: false,
  max_correction_attempts: 3,
  notification_enabled: true,
  notification_channel: 'in_app',
  notification_events: {
    submission_uploaded: true,
    grading_completed: true,
    correction_dispatched: true,
    correction_submitted: true,
    correction_limit_reached: true,
    correction_due_reminder: true
  },
  correction_dispatch_mode: 'manual',
  student_feedback_visibility: 'score_reason',
  notification_digest: 'instant',
  quiet_hours_enabled: false,
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00'
}

export default function TeacherPreferences({
  onBack,
  embedded = false
}: TeacherPreferencesProps) {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

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
        notification_enabled: p.notification_enabled ?? DEFAULT_PREFS.notification_enabled,
        notification_channel: p.notification_channel ?? DEFAULT_PREFS.notification_channel,
        notification_events: {
          ...DEFAULT_PREFS.notification_events,
          ...(p.notification_events ?? {})
        },
        correction_dispatch_mode: p.correction_dispatch_mode ?? DEFAULT_PREFS.correction_dispatch_mode,
        student_feedback_visibility: p.student_feedback_visibility ?? DEFAULT_PREFS.student_feedback_visibility,
        notification_digest: p.notification_digest ?? DEFAULT_PREFS.notification_digest,
        quiet_hours_enabled: p.quiet_hours_enabled ?? DEFAULT_PREFS.quiet_hours_enabled,
        quiet_hours_start: p.quiet_hours_start ?? DEFAULT_PREFS.quiet_hours_start,
        quiet_hours_end: p.quiet_hours_end ?? DEFAULT_PREFS.quiet_hours_end
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
          notificationEnabled: prefs.notification_enabled,
          notificationChannel: prefs.notification_channel,
          notificationEvents: prefs.notification_events,
          correctionDispatchMode: prefs.correction_dispatch_mode,
          studentFeedbackVisibility: prefs.student_feedback_visibility,
          notificationDigest: prefs.notification_digest,
          quietHoursEnabled: prefs.quiet_hours_enabled,
          quietHoursStart: prefs.quiet_hours_start,
          quietHoursEnd: prefs.quiet_hours_end
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

  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }))
  }

  const setEvent = (key: keyof NotificationEvents, value: boolean) => {
    setPrefs((prev) => ({
      ...prev,
      notification_events: { ...prev.notification_events, [key]: value }
    }))
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

            {/* 3. 通知設定 */}
            <SectionCard title="通知設定" icon={Bell}>
              <SettingRow label="通知總開關">
                <ToggleSwitch
                  checked={prefs.notification_enabled}
                  onChange={(v) => set('notification_enabled', v)}
                />
              </SettingRow>
              <SettingRow label="通知管道">
                <select
                  value={prefs.notification_channel}
                  onChange={(e) =>
                    set('notification_channel', e.target.value as Preferences['notification_channel'])
                  }
                  disabled={!prefs.notification_enabled}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {CHANNEL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </SettingRow>

              {prefs.notification_enabled && (
                <>
                  <div className="border-t border-slate-100 pt-3">
                    <p className="mb-3 text-sm font-medium text-slate-700">通知事件</p>
                    <div className="space-y-3">
                      {(Object.keys(NOTIFICATION_EVENT_LABELS) as Array<keyof NotificationEvents>).map(
                        (key) => (
                          <div key={key} className="flex items-center justify-between">
                            <span className="text-sm text-slate-600">
                              {NOTIFICATION_EVENT_LABELS[key]}
                            </span>
                            <ToggleSwitch
                              checked={prefs.notification_events[key]}
                              onChange={(v) => setEvent(key, v)}
                            />
                          </div>
                        )
                      )}
                    </div>
                  </div>
                </>
              )}
            </SectionCard>

            {/* 4. 通知頻率與靜音時段 */}
            <SectionCard title="通知頻率與靜音時段" icon={Volume2}>
              <SettingRow
                label="通知頻率"
                description="即時：每次事件發生時通知；每日彙整：每天一次整理"
              >
                <select
                  value={prefs.notification_digest}
                  onChange={(e) =>
                    set('notification_digest', e.target.value as Preferences['notification_digest'])
                  }
                  disabled={!prefs.notification_enabled}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="instant">即時</option>
                  <option value="daily" disabled>每日彙整（即將推出）</option>
                </select>
              </SettingRow>
              <SettingRow label="靜音時段">
                <ToggleSwitch
                  checked={prefs.quiet_hours_enabled}
                  onChange={(v) => set('quiet_hours_enabled', v)}
                  disabled={!prefs.notification_enabled}
                />
              </SettingRow>
              {prefs.quiet_hours_enabled && prefs.notification_enabled && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-3">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-600">開始</label>
                    <input
                      type="time"
                      value={prefs.quiet_hours_start}
                      onChange={(e) => set('quiet_hours_start', e.target.value)}
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                    />
                  </div>
                  <span className="text-xs text-slate-400">至</span>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-600">結束</label>
                    <input
                      type="time"
                      value={prefs.quiet_hours_end}
                      onChange={(e) => set('quiet_hours_end', e.target.value)}
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                    />
                  </div>
                </div>
              )}
            </SectionCard>

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
