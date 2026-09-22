import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMediaQuery } from '@librechat/client';
import { EModelEndpoint, PermissionTypes, Permissions } from 'librechat-data-provider';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type t from 'librechat-data-provider';
import { useDocumentTitle, useHasAccess, useLocalize, TranslationKeys } from '~/hooks';
import { useGetAgentCategoriesQuery, useGetEndpointsQuery } from '~/data-provider';
import AgentPanelSwitch from '~/components/SidePanel/Agents/AgentPanelSwitch';
import { SidePanelGroup } from '~/components/SidePanel';
import MarketplaceAdminSettings from './MarketplaceAdminSettings';
import AgentWorkspaceHeader from './AgentWorkspaceHeader';
import type { AgentWorkspaceView } from './AgentWorkspaceHeader';
import MyAgentsView from './MyAgentsView';
import CategoryTabs from './CategoryTabs';
import SearchBar from './SearchBar';
import AgentGrid from './AgentGrid';
import { cn } from '~/utils';

interface AgentMarketplaceProps {
  className?: string;
}

type Direction = 'left' | 'right';

function normalizeWorkspaceView(value: string | null): AgentWorkspaceView {
  if (value === 'mine' || value === 'create') {
    return value;
  }
  return 'recommended';
}

export function filterRedundantAgentCategories(
  categories: t.TMarketplaceCategory[],
): t.TMarketplaceCategory[] {
  const allCategory = categories.find((item) => item.value === 'all');
  const promotedCategory = categories.find((item) => item.value === 'promoted');
  const businessCategories = categories.filter(
    (item) => item.value !== 'promoted' && item.value !== 'all',
  );
  const comparisonCount = allCategory?.count ?? promotedCategory?.count;

  if (
    businessCategories.length === 1 &&
    comparisonCount != null &&
    businessCategories[0].count === comparisonCount
  ) {
    return categories.filter((item) => item.value !== businessCategories[0].value);
  }

  return categories;
}

const AgentMarketplace: React.FC<AgentMarketplaceProps> = ({ className = '' }) => {
  const localize = useLocalize();
  const navigate = useNavigate();
  const location = useLocation();
  const { category } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  const view = normalizeWorkspaceView(searchParams.get('view'));
  const workspaceAgentId = searchParams.get('agent') || undefined;
  const searchQuery = searchParams.get('q') || '';

  const hasAccessToAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });
  const hasAccessToCreateAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.CREATE,
  });
  const hasAccessToMarketplace = useHasAccess({
    permissionType: PermissionTypes.MARKETPLACE,
    permission: Permissions.USE,
  });

  const endpointsQuery = useGetEndpointsQuery();
  const agentsEndpoint = endpointsQuery.data?.[EModelEndpoint.agents];
  const workspaceAvailable = agentsEndpoint != null && hasAccessToAgents && hasAccessToMarketplace;
  const canCreate =
    workspaceAvailable && hasAccessToCreateAgents && agentsEndpoint.disableBuilder !== true;
  const effectiveView: AgentWorkspaceView =
    view === 'create' && endpointsQuery.isSuccess && !canCreate ? 'mine' : view;
  const isBuilderOpen =
    effectiveView === 'create' || (effectiveView === 'mine' && workspaceAgentId != null);

  const [displayCategory, setDisplayCategory] = useState<string>(category || 'all');
  const [nextCategory, setNextCategory] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [animationDirection, setAnimationDirection] = useState<Direction>('right');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const transitionTimeoutRef = useRef<number | null>(null);
  const recommendedLocationRef = useRef('/agents');

  useDocumentTitle(`${localize('com_agents_workspace')} | LibreChat`);

  const categoriesQuery = useGetAgentCategoriesQuery({
    enabled: effectiveView === 'recommended' && workspaceAvailable,
    staleTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });

  const visibleCategories = useMemo(
    () => filterRedundantAgentCategories(categoriesQuery.data || []),
    [categoriesQuery.data],
  );

  useEffect(() => {
    if (effectiveView === 'recommended') {
      recommendedLocationRef.current = `${location.pathname}${location.search}`;
    }
  }, [effectiveView, location.pathname, location.search]);

  useEffect(() => {
    if (
      effectiveView === 'recommended' &&
      !category &&
      location.pathname === '/agents' &&
      categoriesQuery.data &&
      displayCategory === 'all'
    ) {
      const hasPromoted = categoriesQuery.data.some((item) => item.value === 'promoted');
      if (hasPromoted) {
        setDisplayCategory('promoted');
      }
    }
  }, [category, categoriesQuery.data, displayCategory, effectiveView, location.pathname]);

  useEffect(() => {
    if (category && category !== displayCategory && !isTransitioning) {
      setDisplayCategory(category);
    }
  }, [category, displayCategory, isTransitioning]);

  useEffect(
    () => () => {
      if (transitionTimeoutRef.current != null) {
        window.clearTimeout(transitionTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (view === 'create' && !canCreate && workspaceAvailable) {
      navigate('/agents?view=mine', { replace: true });
    }
  }, [canCreate, navigate, view, workspaceAvailable]);

  useEffect(() => {
    if (endpointsQuery.isSuccess && !workspaceAvailable) {
      navigate('/c/new', { replace: true });
    }
  }, [endpointsQuery.isSuccess, navigate, workspaceAvailable]);

  const orderedTabs = useMemo(() => {
    const dynamic = visibleCategories.map((item) => item.value);
    return Array.from(new Set(dynamic));
  }, [visibleCategories]);

  const getTabIndex = useCallback(
    (tab: string) => {
      const index = orderedTabs.indexOf(tab);
      return index >= 0 ? index : 0;
    },
    [orderedTabs],
  );

  const getCategoryData = useCallback(
    (categoryValue: string) => {
      if (categoryValue === 'promoted') {
        return {
          name: localize('com_agents_top_picks'),
          description: localize('com_agents_recommended'),
        };
      }
      if (categoryValue === 'all') {
        return {
          name: localize('com_agents_all'),
          description: localize('com_agents_all_description'),
        };
      }
      if (categoryValue === 'automation-workflow') {
        const categoryData = categoriesQuery.data?.find(
          (item) => item.value === categoryValue,
        );
        return {
          name: localize('com_agents_category_agent'),
          description: categoryData?.description || '',
        };
      }

      const categoryData = categoriesQuery.data?.find((item) => item.value === categoryValue);
      if (categoryData) {
        return {
          name: categoryData.label?.startsWith('com_')
            ? localize(categoryData.label as TranslationKeys)
            : categoryData.label,
          description: categoryData.description?.startsWith('com_')
            ? localize(categoryData.description as TranslationKeys)
            : categoryData.description || '',
        };
      }

      return {
        name: categoryValue.charAt(0).toUpperCase() + categoryValue.slice(1),
        description: '',
      };
    },
    [categoriesQuery.data, localize],
  );

  const handleWorkspaceViewChange = useCallback(
    (nextView: AgentWorkspaceView) => {
      if (nextView === 'recommended') {
        navigate(recommendedLocationRef.current);
        return;
      }
      if (nextView === 'create' && !canCreate) {
        return;
      }
      navigate(`/agents?view=${nextView}`);
    },
    [canCreate, navigate],
  );

  const handleBack = useCallback(() => {
    if (effectiveView === 'mine') {
      navigate('/agents?view=mine');
      return;
    }
    navigate(recommendedLocationRef.current);
  }, [effectiveView, navigate]);

  const handleWorkspaceAgentIdChange = useCallback(
    (agentId?: string) => {
      if (agentId) {
        navigate(`/agents?view=mine&agent=${encodeURIComponent(agentId)}`, { replace: true });
        return;
      }
      if (effectiveView === 'mine') {
        navigate('/agents?view=mine', { replace: true });
      }
    },
    [effectiveView, navigate],
  );

  const handleAgentSelect = useCallback(
    (agent: t.Agent) => {
      const newParams = new URLSearchParams(searchParams);
      newParams.set('agent_id', agent.id);
      setSearchParams(newParams);
    },
    [searchParams, setSearchParams],
  );

  const handleEditAgent = useCallback(
    (agent: t.Agent) => {
      navigate(`/agents?view=mine&agent=${encodeURIComponent(agent.id)}`);
    },
    [navigate],
  );

  const handleTabChange = useCallback(
    (tabValue: string) => {
      if (tabValue === displayCategory || isTransitioning) {
        return;
      }

      const direction: Direction =
        getTabIndex(tabValue) > getTabIndex(displayCategory) ? 'right' : 'left';
      setAnimationDirection(direction);
      setNextCategory(tabValue);
      setIsTransitioning(true);

      const currentSearchParams = searchParams.toString();
      const searchParamsString = currentSearchParams ? `?${currentSearchParams}` : '';
      navigate(
        tabValue === 'promoted'
          ? `/agents${searchParamsString}`
          : `/agents/${tabValue}${searchParamsString}`,
      );

      if (transitionTimeoutRef.current != null) {
        window.clearTimeout(transitionTimeoutRef.current);
      }
      transitionTimeoutRef.current = window.setTimeout(() => {
        setDisplayCategory(tabValue);
        setNextCategory(null);
        setIsTransitioning(false);
      }, 300);
    },
    [displayCategory, getTabIndex, isTransitioning, navigate, searchParams],
  );

  const handleSearch = useCallback(
    (query: string) => {
      const newParams = new URLSearchParams(searchParams);
      if (query.trim()) {
        newParams.set('q', query.trim());
      } else {
        newParams.delete('q');
      }

      const suffix = newParams.toString() ? `?${newParams.toString()}` : '';
      navigate(
        displayCategory === 'promoted' ? `/agents${suffix}` : `/agents/${displayCategory}${suffix}`,
      );
    },
    [displayCategory, navigate, searchParams],
  );

  const renderCategoryPane = (categoryValue: string, isNext = false) => {
    const { name, description } = getCategoryData(categoryValue);
    return (
      <div
        className={cn(
          isNext && 'absolute inset-0',
          isNext &&
            (animationDirection === 'right'
              ? 'motion-safe:animate-slide-in-right'
              : 'motion-safe:animate-slide-in-left'),
          !isNext &&
            isTransitioning &&
            (animationDirection === 'right'
              ? 'motion-safe:animate-slide-out-left'
              : 'motion-safe:animate-slide-out-right'),
        )}
        key={`${isNext ? 'next' : 'current'}-${categoryValue}`}
      >
        {!searchQuery && (
          <div className="mb-5 mt-5 text-left">
            <h2 className="text-xl font-semibold text-text-primary">{name}</h2>
            {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
          </div>
        )}
        <AgentGrid
          category={categoryValue}
          searchQuery={searchQuery}
          onSelectAgent={handleAgentSelect}
          scrollElementRef={scrollContainerRef}
          canCreate={canCreate}
          onCreate={() => handleWorkspaceViewChange('create')}
          onClearSearch={() => handleSearch('')}
          onViewAll={() => handleTabChange('all')}
        />
      </div>
    );
  };

  if (!endpointsQuery.isLoading && !workspaceAvailable) {
    return null;
  }

  return (
    <div
      className={`relative flex w-full grow flex-col overflow-hidden bg-presentation ${className}`}
    >
      <AgentWorkspaceHeader
        view={effectiveView}
        canCreate={canCreate}
        isBuilderOpen={isBuilderOpen}
        onBack={handleBack}
        onChange={handleWorkspaceViewChange}
      />
      <SidePanelGroup>
        <main className="flex h-full flex-col overflow-hidden" role="main">
          <div
            id={`agent-workspace-panel-${effectiveView}`}
            role="tabpanel"
            aria-labelledby={`agent-workspace-tab-${effectiveView}`}
            className="h-full min-h-0"
          >
            {isBuilderOpen ? (
              <div className="scrollbar-gutter-stable h-full overflow-y-auto">
                <AgentPanelSwitch
                  workspaceMode
                  workspaceAgentId={effectiveView === 'mine' ? workspaceAgentId : undefined}
                  onAgentIdChange={handleWorkspaceAgentIdChange}
                />
              </div>
            ) : effectiveView === 'mine' ? (
              <div className="scrollbar-gutter-stable h-full overflow-y-auto">
                <div className="container mx-auto max-w-4xl">
                  <MyAgentsView
                    canCreate={canCreate}
                    onCreate={() => handleWorkspaceViewChange('create')}
                    onEdit={handleEditAgent}
                  />
                </div>
              </div>
            ) : (
              <div
                ref={scrollContainerRef}
                className="scrollbar-gutter-stable relative flex h-full flex-col overflow-y-auto overflow-x-hidden"
              >
                <div className="sticky top-0 z-10 bg-presentation pb-3 pt-4">
                  <div className="container mx-auto max-w-4xl px-4">
                    {isSmallScreen && (
                      <div className="mb-3 flex justify-end">
                        <MarketplaceAdminSettings compact />
                      </div>
                    )}
                    <div className="mx-auto flex max-w-2xl gap-2 pb-4">
                      <SearchBar value={searchQuery} onSearch={handleSearch} />
                      {!isSmallScreen && <MarketplaceAdminSettings />}
                    </div>
                    <CategoryTabs
                      categories={visibleCategories}
                      activeTab={displayCategory}
                      isLoading={categoriesQuery.isLoading}
                      onChange={handleTabChange}
                    />
                  </div>
                </div>

                <div className="container mx-auto max-w-4xl px-4 pb-8">
                  <div className="relative overflow-hidden">
                    {renderCategoryPane(displayCategory)}
                    {isTransitioning && nextCategory && renderCategoryPane(nextCategory, true)}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </SidePanelGroup>
    </div>
  );
};

export default AgentMarketplace;
