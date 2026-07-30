import React, { useMemo, useEffect } from 'react';
import { Button, Spinner } from '@librechat/client';
import { PermissionBits } from 'librechat-data-provider';
import type t from 'librechat-data-provider';
import { useMarketplaceAgentsInfiniteQuery } from '~/data-provider/Agents';
import { useAgentCategories, useLocalize } from '~/hooks';
import { useInfiniteScroll } from '~/hooks/useInfiniteScroll';
import { useHasData } from './SmartLoader';
import ErrorDisplay from './ErrorDisplay';
import AgentCard from './AgentCard';

interface AgentGridProps {
  category: string;
  searchQuery: string;
  onSelectAgent: (agent: t.Agent) => void;
  scrollElementRef?: React.RefObject<HTMLElement>;
  canCreate?: boolean;
  onCreate?: () => void;
  onClearSearch?: () => void;
  onViewAll?: () => void;
}

/**
 * Component for displaying a grid of agent cards
 */
const AgentGrid: React.FC<AgentGridProps> = ({
  category,
  searchQuery,
  onSelectAgent,
  scrollElementRef,
  canCreate = false,
  onCreate,
  onClearSearch,
  onViewAll,
}) => {
  const localize = useLocalize();

  // Get category data from API
  const { categories } = useAgentCategories();

  // Build query parameters based on current state
  const queryParams = useMemo(() => {
    const params: {
      requiredPermission: number;
      category?: string;
      search?: string;
      limit: number;
      promoted?: 0 | 1;
    } = {
      requiredPermission: PermissionBits.VIEW, // View permission for marketplace viewing
      limit: 6,
    };

    // Handle search
    if (searchQuery) {
      params.search = searchQuery;
      // Include category filter for search if it's not 'all' or 'promoted'
      if (category !== 'all' && category !== 'promoted') {
        params.category = category;
      }
    } else {
      // Handle category-based queries
      if (category === 'promoted') {
        params.promoted = 1;
      } else if (category !== 'all') {
        params.category = category;
      }
      // For 'all' category, no additional filters needed
    }

    return params;
  }, [category, searchQuery]);

  // Use infinite query for marketplace agents
  const {
    data,
    isLoading,
    error,
    isFetching,
    fetchNextPage,
    hasNextPage,
    refetch,
    isFetchingNextPage,
  } = useMarketplaceAgentsInfiniteQuery(queryParams);

  // Flatten all pages into a single array of agents
  const currentAgents = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap((page) => page.data || []);
  }, [data?.pages]);

  // Check if we have meaningful data to prevent unnecessary loading states
  const hasData = useHasData(data?.pages?.[0]);

  // Set up infinite scroll
  const { setScrollElement } = useInfiniteScroll({
    hasNextPage,
    isLoading: isFetching || isFetchingNextPage,
    fetchNextPage: () => {
      if (hasNextPage && !isFetching) {
        fetchNextPage();
      }
    },
    threshold: 0.8, // Trigger when 80% scrolled
    throttleMs: 200,
  });

  // Connect the scroll element when it's provided
  useEffect(() => {
    const scrollElement = scrollElementRef?.current;
    if (scrollElement) {
      setScrollElement(scrollElement);
    }
  }, [scrollElementRef, setScrollElement]);

  /**
   * Get category display name from API data or use fallback
   */
  const getCategoryDisplayName = (categoryValue: string) => {
    if (categoryValue === 'automation-workflow') {
      return localize('com_agents_category_agent');
    }

    const categoryData = categories.find((cat) => cat.value === categoryValue);
    if (categoryData) {
      return categoryData.label;
    }

    // Fallback for special categories or unknown categories
    if (categoryValue === 'promoted') {
      return localize('com_agents_top_picks');
    }
    if (categoryValue === 'all') {
      return 'All';
    }

    // Simple capitalization for unknown categories
    return categoryValue.charAt(0).toUpperCase() + categoryValue.slice(1);
  };

  const emptyState = useMemo(() => {
    if (searchQuery) {
      return {
        heading: localize('com_agents_search_empty_heading'),
        description: localize('com_agents_search_no_results', { query: searchQuery }),
        actionLabel: localize('com_agents_clear_search'),
        onAction: onClearSearch,
      };
    }

    if (category !== 'all' && category !== 'promoted') {
      const categoryName = getCategoryDisplayName(category);
      return {
        heading: localize('com_agents_category_empty', { category: categoryName }),
        description: localize('com_agents_category_empty_description'),
        actionLabel: localize('com_agents_workspace_view_all'),
        onAction: onViewAll,
      };
    }

    return {
      heading: localize('com_agents_workspace_market_empty'),
      description: localize('com_agents_workspace_market_empty_description'),
      actionLabel: localize('com_agents_workspace_create'),
      onAction: canCreate ? onCreate : undefined,
    };
  }, [canCreate, categories, category, localize, onClearSearch, onCreate, onViewAll, searchQuery]);

  // Simple loading spinner
  const loadingSpinner = (
    <div className="flex justify-center py-12">
      <Spinner className="h-8 w-8 text-primary" />
    </div>
  );

  // Handle error state with enhanced error display
  if (error) {
    return (
      <ErrorDisplay
        error={error || 'Unknown error occurred'}
        onRetry={() => refetch()}
        context={{
          searchQuery,
          category,
        }}
      />
    );
  }

  // Main content component with proper semantic structure
  const mainContent = (
    <div
      className="space-y-6"
      role="tabpanel"
      id={`tabpanel-${category}`}
      aria-labelledby={`category-tab-${category}`}
      aria-live="polite"
      aria-busy={isLoading && !hasData}
    >
      {/* Handle empty results with enhanced accessibility */}
      {(!currentAgents || currentAgents.length === 0) && !isLoading && !isFetching ? (
        <div
          className="flex flex-col items-center px-4 py-14 text-center"
          role="status"
          aria-live="polite"
          aria-label={emptyState.heading}
        >
          <h3 className="text-lg font-semibold text-text-primary">{emptyState.heading}</h3>
          <p className="mt-2 max-w-md text-sm text-text-secondary">{emptyState.description}</p>
          {emptyState.onAction && (
            <Button type="button" variant="outline" className="mt-5" onClick={emptyState.onAction}>
              {emptyState.actionLabel}
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* Announcement for screen readers */}
          <div id="search-results-count" className="sr-only" aria-live="polite" aria-atomic="true">
            {localize('com_agents_grid_announcement', {
              count: currentAgents?.length || 0,
              category: getCategoryDisplayName(category),
            })}
          </div>

          {/* Agent grid - 2 per row with proper semantic structure */}
          {currentAgents && currentAgents.length > 0 && (
            <div
              className="mx-4 grid grid-cols-1 gap-6 md:grid-cols-2"
              role="grid"
              aria-label={localize('com_agents_grid_announcement', {
                count: currentAgents.length,
                category: getCategoryDisplayName(category),
              })}
            >
              {currentAgents.map((agent: t.Agent, index: number) => (
                <div key={`${agent.id}-${index}`} role="gridcell">
                  <AgentCard agent={agent} onSelect={onSelectAgent} />
                </div>
              ))}
            </div>
          )}

          {/* Loading indicator when fetching more with accessibility */}
          {isFetchingNextPage && (
            <div
              className="flex justify-center py-8"
              role="status"
              aria-live="polite"
              aria-label={localize('com_agents_loading')}
            >
              <Spinner className="h-6 w-6 text-primary" />
              <span className="sr-only">{localize('com_agents_loading')}</span>
            </div>
          )}

          {/* End of results indicator */}
          {!hasNextPage && currentAgents && currentAgents.length > 0 && (
            <div className="mt-8 text-center">
              <p className="text-sm text-text-secondary">
                {localize('com_agents_no_more_results')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );

  if (isLoading || (isFetching && !isFetchingNextPage)) {
    return loadingSpinner;
  }
  return mainContent;
};

export default AgentGrid;
