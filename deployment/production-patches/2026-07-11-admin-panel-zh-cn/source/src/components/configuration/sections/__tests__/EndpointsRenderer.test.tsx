import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type * as t from '@/types';
import { CustomEndpointsRenderer } from '../EndpointsRenderer';
import { createField } from '@/test/fixtures';

vi.mock('@/hooks/useLocalize', () => ({
  default: () => (key: string) => key,
  useLocalize: () => (key: string) => key,
}));

interface IconProps {
  name: string;
}

interface ButtonProps {
  label?: string;
  onClick?: () => void;
  children?: React.ReactNode;
}
interface TextFieldProps {
  id?: string;
  value?: string;
  placeholder?: string;
  onChange?: (v: string) => void;
  onBlur?: () => void;
  type?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

vi.mock('@clickhouse/click-ui', () => ({
  Icon: ({ name }: IconProps) => <span data-testid={`icon-${name}`} />,
  Button: ({ label, onClick, children }: ButtonProps) => (
    <button onClick={onClick}>{label ?? children}</button>
  ),
  TextField: ({
    id,
    value,
    placeholder,
    onChange,
    onBlur,
    type,
    disabled,
    ...rest
  }: TextFieldProps) => (
    <input
      id={id}
      value={value ?? ''}
      placeholder={placeholder}
      type={type ?? 'text'}
      disabled={disabled}
      aria-label={rest['aria-label']}
      onChange={(e) => onChange?.(e.target.value)}
      onBlur={onBlur}
    />
  ),
  MultiAccordion: {
    Item: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}));

vi.mock('@/components/shared', async () => {
  const actual = await vi.importActual<typeof import('@/components/shared')>('@/components/shared');
  return {
    ...actual,
    TrashButton: ({ onClick, ariaLabel }: { onClick?: () => void; ariaLabel: string }) => (
      <button type="button" aria-label={ariaLabel} onClick={onClick} />
    ),
    FormDialog: ({
      open,
      children,
      onSubmit,
    }: {
      open: boolean;
      children: React.ReactNode;
      onSubmit?: () => void;
    }) =>
      open ? (
        <div data-testid="form-dialog">
          {children}
          <button type="button" onClick={onSubmit}>
            submit
          </button>
        </div>
      ) : null,
  };
});

function endpointFields(): t.SchemaField[] {
  return [
    createField({
      key: 'custom',
      path: 'endpoints.custom',
      type: 'array<object>',
      isArray: true,
      children: [
        createField({ key: 'name', path: 'endpoints.custom.name', type: 'string' }),
        createField({ key: 'apiKey', path: 'endpoints.custom.apiKey', type: 'string' }),
        createField({ key: 'baseURL', path: 'endpoints.custom.baseURL', type: 'string' }),
      ],
    }),
  ];
}

function renderRenderer({
  endpoints,
  yamlBaseKeys,
  isEditingScope,
  onValidationError,
  onChange = vi.fn(),
}: {
  endpoints: Record<string, t.ConfigValue>;
  yamlBaseKeys?: Set<string>;
  isEditingScope?: boolean;
  onValidationError?: (message: string) => void;
  onChange?: (path: string, value: t.ConfigValue) => void;
}) {
  const props: t.FieldRendererProps = {
    fields: endpointFields(),
    parentValue: endpoints,
    parentPath: 'endpoints',
    getValue: (path, fallback) => {
      if (path === 'endpoints.custom') return endpoints.custom ?? fallback;
      return fallback;
    },
    onChange,
    yamlBaseKeys,
    isEditingScope,
    onValidationError,
  };
  return {
    ...render(<CustomEndpointsRenderer {...props} />),
    onChange,
  };
}

describe('CustomEndpointsRenderer', () => {
  it('does not show delete for YAML-defined custom endpoints', () => {
    const { container } = renderRenderer({
      endpoints: {
        custom: [
          {
            name: 'MuskAPI',
            apiKey: '${ANTHROPIC_API_KEY}',
            baseURL: 'https://api.example',
          },
        ],
      },
      yamlBaseKeys: new Set(['MuskAPI']),
    });

    expect(container.querySelector('button[aria-label="com_ui_delete MuskAPI"]')).toBeNull();
  });

  it('locks the name field for YAML-defined custom endpoints but leaves settings editable', () => {
    const { container } = renderRenderer({
      endpoints: {
        custom: [
          {
            name: 'MuskAPI',
            apiKey: '${ANTHROPIC_API_KEY}',
            baseURL: 'https://api.example',
          },
        ],
      },
      yamlBaseKeys: new Set(['MuskAPI']),
    });

    fireEvent.click(container.querySelector('[title="MuskAPI"]')!);

    const name = container.querySelector('input#MuskAPI-name') as HTMLInputElement | null;
    const baseURL = container.querySelector('input#MuskAPI-baseURL') as HTMLInputElement | null;

    expect(name).not.toBeNull();
    expect(name!.hasAttribute('disabled')).toBe(true);
    expect(baseURL).not.toBeNull();
    expect(baseURL!.hasAttribute('disabled')).toBe(false);
  });

  it('does not lock YAML-defined custom endpoint identity in scope editing mode', () => {
    const { container } = renderRenderer({
      endpoints: {
        custom: [
          {
            name: 'MuskAPI',
            apiKey: '${ANTHROPIC_API_KEY}',
            baseURL: 'https://api.example',
          },
        ],
      },
      yamlBaseKeys: new Set(['MuskAPI']),
      isEditingScope: true,
    });

    fireEvent.click(container.querySelector('[title="MuskAPI"]')!);

    const name = container.querySelector('input#MuskAPI-name') as HTMLInputElement | null;

    expect(container.querySelector('button[aria-label="com_ui_delete MuskAPI"]')).not.toBeNull();
    expect(name).not.toBeNull();
    expect(name!.hasAttribute('disabled')).toBe(false);
  });

  it('rejects renaming an Admin DB custom endpoint to an existing YAML endpoint name', () => {
    const onValidationError = vi.fn();
    const { container, onChange } = renderRenderer({
      endpoints: {
        custom: [
          {
            name: 'MuskAPI',
            apiKey: '${ANTHROPIC_API_KEY}',
            baseURL: 'https://api.example',
          },
          {
            name: 'Muskapis-openai',
            apiKey: '${OPENAI_API_KEY}',
            baseURL: 'https://api.example',
          },
        ],
      },
      yamlBaseKeys: new Set(['MuskAPI']),
      onValidationError,
    });

    fireEvent.click(container.querySelector('[title="Muskapis-openai"]')!);

    const name = container.querySelector('input#Muskapis-openai-name') as HTMLInputElement | null;

    expect(name).not.toBeNull();
    fireEvent.change(name!, { target: { value: 'MuskAPI' } });
    fireEvent.blur(name!);

    expect(onChange).not.toHaveBeenCalled();
    expect(onValidationError).toHaveBeenCalledWith('com_config_endpoint_name_exists');
  });

  it('rejects creating a custom endpoint with an existing name', () => {
    const { container, onChange } = renderRenderer({
      endpoints: {
        custom: [
          {
            name: 'MuskAPI',
            apiKey: '${ANTHROPIC_API_KEY}',
            baseURL: 'https://api.example',
          },
        ],
      },
      yamlBaseKeys: new Set(['MuskAPI']),
    });

    const createButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('com_config_create_endpoint'),
    );
    expect(createButton).not.toBeUndefined();
    fireEvent.click(createButton!);

    const name = container.querySelector('input#create-endpoint-name') as HTMLInputElement | null;
    expect(name).not.toBeNull();
    fireEvent.change(name!, { target: { value: 'MuskAPI' } });
    fireEvent.blur(name!);

    const submitButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'submit',
    );
    expect(submitButton).not.toBeUndefined();
    fireEvent.click(submitButton!);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps delete available for Admin DB custom endpoints', () => {
    const { container, onChange } = renderRenderer({
      endpoints: {
        custom: [
          {
            name: 'Muskapis-openai',
            apiKey: '${ANTHROPIC_API_KEY}',
            baseURL: 'https://api.example',
          },
        ],
      },
      yamlBaseKeys: new Set(['MuskAPI']),
    });

    const deleteButton = container.querySelector(
      'button[aria-label="com_ui_delete Muskapis-openai"]',
    ) as HTMLButtonElement | null;
    expect(deleteButton).not.toBeNull();

    fireEvent.click(deleteButton!);

    expect(onChange).toHaveBeenCalledWith('endpoints.custom', []);
  });
});
