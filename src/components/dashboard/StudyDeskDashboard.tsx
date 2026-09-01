import { useState } from 'react';
import { TopNavigation } from './TopNavigation';
import { NotebookCard } from './NotebookCard';
import { NewNotebookCard } from './NewNotebookCard';
import { colors, spacing, typography } from './theme';

interface NotebookData {
  id: string;
  title: string;
  sourcesCount: number;
  lastUpdated: string;
  status: 'active' | 'inactive' | 'archived';
  accentColor: 'blue' | 'purple';
}

interface StudyDeskDashboardProps {
  userEmail?: string;
  notebooks?: NotebookData[];
  onNotebookClick?: (notebookId: string) => void;
  onCreateNotebook?: () => void;
  onSettings?: () => void;
  onSignOut?: () => void;
}

export function StudyDeskDashboard({
  userEmail = 'student@example.com',
  notebooks = [
    {
      id: '1',
      title: 'AUDIT',
      sourcesCount: 6,
      lastUpdated: 'Aug 12, 2026',
      status: 'active',
      accentColor: 'blue',
    },
    {
      id: '2',
      title: 'CFAP-3',
      sourcesCount: 3,
      lastUpdated: 'Aug 12, 2026',
      status: 'active',
      accentColor: 'purple',
    },
  ],
  onNotebookClick,
  onCreateNotebook,
  onSettings,
  onSignOut,
}: StudyDeskDashboardProps) {
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);

  return (
    <div
      style={{
        backgroundColor: colors.background.page,
        minHeight: '100vh',
        padding: `${spacing.lg} ${spacing.lg}`,
      }}
    >
      {/* Background decorative elements */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: '400px',
          height: '400px',
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(23, 105, 224, 0.03) 0%, transparent 70%)`,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      ></div>
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          width: '300px',
          height: '300px',
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(109, 53, 216, 0.02) 0%, transparent 70%)`,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      ></div>

      {/* Content Container */}
      <div className="relative z-10 max-w-7xl mx-auto">
        {/* Top Navigation */}
        <TopNavigation
          userEmail={userEmail}
          onSettings={onSettings}
          onSignOut={onSignOut}
        />

        {/* Page Header Section */}
        <div
          className="mb-12"
          style={{
            paddingBottom: spacing.lg,
          }}
        >
          <h2
            style={{
              fontSize: typography.headingLg.fontSize,
              fontWeight: typography.headingLg.fontWeight,
              color: colors.primary.darkNavy,
              margin: `0 0 ${spacing.md} 0`,
            }}
          >
            Notebooks
          </h2>
          <p
            style={{
              fontSize: typography.body.fontSize,
              color: colors.primary.secondaryText,
              margin: 0,
              maxWidth: '600px',
            }}
          >
            One notebook per subject — its own sources, questions and lessons learned.
          </p>
        </div>

        {/* Notebook Grid */}
        <div
          className="grid gap-6"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
          }}
        >
          {/* New Notebook Card */}
          <NewNotebookCard onClick={onCreateNotebook} />

          {/* Existing Notebooks */}
          {notebooks.map((notebook) => (
            <div
              key={notebook.id}
              onMouseEnter={() => setHoveredCard(notebook.id)}
              onMouseLeave={() => setHoveredCard(null)}
            >
              <NotebookCard
                title={notebook.title}
                sourcesCount={notebook.sourcesCount}
                lastUpdated={notebook.lastUpdated}
                status={notebook.status}
                accentColor={notebook.accentColor}
                onNavigate={() => onNotebookClick?.(notebook.id)}
                onMenu={() => console.log(`Menu clicked for ${notebook.title}`)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Export all sub-components for standalone use
export { TopNavigation } from './TopNavigation';
export { NotebookCard } from './NotebookCard';
export { NewNotebookCard } from './NewNotebookCard';
export { StatusBadge } from './StatusBadge';
export { IconButton } from './IconButton';
export { MetadataItem } from './MetadataItem';
