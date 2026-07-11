import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type * as t from '@/types';
import { SECTION_META, splitCamelCase } from '@/components/configuration/configMeta';
import { configSchemaTreeOptions } from '@/server';

function buildSearchItems(tree: t.SchemaField[], localize: t.LocalizeFn): t.CommandItem[] {
  const items: t.CommandItem[] = [];
  for (const section of tree) {
    const meta = SECTION_META[section.key];
    if (!meta) continue;

    items.push({
      id: `section:${section.key}`,
      label: localize(meta.titleKey),
      keywords: [section.key, ...splitCamelCase(section.key)],
      category: 'config-section',
      tab: meta.tab,
    });
  }
  return items;
}

export function useSearchIndex(
  localize: t.LocalizeFn,
  shouldLoad: boolean,
): { items: t.CommandItem[]; loading: boolean } {
  const { data: tree, isLoading } = useQuery({
    ...configSchemaTreeOptions,
    enabled: shouldLoad,
  });

  const items = useMemo(() => (tree ? buildSearchItems(tree, localize) : []), [tree, localize]);

  return { items, loading: isLoading };
}
