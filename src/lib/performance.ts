// === 📊 PERFORMANCE MONITORING ===

import React from 'react';

/**
 * Hook to monitor component render performance
 * Warns if component re-renders too frequently
 */
export function useRenderPerformance(componentName: string) {
  const renderCount = React.useRef(0);
  const lastRenderTime = React.useRef<number | null>(null);

  React.useEffect(() => {
    renderCount.current++;
    const now = performance.now();
    const timeSinceLastRender = lastRenderTime.current !== null ? now - lastRenderTime.current : Infinity;
    lastRenderTime.current = now;

    if (renderCount.current > 10 && timeSinceLastRender < 100) {
      console.warn(`Frequent re-renders detected: ${componentName} rendered ${renderCount.current} times`);
    }
  }, [componentName]);
} 