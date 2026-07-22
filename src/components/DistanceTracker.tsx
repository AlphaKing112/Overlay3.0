"use client";

import React, { useEffect, useState, useMemo } from 'react';

export interface DistanceTrackerProps {
  current: number;
  goal: number;
  unit?: 'mi' | 'km' | 'm';
  title?: string;
  locationText?: string;
  currentLocationText?: string;
  icon?: string;
  visible: boolean;
  color?: 'neon-green' | 'electric-blue' | 'cyber-pink' | 'sunset-orange' | 'gold';
  styleVariant?: 'default' | 'compact' | 'no-background' | 'borderless';
  fontStyle?: 'default' | 'neon' | 'retro' | 'bold' | 'impact';
  scale?: number;
  x?: number;
  y?: number;
  isDemo?: boolean;
}

const COLOR_MAPS = {
  'neon-green': {
    accent: '#00ff66',
    secondary: '#10b981',
    gradient: 'linear-gradient(90deg, #00e65c, #00ffaa)',
    glow: 'rgba(0, 255, 102, 0.4)',
    border: 'rgba(0, 255, 102, 0.35)',
    trackBorder: 'rgba(0, 255, 102, 0.6)',
  },
  'electric-blue': {
    accent: '#00d2ff',
    secondary: '#3b82f6',
    gradient: 'linear-gradient(90deg, #0099ff, #00d2ff)',
    glow: 'rgba(0, 210, 255, 0.4)',
    border: 'rgba(0, 210, 255, 0.35)',
    trackBorder: 'rgba(0, 210, 255, 0.6)',
  },
  'cyber-pink': {
    accent: '#ff007f',
    secondary: '#ec4899',
    gradient: 'linear-gradient(90deg, #d9006c, #ff40a0)',
    glow: 'rgba(255, 0, 127, 0.4)',
    border: 'rgba(255, 0, 127, 0.35)',
    trackBorder: 'rgba(255, 0, 127, 0.6)',
  },
  'sunset-orange': {
    accent: '#ff6b00',
    secondary: '#f97316',
    gradient: 'linear-gradient(90deg, #e65c00, #ff8833)',
    glow: 'rgba(255, 107, 0, 0.4)',
    border: 'rgba(255, 107, 0, 0.35)',
    trackBorder: 'rgba(255, 107, 0, 0.6)',
  },
  'gold': {
    accent: '#ffd700',
    secondary: '#eab308',
    gradient: 'linear-gradient(90deg, #d4af37, #ffe066)',
    glow: 'rgba(255, 215, 0, 0.4)',
    border: 'rgba(255, 215, 0, 0.35)',
    trackBorder: 'rgba(255, 215, 0, 0.6)',
  },
};

export const DistanceTracker: React.FC<DistanceTrackerProps> = ({
  current = 154,
  goal = 378,
  unit = 'mi',
  title = '',
  locationText = '',
  currentLocationText = '',
  icon = '🛼',
  visible = true,
  color = 'neon-green',
  styleVariant = 'default',
  fontStyle = 'default',
  scale = 1,
  x = 0,
  y = 0,
  isDemo = false,
}) => {
  const [shouldRender, setShouldRender] = useState(visible);
  const [activeLabelIndex, setActiveLabelIndex] = useState(0);
  const [labelFadeState, setLabelFadeState] = useState<'in' | 'out'>('in');

  const availableLabels = useMemo(() => {
    const list: string[] = [];
    if (title && title.trim()) list.push(title.trim());
    if (locationText && locationText.trim()) list.push(locationText.trim());
    if (currentLocationText && currentLocationText.trim()) list.push(currentLocationText.trim());
    return list;
  }, [title, locationText, currentLocationText]);

  const fontFamilyStyle = useMemo(() => {
    switch (fontStyle) {
      case 'neon':
        return '"Comic Sans MS", cursive, sans-serif';
      case 'retro':
        return '"Courier New", Courier, monospace';
      case 'bold':
        return '"Arial Black", sans-serif';
      case 'impact':
        return 'Impact, sans-serif';
      case 'default':
      default:
        return "'JetBrains Mono', 'Roboto Mono', 'Courier New', monospace";
    }
  }, [fontStyle]);

  useEffect(() => {
    if (availableLabels.length <= 1) {
      setActiveLabelIndex(0);
      setLabelFadeState('in');
      return;
    }

    const rotationIntervalMs = isDemo ? 5000 : 2 * 60 * 1000; // 2 minutes for live overlay, 5s for admin preview

    const interval = setInterval(() => {
      setLabelFadeState('out');
      setTimeout(() => {
        setActiveLabelIndex((prev) => (prev + 1) % availableLabels.length);
        setLabelFadeState('in');
      }, 400);
    }, rotationIntervalMs);

    return () => clearInterval(interval);
  }, [availableLabels]);

  const displayedLabelText = availableLabels[activeLabelIndex] || availableLabels[0] || '';

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
    } else if (!isDemo) {
      const timer = setTimeout(() => setShouldRender(false), 400);
      return () => clearTimeout(timer);
    }
  }, [visible, isDemo]);

  const percentage = useMemo(() => {
    if (!goal || goal <= 0) return 0;
    const calc = (current / goal) * 100;
    return Math.min(Math.max(calc, 0), 100);
  }, [current, goal]);

  const formattedCurrent = useMemo(() => {
    return Number(current || 0).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: current % 1 === 0 ? 0 : 1,
    });
  }, [current]);

  const formattedGoal = useMemo(() => {
    return Number(goal || 0).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: goal % 1 === 0 ? 0 : 1,
    });
  }, [goal]);

  const theme = COLOR_MAPS[color] || COLOR_MAPS['neon-green'];

  if (!shouldRender && !isDemo) return null;

  return (
    <div
      className={`distance-tracker-root ${visible ? 'fade-in' : 'fade-out'} variant-${styleVariant} ${isDemo ? 'is-demo' : ''}`}
      style={{
        transform: isDemo ? 'none' : `translate(${x}px, ${y}px) scale(${scale})`,
        transformOrigin: 'bottom center',
      }}
    >
      <div className="distance-tracker-inner">
        {/* Left Section: Icon & Header Title / Location Fade */}
        <div className="distance-left-panel">
          <span className="distance-activity-icon" role="img" aria-label="activity">
            {icon || '🛼'}
          </span>
          {displayedLabelText && (
            <span className={`distance-title-label label-fade-${labelFadeState}`}>
              {displayedLabelText}
            </span>
          )}
        </div>

        {/* Center Progress Track */}
        <div className="distance-progress-track-wrapper">
          <div className="distance-progress-track">
            {/* Filled Bar */}
            <div
              className="distance-progress-fill"
              style={{ width: `${percentage}%` }}
            >
              <div className="distance-fill-glow" />
            </div>

            {/* Leading Edge Icon Marker (slips across bar) */}
            <div
              className="distance-leading-marker"
              style={{
                left: `clamp(8px, ${percentage}%, calc(100% - 10px))`,
              }}
            >
              <span className="marker-icon">{icon || '🛼'}</span>
            </div>
          </div>
        </div>

        {/* Right Section: Distance stats & Percentage / Completed */}
        <div className="distance-stats-panel">
          <span className="distance-values">
            <strong className="current-val">{formattedCurrent}</strong>
            <span className="divider"> / </span>
            <span className="goal-val">{formattedGoal}</span>
            <span className="unit-label"> {unit}</span>
          </span>
          <span className={`distance-percentage ${percentage >= 100 ? 'is-completed' : ''}`}>
            <span className="dot-sep"> · </span>
            {percentage >= 100 ? 'COMPLETED! 🎉' : `${percentage.toFixed(1)}%`}
          </span>
        </div>
      </div>

      <style jsx>{`
        .distance-tracker-root {
          position: ${isDemo ? 'relative' : 'fixed'};
          bottom: ${isDemo ? 'auto' : '40px'};
          left: ${isDemo ? 'auto' : '50%'};
          margin-left: ${isDemo ? '0' : '0'};
          transform-origin: bottom center;
          z-index: 999;
          font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          transition: opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1), transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
          width: 100%;
          max-width: ${styleVariant === 'compact' ? '480px' : '680px'};
          pointer-events: auto;
          box-sizing: border-box;
        }

        .distance-tracker-root.fade-in {
          opacity: 1;
        }

        .distance-tracker-root.fade-out {
          opacity: 0;
        }

        .distance-tracker-root.is-demo {
          opacity: 1 !important;
          transform: none !important;
          margin: 0 auto;
        }

        /* Styles & Variants */
        .distance-tracker-inner {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 8px 18px;
          background: rgba(10, 14, 20, 0.88);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid ${theme.border};
          border-radius: 9999px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 20px ${theme.glow};
          box-sizing: border-box;
        }

        .variant-no-background .distance-tracker-inner {
          background: transparent;
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          border: none;
          box-shadow: none;
        }

        .variant-borderless .distance-tracker-inner {
          border: none;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        }

        .variant-compact .distance-tracker-inner {
          padding: 6px 14px;
          gap: 10px;
        }

        /* Left Panel */
        .distance-left-panel {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .distance-activity-icon {
          font-size: 18px;
          filter: drop-shadow(0 0 6px ${theme.glow});
          display: inline-block;
          animation: floatBounce 2.4s ease-in-out infinite;
        }

        .distance-title-label {
          font-size: 12px;
          font-weight: 900;
          letter-spacing: 0.12em;
          color: ${theme.accent};
          text-transform: uppercase;
          text-shadow: 0 0 8px ${theme.glow};
          white-space: nowrap;
          font-family: ${fontFamilyStyle};
          transition: opacity 0.4s ease, transform 0.4s ease;
          display: inline-block;
        }

        .distance-title-label.label-fade-in {
          opacity: 1;
          transform: translateY(0);
        }

        .distance-title-label.label-fade-out {
          opacity: 0;
          transform: translateY(-4px);
        }

        /* Track & Fill */
        .distance-progress-track-wrapper {
          flex: 1;
          display: flex;
          align-items: center;
          min-width: 120px;
        }

        .distance-progress-track {
          position: relative;
          width: 100%;
          height: 14px;
          background: rgba(0, 0, 0, 0.75);
          border: 1.5px solid ${theme.trackBorder};
          border-radius: 9999px;
          padding: 1.5px;
          box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.8), 0 0 8px ${theme.glow};
          box-sizing: border-box;
        }

        .distance-progress-fill {
          height: 100%;
          background: ${theme.gradient};
          border-radius: 9999px;
          transition: width 0.5s ease-out;
          position: relative;
          box-shadow: 0 0 12px ${theme.glow};
        }

        .distance-fill-glow {
          position: absolute;
          top: 0;
          right: 0;
          width: 12px;
          height: 100%;
          background: #ffffff;
          opacity: 0.6;
          border-radius: 9999px;
          filter: blur(2px);
        }

        /* Leading Marker Icon */
        .distance-leading-marker {
          position: absolute;
          top: 50%;
          transform: translate(-50%, -50%);
          z-index: 4;
          transition: left 0.5s ease-out;
          pointer-events: none;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .marker-icon {
          font-size: 13px;
          filter: drop-shadow(0 0 5px ${theme.accent});
          animation: markerPulse 1.8s infinite alternate;
        }

        /* Right Stats Panel */
        .distance-stats-panel {
          display: flex;
          align-items: center;
          flex-shrink: 0;
          font-family: 'JetBrains Mono', 'Roboto Mono', 'Courier New', monospace;
          white-space: nowrap;
          font-size: 12.5px;
          color: rgba(255, 255, 255, 0.95);
        }

        .distance-values {
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }

        .current-val {
          color: #ffffff;
          font-weight: 900;
          font-size: 13.5px;
        }

        .divider {
          color: rgba(255, 255, 255, 0.4);
          margin: 0 2px;
        }

        .goal-val {
          color: rgba(255, 255, 255, 0.85);
        }

        .unit-label {
          color: rgba(255, 255, 255, 0.7);
          font-size: 11.5px;
          margin-left: 2px;
        }

        .distance-percentage {
          font-weight: 800;
          color: ${theme.accent};
          text-shadow: 0 0 6px ${theme.glow};
        }

        .dot-sep {
          color: rgba(255, 255, 255, 0.4);
          margin: 0 4px;
        }

        @keyframes floatBounce {
          0% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
          100% { transform: translateY(0); }
        }

        @keyframes markerPulse {
          0% { transform: scale(1); }
          100% { transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
};

export default DistanceTracker;
