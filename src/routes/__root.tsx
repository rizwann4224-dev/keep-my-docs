import { Outlet, RootRoute } from '@tanstack/react-router';

export const rootRoute = new RootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div>
      <Outlet />
    </div>
  );
}
