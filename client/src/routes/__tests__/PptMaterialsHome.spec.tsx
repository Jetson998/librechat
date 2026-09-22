/* eslint-disable i18next/no-literal-string */
import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import PptMaterialsHome from '../PptMaterialsHome';
import {
  PPT_EMBEDDED_LOGIN_URL,
} from '~/ppt-entry/routing';

describe('PptMaterialsHome', () => {
  it('renders the home page and opens the original login page in a modal', () => {
    render(<PptMaterialsHome />);

    expect(screen.getByRole('heading', { name: '最新PPT模板' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTitle('原站登录')).toHaveAttribute('src', PPT_EMBEDDED_LOGIN_URL);
  });

  it('does not render a local credential form or local two-factor UI', () => {
    render(<PptMaterialsHome />);

    expect(screen.queryByRole('textbox', { name: /邮箱|密码|验证码/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '验证' })).not.toBeInTheDocument();
  });

  it('keeps the PPT page behind the modal while the original service authenticates', () => {
    render(<PptMaterialsHome />);
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(screen.getByRole('heading', { name: '最新PPT模板' })).toBeInTheDocument();
  });
});
