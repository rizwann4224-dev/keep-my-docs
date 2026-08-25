# Study Desk Dashboard

## Overview

A premium, professional Study Desk / Notebook Dashboard designed for CA students, accounting professionals, and exam preparation. Built with TypeScript, React, Tailwind CSS, and Lucide Icons.

## Design Philosophy

The dashboard combines:
- **Professional SaaS aesthetics** from accounting/finance products
- **Premium visual identity** with sophisticated blue-based color system
- **Calm and spacious layout** suitable for long study sessions
- **Clean typography hierarchy** inspired by modern productivity apps
- **Subtle animations** that enhance rather than distract

## Color System

```
Primary Blue:        #1769E0
Dark Navy:           #142B4A
Secondary Text:      #52657A
Page Background:     #F4F8FE
Card Background:     #FFFFFF
Border:              #D9E3F0
Light Blue Surface:  #EAF3FF
Purple Accent:       #6D35D8
Light Purple:        #F2ECFF
```

## Component Structure

### Core Components

#### `StudyDeskDashboard`
The main dashboard component that orchestrates the entire interface.

```tsx
<StudyDeskDashboard
  userEmail="student@university.com"
  notebooks={notebookData}
  onNotebookClick={(id) => {}}
  onCreateNotebook={() => {}}
  onSettings={() => {}}
  onSignOut={() => {}}
/>
```

#### `TopNavigation`
Professional header with:
- Study Desk branding
- User profile section
- Action buttons (ICAP exam tool, Settings, Sign out)
- Responsive mobile menu

#### `NotebookCard`
Individual notebook card displaying:
- Notebook icon (subject-specific)
- Title and metadata (sources, last updated)
- Status badge (Active/Inactive/Archived)
- Navigation arrow button
- Three-dot menu for additional options

Supports accent colors (blue/purple) for visual differentiation.

#### `NewNotebookCard`
Call-to-action card for creating new notebooks:
- Light blue dashed border
- Large plus icon button
- Clear messaging
- Hover elevation effect

#### `StatusBadge`
Small badge component showing notebook status.

Variants:
- `blue` - for standard notebooks
- `purple` - for special subjects (CFAP-3)

#### `IconButton`
Reusable circular button component.

Variants:
- `primary` - blue background, used for actions
- `secondary` - gray background
- `ghost` - transparent, used for menu items

Sizes: `sm`, `md`, `lg`

#### `MetadataItem`
Displays metadata with icon and label.

Supports optional divider for visual separation.

## Theme System

`theme.ts` provides centralized configuration:

```tsx
- colors       // Complete color palette
- spacing      // Consistent spacing scale
- borderRadius // Border radius tokens
- shadows      // Shadow definitions
- transitions  // Animation timing
- typography   // Font size and weight specs
```

This ensures consistency across all components and enables easy theme modifications.

## Layout & Responsiveness

### Desktop
- Three cards per row
- Full-featured navigation
- All buttons visible

### Tablet
- Two cards per row
- Navigation adapts gracefully

### Mobile
- One card per row
- Mobile menu button
- Full usability without horizontal scrolling

## Interactions

### Hover States
- Cards move upward 2-4px
- Shadow strengthens
- Border becomes slightly more visible
- Transition duration: 150-200ms

### Button Hover States
- Subtle opacity and shadow changes
- Color transitions for themed buttons
- No exaggerated animations

### Focus States
- Clear 2px outline with 2px offset
- Meets WCAG AA accessibility standards
- Visible keyboard navigation

## Accessibility

✅ Semantic HTML structure
✅ ARIA labels on icon buttons
✅ Keyboard navigation support
✅ Focus visibility
✅ Color contrast compliance
✅ Responsive text sizing

## Typography

Uses **Inter** font family (recommended) or system fallbacks.

### Hierarchy

| Element | Size | Weight |
|---------|------|--------|
| Page Heading | 40px | 600 |
| Card Title | 28px | 600 |
| Section Heading | 20px | 600 |
| Body Text | 16px | 400 |
| Standard | 14px | 400 |
| Metadata | 13px | 400 |
| Label/Nav | 14px | 500 |

## Usage Example

```tsx
import { StudyDeskDashboard } from '~/components/dashboard/StudyDeskDashboard';

function MyPage() {
  return (
    <StudyDeskDashboard
      userEmail="student@example.com"
      notebooks={[
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
      ]}
      onNotebookClick={(id) => {
        // Handle notebook navigation
      }}
      onCreateNotebook={() => {
        // Handle new notebook creation
      }}
    />
  );
}
```

## Customization

### Changing Colors

Edit `theme.ts` to customize the color palette:

```tsx
export const colors = {
  primary: {
    blue: '#YOUR_COLOR',
  },
  // ...
};
```

### Adjusting Spacing

Modify the spacing scale in `theme.ts`:

```tsx
export const spacing = {
  xs: '0.5rem',
  sm: '1rem',
  // ...
};
```

### Typography Changes

Update font sizes and weights in `theme.ts`:

```tsx
export const typography = {
  headingLg: {
    fontSize: '40px',
    fontWeight: '600',
  },
  // ...
};
```

## Performance Considerations

- Lightweight component structure
- Minimal re-renders with proper memoization
- Smooth 60fps animations
- Optimized Lucide Icons (tree-shakeable)
- No heavy dependencies

## Browser Support

- Chrome/Edge: Latest 2 versions
- Firefox: Latest 2 versions
- Safari: Latest 2 versions
- Mobile browsers: Latest versions

## Future Enhancements

- [ ] Dark mode support
- [ ] Customizable notebook colors
- [ ] Drag-and-drop card reordering
- [ ] Notebook search and filtering
- [ ] Advanced analytics dashboard
- [ ] Integration with study tracking

## License

MIT
