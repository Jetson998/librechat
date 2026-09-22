import {
  completePptLogin,
  getPptEntryRedirect,
  isPptAuthEntry,
  isValidPptAuthMessage,
  LIBRECHAT_ORIGIN,
  isPptEmbeddedAuth,
  PPT_AUTH_COMPLETE_MESSAGE,
  PPT_LOGIN_URL,
  PPT_POST_LOGIN_URL,
} from '../routing';

describe('PPT entry routing', () => {
  it('uses the fixed original login host', () => {
    expect(PPT_LOGIN_URL).toBe(`${LIBRECHAT_ORIGIN}/login`);
    expect(new URL(PPT_LOGIN_URL).host).toBe('152.32.172.162.sslip.io');
    expect(new URL(PPT_LOGIN_URL).host).not.toBe('ppt.152.32.172.162.sslip.io');
  });

  it('uses only the fixed original workspace after embedded authentication', () => {
    const navigate = jest.fn();
    completePptLogin(navigate);

    expect(navigate).toHaveBeenCalledWith(PPT_POST_LOGIN_URL);
    expect(PPT_POST_LOGIN_URL).toBe(`${LIBRECHAT_ORIGIN}/c/new`);
  });

  it('recognizes only the explicit PPT entry flag', () => {
    window.history.replaceState({}, '', '/login?entry=ppt');
    expect(isPptAuthEntry()).toBe(true);
    window.history.replaceState({}, '', '/login');
    expect(isPptAuthEntry()).toBe(false);
  });

  it('redirects only the two auth paths and preserves their query string', () => {
    expect(
      getPptEntryRedirect({ pathname: '/login', search: '?redirect_to=%2Fc%2Fnew', hash: '' }),
    ).toBe(`${LIBRECHAT_ORIGIN}/login?redirect_to=%2Fc%2Fnew`);
    expect(
      getPptEntryRedirect({ pathname: '/login/2fa', search: '?tempToken=pending', hash: '#code' }),
    ).toBe(`${LIBRECHAT_ORIGIN}/login/2fa?tempToken=pending#code`);
    expect(getPptEntryRedirect({ pathname: '/', search: '', hash: '' })).toBeNull();
    expect(getPptEntryRedirect({ pathname: '/c/new', search: '', hash: '' })).toBeNull();
  });

  it('drops an external redirect target before leaving the PPT host', () => {
    expect(
      getPptEntryRedirect({ pathname: '/login', search: '?redirect_to=https%3A%2F%2Fevil.test', hash: '' }),
    ).toBe(`${LIBRECHAT_ORIGIN}/login`);
    expect(
      getPptEntryRedirect({ pathname: '/login', search: '?redirect_to=%2Fc%2Fnew', hash: '' }),
    ).toBe(`${LIBRECHAT_ORIGIN}/login?redirect_to=%2Fc%2Fnew`);
    expect(
      getPptEntryRedirect({ pathname: '/login', search: '?redirect_to=%2Flogin', hash: '' }),
    ).toBe(`${LIBRECHAT_ORIGIN}/login`);
  });

  it('accepts the completion message only from the exact login iframe', () => {
    const frameWindow = {} as Window;
    const validEvent = {
      origin: LIBRECHAT_ORIGIN,
      source: frameWindow,
      data: { type: PPT_AUTH_COMPLETE_MESSAGE },
    } as MessageEvent;

    expect(isValidPptAuthMessage(validEvent, frameWindow)).toBe(true);
  });

  it.each([
    ['wrong origin', { origin: 'https://evil.example' }],
    ['wrong source', { source: {} as Window }],
    ['null source', { source: null }],
  ])('rejects a completion message with %s', (_label, overrides) => {
    const frameWindow = {} as Window;
    const event = {
      origin: LIBRECHAT_ORIGIN,
      source: frameWindow,
      data: { type: PPT_AUTH_COMPLETE_MESSAGE },
      ...overrides,
    } as MessageEvent;

    expect(isValidPptAuthMessage(event, frameWindow)).toBe(false);
  });

  it('rejects a completion message when the iframe is unavailable', () => {
    const event = {
      origin: LIBRECHAT_ORIGIN,
      source: null,
      data: { type: PPT_AUTH_COMPLETE_MESSAGE },
    } as MessageEvent;

    expect(isValidPptAuthMessage(event, null)).toBe(false);
  });
});
