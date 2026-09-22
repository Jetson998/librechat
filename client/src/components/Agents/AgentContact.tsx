import type t from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type AgentContactProps = {
  agent?: Pick<t.Agent, 'id' | 'support_contact' | 'owner_contact'> | null;
  className?: string;
};

const HIDDEN_CONTACT_AGENT_IDS = new Set([
  'agent_workflow_meeting-to-action',
  'agent_workflow_knowledge-base-curator',
  'agent_workflow_excel-audit-reconciliation',
  'agent_workflow_policy-change-impact',
  'agent_workflow_feedback-root-cause-analysis',
  'agent_workflow_kyc-periodic-review',
  'agent_workflow_journal-entry-audit',
]);

export default function AgentContact({ agent, className = '' }: AgentContactProps) {
  if (agent?.id && HIDDEN_CONTACT_AGENT_IDS.has(agent.id)) {
    return null;
  }

  const localize = useLocalize();
  const supportName = agent?.support_contact?.name?.trim() ?? '';
  const supportEmail = agent?.support_contact?.email?.trim() ?? '';
  const ownerName = agent?.owner_contact?.name?.trim() ?? '';
  const ownerEmail = agent?.owner_contact?.email?.trim() ?? '';
  let contact: { name: string; email: string } | null = null;
  if (supportName || supportEmail) {
    contact = { name: supportName, email: supportEmail };
  } else if (ownerName || ownerEmail) {
    contact = { name: ownerName, email: ownerEmail };
  }

  const label = contact?.name || contact?.email || localize('com_agents_no_contact_available');

  return (
    <div className={cn('flex min-w-0 items-center gap-1 text-text-secondary', className)}>
      <span className="shrink-0">{localize('com_agents_contact')}:</span>
      <span className="min-w-0 truncate">
        {contact?.email ? (
          <a href={`mailto:${contact.email}`} className="text-primary hover:underline">
            {label}
          </a>
        ) : (
          label
        )}
      </span>
    </div>
  );
}
