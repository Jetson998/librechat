import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/locales/i18n';
import { LanguageSelector } from './LanguageSelector';

describe('LanguageSelector', () => {
  afterEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage('zh-Hans');
  });

  it('selects Simplified Chinese by default', () => {
    render(<LanguageSelector />);
    expect(screen.getByRole('button', { name: '简体中文' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('switches to English, persists the choice, and updates the document language', async () => {
    render(<LanguageSelector />);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    await screen.findByRole('button', { name: 'English', pressed: true });
    expect(localStorage.getItem('i18nextLng')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
