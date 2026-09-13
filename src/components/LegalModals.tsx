// 2026-09-13 四份政策（AI 免責／著作權聲明／服務條款／隱私權政策）抽成共用元件：
//   登入後系統最下方的頁尾與官網公開頁的頁尾用同一份內容（user：官網 footer 只放 policy 一排，不放跳轉）。
//   內文原封不動從 App.tsx 搬來；改條款請改這裡。
import { useState, type ReactNode } from 'react'
import { TERMS_VERSION, PRIVACY_VERSION, REFUND_FEE_RATE } from '../lib/legal'

export type LegalKind = 'ai' | 'ip' | 'terms' | 'privacy'
export const LEGAL_ITEMS: Array<{ kind: LegalKind; label: string }> = [
  { kind: 'ai', label: 'AI 免責' },
  { kind: 'ip', label: '著作權聲明' },
  { kind: 'terms', label: '服務條款' },
  { kind: 'privacy', label: '隱私權政策' },
]

const TITLES: Record<LegalKind, string> = {
  ai: '免責聲明及 AI 生成內容著作權聲明',
  ip: '網站智慧財產權聲明',
  terms: '服務條款',
  privacy: '隱私權政策',
}

function Body({ kind }: { kind: LegalKind }): ReactNode {
  const refundFeePercent = Math.round(REFUND_FEE_RATE * 1000) / 10
  void refundFeePercent
  switch (kind) {
    case 'terms':
      return (
        <>
              <p>
                <span className="font-semibold">一、服務內容</span>
                <br />
                本平台提供 AI 考卷批改與相關教學管理功能，並採點數制扣抵服務費用。
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
        </>
      )
    case 'privacy':
      return (
        <>
              <p>
                <span className="font-semibold">一、蒐集資訊</span>
                <br />
                我們可能蒐集使用者帳號資訊（Email、姓名）、考卷內容（文字或影像）、
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
                考卷內容會傳送至 Google Gemini API 進行運算，我們不會另行將資料
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
        </>
      )
    case 'ai':
      return (
        <>
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
        </>
      )
    default:
      return (
        <>
              <p>
                除另有標示外，本網站之商標、標誌、介面設計、文字、圖像、影音、程式碼、資料庫及其他內容之智慧財產權，均屬本網站或其權利人所有。
              </p>
              <p>
                未經事前書面同意，任何人不得以任何形式重製、改作、散布、公開傳輸、展示、出版或作商業使用；僅限於合法且必要之個人瀏覽或學習用途之合理使用，不構成授權。
              </p>
        </>
      )
  }
}

export function LegalModal({ kind, onClose }: { kind: LegalKind | null; onClose: () => void }) {
  if (!kind) return null
  const version = kind === 'terms' ? TERMS_VERSION : kind === 'privacy' ? PRIVACY_VERSION : null
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="legal-dialog-title">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h2 id="legal-dialog-title" className="text-base font-semibold text-gray-900">{TITLES[kind]}</h2>
            {version && <p className="text-xs text-gray-500 mt-1">版本：{version}</p>}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-full hover:bg-gray-100 text-gray-500" aria-label="關閉">X</button>
        </div>
        <div className="px-5 py-4 text-sm text-gray-700 space-y-3 overflow-y-auto max-h-[75vh] leading-relaxed">
          <Body kind={kind} />
        </div>
      </div>
    </div>
  )
}

/** 一排政策連結（自帶 modal）。dark＝深色頁尾用 */
export function PolicyLinks({ dark = false }: { dark?: boolean }) {
  const [kind, setKind] = useState<LegalKind | null>(null)
  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
        {LEGAL_ITEMS.map((it) => (
          <button key={it.kind} type="button" onClick={() => setKind(it.kind)}
            className={`underline underline-offset-2 ${dark ? 'text-gray-500 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}>
            {it.label}
          </button>
        ))}
      </span>
      <LegalModal kind={kind} onClose={() => setKind(null)} />
    </>
  )
}
