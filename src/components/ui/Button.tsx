import { ButtonHTMLAttributes, forwardRef } from 'react'
import { cn } from '@/lib/utils'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive'
  size?: 'sm' | 'md' | 'lg'
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          // 共同基底
          'inline-flex items-center justify-center gap-2 rounded-lg font-semibold',
          'transition-colors active:scale-[0.98]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
          // Variants
          {
            'bg-green-600 text-white hover:bg-green-700 focus-visible:ring-green-500':
              variant === 'primary',
            'bg-slate-600 text-white hover:bg-slate-700 focus-visible:ring-slate-500':
              variant === 'secondary',
            'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-400':
              variant === 'outline',
            'text-slate-700 hover:bg-slate-100 focus-visible:ring-slate-400':
              variant === 'ghost',
            'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500':
              variant === 'destructive'
          },
          // Sizes
          {
            'px-3 py-1.5 text-sm': size === 'sm',
            'px-4 py-2 text-sm': size === 'md',
            'px-5 py-2.5 text-base': size === 'lg'
          },
          className
        )}
        {...props}
      >
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'

export default Button
