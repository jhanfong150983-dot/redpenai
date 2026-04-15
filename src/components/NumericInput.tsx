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
 * 使用內部 state 避免輸入小數點中途被外部 state 覆蓋（如 "14." → 14 → 失去小數點）
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
  const [localValue, setLocalValue] = React.useState<string>(
    value != null && value !== '' ? String(value) : ''
  )
  const isFocused = React.useRef(false)

  // 外部 value 變更時同步（僅在未聚焦時）
  React.useEffect(() => {
    if (!isFocused.current) {
      setLocalValue(value != null && value !== '' ? String(value) : '')
    }
  }, [value])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value

    if (v === '') {
      setLocalValue('')
      onChange('')
      return
    }

    const regex = allowDecimal ? /^\d*\.?\d*$/ : /^\d+$/
    if (!regex.test(v)) return

    const num = Number(v)
    if (max !== undefined && num > max) return

    setLocalValue(v)

    if (allowDecimal) {
      // 末尾是 "." 時為輸入中間狀態，暫不通知外部（blur 時再通知）
      if (!v.endsWith('.')) {
        onChange(num)
      }
    } else {
      onChange(num)
    }
  }

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocused.current = true
    e.target.select()
    onFocus?.(e)
  }

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocused.current = false
    const v = e.target.value

    if (v === '' || v === '.') {
      const fallback = min ?? 0
      setLocalValue(String(fallback))
      onChange(fallback)
    } else {
      const num = Number(v)
      setLocalValue(String(num)) // 正規化，例如 "14." → "14"
      onChange(num)
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
      value={localValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  )
}
