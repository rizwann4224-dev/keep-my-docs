import { createFileRoute } from '@tanstack/react-router';
import { StudyDeskDashboard } from '~/components/dashboard/StudyDeskDashboard';

export const Route = createFileRoute('/study-desk/')({ 
  component: StudyDeskPage,
});

function StudyDeskPage() {
  return (
    <StudyDeskDashboard
      userEmail="student@university.com"
      onCreateNotebook={() => console.log('Create new notebook')}
      onSettings={() => console.log('Settings clicked')}
      onSignOut={() => console.log('Sign out clicked')}
      onNotebookClick={(id) => console.log(`Navigate to notebook ${id}`)}
    />
  );
}
