import { useRef, useCallback } from 'react';

/**
 * Ref callback instead of useEffect so highlighting fires exactly once on mount
 * without stale-closure or timing issues from effect-based scroll/focus.
 */
export function useHighlightRef(
  fieldId: string | undefined,
): (container: HTMLElement | null) => void {
  const applied = useRef<string | null>(null);

  return useCallback(
    (container: HTMLElement | null) => {
      if (!container || !fieldId || applied.current === fieldId) return;
      applied.current = fieldId;

      requestAnimationFrame(() => {
        const el = container.querySelector<HTMLElement>(`#${CSS.escape(fieldId)}`);
        if (!el) return;

        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const offset =
          elRect.top -
          containerRect.top +
          container.scrollTop -
          containerRect.height / 2 +
          elRect.height / 2;
        container.scrollTo({ top: offset, behavior: 'smooth' });
        el.classList.add('cmdk-highlight');

        setTimeout(() => {
          const focusable = el.querySelector<HTMLElement>(
            'input, select, textarea, button, [tabindex]',
          );
          focusable?.focus({ preventScroll: true });
        }, 400);
      });
    },
    [fieldId],
  );
}
