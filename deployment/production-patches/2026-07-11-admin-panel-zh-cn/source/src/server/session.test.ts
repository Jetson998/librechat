import { describe, it, expect } from 'vitest';
import { SESSION_CONFIG } from './session';

describe('SESSION_CONFIG', () => {
  it('revalidation interval is 60 seconds', () => {
    expect(SESSION_CONFIG.revalidationInterval).toBe(60_000);
  });

  it('idle timeout defaults to 30 minutes', () => {
    expect(SESSION_CONFIG.idleTimeout).toBe(30 * 60 * 1000);
  });
});
