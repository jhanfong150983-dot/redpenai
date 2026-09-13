// 常見問題（公開頁 /faq）。2026-09-13 從首頁的 FAQ 區塊獨立成分頁（user：分頁要是真的分頁）。
//   內容＝原首頁五題＋定價相關三題（一份是什麼／用完怎麼辦／失敗不扣）。
import { useEffect, useState } from 'react'
import PublicNav from '../components/PublicNav'
import PublicFooter from '../components/PublicFooter'
import { SUPPORT_EMAIL, LINE_OA_URL } from '../lib/legal'

const PAGE_TITLE = 'RedPen AI 常見問題'
const PAGE_DESC = 'AI 判錯怎麼辦、手寫題能不能改、資料安全、學校怎麼採購、一份怎麼算、份數用完怎麼辦。'

function usePageMeta(): void {
  useEffect(() => {
    const prevTitle = document.title
    const metaEl = document.querySelector('meta[name="description"]')
    const prevDesc = metaEl?.getAttribute('content') ?? null
    document.title = PAGE_TITLE
    metaEl?.setAttribute('content', PAGE_DESC)
    return () => {
      document.title = prevTitle
      if (prevDesc !== null) metaEl?.setAttribute('content', prevDesc)
    }
  }, [])
}

const GROUPS: Array<{ title: string; items: Array<{ q: string; a: string; bullets?: string[] }> }> = [
  {
    title: '我們對 AI 的態度',
    items: [
      {
        q: 'AI 會判錯，你們怎麼把關？',
        a: 'AI 會判錯。所以把關做在流程裡，不是寫在免責聲明裡。你可以相信 AI，但你一定要認真檢查——這句話寫在我們的產品裡，也寫在教學影片裡。我們的設計目標不是「零錯誤」，是「錯了你三十秒內就會發現」。',
        bullets: [
          '低信心標記：AI 自己不確定的格子會標出來、集中一頁讓你複核；標記永久保留，可追溯。',
          '檢討單當第二道檢查：檢討單把 AI 沒把握的題印成醒目標示，發下去逐題核對後簽名。',
          '一鍵回復 AI 原判：老師改過的分數留有紀錄；覺得改錯了，隨時還原成 AI 原本的判斷。',
          '改分留紀錄：疑義當面提出、老師當場判斷，系統負責把紀錄留下來。',
        ],
      },
    ],
  },
  {
    title: '批改',
    items: [
      {
        q: 'AI 判錯了怎麼辦？',
        a: '系統會把 AI 沒把握的格子標記出來、集中在一頁讓你複核，你也可以直接改分數並隨時回復 AI 原判。檢討單上也會標示這些題目，學生看到不對可以直接向老師反映。',
      },
      {
        q: '我要改變出題方式嗎？',
        a: '不用。你照平常出卷、印卷、考試。唯一多做的一件事是把答案卷上傳一次讓 AI 解析題目——同一份卷子之後重複使用不用再解析。',
      },
      {
        q: '手寫的題目也能改嗎？',
        a: '可以，這正是重點。國字注音、注釋、填空、應用題、作圖題都支援；系統會裁出每一格的作答影像，判分時同時看文字與圖像。數學應用題採會考級分制，逐要素看計算過程給分。',
      },
      {
        q: '學生的考卷資料安全嗎？',
        a: '資料存放在雲端資料庫，只有該班老師與（學校方案下）學校指定的行政人員能存取。家長報告以每位學生獨立產出，不會看到其他學生的資料。',
      },
    ],
  },
  {
    title: '費用',
    items: [
      {
        q: '「一份」是什麼？',
        a: '一位學生的一份考卷。不管幾題、什麼題型、哪一科，都算一份。30 人的班批一次段考就是 30 份。',
      },
      {
        q: '份數用完了怎麼辦？',
        a: '校園版由行政端加購，每份同價、隨時補。學校配給老師的「校園墨水」用完，老師可以改用自己的份數，或請行政再配發。',
      },
      {
        q: '批改失敗會扣嗎？重新批改呢？',
        a: '批改失敗不扣。重新批改會整份重新讀卷，照扣一份。不確定答案卷對不對時，可以先批一份確認，再批其餘的。',
      },
      {
        q: '學校要怎麼採購？',
        a: '學校一次購買一學年的份數、統一付費，老師不需自費；買越多每份越便宜。建議先用一個領域、一次段考試辦，跑完一輪再擴大。歡迎用 LINE 或 Email 跟我們談。',
      },
    ],
  },
]

export default function FaqPage() {
  usePageMeta()
  const [open, setOpen] = useState<string | null>(GROUPS[0].items[0].q)
  return (
    <div className="min-h-screen bg-white">
      <PublicNav active="faq" />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-32 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black tracking-tight text-gray-900 sm:text-5xl">常見問題</h1>
        <p className="mt-4 text-lg text-gray-500">找不到答案的，直接問我們。</p>

        {GROUPS.map((g) => (
          <section key={g.title} className="mt-12">
            <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-gray-400">{g.title}</h2>
            <div className="mt-3 border-t border-gray-100">
              {g.items.map((f) => {
                const isOpen = open === f.q
                return (
                  <div key={f.q} className="border-b border-gray-100">
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : f.q)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-4 py-5 text-left"
                    >
                      <span className="flex-1 text-lg font-semibold text-gray-900">{f.q}</span>
                      <span className="font-mono text-gray-400">{isOpen ? '－' : '＋'}</span>
                    </button>
                    {isOpen && (
                      <div className="mb-5">
                        <p className="leading-relaxed text-gray-500">{f.a}</p>
                        {f.bullets && (
                          <ul className="mt-3 space-y-2">
                            {f.bullets.map((b) => <li key={b} className="border-l-2 border-gray-200 pl-3 leading-relaxed text-gray-600">{b}</li>)}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ))}

        <div className="mt-14 rounded-2xl border border-gray-200 p-7">
          <h2 className="text-xl font-bold text-gray-900">還有問題？</h2>
          <p className="mt-2 text-gray-500">加 LINE 最快，或來信 {SUPPORT_EMAIL}。</p>
          <a href={LINE_OA_URL} target="_blank" rel="noreferrer"
            className="mt-4 inline-flex items-center justify-center rounded-full px-6 py-3 font-bold text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}>
            加入 LINE 好友
          </a>
        </div>
      </main>
      <PublicFooter />
    </div>
  )
}
