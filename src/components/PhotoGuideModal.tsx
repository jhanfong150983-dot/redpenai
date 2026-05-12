import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

interface PhotoGuideModalProps {
  open: boolean
  onClose: () => void
}

const PORTRAIT_WORKSHEET = '/photo-guide/worksheet_portrait.jpg'
const LANDSCAPE_WORKSHEET = '/photo-guide/worksheet_landscape.jpg'

export default function PhotoGuideModal({ open, onClose }: PhotoGuideModalProps) {
  // 用 viewport aspect ratio 判斷直/橫版（高 > 寬 = 裝置直握 → 直版）
  // 涵蓋手機直/橫 + iPad 直/橫 + 桌機（永遠橫版）
  const [isPortrait, setIsPortrait] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerHeight > window.innerWidth
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const update = () => setIsPortrait(window.innerHeight > window.innerWidth)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  // ESC 鍵關閉
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="pg-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-3"
      onClick={onClose}
    >
      <style>{PHOTO_GUIDE_CSS}</style>
      <div
        className={isPortrait ? 'pg-modal pg-mobile' : 'pg-modal pg-desktop'}
        onClick={(e) => e.stopPropagation()}
      >
        {isPortrait ? <MobileLayout onClose={onClose} /> : <DesktopLayout onClose={onClose} />}
      </div>
    </div>
  )
}

// ─── Desktop / Landscape (16:9) ───
function DesktopLayout({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="pg-header">
        <h1>📸 拍作業說明書 — 怎麼拍才不會被擋</h1>
        <button className="pg-close" onClick={onClose} aria-label="關閉">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="pg-main">
        <div className="pg-col pg-col-correct">
          <h2>✅ 作頁放框內不壓線、盡量占滿整個框</h2>
          <div className="pg-correct-stack">
            <CorrectExample variant="portrait" />
            <CorrectExample variant="landscape" />
          </div>
        </div>

        <div className="pg-col pg-col-wrong">
          <h2>❌ 這幾種會被擋</h2>
          <div className="pg-ng-grid">
            <NgCard n={1} title="太遠" variant="ng-far" why="紙張在畫面中太小、桌面背景太多" fix="手機<strong>靠近作業</strong>、讓紙張填滿虛線框" />
            <NgCard n={2} title="出框" variant="ng-out" why="紙張一邊跑出畫面外、AI 看不到完整作業" fix="手機<strong>拿遠一點</strong>、整張紙都進畫面" />
            <NgCard n={3} title="歪斜" variant="ng-tilt" why="紙張沒對齊虛線框、超出引導框邊界" fix="紙張<strong>4 角對準</strong>畫面虛線框" />
            <NgCard n={4} title="模糊" variant="ng-blur" why="字看不清楚、AI 無法辨識內容" fix="手機<strong>拿穩</strong>、靠近後再按拍照" />
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Mobile / Portrait ───
function MobileLayout({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="pg-header pg-header-mobile">
        <h1>📸 拍作業說明書</h1>
        <button className="pg-close" onClick={onClose} aria-label="關閉">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="pg-body">
        <h2 className="pg-section-h pg-section-correct">✅ 作頁放框內不壓線、盡量占滿整個框</h2>
        <div className="pg-correct-list">
          <CorrectExample variant="portrait" mobile />
          <CorrectExample variant="landscape" mobile />
        </div>

        <h2 className="pg-section-h pg-section-wrong">❌ 這幾種會被擋</h2>
        <div className="pg-ng-list">
          <NgCard mobile n={1} title="太遠" variant="ng-far" why="紙張在畫面中太小、桌面背景太多" fix="手機<strong>靠近作業</strong>、讓紙張填滿虛線框" />
          <NgCard mobile n={2} title="出框" variant="ng-out" why="紙張一邊跑出畫面外、AI 看不到完整作業" fix="手機<strong>拿遠一點</strong>、整張紙都進畫面" />
          <NgCard mobile n={3} title="歪斜" variant="ng-tilt" why="紙張沒對齊虛線框、超出引導框邊界" fix="紙張<strong>4 角對準</strong>畫面虛線框" />
          <NgCard mobile n={4} title="模糊" variant="ng-blur" why="字看不清楚、AI 無法辨識內容" fix="手機<strong>拿穩</strong>、靠近後再按拍照" />
        </div>
      </div>

      <div className="pg-footer">
        <button className="pg-dismiss-btn" onClick={onClose}>我知道了、開始拍照</button>
      </div>
    </>
  )
}

// ─── Correct example (phone with worksheet aligned) ───
function CorrectExample({ variant, mobile }: { variant: 'portrait' | 'landscape'; mobile?: boolean }) {
  const phoneClass = mobile
    ? variant === 'portrait' ? 'pg-phone pg-p-portrait pg-size-mobile' : 'pg-phone pg-p-landscape pg-size-mobile-l'
    : variant === 'portrait' ? 'pg-phone pg-p-portrait' : 'pg-phone pg-p-landscape'
  return (
    <div className="pg-ex">
      <div className={phoneClass}>
        <div className="pg-screen">
          <img
            className={`pg-paper pg-correct pg-correct-${variant}`}
            src={variant === 'portrait' ? PORTRAIT_WORKSHEET : LANDSCAPE_WORKSHEET}
            alt=""
          />
          <div className="pg-guide"></div>
          <div className="pg-shutter"></div>
        </div>
      </div>
      <p className="pg-ex-label">{variant === 'portrait' ? '📱 直式拍法' : '📱 橫式拍法'}</p>
    </div>
  )
}

// ─── NG card ───
function NgCard({
  n, title, variant, why, fix, mobile
}: { n: number; title: string; variant: string; why: string; fix: string; mobile?: boolean }) {
  return (
    <div className="pg-ng-card">
      <div className={mobile ? 'pg-phone pg-p-ng-mobile' : 'pg-phone pg-p-ng'}>
        <div className="pg-screen">
          <img className={`pg-paper pg-${variant}`} src={PORTRAIT_WORKSHEET} alt="" />
          <div className="pg-guide"></div>
          <div className="pg-shutter"></div>
        </div>
      </div>
      <div className="pg-ng-info">
        <h3 className="pg-ng-title">
          <span className="pg-ng-num">{n}</span>{title}
        </h3>
        <p className="pg-ng-why">{why}</p>
        <p className="pg-ng-fix" dangerouslySetInnerHTML={{ __html: fix }} />
      </div>
    </div>
  )
}

// ─── styles (scoped via pg- prefix) ───
const PHOTO_GUIDE_CSS = `
.pg-overlay * { box-sizing: border-box; }

.pg-modal {
  background: #f8fafc;
  border-radius: 14px;
  box-shadow: 0 16px 50px rgba(0,0,0,0.5);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* desktop landscape 16:9 */
.pg-desktop {
  width: min(1600px, 96vw);
  height: min(900px, 92vh);
  aspect-ratio: 16 / 9;
  padding: 24px 32px;
  gap: 16px;
}
.pg-desktop .pg-header {
  display: flex; align-items: baseline; justify-content: space-between;
  padding-bottom: 12px; border-bottom: 2px solid #e2e8f0;
}
.pg-desktop .pg-header h1 { margin: 0; font-size: 26px; color: #0f172a; font-weight: 700; }
.pg-desktop .pg-main {
  flex: 1; display: grid; grid-template-columns: 420px 1fr; gap: 24px; overflow: hidden;
}
.pg-col { display: grid; grid-template-rows: auto 1fr; gap: 14px; min-height: 0; }
.pg-col h2 { margin: 0; font-size: 20px; font-weight: 700; padding-bottom: 8px; border-bottom: 3px solid; line-height: 1.3; }
.pg-col-correct h2 { color: #047857; border-color: #10b981; }
.pg-col-wrong h2   { color: #b91c1c; border-color: #ef4444; }
.pg-correct-stack { display: flex; flex-direction: column; align-items: center; justify-content: space-around; height: 100%; min-height: 0; gap: 14px; }
.pg-ng-grid { display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(2, 1fr); gap: 14px; height: 100%; min-height: 0; }
.pg-ng-card {
  background: white; border: 2px solid #fecaca; border-radius: 12px;
  padding: 12px 16px; display: flex; align-items: center; justify-content: center; gap: 18px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.05);
}
.pg-ng-info { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.pg-ng-title { font-size: 20px; font-weight: 800; color: #b91c1c; margin: 0 0 6px 0; display: flex; align-items: center; gap: 7px; }
.pg-ng-num { background: #fef2f2; color: #b91c1c; border: 2px solid #fecaca; width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; }
.pg-ng-why { font-size: 12px; color: #64748b; margin: 0 0 4px 0; line-height: 1.5; }
.pg-ng-fix { font-size: 13px; color: #047857; font-weight: 600; margin: 0; line-height: 1.5; }
.pg-ng-fix::before { content: "→ "; color: #047857; }
.pg-ng-fix strong { color: #047857; }
.pg-ex { text-align: center; }
.pg-ex-label { margin-top: 6px; font-size: 13px; color: #0f172a; font-weight: 700; }

/* portrait modal (手機直 + iPad 直) */
.pg-mobile {
  width: min(480px, 94vw);
  height: min(900px, 94vh);
  border-radius: 22px;
}
.pg-header-mobile {
  flex-shrink: 0; background: white; padding: 14px 16px;
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid #e2e8f0;
}
.pg-header-mobile h1 { margin: 0; font-size: 16px; color: #0f172a; font-weight: 800; }
.pg-close {
  width: 36px; height: 36px; border-radius: 50%; background: #f1f5f9; border: none;
  color: #475569; cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.pg-close:hover { background: #e2e8f0; }
.pg-body {
  flex: 1; overflow-y: auto; padding: 16px 14px 20px;
  -webkit-overflow-scrolling: touch;
}
.pg-section-h { margin: 0 0 12px 0; font-size: 15px; font-weight: 800; padding-bottom: 8px; border-bottom: 3px solid; line-height: 1.4; }
.pg-section-correct { color: #047857; border-color: #10b981; }
.pg-section-wrong   { color: #b91c1c; border-color: #ef4444; margin-top: 20px; }
.pg-correct-list { display: flex; flex-direction: column; align-items: center; gap: 16px; }
.pg-ng-list { display: flex; flex-direction: column; gap: 10px; }
.pg-mobile .pg-ng-card { padding: 10px 12px; gap: 12px; }
.pg-mobile .pg-ng-title { font-size: 15px; }
.pg-mobile .pg-ng-num { width: 20px; height: 20px; font-size: 11px; }
.pg-mobile .pg-ng-why { font-size: 11px; }
.pg-mobile .pg-ng-fix { font-size: 12px; }
.pg-footer { flex-shrink: 0; background: white; padding: 10px 14px 14px; border-top: 1px solid #e2e8f0; }
.pg-dismiss-btn {
  width: 100%; background: #0f172a; color: white; border: none; border-radius: 12px;
  padding: 13px; font-size: 15px; font-weight: 700; cursor: pointer;
}
.pg-dismiss-btn:hover { background: #1e293b; }

/* ── phone frame ── */
.pg-phone { background: #1f2937; border-radius: 20px; padding: 7px; box-shadow: 0 6px 18px rgba(0,0,0,0.18); flex-shrink: 0; }
.pg-p-portrait { width: 190px; height: 316px; }
.pg-p-landscape { width: 316px; height: 190px; }
.pg-p-ng { width: 146px; height: 244px; }
.pg-p-ng-mobile { width: 104px; height: 174px; border-radius: 14px; padding: 5px; }
.pg-size-mobile { width: 160px; height: 266px; }
.pg-size-mobile-l { width: 266px; height: 160px; }

.pg-screen {
  width: 100%; height: 100%; border-radius: 13px; position: relative; overflow: hidden;
  background: linear-gradient(135deg, #c8a87a 0%, #b08f5e 100%);
}
.pg-guide {
  position: absolute; border: 2px dashed rgba(255,255,255,0.75); border-radius: 3px;
  z-index: 3; pointer-events: none;
}
.pg-p-portrait .pg-guide, .pg-p-ng .pg-guide, .pg-p-ng-mobile .pg-guide, .pg-size-mobile .pg-guide
  { top: 5%; bottom: 14%; left: 3%; right: 3%; }
.pg-p-landscape .pg-guide, .pg-size-mobile-l .pg-guide
  { top: 3%; bottom: 3%; left: 5%; right: 14%; }
.pg-shutter {
  position: absolute; background: white; border: 3px solid rgba(255,255,255,0.4);
  border-radius: 50%; z-index: 5; pointer-events: none;
}
.pg-p-portrait .pg-shutter, .pg-size-mobile .pg-shutter
  { bottom: 4%; left: 50%; transform: translateX(-50%); width: 24px; height: 24px; }
.pg-p-ng .pg-shutter, .pg-p-ng-mobile .pg-shutter
  { bottom: 4%; left: 50%; transform: translateX(-50%); width: 18px; height: 18px; }
.pg-p-landscape .pg-shutter, .pg-size-mobile-l .pg-shutter
  { right: 4%; top: 50%; transform: translateY(-50%); width: 19px; height: 19px; }

.pg-paper { position: absolute; object-fit: contain; box-shadow: 0 4px 10px rgba(0,0,0,0.25); z-index: 2; }
.pg-p-portrait .pg-correct-portrait, .pg-size-mobile .pg-correct-portrait {
  top: 7%; bottom: 16%; left: 5%; right: 5%; width: 90%; height: 77%; margin: auto;
}
.pg-p-landscape .pg-correct-landscape, .pg-size-mobile-l .pg-correct-landscape {
  top: 5%; bottom: 5%; left: 7%; right: 16%; width: 77%; height: 90%; margin: auto;
}
.pg-paper.pg-ng-far {
  top: 32%; bottom: 38%; left: 30%; right: 30%; width: 40%; height: 30%; margin: auto;
}
.pg-paper.pg-ng-out {
  top: 8%; left: 38%; width: 88%; height: 78%; object-fit: cover; object-position: left center;
}
.pg-paper.pg-ng-tilt {
  top: 8%; bottom: 16%; left: 6%; right: 6%; width: 88%; height: 76%; margin: auto;
  transform: rotate(14deg);
}
.pg-paper.pg-ng-blur {
  top: 7%; bottom: 16%; left: 5%; right: 5%; width: 90%; height: 77%; margin: auto;
  filter: blur(2px);
}
`
