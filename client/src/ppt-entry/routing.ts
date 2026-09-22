import { isSafeRedirect } from '~/utils/redirect';

export const LIBRECHAT_ORIGIN = 'https://152.32.172.162.sslip.io';
export const PPT_ENTRY_ORIGIN = 'https://ppt.152.32.172.162.sslip.io';
export const PPT_LOGIN_URL = `${LIBRECHAT_ORIGIN}/login`;
export const PPT_EMBEDDED_LOGIN_URL = `${PPT_LOGIN_URL}?entry=ppt`;
export const PPT_POST_LOGIN_URL = `${LIBRECHAT_ORIGIN}/c/new`;
export const PPT_AUTH_COMPLETE_MESSAGE = 'librechat:ppt-authenticated';

type PptAuthMessage = Pick<MessageEvent, 'origin' | 'source' | 'data'>;

/**
 * Accept a completion signal only from the current original-domain login
 * iframe. The parent page must have an iframe and the event source must be
 * that exact browsing context; origin and message type are fixed as well.
 */
export function isValidPptAuthMessage(
  event: PptAuthMessage,
  frameWindow: Window | null,
): boolean {
  return (
    frameWindow !== null &&
    event.origin === LIBRECHAT_ORIGIN &&
    event.source === frameWindow &&
    event.data?.type === PPT_AUTH_COMPLETE_MESSAGE
  );
}

export function completePptLogin(navigate: (url: string) => void = (url) => window.location.assign(url)) {
  navigate(PPT_POST_LOGIN_URL);
}

type LocationParts = Pick<Location, 'pathname' | 'search' | 'hash'>;

export function isPptAuthEntry(location: Pick<Location, 'search'> = window.location): boolean {
  return new URLSearchParams(location.search).get('entry') === 'ppt';
}

export function isPptEmbeddedAuth(location: Pick<Location, 'search'> = window.location): boolean {
  return isPptAuthEntry(location) && window.parent !== window;
}

export function notifyPptAuthComplete(): void {
  if (!isPptEmbeddedAuth() || window.parent === window) {
    return;
  }

  window.parent.postMessage({ type: PPT_AUTH_COMPLETE_MESSAGE }, PPT_ENTRY_ORIGIN);
}

function getSafeAuthSearch(search: string): string {
  const params = new URLSearchParams(search);
  const redirectTo = params.get('redirect_to');

  if (redirectTo !== null && !isSafeRedirect(redirectTo)) {
    params.delete('redirect_to');
  }

  return params.toString() ? `?${params.toString()}` : '';
}

export function getPptEntryRedirect({ pathname, search, hash }: LocationParts): string | null {
  if (pathname !== '/login' && pathname !== '/login/2fa') {
    return null;
  }

  return `${LIBRECHAT_ORIGIN}${pathname}${getSafeAuthSearch(search)}${hash}`;
}
