import { useState, useCallback, useEffect, useRef } from 'react'

interface UseSeatControllerOptions {
  maxSeat: number
  autoStart?: boolean // 是否自動啟動語音識別，預設 false
  onSeatChange?: (seat: number) => void // 座號改變的回調
}

interface UseSeatControllerReturn {
  currentSeat: number
  nextSeat: () => void
  jumpToSeat: (seat: number) => void
  resetSeat: () => void
  isListening: boolean
  startListening: () => void
  stopListening: () => void
  isSupported: boolean
  error: string | null
}

/**
 * 座號控制器 Hook
 *
 * 功能：
 * - 管理當前座號狀態
 * - 提供座號導航功能（下一個、跳轉）
 * - Web Speech API 語音識別（自動識別數字並跳轉）
 *
 * @example
 * const { currentSeat, nextSeat, jumpToSeat, startListening } = useSeatController({ maxSeat: 30 })
 */
export function useSeatController({
  maxSeat,
  autoStart = false,
  onSeatChange
}: UseSeatControllerOptions): UseSeatControllerReturn {

  // ==================== 狀態管理 ====================

  const [currentSeat, setCurrentSeat] = useState(1)
  const [isListening, setIsListening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const shouldRestartRef = useRef(false) // 是否應該自動重啟
  const isStoppingRef = useRef(false) // 是否正在停止（防止自動重啟）

  // ==================== 瀏覽器兼容性檢查 ====================

  const isSupported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  // ==================== 座號控制函數 ====================

  /**
   * 下一個座號（自動 +1，不超過最大值）
   */
  const nextSeat = useCallback(() => {
    setCurrentSeat(prev => {
      const next = Math.min(prev + 1, maxSeat)
      onSeatChange?.(next)
      return next
    })
  }, [maxSeat, onSeatChange])

  /**
   * 跳轉到指定座號
   */
  const jumpToSeat = useCallback((seat: number) => {
    if (seat < 1 || seat > maxSeat) {
      console.warn(`座號 ${seat} 超出範圍 (1-${maxSeat})`)
      return
    }
    setCurrentSeat(seat)
    onSeatChange?.(seat)
  }, [maxSeat, onSeatChange])

  /**
   * 重置座號到 1
   */
  const resetSeat = useCallback(() => {
    setCurrentSeat(1)
    onSeatChange?.(1)
  }, [onSeatChange])

  // ==================== 中文數字轉換 ====================

  /**
   * 將中文數字轉換為阿拉伯數字
   */
  const chineseToNumber = useCallback((text: string): number | null => {
    const chineseNumbers: Record<string, number> = {
      '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
      '十': 10, '百': 100,
      // 繁體
      '壹': 1, '貳': 2, '參': 3, '肆': 4, '伍': 5,
      '陸': 6, '柒': 7, '捌': 8, '玖': 9, '拾': 10
    }

    // 處理單個字符
    if (text.length === 1 && text in chineseNumbers) {
      return chineseNumbers[text]
    }

    // 處理 "十X" 形式 (如 "十五" = 15)
    if (text.startsWith('十') && text.length === 2) {
      const digit = chineseNumbers[text[1]]
      return digit !== undefined ? 10 + digit : null
    }

    // 處理 "X十" 形式 (如 "二十" = 20)
    if (text.endsWith('十') && text.length === 2) {
      const digit = chineseNumbers[text[0]]
      return digit !== undefined ? digit * 10 : null
    }

    // 處理 "X十Y" 形式 (如 "二十五" = 25)
    if (text.length === 3 && text[1] === '十') {
      const tens = chineseNumbers[text[0]]
      const ones = chineseNumbers[text[2]]
      if (tens !== undefined && ones !== undefined) {
        return tens * 10 + ones
      }
    }

    return null
  }, [])

  /**
   * 從語音文本中提取數字
   */
  const extractNumber = useCallback((text: string): number | null => {
    // 移除空格
    const cleaned = text.replace(/\s+/g, '')

    // 嘗試直接解析阿拉伯數字
    const arabicMatch = cleaned.match(/\d+/)
    if (arabicMatch) {
      return parseInt(arabicMatch[0], 10)
    }

    // 嘗試解析中文數字
    const chineseMatch = cleaned.match(/[零一二三四五六七八九十百壹貳參肆伍陸柒捌玖拾]+/)
    if (chineseMatch) {
      return chineseToNumber(chineseMatch[0])
    }

    return null
  }, [chineseToNumber])

  // ==================== 語音識別功能 ====================

  /**
   * 初始化語音識別
   */
  const initRecognition = useCallback(() => {
    if (!isSupported) {
      setError('您的瀏覽器不支援語音識別功能')
      return null
    }

    try {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      const recognition = new SpeechRecognition()

      // 設定語音識別參數
      recognition.continuous = true // 持續監聽
      recognition.interimResults = false // 不需要即時結果
      recognition.lang = 'zh-TW' // 繁體中文
      recognition.maxAlternatives = 1

      // 識別結果處理
      recognition.onresult = (event) => {
        const last = event.results.length - 1
        const transcript = event.results[last][0].transcript.trim()

        console.log('🎤 語音識別:', transcript)

        // 提取數字
        const number = extractNumber(transcript)

        if (number !== null) {
          console.log('✅ 識別到座號:', number)
          jumpToSeat(number)
        } else {
          console.log('❌ 無法識別數字:', transcript)
        }
      }

      // 錯誤處理
      recognition.onerror = (event) => {
        console.error('語音識別錯誤:', event.error)

        // 忽略 "no-speech" 錯誤（這是正常的，只是暫時沒有語音）
        if (event.error === 'no-speech') {
          console.log('⏳ 等待語音輸入...')
          return
        }

        // 忽略 "aborted" 錯誤（這是手動停止造成的）
        if (event.error === 'aborted') {
          console.log('⏹️ 語音識別已中止')
          return
        }

        switch (event.error) {
          case 'audio-capture':
            setError('未找到麥克風')
            break
          case 'not-allowed':
            setError('麥克風權限被拒絕')
            break
          case 'network':
            setError('網路錯誤')
            break
          default:
            setError(`語音識別錯誤: ${event.error}`)
        }

        // 發生錯誤時停止監聽
        shouldRestartRef.current = false
        setIsListening(false)
      }

      // 監聽開始
      recognition.onstart = () => {
        console.log('🎤 開始監聽...')
        setIsListening(true)
        setError(null)
        isStoppingRef.current = false
      }

      // 監聽結束 - 添加自動重啟機制
      recognition.onend = () => {
        console.log('🎤 監聽結束')

        // 如果不是手動停止，且 shouldRestart 為 true，則自動重啟
        if (!isStoppingRef.current && shouldRestartRef.current) {
          console.log('🔄 自動重啟語音識別...')
          setTimeout(() => {
            if (shouldRestartRef.current && recognitionRef.current) {
              try {
                recognitionRef.current.start()
              } catch (err) {
                console.error('自動重啟失敗:', err)
                shouldRestartRef.current = false
                setIsListening(false)
              }
            }
          }, 100) // 延遲 100ms 重啟，避免立即重啟造成的問題
        } else {
          setIsListening(false)
        }
      }

      return recognition
    } catch (err) {
      console.error('初始化語音識別失敗:', err)
      setError('初始化語音識別失敗')
      return null
    }
  }, [isSupported, extractNumber, jumpToSeat])

  /**
   * 啟動語音識別
   */
  const startListening = useCallback(() => {
    if (!isSupported) {
      setError('您的瀏覽器不支援語音識別功能（建議使用 Chrome）')
      return
    }

    if (!recognitionRef.current) {
      recognitionRef.current = initRecognition()
    }

    if (recognitionRef.current && !isListening) {
      try {
        shouldRestartRef.current = true // 啟用自動重啟
        isStoppingRef.current = false
        recognitionRef.current.start()
        console.log('▶️ 啟動語音識別')
      } catch (err) {
        console.error('啟動語音識別失敗:', err)
        setError('啟動語音識別失敗，請重試')
      }
    }
  }, [isSupported, isListening, initRecognition])

  /**
   * 停止語音識別 - 改進版本，立即更新狀態
   */
  const stopListening = useCallback(() => {
    console.log('⏹️ 停止語音識別')

    // 立即更新狀態，不等待 onend 事件
    shouldRestartRef.current = false // 禁用自動重啟
    isStoppingRef.current = true // 標記為正在停止
    setIsListening(false) // 立即更新 UI 狀態

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch (err) {
        console.error('停止語音識別失敗:', err)
      }
    }
  }, [])

  // ==================== 生命週期管理 ====================

  // 自動啟動語音識別
  useEffect(() => {
    if (autoStart && isSupported) {
      startListening()
    }

    // 清理函數
    return () => {
      console.log('🧹 清理語音識別資源')
      shouldRestartRef.current = false
      isStoppingRef.current = true
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop()
          recognitionRef.current = null
        } catch (err) {
          console.error('清理失敗:', err)
        }
      }
    }
  }, []) // 只在組件掛載/卸載時執行

  // ==================== 返回值 ====================

  return {
    currentSeat,
    nextSeat,
    jumpToSeat,
    resetSeat,
    isListening,
    startListening,
    stopListening,
    isSupported,
    error
  }
}

// ==================== TypeScript 類型擴展 ====================

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => any) | null
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => any) | null
  onstart: ((this: SpeechRecognition, ev: Event) => any) | null
  onend: ((this: SpeechRecognition, ev: Event) => any) | null
}

declare var SpeechRecognition: {
  prototype: SpeechRecognition
  new(): SpeechRecognition
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
  message: string
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionResultList {
  length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
  isFinal: boolean
  length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}
