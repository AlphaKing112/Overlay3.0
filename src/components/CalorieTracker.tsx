"use client";

import { useEffect, useState, useMemo } from 'react';

interface CalorieTrackerProps {
  calories: number;
  goal: number;
  visible: boolean;
  scale?: number;
  x?: number;
  y?: number;
}

export const CalorieTracker = ({ calories, goal, visible, scale = 1, x = 0, y = 0 }: CalorieTrackerProps) => {
  const [shouldRender, setShouldRender] = useState(visible);

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
    } else {
      const timer = setTimeout(() => setShouldRender(false), 500);
      return () => clearTimeout(timer);
    }
  }, [visible]);

  const progress = useMemo(() => {
    return Math.min(Math.round((calories / goal) * 100), 100);
  }, [calories, goal]);

  if (!shouldRender) return null;

  return (
    <div
      className={`calorie-tracker-container ${visible ? 'fade-in' : 'fade-out'}`}
      style={{
        transform: `translate(${x}px, ${y}px) scale(${scale})`,
        transformOrigin: 'bottom right'
      }}
    >
      <div className="calorie-header">
        <div className="calorie-label">
          <span className="fire-icon">🔥</span>
          <span className="label-text">CALORIES BURNED</span>
        </div>
        <div className="calorie-values">
          <span className="current-calories">{Math.round(calories)}</span>
          <span className="goal-calories">/ {goal} kcal</span>
        </div>
      </div>

      <div className="calorie-progress-container">
        <div
          className="calorie-progress-bar"
          style={{ width: `${progress}%` }}
        >
          <div className="calorie-progress-glow"></div>
        </div>
      </div>

      <style jsx>{`
        .calorie-tracker-container {
          position: fixed;
          bottom: 40px;
          right: 40px;
          width: 350px;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 60, 60, 0.3);
          border-radius: 12px;
          padding: 16px;
          color: white;
          font-family: 'Inter', system-ui, sans-serif;
          z-index: 1000;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 15px rgba(255, 0, 0, 0.1);
          transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease;
        }

        .fade-in {
          opacity: 1;
        }

        .fade-out {
          opacity: 0;
        }

        .calorie-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          margin-bottom: 12px;
        }

        .calorie-label {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .fire-icon {
          font-size: 20px;
          filter: drop-shadow(0 0 5px rgba(255, 80, 0, 0.8));
          animation: flicker 1.5s infinite alternate;
        }

        .label-text {
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.1em;
          color: rgba(255, 255, 255, 0.7);
        }

        .calorie-values {
          text-align: right;
        }

        .current-calories {
          font-size: 28px;
          font-weight: 900;
          color: #ff3c3c;
          text-shadow: 0 0 10px rgba(255, 60, 60, 0.4);
          font-variant-numeric: tabular-nums;
        }

        .goal-calories {
          font-size: 14px;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.5);
          margin-left: 4px;
        }

        .calorie-progress-container {
          height: 10px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 5px;
          overflow: hidden;
          position: relative;
        }

        .calorie-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, #ff8000, #ff3c3c);
          border-radius: 5px;
          transition: width 0.5s cubic-bezier(0.1, 0.7, 1.0, 0.1);
          position: relative;
        }

        .calorie-progress-glow {
          position: absolute;
          top: 0;
          right: 0;
          height: 100%;
          width: 20px;
          background: white;
          filter: blur(5px);
          opacity: 0.4;
        }

        @keyframes flicker {
          0% { transform: scale(1); opacity: 0.8; }
          100% { transform: scale(1.1); opacity: 1; }
        }
      `}</style>
    </div>
  );
};
