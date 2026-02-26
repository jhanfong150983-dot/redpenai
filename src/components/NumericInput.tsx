import React from 'react'

interface NumericInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'inputMode' | 'pattern' | 'onChange'> {
  value: number | string | undefined
  onChange: (value: number | string) => void
  allowDecimal?: boolean
  min?: number
  max?: number
}

/**
 * 數字輸入框元件
 * 解決移動設備上 type="number" 無法完全清除的問題
 * 使用 type="text" + inputMode="numeric" + 自動選取
 */
export function NumericInput({
  value,
  onChange,
  allowDecimal = false,
  min,
  max,
  className = '',
  onFocus,
  onBlur,
  ...props
}: NumericInputProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value

    // 允許空字串（讓用戶可以清空後重新輸入）
    if (v === '') {
      onChange('')
      return
    }

    // 驗證格式
    const regex = allowDecimal ? /^\d*\.?\d*$/ : /^\d+$/
    if (!regex.test(v)) {
      return // 不符合格式，不更新
    }

    // 檢查範圍（只檢查 max，min 在 blur 時處理）
    const num = Number(v)
    if (max !== undefined && num > max) return

    onChange(allowDecimal ? v : num)
  }

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    // 點擊時自動選取全部文字
    e.target.select()
    onFocus?.(e)
  }

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    // 失焦時確保是有效數字
    if (e.target.value === '') {
      onChange(min ?? 0)
    }
    onBlur?.(e)
  }

  return (
    <input
      {...props}
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      pattern={allowDecimal ? '[0-9]*\\.?[0-9]*' : '[0-9]*'}
      className={className}
      value={value ?? ''}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  )
}
