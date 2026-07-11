import { createFileRoute } from '@tanstack/react-router';
import { DashboardPage } from '@/components/dashboard';

export const Route = createFileRoute('/_app/')({
  component: DashboardRoute,
});

function DashboardRoute() {
  return <DashboardPage />;
}
