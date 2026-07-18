import { createFileRoute } from '@tanstack/react-router';
import { AccessDenied, PermissionsUnavailable } from '@/components/shared';
import { ModelPricingPage } from '@/components/pricing';
import { SystemCapabilities } from '@/constants';
import { useCapabilities } from '@/hooks';

export const Route = createFileRoute('/_app/pricing')({
  component: PricingRoute,
});

function PricingRoute() {
  const { hasCapability, isLoading, isError } = useCapabilities();

  if (isLoading) return null;
  if (isError) return <PermissionsUnavailable />;
  if (!hasCapability(SystemCapabilities.READ_CONFIGS)) return <AccessDenied />;

  return <ModelPricingPage />;
}
