import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AgentContact from '../AgentContact';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_agents_contact: 'Contact',
      com_agents_no_contact_available: 'No contact available',
    };
    return translations[key] || key;
  },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
}));

describe('AgentContact', () => {
  it.each([
    'agent_workflow_meeting-to-action',
    'agent_workflow_knowledge-base-curator',
    'agent_workflow_excel-audit-reconciliation',
    'agent_workflow_policy-change-impact',
    'agent_workflow_feedback-root-cause-analysis',
    'agent_workflow_kyc-periodic-review',
    'agent_workflow_journal-entry-audit',
  ])('hides contact for managed preset Agent %s', (id) => {
    const { container } = render(
      <AgentContact
        agent={
          {
            id,
            support_contact: { name: 'LibreChat Workflow Agent' },
            owner_contact: { name: 'Owner User', email: 'owner@example.com' },
          } as any
        }
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
    expect(screen.queryByText('LibreChat Workflow Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Owner User')).not.toBeInTheDocument();
  });

  it('keeps contact visible for an Agent outside the exact preset ID list', () => {
    render(
      <AgentContact
        agent={
          {
            id: 'workflow_custom-agent',
            support_contact: { name: 'Visible Support', email: 'support@example.com' },
          } as any
        }
      />,
    );

    expect(screen.getByRole('link', { name: 'Visible Support' })).toHaveAttribute(
      'href',
      'mailto:support@example.com',
    );
  });

  it('uses support contact before owner contact', () => {
    render(
      <AgentContact
        agent={
          {
            support_contact: { name: 'Support Team', email: 'support@example.com' },
            owner_contact: { name: 'Owner User', email: 'owner@example.com' },
          } as any
        }
      />,
    );

    expect(screen.getByText('Contact:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Support Team' })).toHaveAttribute(
      'href',
      'mailto:support@example.com',
    );
    expect(screen.queryByText('Owner User')).not.toBeInTheDocument();
  });

  it('falls back to owner contact', () => {
    render(
      <AgentContact
        agent={
          {
            support_contact: undefined,
            owner_contact: { name: 'Owner User', email: 'owner@example.com' },
          } as any
        }
      />,
    );

    expect(screen.getByRole('link', { name: 'Owner User' })).toHaveAttribute(
      'href',
      'mailto:owner@example.com',
    );
  });

  it('renders a plain name when no email is available', () => {
    render(<AgentContact agent={{ owner_contact: { name: 'Owner User' } } as any} />);

    expect(screen.getByText('Owner User')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders no-contact text when no contact is available', () => {
    render(<AgentContact agent={{ support_contact: {}, owner_contact: undefined } as any} />);

    expect(screen.getByText('No contact available')).toBeInTheDocument();
  });
});
