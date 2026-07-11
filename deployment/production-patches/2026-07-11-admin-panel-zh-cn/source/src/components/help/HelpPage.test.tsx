import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/locales/i18n';
import { HelpPage } from './HelpPage';

vi.mock('@clickhouse/click-ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

describe('HelpPage', () => {
  it('links to the complete modified source', () => {
    render(<HelpPage />);
    expect(
      screen.getByRole('link', {
        name: /修改版源代码|Modified source code/,
      }),
    ).toHaveAttribute(
      'href',
      'https://github.com/Jetson998/librechat/tree/main/deployment/production-patches/2026-07-11-admin-panel-zh-cn/source',
    );
  });
});
