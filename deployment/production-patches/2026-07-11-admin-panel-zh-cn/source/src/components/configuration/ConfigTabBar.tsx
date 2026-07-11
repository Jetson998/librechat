import { Tabs } from '@clickhouse/click-ui';
import type * as t from '@/types';
import { useLocalize } from '@/hooks';
import { cn } from '@/utils';

export function ConfigTabBar({
  tabs,
  activeTab,
  onTabChange,
  tabCounts,
  children,
}: t.ConfigTabBarProps) {
  const localize = useLocalize();

  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      ariaLabel={localize('com_nav_configuration')}
    >
      <Tabs.TriggersList>
        {tabs.map((tab) => {
          const count = tabCounts?.[tab.id];
          return (
            <Tabs.Trigger key={tab.id} value={tab.id}>
              <span className="flex items-center gap-1.5">
                {localize(tab.labelKey)}
                {count !== undefined && (
                  <span
                    className={cn(
                      'config-tab-count',
                      count > 0 ? 'config-tab-count-active' : 'config-tab-count-zero',
                    )}
                  >
                    {count}
                  </span>
                )}
              </span>
            </Tabs.Trigger>
          );
        })}
      </Tabs.TriggersList>
      {children}
    </Tabs>
  );
}
