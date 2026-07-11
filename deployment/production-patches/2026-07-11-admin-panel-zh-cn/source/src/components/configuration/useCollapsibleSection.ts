import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Shared state machine for collapsible sections.
 *
 * Manages expand/collapse state, deferred rendering via `hasEverExpanded`,
 * deferred add-after-expand via `pendingAddRef`, and `config:expand` /
 * `config:collapse` custom DOM event listeners.
 */
export function useCollapsibleSection({
  defaultExpanded,
  onAdd,
}: {
  defaultExpanded: boolean;
  onAdd?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [hasEverExpanded, setHasEverExpanded] = useState(defaultExpanded);
  const sectionRef = useRef<HTMLElement>(null);
  const pendingAddRef = useRef(false);

  useEffect(() => {
    if (isExpanded && !hasEverExpanded) setHasEverExpanded(true);
  }, [isExpanded, hasEverExpanded]);

  useEffect(() => {
    if (isExpanded && pendingAddRef.current) {
      if (!hasEverExpanded) return;
      pendingAddRef.current = false;
      requestAnimationFrame(() => onAdd?.());
    }
  }, [isExpanded, hasEverExpanded, onAdd]);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const expand = () => setIsExpanded(true);
    const collapse = () => setIsExpanded(false);
    el.addEventListener('config:expand', expand);
    el.addEventListener('config:collapse', collapse);
    return () => {
      el.removeEventListener('config:expand', expand);
      el.removeEventListener('config:collapse', collapse);
    };
  }, []);

  const toggle = useCallback(() => setIsExpanded((prev) => !prev), []);

  const handleAddClick = useCallback(() => {
    if (!isExpanded) {
      pendingAddRef.current = true;
      setIsExpanded(true);
    } else {
      onAdd?.();
    }
  }, [isExpanded, onAdd]);

  return {
    isExpanded,
    hasEverExpanded,
    sectionRef,
    toggle,
    handleAddClick,
  };
}
