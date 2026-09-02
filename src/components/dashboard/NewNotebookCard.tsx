import { Plus } from 'lucide-react';
import { IconButton } from './IconButton';
import { colors, spacing, borderRadius, shadows, transitions } from './theme';

interface NewNotebookCardProps {
  onClick?: (() => void) | undefined;
}

export function NewNotebookCard({ onClick }: NewNotebookCardProps) {
  return (
    <div
      className="relative overflow-hidden transition-all group cursor-pointer"
      style={{
        backgroundColor: colors.background.lightBlue,
        border: `2px dashed ${colors.primary.blue}`,
        borderRadius: borderRadius.xl,
        padding: spacing.lg,
        minHeight: '280px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.md,
        transitionDuration: transitions.normal,
        transitionProperty: 'all',
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-4px)';
        e.currentTarget.style.boxShadow = shadows.lg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
      }}
      role="button"
      tabIndex={0}
    >
      {/* Subtle background decoration */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100"
        style={{
          background: 'radial-gradient(circle at 30% 50%, rgba(23, 105, 224, 0.02) 0%, transparent 50%)',
          transitionDuration: transitions.normal,
        }}
      ></div>

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-4">
        {/* Plus Icon Button */}
        <IconButton
          icon={<Plus size={32} />}
          variant="primary"
          size="lg"
          ariaLabel="Create new notebook"
        />

        {/* Text Content */}
        <div className="text-center">
          <h3
            className="font-semibold mb-1"
            style={{
              color: colors.primary.darkNavy,
              fontSize: '18px',
            }}
          >
            New notebook
          </h3>
          <p
            style={{
              color: colors.primary.secondaryText,
              fontSize: '14px',
            }}
          >
            Start a new subject workspace
          </p>
        </div>
      </div>
    </div>
  );
}
