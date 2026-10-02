import { createFileRoute } from '@tanstack/react-router';
import { StudyDeskDashboard } from '@/components/dashboard/StudyDeskDashboard';

export const Route = createFileRoute('/study-desk/')({
  head: () => ({
    meta: [
      { title: 'Study Desk — Source-Grounded Exam Workspace' },
      {
        name: 'description',
        content: 'Ask questions, review documents, and practise professional exam marking in Study Desk.',
      },
      { property: 'og:title', content: 'Study Desk — Source-Grounded Exam Workspace' },
      {
        property: 'og:description',
        content: 'Ask questions, review documents, and practise professional exam marking in Study Desk.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
  component: StudyDeskPage,
});

function StudyDeskPage() {
  return (
    <StudyDeskDashboard
      userEmail="student@university.com"
      onCreateNotebook={() => console.log('Create new notebook')}
      onSettings={() => console.log('Settings clicked')}
      onSignOut={() => console.log('Sign out clicked')}
      onNotebookClick={(id: string) => console.log(`Navigate to notebook ${id}`)}
    />
  );
}
