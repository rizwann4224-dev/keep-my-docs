import { colors } from './theme';

interface StatusBadgeProps {
  status: 'active' | 'inactive' | 'archived';
  variant?: 'blue' | 'purple';
}

export function StatusBadge({ status, variant = 'blue' }: StatusBadgeProps) {
  const getBgColor = () => {
    if (variant === 'purple') {
      return 'bg-purple-50 text-purple-700';
    }
    return 'bg-blue-50 text-blue-700';
  };

  const statusText =
    status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <span
      className={`
        inline-flex items-center px-3 py-1 rounded-full
        text-sm font-medium
        ${getBgColor()}
      `}
    >
      {statusText}
    </span>
  );
}
