import { User, Settings, LogOut } from 'lucide-react';
import { colors, spacing, borderRadius, shadows, typography } from './theme';

interface TopNavigationProps {
  userEmail?: string;
  onSettings?: () => void;
  onSignOut?: () => void;
  onICAPClick?: () => void;
}

export function TopNavigation({
  userEmail = 'student@example.com',
  onSettings,
  onSignOut,
  onICAPClick,
}: TopNavigationProps) {
  return (
    <nav
      className="flex items-center justify-between"
      style={{
        backgroundColor: colors.background.card,
        border: `1px solid ${colors.border}`,
        borderRadius: borderRadius.xl,
        padding: `${spacing.md} ${spacing.lg}`,
        boxShadow: shadows.md,
        marginBottom: spacing.xl,
      }}
    >
      {/* Left side - Logo and title */}
      <div className="flex items-center gap-3">
        {/* Logo Icon */}
        <div
          className="flex items-center justify-center rounded-lg"
          style={{
            width: '40px',
            height: '40px',
            backgroundColor: colors.background.lightBlue,
            color: colors.primary.blue,
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </div>

        {/* Brand Text */}
        <div className="flex flex-col gap-1">
          <span
            style={{
              fontSize: '11px',
              fontWeight: '700',
              letterSpacing: '0.5px',
              color: colors.primary.blue,
              textTransform: 'uppercase',
            }}
          >
            Study Desk
          </span>
          <h1
            style={{
              fontSize: '18px',
              fontWeight: '600',
              color: colors.primary.darkNavy,
              margin: 0,
              lineHeight: '1.2',
            }}
          >
            Your notebooks
          </h1>
        </div>
      </div>

      {/* Right side - Actions */}
      <div className="flex items-center gap-3">
        {/* User Profile */}
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center rounded-full"
            style={{
              width: '36px',
              height: '36px',
              backgroundColor: colors.background.lightBlue,
              color: colors.primary.blue,
            }}
          >
            <User size={18} />
          </div>
          <span
            className="hidden sm:inline text-sm"
            style={{
              color: colors.primary.secondaryText,
            }}
          >
            {userEmail}
          </span>
        </div>

        {/* ICAP Exam Tool Button */}
        <button
          onClick={onICAPClick}
          style={{
            backgroundColor: colors.primary.blue,
            color: 'white',
            padding: `${spacing.sm} ${spacing.md}`,
            borderRadius: borderRadius.md,
            border: 'none',
            fontSize: '14px',
            fontWeight: '500',
            cursor: 'pointer',
            transition: 'all 150ms ease-in-out',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '0.9';
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = shadows.md;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = 'none';
          }}
          className="hidden sm:block whitespace-nowrap"
        >
          ICAP exam tool
        </button>

        {/* Settings Button */}
        <button
          onClick={onSettings}
          style={{
            backgroundColor: 'transparent',
            color: colors.primary.secondaryText,
            padding: `${spacing.sm} ${spacing.md}`,
            borderRadius: borderRadius.md,
            border: `1px solid ${colors.border}`,
            fontSize: '14px',
            fontWeight: '500',
            cursor: 'pointer',
            transition: 'all 150ms ease-in-out',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = colors.background.lightBlue;
            e.currentTarget.style.color = colors.primary.blue;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = colors.primary.secondaryText;
          }}
          className="hidden sm:flex"
        >
          <Settings size={16} />
          <span>Settings</span>
        </button>

        {/* Sign Out Button */}
        <button
          onClick={onSignOut}
          style={{
            backgroundColor: 'transparent',
            color: colors.primary.secondaryText,
            fontSize: '14px',
            fontWeight: '500',
            cursor: 'pointer',
            transition: 'color 150ms ease-in-out',
            border: 'none',
            padding: '0',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = colors.primary.blue;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = colors.primary.secondaryText;
          }}
          className="hidden sm:block"
        >
          Sign out
        </button>

        {/* Mobile menu icon (optional) */}
        <button
          className="sm:hidden flex items-center justify-center"
          style={{
            width: '36px',
            height: '36px',
            backgroundColor: colors.background.lightBlue,
            color: colors.primary.blue,
            borderRadius: borderRadius.md,
            border: 'none',
            cursor: 'pointer',
          }}
          aria-label="Menu"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
