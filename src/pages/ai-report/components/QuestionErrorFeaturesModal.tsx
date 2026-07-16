// AI 歸納錯誤樣態 modal（2026-07-16、user 拍板）：點開 → 有快取直接看；沒有 → 「開始 AI 歸納」
// （經頁面的墨水確認）→ 跑完存 Dexie、下次隨開隨看。資料變更（signature 不符）→ 提示可重新分析。
import { useEffect, useState } from 'react'
import type { ItemStat } from '../item-analysis'
import {
  generateErrorFeatures, readErrorFeaturesCache, errorFeaturesSignature,
} from '../error-features'
import type { ErrorFeaturesPayload } from '../error-features'

type Props = {
  open: boolean
  onClose: () => void
  assignmentId: string
  domain: string
  item: ItemStat | null
  /** 頁面的墨水確認包裝（AiReport 的 requestInk）：確認後才執行傳入的 fn */
  requestInk: (fn: () => void) => void
}

export default function QuestionErrorFeaturesModal({ open, onClose, assignmentId, domain, item, requestInk }: Props) {
  const [payload, setPayload] = useState<ErrorFeaturesPayload | null>(null)
  const [cachedAt, setCachedAt] = useState<number | null>(null)
  const [stale, setStale] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !item) return
    setPayload(null); setCachedAt(null); setStale(false); setError(null)
    readErrorFeaturesCache(assignmentId, item.questionId).then((entry) => {
      if (!entry) return
      setPayload(entry.payload)
      setCachedAt(entry.updatedAt)
      setStale(entry.signature !== errorFeaturesSignature(item))
    })
  }, [open, assignmentId, item])

  if (!open || !item) return null

  const run = () => requestInk(() => {
    setLoading(true); setError(null)
    generateErrorFeatures(assignmentId, item, domain)
      .then((p) => { setPayload(p); setCachedAt(Date.now()); setStale(false) })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  })

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#fff', borderRadius: 12, maxWidth: 640, width: '100%', maxHeight: '82vh', overflowY: 'auto', padding: '16px 20px', boxShadow: '0 20px 50px rgba(0,0,0,.2)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>AI 歸納錯誤樣態　<span style={{ color: '#64748b', fontWeight: 400, fontSize: 13 }}>題 {item.questionId}</span></h3>
          <button type="button" onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#64748b' }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#64748b', margin: '4px 0 12px' }}>
          正解「{item.keyAnswer}」·答錯 {item.wrongCount - item.blankCount - item.unrecognizableCount < 0 ? item.wrongCount : item.n - item.correctCount - item.blankCount - item.unrecognizableCount} 人·未作答 {item.blankCount + item.unrecognizableCount} 人
        </div>

        {!payload && !loading && (
          <div style={{ textAlign: 'center', padding: '24px 12px' }}>
            <p style={{ fontSize: 13, color: '#475569', margin: '0 0 12px' }}>
              尚未分析。AI 會讀取全班的錯誤作答、統計高頻錯誤特徵（一個作答可計入多個特徵），並給出檢討課重點。
            </p>
            <button
              type="button"
              onClick={run}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              開始 AI 歸納（消耗墨水）
            </button>
          </div>
        )}

        {loading && <div style={{ textAlign: 'center', padding: 24, color: '#64748b', fontSize: 13 }}>AI 歸納中、約 10~20 秒…</div>}
        {error && <div style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 8 }}>{error}</div>}

        {payload && !loading && (
          <div>
            {stale && (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '6px 10px', fontSize: 12, color: '#78350f', marginBottom: 10 }}>
                批改資料在分析之後有變更，以下為舊結果——可按下方「重新分析」更新。
              </div>
            )}
            {payload.features.map((f) => (
              <div key={f.feature} style={{ borderLeft: '3px solid #3b82f6', padding: '4px 10px', marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
                  {f.feature}　<span style={{ color: '#2563eb' }}>{f.count} 人次</span>
                </div>
                {f.examples.length > 0 && (
                  <div style={{ fontSize: 12, color: '#64748b', margin: '2px 0' }}>例：{f.examples.join('　／　')}</div>
                )}
                {f.note && <div style={{ fontSize: 12, color: '#475569' }}>{f.note}</div>}
              </div>
            ))}
            {payload.nonsense.length > 0 && (
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
                不成句／亂答：{payload.nonsense.join('、')}
              </div>
            )}
            {payload.teachingFocus && (
              <div style={{ background: '#eff6ff', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#1e3a8a' }}>
                📌 檢討課重點：{payload.teachingFocus}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>
                {cachedAt ? `分析於 ${new Date(cachedAt).toLocaleString('zh-TW', { hour12: false })}` : ''}
              </span>
              <button
                type="button"
                onClick={run}
                style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontSize: 12, cursor: 'pointer' }}
              >
                重新分析（消耗墨水）
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
