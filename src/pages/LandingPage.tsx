import {
  Camera,
  Sparkles,
  BarChart3,
  ClipboardCheck,
  ArrowRight,
  Check,
  X,
  Shield,
  CreditCard,
  RefreshCw,
  Mail,
  Phone,
  Crown,
  FileText
} from 'lucide-react'
import { SUPPORT_EMAIL, SUPPORT_PHONE } from '../lib/legal'

// 登入連結
const LOGIN_URL = '/api/auth/google'

export default function LandingPage() {

  return (
    <div className="min-h-screen bg-white">
      {/* Navbar - 固定頂部 */}
      <nav className="fixed top-0 left-0 right-0 bg-white/95 backdrop-blur-sm border-b border-gray-100 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="RedPen AI" className="w-8 h-8" />
              <span className="text-xl font-bold text-gray-900">RedPen AI</span>
            </div>
            <a
              href={LOGIN_URL}
              className="px-5 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors"
            >
              登入
            </a>
          </div>
        </div>
      </nav>

      {/* Hero 區塊 */}
      <section className="pt-24 pb-16 sm:pt-32 sm:pb-24 bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="animate-fade-in-up">
              <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 leading-tight">
                AI 自動批改作業
                <br />
                <span className="text-blue-600">讓老師把時間留給教學</span>
              </h1>
              <p className="mt-6 text-lg text-gray-600 leading-relaxed">
                拍照即可批改紙本作業，自動分析學生錯誤並產出教學建議。
                <br />
                專為國小、國中老師打造的智慧批改助手。
              </p>
              <div className="mt-8 flex flex-col sm:flex-row gap-4">
                <a
                  href={LOGIN_URL}
                  className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition-colors shadow-lg shadow-blue-600/25"
                >
                  立即免費試用
                  <ArrowRight className="w-5 h-5" />
                </a>
                {/* 查看範例按鈕 - 暫時隱藏
                <a
                  href="#example"
                  className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-white text-gray-700 font-semibold rounded-xl hover:bg-gray-50 transition-colors border border-gray-200"
                >
                  查看範例
                </a>
                */}
              </div>
            </div>
            <div className="relative animate-fade-in-up animation-delay-200">
              {/* Hero 主視覺 */}
              <img 
                src="/hero-mockup.png" 
                alt="RedPen AI 批改介面示意圖"
                className="w-full h-auto rounded-2xl shadow-2xl border border-gray-200"
              />
              {/* 裝飾元素 */}
              <div className="absolute -top-4 -right-4 w-24 h-24 bg-yellow-200 rounded-full opacity-50 blur-2xl" />
              <div className="absolute -bottom-4 -left-4 w-32 h-32 bg-blue-200 rounded-full opacity-50 blur-2xl" />
            </div>
          </div>
        </div>
      </section>

      {/* 教師痛點影片區塊 */}
      <section className="py-16 sm:py-24 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12 animate-fade-in-up">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
              老師的日常，我們懂
            </h2>
            <p className="mt-4 text-lg text-gray-600">
              每天批改作業到深夜？ RedPen AI 幫你解決繁重的批改工作，讓你有更多時間專注教學。
            </p>
          </div>
          {/* PWA 優化: 使用 YouTube 嵌入式播放器替代本地 26MB 影片 */}
          <div className="relative aspect-video rounded-2xl overflow-hidden shadow-2xl bg-gray-900 animate-fade-in-up animation-delay-200">
            <iframe
              className="absolute inset-0 w-full h-full"
              src="https://www.youtube.com/embed/gbTN5zb67To"
              title="RedPen AI 介紹影片"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              loading="lazy"
            />
          </div>
        </div>
      </section>

      {/* 解決方案區塊 */}
      <section id="example" className="py-16 sm:py-24 bg-gray-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16 animate-fade-in-up">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
              RedPen AI 如何幫助你
            </h2>
            <p className="mt-4 text-lg text-gray-600">
              四大核心功能，讓批改作業變得輕鬆高效
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {/* 功能卡片 1 */}
            <div className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-shadow animate-fade-in-up">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0">
                  <Camera className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-gray-900">拍照上傳</h3>
                  <p className="mt-2 text-gray-600">
                    手機或平板直接拍照，紙本作業秒變數位檔案。同時支援pdf檔批次上傳，一次處理整班作業與考卷。
                  </p>
                </div>
              </div>
              <div className="mt-4 aspect-[3/2] bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl overflow-hidden">
                <img src="/screenshot-upload.png" alt="拍照上傳" className="w-full h-full object-cover" />
              </div>
            </div>

            {/* 功能卡片 2 */}
            <div className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-shadow animate-fade-in-up animation-delay-100">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-6 h-6 text-purple-600" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-gray-900">AI 自動批改</h3>
                  <p className="mt-2 text-gray-600">
                    智慧辨識學生答案，自動比對正確答案並標記錯誤。老師只需確認，大幅節省時間。
                  </p>
                </div>
              </div>
              <div className="mt-4 aspect-[3/2] bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl overflow-hidden">
                <img src="/screenshot-grading.png" alt="AI 自動批改" className="w-full h-full object-cover" />
              </div>
            </div>

            {/* 功能卡片 3 */}
            <div className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-shadow animate-fade-in-up animation-delay-200">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-orange-100 flex items-center justify-center flex-shrink-0">
                  <BarChart3 className="w-6 h-6 text-orange-600" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-gray-900">訂正管理面板</h3>
                  <p className="mt-2 text-gray-600">
                    清楚呈現學生錯誤題目，讓教師輕鬆管理學生訂正情況。也可以產生訂正單，方便學生自主訂正。
                  </p>
                </div>
              </div>
              <div className="mt-4 aspect-[3/2] bg-gradient-to-br from-orange-50 to-orange-100 rounded-xl overflow-hidden">
                <img src="/screenshot-report.png" alt="錯誤類型分析" className="w-full h-full object-cover" />
              </div>
            </div>

            {/* 功能卡片 4 */}
            <div className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-shadow animate-fade-in-up animation-delay-300">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-green-100 flex items-center justify-center flex-shrink-0">
                  <ClipboardCheck className="w-6 h-6 text-green-600" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-gray-900">成績自動計算</h3>
                  <p className="mt-2 text-gray-600">
                    自動計算學生分數，並生成成績單。輕鬆匯出 Excel 檔，方便老師記錄與分析學生表現。
                  </p>
                </div>
              </div>
              <div className="mt-4 aspect-[3/2] bg-gradient-to-br from-green-50 to-green-100 rounded-xl overflow-hidden">
                <img src="/screenshot-summary.png" alt="老師行動摘要" className="w-full h-full object-cover" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 使用流程區塊 */}
      <section className="py-16 sm:py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16 animate-fade-in-up">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
              簡單四步驟，輕鬆完成批改
            </h2>
            <p className="mt-4 text-lg text-gray-600">
              從建立作業到完成分析，只需要幾分鐘
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              { step: 1, title: '建立作業', desc: '輸入題目與答案', icon: FileText, color: 'blue' },
              { step: 2, title: '拍照上傳', desc: '掃描學生作業', icon: Camera, color: 'purple' },
              { step: 3, title: 'AI 批改', desc: '自動辨識批改', icon: Sparkles, color: 'orange' },
              { step: 4, title: '教學分析', desc: '查看報告建議', icon: BarChart3, color: 'green' }
            ].map((item, index) => {
              const colorClasses: Record<string, { bg: string; text: string }> = {
                blue: { bg: 'bg-blue-100', text: 'text-blue-600' },
                purple: { bg: 'bg-purple-100', text: 'text-purple-600' },
                orange: { bg: 'bg-orange-100', text: 'text-orange-600' },
                green: { bg: 'bg-green-100', text: 'text-green-600' }
              }
              const colors = colorClasses[item.color]
              return (
                <div
                  key={item.step}
                  className={`relative text-center animate-fade-in-up`}
                  style={{ animationDelay: `${index * 100}ms` }}
                >
                  <div className={`w-16 h-16 mx-auto rounded-2xl ${colors.bg} flex items-center justify-center mb-4`}>
                    <item.icon className={`w-8 h-8 ${colors.text}`} />
                  </div>
                  <div className="absolute -top-2 right-1/2 translate-x-1/2 sm:right-4 sm:translate-x-0 w-8 h-8 bg-gray-900 text-white rounded-full flex items-center justify-center text-sm font-bold">
                    {item.step}
                  </div>
                  <h3 className="text-lg font-bold text-gray-900">{item.title}</h3>
                  <p className="mt-1 text-gray-600">{item.desc}</p>
                  {index < 3 && (
                    <div className="hidden lg:block absolute top-8 left-full w-full">
                      <ArrowRight className="w-6 h-6 text-gray-300 mx-auto" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* 方案與價格區塊 */}
      <section className="py-16 sm:py-24 bg-gradient-to-br from-gray-50 to-blue-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16 animate-fade-in-up">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
              選擇適合你的方案
            </h2>
            <p className="mt-4 text-lg text-gray-600">
              免費開始使用，隨時升級解鎖更多功能
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            {/* 免費方案 */}
            <div className="bg-white rounded-2xl p-8 shadow-lg border border-gray-100 animate-fade-in-up">
              <h3 className="text-2xl font-bold text-gray-900">免費體驗</h3>
              <p className="mt-2 text-gray-600">適合初次體驗的老師</p>
              <div className="mt-6">
                <span className="text-4xl font-bold text-gray-900">$0</span>
                <span className="text-gray-500 ml-2">/ 永久免費</span>
              </div>
              <ul className="mt-6 space-y-3">
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-500 flex-shrink-0" />
                  <span className="text-gray-600">班級管理</span>
                </li>
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-500 flex-shrink-0" />
                  <span className="text-gray-600">作業管理與匯入</span>
                </li>
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-500 flex-shrink-0" />
                  <span className="text-gray-600">AI 批改（依墨水用量）</span>
                </li>
                <li className="flex items-center gap-3">
                  <X className="w-5 h-5 text-gray-300 flex-shrink-0" />
                  <span className="text-gray-400">訂正管理</span>
                </li>
                <li className="flex items-center gap-3">
                  <X className="w-5 h-5 text-gray-300 flex-shrink-0" />
                  <span className="text-gray-400">成績管理</span>
                </li>
                <li className="flex items-center gap-3">
                  <X className="w-5 h-5 text-gray-300 flex-shrink-0" />
                  <span className="text-gray-400">AI 學情報告</span>
                </li>
                <li className="flex items-center gap-3">
                  <X className="w-5 h-5 text-gray-300 flex-shrink-0" />
                  <span className="text-gray-400">最新模組優先體驗</span>
                </li>
              </ul>
              <a
                href={LOGIN_URL}
                className="mt-8 block w-full py-3 text-center bg-gray-100 text-gray-700 font-semibold rounded-xl hover:bg-gray-200 transition-colors"
              >
                立即免費試用
              </a>
            </div>

            {/* Pro 方案 */}
            <div className="bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl p-8 shadow-xl relative overflow-hidden animate-fade-in-up animation-delay-100">
              <div className="absolute top-4 right-4 px-3 py-1 bg-yellow-400 text-yellow-900 text-xs font-bold rounded-full flex items-center gap-1">
                <Crown className="w-3 h-3" />
                最受老師歡迎
              </div>
              <h3 className="text-2xl font-bold text-white">Pro 方案</h3>
              <p className="mt-2 text-blue-100">解鎖完整功能</p>
              <div className="mt-6">
                <span className="text-4xl font-bold text-white">NT$ 100 起</span>
              </div>
              <p className="text-blue-200 text-sm mt-1">購買墨水即自動升級 Pro</p>

              {/* 墨水方案清單 */}
              <div className="mt-4 bg-white/10 rounded-xl p-4 backdrop-blur-sm">
                <h4 className="text-sm font-semibold text-white mb-3">墨水方案</h4>
                <ul className="space-y-2 text-sm">
                  <li className="flex justify-between text-blue-50">
                    <span>100 墨水</span>
                    <span className="font-semibold">NT$ 100</span>
                  </li>
                  <li className="flex justify-between text-blue-50">
                    <span>300 墨水</span>
                    <span className="font-semibold">NT$ 280</span>
                  </li>
                  <li className="flex justify-between text-blue-50">
                    <span>1000 墨水</span>
                    <span className="font-semibold">NT$ 800</span>
                  </li>
                </ul>
                <p className="text-xs text-blue-200 mt-3 border-t border-white/20 pt-3">
                  墨水用於 AI 批改用量（依頁數/題數扣點），購買後自動升級 Pro 功能
                </p>
              </div>

              <p className="text-xs text-blue-100 mt-4 text-center">
                價格皆以新台幣（NT$）計價
              </p>

              <ul className="mt-6 space-y-3">
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-300 flex-shrink-0" />
                  <span className="text-white">班級管理</span>
                </li>
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-300 flex-shrink-0" />
                  <span className="text-white">作業管理與匯入</span>
                </li>
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-300 flex-shrink-0" />
                  <span className="text-white">AI 批改（依墨水用量）</span>
                </li>
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-300 flex-shrink-0" />
                  <span className="text-white">訂正管理</span>
                </li>
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-300 flex-shrink-0" />
                  <span className="text-white">成績管理</span>
                </li>
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-300 flex-shrink-0" />
                  <span className="text-white">AI 學情報告</span>
                </li>
                <li className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-300 flex-shrink-0" />
                  <span className="text-white">最新模組優先體驗</span>
                </li>
              </ul>
              <a
                href={LOGIN_URL}
                className="mt-8 block w-full py-3 text-center bg-white text-blue-600 font-semibold rounded-xl hover:bg-blue-50 transition-colors"
              >
                升級 Pro 方案
              </a>
            </div>
          </div>

          {/* 功能比較表 - 暫時隱藏
          <div className="mt-16 bg-white rounded-2xl p-6 sm:p-8 shadow-lg max-w-3xl mx-auto animate-fade-in-up">
            <h3 className="text-xl font-bold text-gray-900 mb-6 text-center">功能比較</h3>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 font-semibold text-gray-900">功能</th>
                    <th className="text-center py-3 px-4 font-semibold text-gray-900">免費</th>
                    <th className="text-center py-3 px-4 font-semibold text-blue-600">
                      <span className="inline-flex items-center gap-1">
                        <Crown className="w-4 h-4 text-yellow-500" />
                        Pro
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {[
                    { feature: '班級管理', free: true, pro: true },
                    { feature: '作業管理與匯入', free: true, pro: true },
                    { feature: 'AI 批改', free: true, pro: true },
                    { feature: '訂正管理', free: false, pro: true },
                    { feature: '成績管理', free: false, pro: true },
                    { feature: 'AI 學情報告', free: false, pro: true }
                  ].map((row) => (
                    <tr key={row.feature}>
                      <td className="py-3 px-4 text-gray-700">{row.feature}</td>
                      <td className="py-3 px-4 text-center">
                        {row.free ? (
                          <Check className="w-5 h-5 text-green-500 mx-auto" />
                        ) : (
                          <X className="w-5 h-5 text-gray-300 mx-auto" />
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {row.pro ? (
                          <Check className="w-5 h-5 text-green-500 mx-auto" />
                        ) : (
                          <X className="w-5 h-5 text-gray-300 mx-auto" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          */}
        </div>
      </section>

      {/* 中間 CTA 區塊 */}
      <section className="py-16 sm:py-24 bg-blue-600">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="animate-fade-in-up">
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              準備好提升批改效率了嗎？
            </h2>
            <p className="mt-4 text-lg text-blue-100">
              加入數百位老師的行列，讓 AI 成為你的批改助手
            </p>
            <a
              href={LOGIN_URL}
              className="mt-8 inline-flex items-center justify-center gap-2 px-8 py-4 bg-white text-blue-600 font-semibold rounded-xl hover:bg-blue-50 transition-colors shadow-lg"
            >
              立即免費試用
              <ArrowRight className="w-5 h-5" />
            </a>
          </div>
        </div>
      </section>

      {/* 安心與信任說明 */}
      <section className="py-16 sm:py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12 animate-fade-in-up">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
              安心使用，放心教學
            </h2>
          </div>

          <div className="grid sm:grid-cols-3 gap-8">
            <div className="text-center animate-fade-in-up">
              <div className="w-14 h-14 mx-auto rounded-2xl bg-green-100 flex items-center justify-center mb-4">
                <CreditCard className="w-7 h-7 text-green-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900">不會自動扣款</h3>
              <p className="mt-2 text-gray-600">
                墨水用完前會提醒，不會自動續訂或扣款，完全由你掌控。
              </p>
            </div>

            <div className="text-center animate-fade-in-up animation-delay-100">
              <div className="w-14 h-14 mx-auto rounded-2xl bg-blue-100 flex items-center justify-center mb-4">
                <Shield className="w-7 h-7 text-blue-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900">教育用途資料保護</h3>
              <p className="mt-2 text-gray-600">
                學生資料安全加密儲存，僅供教學用途，絕不外洩或商業使用。
              </p>
            </div>

            <div className="text-center animate-fade-in-up animation-delay-200">
              <div className="w-14 h-14 mx-auto rounded-2xl bg-purple-100 flex items-center justify-center mb-4">
                <RefreshCw className="w-7 h-7 text-purple-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900">隨時可升級或停用</h3>
              <p className="mt-2 text-gray-600">
                沒有綁約限制，想升級就升級，想暫停就暫停，彈性自由。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 bg-gray-900">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {/* 品牌 */}
            <div className="sm:col-span-2 lg:col-span-1">
              <div className="flex items-center gap-2">
                <img src="/logo.png" alt="RedPen AI" className="w-8 h-8" />
                <span className="text-xl font-bold text-white">RedPen AI</span>
              </div>
              <p className="mt-4 text-gray-400">
                AI 自動批改作業，讓老師把時間留給教學
              </p>
            </div>

            {/* 快速連結 */}
            <div>
              <h4 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                快速連結
              </h4>
              <ul className="mt-4 space-y-2">
                <li>
                  <a href="#example" className="text-gray-400 hover:text-white transition-colors">
                    功能介紹
                  </a>
                </li>
                <li>
                  <a href={LOGIN_URL} className="text-gray-400 hover:text-white transition-colors">
                    登入
                  </a>
                </li>
                <li>
                  <a href={LOGIN_URL} className="text-gray-400 hover:text-white transition-colors">
                    免費試用
                  </a>
                </li>
              </ul>
            </div>

            {/* 聯絡資訊 */}
            <div>
              <h4 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                聯絡我們
              </h4>
              <ul className="mt-4 space-y-2">
                <li className="flex items-center gap-2 text-gray-400">
                  <Mail className="w-4 h-4" />
                  <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-white transition-colors">
                    {SUPPORT_EMAIL}
                  </a>
                </li>
                <li className="flex items-center gap-2 text-gray-400">
                  <Phone className="w-4 h-4" />
                  <a href={`tel:${SUPPORT_PHONE.replace(/-/g, '')}`} className="hover:text-white transition-colors">
                    {SUPPORT_PHONE}
                  </a>
                </li>
              </ul>
            </div>

            {/* CTA */}
            <div>
              <h4 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                開始使用
              </h4>
              <a
                href={LOGIN_URL}
                className="mt-4 inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors"
              >
                立即免費試用
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </div>

          <div className="mt-12 pt-8 border-t border-gray-800 text-center">
            <p className="text-gray-500">
              Copyright © 2026 黃政昱. All Rights Reserved.
            </p>
          </div>
        </div>
      </footer>

      {/* CSS 動畫樣式 */}
      <style>{`
        @keyframes fade-in-up {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .animate-fade-in-up {
          animation: fade-in-up 0.6s ease-out forwards;
        }
        
        .animation-delay-100 {
          animation-delay: 100ms;
        }
        
        .animation-delay-200 {
          animation-delay: 200ms;
        }
        
        .animation-delay-300 {
          animation-delay: 300ms;
        }
      `}</style>
    </div>
  )
}
