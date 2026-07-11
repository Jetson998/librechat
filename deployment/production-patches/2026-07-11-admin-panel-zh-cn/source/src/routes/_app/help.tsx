import { createFileRoute } from '@tanstack/react-router';
import { HelpPage } from '@/components/help/HelpPage';

export const Route = createFileRoute('/_app/help')({
  component: HelpPage,
});
