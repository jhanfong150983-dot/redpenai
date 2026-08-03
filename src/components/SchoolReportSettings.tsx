import { useCallback, useEffect, useState } from 'react'
import { Upload, X } from 'lucide-react'

/**
 * 2026-08-03 行政端偏好設定 → 家長報告抬頭(學校級、存雲端)。
 *
 * user 提:行政帳號可能多人共用或換電腦,localStorage per-device 會讓同一所學校印出兩種抬頭。
 *   校名預設吃 1Campus 正式校名,只有要印不同名稱時才覆寫。
 *   老師姓名不放這裡——報告會自動帶該班該科的任課老師(school_class_courses)。
 */

export interface SchoolReportSettingsValue {
  schoolName: string
  schoolNameOverridden: boolean
  crestDataUrl: string
}

export function useSchoolReportSettings(schoolId: string) {
  const [value, setValue] = useState<SchoolReportSettingsValue | null>(null)

  const reload = useCallback(async () => {
    if (!schoolId) return
    try {
      const r = await fetch(`/api/data/school-report-settings?schoolId=${encodeURIComponent(schoolId)}`, {
        credentials: 'include'
      })
      if (!r.ok) return
      const d = await r.json()
      setValue({
        schoolName: d?.schoolName || '',
        schoolNameOverridden: !!d?.schoolNameOverridden,
        crestDataUrl: d?.crestDataUrl || ''
      })
    } catch { /* 非致命:抬頭會空白,畫面有提示 */ }
  }, [schoolId])

  useEffect(() => { void reload() }, [reload])
  return { value, reload }
}

export default function SchoolReportSettings({ schoolId }: { schoolId: string }) {
  const { value, reload } = useSchoolReportSettings(schoolId)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const save = useCallback(async (patch: { schoolName?: string; crestDataUrl?: string }) => {
    setSaving(true)
    setMsg('')
    try {
      const r = await fetch('/api/data/school-report-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ schoolId, ...patch })
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || '儲存失敗')
      await reload()
      setMsg('已儲存,全校行政共用')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '儲存失敗')
    } finally {
      setSaving(false)
    }
  }, [schoolId, reload])

  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-800">家長報告抬頭</h3>
        <p className="mt-1 text-xs text-slate-500">
          設定存在雲端、<span className="font-medium text-slate-600">全校行政共用</span>,換電腦或換承辦人都不用重設。
          老師姓名不必填——報告會自動帶入該班該科的任課老師。
        </p>

        <div className="mt-4 space-y-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-800">報告上的學校名稱</label>
            <input
              type="text"
              defaultValue={value?.schoolName ?? ''}
              key={value?.schoolName ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== (value?.schoolName ?? '')) void save({ schoolName: v })
              }}
              placeholder="例如:新竹市關埔國民小學"
              className="w-full max-w-md rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
            />
            <p className="mt-1 text-xs text-slate-400">
              {value?.schoolNameOverridden
                ? '已覆寫。清空後會回到 1Campus 的正式校名。'
                : '目前使用 1Campus 的正式校名,要印別的名稱才需要改。'}
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-800">校徽(選填)</label>
            <div className="flex items-center gap-3">
              {value?.crestDataUrl ? (
                <img
                  src={value.crestDataUrl}
                  alt="校徽"
                  className="h-16 w-16 rounded border border-slate-200 bg-white object-contain p-1"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded border border-dashed border-slate-300 bg-white text-xs text-slate-400">
                  未設定
                </div>
              )}
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                <Upload className="h-4 w-4" />
                {value?.crestDataUrl ? '更換' : '上傳'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (!f) return
                    const reader = new FileReader()
                    reader.onload = () => { void save({ crestDataUrl: String(reader.result || '') }) }
                    reader.onerror = () => setMsg('讀取圖片失敗')
                    reader.readAsDataURL(f)
                  }}
                />
              </label>
              {value?.crestDataUrl && (
                <button
                  type="button"
                  onClick={() => void save({ crestDataUrl: '' })}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-50"
                >
                  <X className="h-4 w-4" />
                  移除
                </button>
              )}
            </div>
            <p className="mt-1.5 text-xs text-slate-400">
              建議正方形、512 KB 以內。校徽會直接嵌進 PDF,不需要對外可存取的網址。
            </p>
          </div>
        </div>

        {(saving || msg) && (
          <p className={`mt-3 text-xs ${msg.includes('失敗') ? 'text-red-600' : 'text-emerald-600'}`}>
            {saving ? '儲存中…' : msg}
          </p>
        )}
      </div>
    </div>
  )
}
