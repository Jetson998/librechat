import type * as t from '@/types';

export function SectionControls({ children }: t.SectionControlsProps) {
  return <div className="flex min-w-0 flex-1 flex-col gap-3">{children}</div>;
}
