// 2026-09-14 user：AI 解析完成、進入「答案卷編輯」時彈一次的檢查提醒（不是教學）。
//   一般模式／自備作答卷：兩張卡並排＝①框選位置 ②標準答案，各自 8 秒循環動畫。
//   系統製作作答卷：格位由排版決定、不能改框 → 只有「標準答案」一張卡。
//   「下次不用再提醒」記本機（localStorage）。Esc／點外面＝開始檢查。
import { useEffect } from 'react'

export const PARSE_CHECK_REMINDER_KEY = 'redpen-parse-check-reminder-dismissed'
export const isParseCheckReminderDismissed = () => { try { return localStorage.getItem(PARSE_CHECK_REMINDER_KEY) === '1' } catch { return false } }

interface Props {
  questionCount: number
  /** 'two'＝框＋答案；'answer'＝只有答案（系統製作作答卷） */
  variant: 'two' | 'answer'
  onClose: () => void
}

const CSS = `
.pcr-scene{position:relative;height:230px;background:#fff;margin:10px;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden;font-family:inherit}
.pcr-thumb{position:absolute;left:14px;top:14px;width:120px;height:74px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;display:grid;place-items:center;overflow:hidden}
.pcr-paper{width:96px;height:44px;position:relative}
.pcr-t{position:absolute;left:6px;right:6px;height:5px;background:#e4e4e7;border-radius:3px}
.pcr-box{position:absolute;left:10px;top:16px;width:30px;height:16px;border:2px solid #3b82f6;border-radius:2px;background:rgba(59,130,246,.1)}
.pcr-hint{position:absolute;left:0;right:0;bottom:0;background:rgba(24,24,27,.6);color:#fff;font-size:9.5px;text-align:center;padding:1px 0;opacity:0}
.pcr-status{position:absolute;left:14px;top:94px;font-size:11px;color:#3b82f6}
.pcr-big{position:absolute;left:146px;top:12px;right:12px;bottom:12px;background:#fff;border:1px solid #e4e4e7;border-radius:8px;box-shadow:0 10px 24px rgba(0,0,0,.22);opacity:0;transform:scale(.94);display:grid;grid-template-rows:24px 1fr 26px}
.pcr-big .h{font-size:10px;padding:0 8px;display:flex;align-items:center;border-bottom:1px solid #e4e4e7;font-weight:700;color:#18181b}
.pcr-big .bd{position:relative;background:#f4f4f5;display:grid;place-items:center}
.pcr-sheet{position:relative;width:150px;height:126px;background:#fff;border:1px solid #e4e4e7}
.pcr-sheet .t{position:absolute;left:10px;right:10px;height:5px;background:#e4e4e7;border-radius:3px}
.pcr-sheet .q{position:absolute;left:14px;font-size:8px;color:#52525b}
.pcr-sheet .old{position:absolute;left:12px;top:56px;width:40px;height:16px;border:2px solid #3b82f6;background:rgba(59,130,246,.1)}
.pcr-sheet .new{position:absolute;left:9px;top:48px;width:0;height:0;border:2px solid #16a34a;background:rgba(22,163,74,.14)}
.pcr-big .f{display:flex;justify-content:flex-end;align-items:center;gap:6px;padding:0 8px;border-top:1px solid #e4e4e7;font-size:9.5px;color:#52525b}
.pcr-big .f .ok{background:#16a34a;color:#fff;border-radius:5px;padding:2px 9px;font-weight:700}
.pcr-list{position:absolute;left:12px;top:12px;width:118px;bottom:12px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;padding:6px;font-size:10.5px;color:#52525b}
.pcr-list div{padding:4px 7px;border-radius:5px;margin-bottom:3px;display:flex;justify-content:space-between}
.pcr-list .bad{background:#fee2e2;color:#dc2626;font-weight:700;border-left:3px solid #dc2626}
.pcr-form{position:absolute;left:142px;top:12px;right:12px;bottom:12px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;padding:10px 12px;font-size:10.5px;color:#52525b;display:flex;flex-direction:column;gap:8px}
.pcr-form .lb{display:flex;justify-content:space-between}
.pcr-form .in{height:24px;border:1px solid #e4e4e7;border-radius:6px;padding:3px 8px;font-size:11.5px;color:#18181b;background:#fff;display:flex;align-items:center;gap:4px}
.pcr-form .in.bad{border-color:#dc2626;background:#fee2e2}
.pcr-form .in .txt{display:inline-block;overflow:hidden;white-space:nowrap;width:0}
.pcr-form .in .caret{width:1px;height:13px;background:#18181b;opacity:0}
.pcr-form .warn{font-size:10.5px;color:#dc2626;font-weight:700}
.pcr-cur{position:absolute;width:16px;height:20px;z-index:5;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))}
.pcr-ring{position:absolute;width:22px;height:22px;border:2px solid #16a34a;border-radius:50%;opacity:0;z-index:4}
.pcr-a1 .pcr-cur{left:60px;top:200px;animation:pcr-c1 8s infinite}
.pcr-a1 .pcr-hint{animation:pcr-hint 8s infinite}
.pcr-a1 .pcr-ring{animation:pcr-r1 8s infinite}
.pcr-a1 .pcr-big{animation:pcr-big 8s infinite}
.pcr-a1 .pcr-sheet .new{animation:pcr-draw 8s infinite}
.pcr-a1 .pcr-box{animation:pcr-tb 8s infinite}
.pcr-a1 .pcr-status{animation:pcr-st 8s infinite}
@keyframes pcr-c1{0%{left:60px;top:200px}14%{left:70px;top:48px}18%{left:70px;top:48px}30%{left:158px;top:72px}46%{left:236px;top:104px}50%{left:236px;top:104px}62%{left:262px;top:206px}66%{left:262px;top:206px}100%{left:60px;top:200px}}
@keyframes pcr-hint{0%,8%{opacity:0}12%,20%{opacity:1}22%,100%{opacity:0}}
@keyframes pcr-r1{0%,17%{opacity:0;left:64px;top:42px;transform:scale(.4)}18%{opacity:1}22%{opacity:0;transform:scale(1.5)}23%,65%{opacity:0;left:256px;top:200px;transform:scale(.4)}66%{opacity:1}70%{opacity:0;transform:scale(1.5)}100%{opacity:0}}
@keyframes pcr-big{0%,20%{opacity:0;transform:scale(.94)}24%,68%{opacity:1;transform:scale(1)}72%,100%{opacity:0;transform:scale(.94)}}
@keyframes pcr-draw{0%,30%{width:0;height:0}46%,70%{width:78px;height:34px}72%,100%{width:0;height:0}}
@keyframes pcr-tb{0%,70%{border-color:#3b82f6;left:10px;top:16px;width:30px;height:16px}72%,100%{border-color:#16a34a;left:8px;top:12px;width:40px;height:22px}}
@keyframes pcr-st{0%,70%{color:#3b82f6}72%,100%{color:#16a34a}}
.pcr-a2 .pcr-cur{left:40px;top:200px;animation:pcr-c2 8s infinite}
.pcr-a2 .pcr-ring{animation:pcr-r2 8s infinite}
.pcr-a2 .pcr-list .bad{animation:pcr-lf 8s infinite}
.pcr-a2 .pcr-form .in.bad{animation:pcr-ff 8s infinite}
.pcr-a2 .pcr-form .in .txt{animation:pcr-ty 8s infinite}
.pcr-a2 .pcr-form .in .caret{animation:pcr-ca 8s infinite}
.pcr-a2 .pcr-form .warn{animation:pcr-wf 8s infinite}
@keyframes pcr-c2{0%{left:40px;top:200px}16%{left:66px;top:80px}20%{left:66px;top:80px}38%{left:196px;top:70px}42%{left:196px;top:70px}80%{left:196px;top:70px}100%{left:40px;top:200px}}
@keyframes pcr-r2{0%,19%{opacity:0;left:58px;top:72px;transform:scale(.4)}20%{opacity:1}24%{opacity:0;transform:scale(1.5)}25%,41%{opacity:0;left:188px;top:62px;transform:scale(.4)}42%{opacity:1}46%{opacity:0;transform:scale(1.5)}100%{opacity:0}}
@keyframes pcr-lf{0%,72%{background:#fee2e2;color:#dc2626;border-left-color:#dc2626}76%,100%{background:#dcfce7;color:#16a34a;border-left-color:#16a34a}}
@keyframes pcr-ff{0%,72%{border-color:#dc2626;background:#fee2e2}76%,100%{border-color:#16a34a;background:#fff}}
@keyframes pcr-ty{0%,44%{width:0}70%,100%{width:80px}}
@keyframes pcr-ca{0%,41%{opacity:0}42%,72%{opacity:1}74%,100%{opacity:0}}
@keyframes pcr-wf{0%,72%{opacity:1}76%,100%{opacity:0}}
@media (prefers-reduced-motion: reduce){.pcr-a1 *,.pcr-a2 *{animation:none!important}.pcr-big{opacity:1;transform:none}.pcr-sheet .new{width:78px;height:34px}.pcr-form .in .txt{width:80px}}
`

const Cursor = () => (
  <svg className="pcr-cur" viewBox="0 0 18 22" aria-hidden="true"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12.5 18.7 L9.5 12 L15 12 Z" fill="#fff" stroke="#18181b" strokeWidth="1.4" strokeLinejoin="round" /></svg>
)

export default function ParseCheckReminderModal({ questionCount, variant, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const two = variant === 'two'
  return (
    <div className="fixed inset-0 z-[130] bg-black/45 flex items-center justify-center p-4" onClick={onClose}>
      <style>{CSS}</style>
      <div
        className={`bg-white rounded-2xl shadow-2xl border border-gray-200 p-6 pb-4 flex flex-col gap-4 w-full ${two ? 'max-w-3xl' : 'max-w-md'}`}
        role="dialog" aria-labelledby="pcr-title" onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="pcr-title" className="text-lg font-bold text-gray-900 m-0">
            {questionCount} 題已解析。儲存前請逐題檢查{two ? '這兩件事' : '標準答案'}
          </h2>
          <span className="text-xs text-gray-500 whitespace-nowrap">你改過的，批改就以你的為準</span>
        </div>
        <div className={`grid gap-3.5 ${two ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
          {two && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden flex flex-col pcr-a1">
              <div className="px-3 pt-2.5 pb-2 grid grid-cols-[24px_1fr] gap-2 items-start bg-white border-b border-gray-200">
                <div className="w-[22px] h-[22px] rounded-full bg-green-600 text-white text-xs font-bold grid place-items-center mt-0.5">1</div>
                <div><b className="block text-sm text-gray-900">框選位置</b><small className="block text-xs text-gray-500">點截圖，在整頁上把框拉到學生會寫字的整個範圍</small></div>
              </div>
              <div className="pcr-scene">
                <div className="pcr-thumb"><div className="pcr-paper"><div className="pcr-t" style={{ top: 5 }} /><div className="pcr-t" style={{ top: 34, width: '55%' }} /><div className="pcr-box" /></div><div className="pcr-hint">點一下在整頁上框選</div></div>
                <div className="pcr-status">AI 已自動標記</div>
                <div className="pcr-big">
                  <div className="h">框選作答區 3-H-4</div>
                  <div className="bd"><div className="pcr-sheet"><div className="t" style={{ top: 10 }} /><div className="q" style={{ top: 30 }}>4. What time does Raymond order?</div><div className="q" style={{ top: 52 }}>A. 11:00</div><div className="q" style={{ top: 66 }}>B. 12:00</div><div className="q" style={{ top: 80 }}>C. 12:30</div><div className="old" /><div className="new" /></div></div>
                  <div className="f"><span>取消</span><span className="ok">確定</span></div>
                </div>
                <div className="pcr-ring" /><Cursor />
              </div>
            </div>
          )}
          <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden flex flex-col pcr-a2">
            <div className="px-3 pt-2.5 pb-2 grid grid-cols-[24px_1fr] gap-2 items-start bg-white border-b border-gray-200">
              <div className="w-[22px] h-[22px] rounded-full bg-green-600 text-white text-xs font-bold grid place-items-center mt-0.5">{two ? 2 : 1}</div>
              <div><b className="block text-sm text-gray-900">標準答案</b><small className="block text-xs text-gray-500">紅色的題目缺答案，批改會全錯，請補上</small></div>
            </div>
            <div className="pcr-scene">
              <div className="pcr-list"><div><span>4-J-2</span><span>2分</span></div><div><span>4-J-3</span><span>2分</span></div><div className="bad"><span>4-K-1</span><span>缺答案</span></div><div><span>3-H-5</span><span>2分</span></div></div>
              <div className="pcr-form">
                <div className="lb"><span>題號 4-K-1</span><span>填空題</span></div>
                <div>標準答案<div className="in bad"><span className="txt">South Africa</span><span className="caret" /></div></div>
                <div className="warn">❌ 缺少標準答案</div>
              </div>
              <div className="pcr-ring" /><Cursor />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
            <input type="checkbox" className="w-3.5 h-3.5 accent-green-600" onChange={(e) => { try { if (e.target.checked) localStorage.setItem(PARSE_CHECK_REMINDER_KEY, '1'); else localStorage.removeItem(PARSE_CHECK_REMINDER_KEY) } catch { /* noop */ } }} />
            下次不用再提醒
          </label>
          <button type="button" onClick={onClose} className="px-5 py-2 rounded-lg bg-green-600 text-white text-sm font-semibold hover:bg-green-700">開始檢查</button>
        </div>
      </div>
    </div>
  )
}
