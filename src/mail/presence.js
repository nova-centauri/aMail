import { useEffect, useRef, useState } from 'react';

export const PANEL_EASE_MS = 220;

export function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Keep a panel mounted through a short close animation. Open mounts immediately.
 * prefers-reduced-motion unmounts on the same turn the panel is dismissed.
 */
export function usePresence(open) {
  const [mounted, setMounted] = useState(Boolean(open));
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(Boolean(open));

  if (open) {
    if (!mounted || closing) {
      setMounted(true);
      setClosing(false);
    }
  } else if (wasOpen.current && mounted && !closing) {
    if (prefersReducedMotion()) setMounted(false);
    else setClosing(true);
  }
  wasOpen.current = Boolean(open);

  useEffect(() => {
    if (open || !closing) return undefined;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, PANEL_EASE_MS);
    return () => window.clearTimeout(timer);
  }, [open, closing]);

  return {
    mounted: Boolean(open || mounted),
    closing: Boolean(!open && closing && mounted),
  };
}
