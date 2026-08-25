import { ReactNode } from 'react';

interface MetadataItemProps {
  icon: ReactNode;
  label: string;
  showDivider?: boolean;
}

export function MetadataItem({
  icon,
  label,
  showDivider = false,
}: MetadataItemProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-gray-400">{icon}</span>
        <span className="text-sm text-gray-600 font-medium">{label}</span>
      </div>
      {showDivider && (
        <div className="w-px h-5 bg-gray-300"></div>
      )}
    </>
  );
}
