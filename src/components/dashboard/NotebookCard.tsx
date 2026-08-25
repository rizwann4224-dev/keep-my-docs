import { MoreVertical, FileText, ArrowRight, Calendar, Layers } from 'lucide-react';
import { IconButton } from './IconButton';
import { StatusBadge } from './StatusBadge';
import { MetadataItem } from './MetadataItem';
import { colors, spacing, borderRadius, shadows, transitions } from './theme';

interface NotebookCardProps {
  title: string;
  sourcesCount: number;
  lastUpdated: string;
  status: 'active' | 'inactive' | 'archived';
  accentColor?: 'blue' | 'purple';
  onNavigate?: () => void;
  onMenu?: () => void;
}

export function NotebookCard({
  title,
  sourcesCount,
  lastUpdated,
  status,
  accentColor = 'blue',
  onNavigate,
  onMenu,
}: NotebookCardProps) {
  const isPurple = accentColor === 'purple';
  const bgColor = isPurple ? colors.background.lightPurple : colors.background.card;
  const accentHex = isPurple ? colors.accent.purple : colors.primary.blue;

  return (
    <div
      className="relative overflow-hidden transition-all"
      style={{
        backgroundColor: bgColor,
        border: `1px solid ${colors.border}`,
        borderRadius: borderRadius.xl,
        padding: spacing.md,
        minHeight: '280px',
        display: 'flex',
        flexDirection: 'column',
        transitionDuration: transitions.normal,
        transitionProperty: 'all',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-4px)';
        e.currentTarget.style.boxShadow = shadows.lg;
        e.currentTarget.style.borderColor = accentHex + '40';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = shadows.md;
        e.currentTarget.style.borderColor = colors.border;
      }}
    >
      {/* Header with Icon and Menu */}
      <div className="flex items-start justify-between mb-4">
        <div
          className="flex items-center justify-center rounded-lg"
          style={{
            width: '44px',
            height: '44px',
            backgroundColor: isPurple ? '#F2ECFF' : '#EAF3FF',
            color: accentHex,
          }}
        >
          <FileText size={24} />
        </div>
        <IconButton
          icon={<MoreVertical size={20} />}
          variant="ghost"
          size="sm"
          onClick={onMenu}
          ariaLabel="Notebook options"
        />
      </div>

      {/* Title */}
      <h3
        className="font-semibold mb-4"
        style={{
          color: colors.primary.darkNavy,
          fontSize: '20px',
        }}
      >
        {title}
      </h3>

      {/* Metadata */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <MetadataItem
          icon={<Layers size={16} />}
          label={`${sourcesCount} ${sourcesCount === 1 ? 'source' : 'sources'}`}
          showDivider
        />
        <MetadataItem
          icon={<Calendar size={16} />}
          label={lastUpdated}
        />
      </div>

      {/* Divider */}
      <div
        className="my-4"
        style={{
          height: '1px',
          backgroundColor: colors.border,
        }}
      ></div>

      {/* Footer with Status and Action */}
      <div className="flex items-center justify-between mt-auto">
        <StatusBadge status={status} variant={accentColor} />
        <IconButton
          icon={<ArrowRight size={20} />}
          variant="primary"
          size="md"
          onClick={onNavigate}
          ariaLabel={`Open ${title}`}
          style={{
            backgroundColor: isPurple ? '#F2ECFF' : '#EAF3FF',
            color: accentHex,
          }}
        />
      </div>
    </div>
  );
}
