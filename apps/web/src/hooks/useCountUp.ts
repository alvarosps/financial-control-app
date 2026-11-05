'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

const DEFAULT_DURATION_MS = 600;

/**
 * Animates a stable mount-time value once. Later target updates snap so
 * frequently refreshed values never animate.
 */
export function useCountUp(target: number, durationMs: number = DEFAULT_DURATION_MS): number {
  const prefersReducedMotion = usePrefersReducedMotion();
  const previousTarget = useRef(target);
  const hasReceivedTargetUpdate = useRef(false);
  const animationStarted = useRef(false);
  const animationGeneration = useRef(0);
  const [value, setValue] = useState(() => (prefersReducedMotion ? target : 0));

  useEffect(() => {
    const generation = ++animationGeneration.current;

    if (target !== previousTarget.current) {
      hasReceivedTargetUpdate.current = true;
      previousTarget.current = target;
    }

    const shouldSnap =
      prefersReducedMotion ||
      hasReceivedTargetUpdate.current ||
      animationStarted.current ||
      durationMs <= 0;

    if (shouldSnap) {
      setValue(target);
      return;
    }

    const start = performance.now();
    let animationFrame = 0;

    const tick = (now: number) => {
      if (animationGeneration.current !== generation) {
        return;
      }

      animationStarted.current = true;

      const progress = Math.min((now - start) / durationMs, 1);
      const eased = 1 - (1 - progress) ** 3;

      setValue(progress === 1 ? target : target * eased);

      if (progress < 1) {
        animationFrame = requestAnimationFrame(tick);
      }
    };

    animationFrame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(animationFrame);
  }, [durationMs, prefersReducedMotion, target]);

  return value;
}
