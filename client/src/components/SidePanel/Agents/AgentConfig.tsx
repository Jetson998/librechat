import { Input } from '@librechat/client';
import { Controller, useWatch, useFormContext } from 'react-hook-form';
import { EModelEndpoint, getEndpointField } from 'librechat-data-provider';
import type { AgentForm, IconComponentTypes } from '~/common';
import { useLocalize, useAgentCapabilities } from '~/hooks';
import { getIconKey, cn } from '~/utils';
import { useAgentFileEntries } from './Tools/hooks';
import { useAgentPanelContext } from '~/Providers';
import ToolsSection from './Tools/ToolsSection';
import { icons } from '~/hooks/Endpoint/Icons';
import Instructions from './Instructions';
import FileContext from './FileContext';
import AgentAvatar from './AgentAvatar';
import { Panel } from '~/common';

const fieldClass = 'h-9';

export default function AgentConfig() {
  const localize = useLocalize();
  const methods = useFormContext<AgentForm>();
  const { setActivePanel, endpointsConfig, agentsConfig } = useAgentPanelContext();
  const { contextEnabled } = useAgentCapabilities(agentsConfig?.capabilities);

  const {
    control,
    formState: { errors },
  } = methods;
  const provider = useWatch({ control, name: 'provider' });
  const model = useWatch({ control, name: 'model' });
  const agent = useWatch({ control, name: 'agent' });
  const agent_id = useWatch({ control, name: 'id' });
  const { contextFiles } = useAgentFileEntries();

  const providerValue = typeof provider === 'string' ? provider : provider?.value;
  let Icon: IconComponentTypes | null | undefined;
  let endpointType: EModelEndpoint | undefined;
  let endpointIconURL: string | undefined;
  let iconKey: string | undefined;

  if (providerValue !== undefined) {
    endpointType = getEndpointField(endpointsConfig, providerValue as string, 'type');
    endpointIconURL = getEndpointField(endpointsConfig, providerValue as string, 'iconURL');
    iconKey = getIconKey({
      endpoint: providerValue as string,
      endpointsConfig,
      endpointType,
      endpointIconURL,
    });
    Icon = icons[iconKey];
  }

  return (
    <div className="h-auto pt-1">
      {/* Identity: flat header, always visible, avatar inline. */}
      <div className="mb-3 mt-1 flex items-center gap-3">
        <div className="flex-shrink-0">
          <AgentAvatar avatar={agent?.['avatar'] ?? null} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Controller
            name="name"
            rules={{ required: localize('com_ui_agent_name_is_required') }}
            control={control}
            render={({ field }) => (
              <div className="flex flex-col">
                <Input
                  {...field}
                  value={field.value ?? ''}
                  maxLength={256}
                  className={cn(fieldClass, 'font-medium')}
                  id="name"
                  type="text"
                  placeholder={localize('com_agents_name_placeholder')}
                  aria-label={localize('com_ui_agent_name')}
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? 'agent-name-error' : undefined}
                />
                {errors.name && (
                  <div id="agent-name-error" className="mt-1 text-xs text-red-500" role="alert">
                    {errors.name.message}
                  </div>
                )}
              </div>
            )}
          />
          <Controller
            name="description"
            control={control}
            render={({ field }) => (
              <Input
                {...field}
                value={field.value ?? ''}
                maxLength={512}
                className={fieldClass}
                id="description"
                type="text"
                placeholder={localize('com_agents_description_placeholder')}
                aria-label={localize('com_ui_agent_description')}
              />
            )}
          />
        </div>
      </div>

      {/* MODEL */}
      <div className="mb-3">
        <div className="flex min-w-0 flex-col">
          <label
            className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary"
            htmlFor="provider"
          >
            {localize('com_ui_model')} <span className="text-red-500">*</span>
          </label>
          <button
            type="button"
            onClick={() => setActivePanel(Panel.model)}
            title={model || undefined}
            className={cn(
              'relative flex h-9 w-full min-w-0 items-center overflow-hidden rounded-lg border border-border-light bg-surface-secondary text-sm font-medium text-text-primary transition-colors hover:bg-surface-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary',
              model != null && model ? 'px-1' : 'px-3',
            )}
          >
            <div className="flex w-full min-w-0 items-center gap-2">
              {Icon && (
                <div className="shadow-stroke relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white text-black dark:bg-white">
                  <Icon
                    className="h-2/3 w-2/3"
                    endpoint={providerValue as string}
                    endpointType={endpointType}
                    iconURL={endpointIconURL}
                  />
                </div>
              )}
              <span className="truncate">
                {model != null && model ? model : localize('com_ui_select_model')}
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* INSTRUCTIONS */}
      <Instructions />

      {/* Platform capabilities and personal Skills only. */}
      <ToolsSection agentId={agent_id} variant="basic" />

      {/* File context stays separate from the tool library. */}
      {contextEnabled && (
        <div className="mb-3">
          <FileContext agent_id={agent_id} files={contextFiles} />
        </div>
      )}
    </div>
  );
}
