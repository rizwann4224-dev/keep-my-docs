import { forwardRef, ReactNode } from 'react';

interface IconButtonProps {
  icon: ReactNode;
  onClick?: (() => void) | undefined;
  style?: React.CSSProperties | undefined;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

const sizeMap = {
  sm: 'w-8 h-8 text-sm',
  md: 'w-10 h-10 text-base',
  lg: 'w-12 h-12 text-lg',
};

const variantMap = {
  primary: 'bg-blue-50 text-blue-600 hover:bg-blue-100 hover:shadow-md',
  secondary: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
  ghost: 'text-gray-600 hover:text-gray-900 hover:bg-gray-50',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon,
      onClick,
      style,
      variant = 'ghost',
      size = 'md',
      className = '',
      ariaLabel,
      disabled = false,
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        className={`
          flex items-center justify-center
          rounded-full transition-all
          ${sizeMap[size]}
          ${variantMap[variant]}
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          ${className}
        `}
        style={{
          transitionDuration: '150ms',
          transitionTimingFunction: 'ease-in-out',
          ...style,
        }}

      >
        {icon}
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';
