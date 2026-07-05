"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { authenticatedFetch } from '@/lib/client-auth';
import { OverlaySettings, DEFAULT_OVERLAY_SETTINGS, LocationDisplayMode, MapZoomLevel, DisplayMode, TodoItem, UrlItem } from '@/types/settings';
import '@/styles/admin.css';

declare global {
  interface Window {
    RealtimeIRL?: {
      forPullKey: (key: string) => {
        addListener: (cb: (p: unknown) => void) => void;
      };
    };
  }
}

export default function AdminPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULT_OVERLAY_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [toast, setToast] = useState<{ type: 'saving' | 'saved' | 'error'; message: string } | null>(null);
  const [syncStatus, setSyncStatus] = useState<'connected' | 'disconnected' | 'syncing'>('disconnected');

  // Custom location input state (for debouncing)
  const [customLocationInput, setCustomLocationInput] = useState('');
  const customLocationTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Todo editing state
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [editingTodoText, setEditingTodoText] = useState('');

  // URL input state
  const [urlLabelInput, setUrlLabelInput] = useState('');
  const [urlAddressInput, setUrlAddressInput] = useState('');
  const [urlTypeInput, setUrlTypeInput] = useState<'text' | 'embed'>('text');

  // Donation Goal input state
  const [newGoalName, setNewGoalName] = useState('');
  const [newGoalTarget, setNewGoalTarget] = useState('');
  const [newGoalCurrent, setNewGoalCurrent] = useState('0');
  const [newGoalDuration, setNewGoalDuration] = useState('0');

  // Countdown timer tick state for Donation Goals countdown
  const [timeTick, setTimeTick] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeTick(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);



  // Check authentication status and refresh session
  useEffect(() => {
    const checkAuth = async () => {
      try {
        // Add timeout to prevent infinite loading
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

        const res = await authenticatedFetch('/api/refresh-session', {
          method: 'POST',
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            setIsAuthenticated(true);
            refreshSession();
          } else {
            router.push('/login');
          }
        } else if (res.status === 401) {
          router.push('/login');
          return;
        } else {
          // Handle other HTTP errors
          console.error('Authentication check failed with status:', res.status);
          router.push('/login');
          return;
        }
      } catch (error) {
        console.error('Authentication check error:', error);
        if (error instanceof Error && error.name === 'AbortError') {
          console.error('Authentication check timed out');
        }
        router.push('/login');
        return;
      }
    };

    checkAuth();
  }, [router]);

  // Session refresh function
  const refreshSession = async () => {
    try {
      await authenticatedFetch('/api/refresh-session', {
        method: 'POST',
      });
    } catch (error) {
      console.warn('Session refresh error:', error);
    }
  };

  // Periodic session refresh to prevent expiry
  useEffect(() => {
    if (!isAuthenticated) return;

    // Refresh session every 6 hours (before 7-day expiry)
    const refreshInterval = setInterval(refreshSession, 6 * 60 * 60 * 1000); // 6 hours

    return () => clearInterval(refreshInterval);
  }, [isAuthenticated]);

  const loadSettings = useCallback(async () => {
    try {
      setSyncStatus('syncing');
      // Add timeout to prevent infinite loading
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const res = await authenticatedFetch('/api/get-settings', {
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        if (res.status === 401) {
          router.push('/login');
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data) {
        setSettings(data);
        setSyncStatus('connected');
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('Settings load timed out');
      }
      setSyncStatus('disconnected');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadSettings();

    // Set up Server-Sent Events listener to receive database settings updates in real time (e.g. donation goals)
    const setupSSE = () => {
      const eventSource = new EventSource('/api/settings-stream');

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'settings_update') {
            const { type: _type, timestamp: _timestamp, ...settingsData } = data;
            
            // Only sync database updates if the Admin UI is connected (not currently saving or offline)
            setSyncStatus((currentStatus) => {
              if (currentStatus === 'connected') {
                setSettings(() => {
                  return {
                    ...DEFAULT_OVERLAY_SETTINGS,
                    ...settingsData
                  } as OverlaySettings;
                });
              }
              return currentStatus;
            });
          }
        } catch {
          // Ignore parsing errors
        }
      };

      eventSource.onerror = () => {
        try {
          eventSource.close();
        } catch {
          // Ignore close error
        }
        // Reconnect after 2 seconds
        setTimeout(() => {
          setupSSE();
        }, 2000);
      };

      return eventSource;
    };

    const eventSource = setupSSE();

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [loadSettings]);

  const handleSettingsChange = useCallback(async (updates: Partial<OverlaySettings>) => {
    const mergedSettings = { ...settings, ...updates };

    // Handle minimap logic conflicts
    if (updates.showMinimap !== undefined) {
      if (updates.showMinimap) {
        mergedSettings.minimapSpeedBased = false;
      }
    }

    if (updates.minimapSpeedBased !== undefined) {
      if (updates.minimapSpeedBased) {
        mergedSettings.showMinimap = false;
      }
    }

    setSettings(mergedSettings);
    setToast({ type: 'saving', message: 'Saving settings...' });
    setSyncStatus('syncing');

    try {
      const res = await authenticatedFetch('/api/save-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mergedSettings),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error('Save settings failed:', res.status, errorText);
        throw new Error(`HTTP ${res.status}: ${errorText}`);
      }

      setToast({ type: 'saved', message: 'Settings saved successfully!' });
      setSyncStatus('connected');
      setTimeout(() => setToast(null), 2000);
    } catch (error) {
      console.error('Save settings error:', error);
      setToast({ type: 'error', message: `Failed to save settings: ${error instanceof Error ? error.message : 'Unknown error'}` });
      setSyncStatus('disconnected');
      setTimeout(() => setToast(null), 5000);
    }
  }, [settings]);

  // Debounced custom location handler
  const handleCustomLocationChange = useCallback((value: string) => {
    setCustomLocationInput(value);

    // Clear existing timeout
    if (customLocationTimeoutRef.current) {
      clearTimeout(customLocationTimeoutRef.current);
    }

    // Set new timeout to save after 1 second of no typing
    customLocationTimeoutRef.current = setTimeout(() => {
      handleSettingsChange({ customLocation: value });
    }, 1000);
  }, [handleSettingsChange]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (customLocationTimeoutRef.current) {
        clearTimeout(customLocationTimeoutRef.current);
      }
    };
  }, []);

  // Sync custom location input with settings when they change
  useEffect(() => {
    setCustomLocationInput(settings.customLocation || '');
  }, [settings.customLocation]);


  const openPreview = () => {
    window.open('/overlay', '_blank');
  };




  // Simple Radio Group Component
  const RadioGroup = ({
    options,
    value,
    onChange
  }: {
    options: { value: string; label: string; icon: string; description?: string }[];
    value: string;
    onChange: (value: string) => void;
  }) => (
    <div className="radio-group segmented" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          className={`radio-option ${value === option.value ? 'active' : ''}`}
          onClick={() => onChange(option.value)}
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.label}
          type="button"
          tabIndex={0}
        >
          <span className="radio-icon" aria-hidden="true">{option.icon}</span>
          <div className="radio-content">
            <span className="radio-label">{option.label}</span>
            {option.description && (
              <span className="radio-description">{option.description}</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );

  // Show loading screen while checking authentication or loading settings
  if (!isAuthenticated || isLoading) return (
    <div className="admin-page">
      <div className="loading-screen">
        <div className="loading-content">
          <div className="loading-icon">🎮</div>
          <div className="loading-text">
            {!isAuthenticated ? 'Checking authentication...' : 'Loading settings...'}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="admin-page">
      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="header-title">
            <span className="title-icon">🎮</span>
            <h1>Overlay Admin</h1>
            <div className={`sync-status ${syncStatus}`}>
              {syncStatus === 'connected' && '🟢'}
              {syncStatus === 'syncing' && '🟡'}
              {syncStatus === 'disconnected' && '🔴'}
            </div>
          </div>
          <div className="header-actions">
            <button className="btn btn-primary" onClick={openPreview}>
              👁️ Preview
            </button>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                try {
                  await fetch('/api/logout', { method: 'GET', credentials: 'include' });
                  router.push('/login');
                } catch (error) {
                  console.error('Logout error:', error);
                  router.push('/login');
                }
              }}
            >
              🚪 Logout
            </button>
          </div>
        </div>
      </header>

      {/* Toast Notification */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          <div className="toast-content">
            <span className="toast-icon">
              {toast.type === 'saving' && '⏳'}
              {toast.type === 'saved' && '✅'}
              {toast.type === 'error' && '❌'}
            </span>
            <span className="toast-message">{toast.message}</span>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="main-content">
        <div className="settings-container">

          {/* Global Styling & Fonts Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>🎨 Global Styling & Fonts</h2>
            </div>
            
            <div className="setting-group">
              <label className="group-label">Global Font</label>
              <RadioGroup
                value={settings.globalFont || 'default'}
                onChange={(value) => handleSettingsChange({ globalFont: value as string })}
                options={[
                  { value: 'default', label: 'Montserrat (Default)', icon: 'Aa' },
                  { value: 'inter', label: 'Inter (Clean)', icon: 'Aa' },
                  { value: 'teko', label: 'Teko (Condensed)', icon: 'Aa' },
                  { value: 'bangers', label: 'Bangers (Comic)', icon: 'Aa' },
                  { value: 'courier', label: 'Courier New (Retro)', icon: 'Aa' },
                  { value: 'comic', label: 'Comic Sans', icon: 'Aa' },
                ]}
              />
            </div>

            <div className="setting-group" style={{ marginTop: '20px' }}>
              <label className="group-label">Global Theme Style (Affects main overlay boxes)</label>
              <div className="select-container">
                <select
                  className="theme-select"
                  value={settings.globalTheme || 'default'}
                  onChange={(e) => handleSettingsChange({ globalTheme: e.target.value })}
                >
                  <option value="default">Modern Clean (Default)</option>
                  <option value="neon">Neon Cyberpunk</option>
                  <option value="retro">Retro Arcade</option>
                  <option value="bold">Bold Striped</option>
                  <option value="impact">Comic Impact</option>
                </select>
                <div className="select-arrow">▼</div>
              </div>
            </div>
          </section>

          {/* Location & Weather Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>📍 Location & Weather</h2>
            </div>

            <div className="setting-group">
              <label className="group-label">Location Mode</label>
              <RadioGroup
                value={settings.locationDisplay}
                onChange={(value) => handleSettingsChange({ locationDisplay: value as LocationDisplayMode })}
                options={[
                  {
                    value: 'neighbourhood',
                    label: 'Neighbourhood',
                    icon: '🏘️'
                  },
                  {
                    value: 'city',
                    label: 'City',
                    icon: '🏙️'
                  },
                  {
                    value: 'state',
                    label: 'State',
                    icon: '🗺️'
                  },
                  {
                    value: 'country',
                    label: 'Country',
                    icon: '🌍'
                  },
                  {
                    value: 'custom',
                    label: 'Custom',
                    icon: '✏️'
                  },
                  {
                    value: 'hidden',
                    label: 'Hidden',
                    icon: '🚫'
                  }
                ]}
              />

              {/* Custom location input */}
              {settings.locationDisplay === 'custom' && (
                <div className="custom-location-input" style={{ marginTop: '12px' }}>
                  <label className="input-label">Custom Location Text</label>
                  <input
                    type="text"
                    value={customLocationInput}
                    onChange={(e) => handleCustomLocationChange(e.target.value)}
                    placeholder="Enter custom location (e.g., 'Tokyo, Japan' or 'Las Vegas Strip')"
                    className="text-input"
                    maxLength={50}
                  />

                  {/* Country name toggle for custom location */}
                  <div className="checkbox-group" style={{ marginTop: '12px' }}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.showCountryName}
                        onChange={(e) => handleSettingsChange({ showCountryName: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">🏴 Show Country Name & Flag</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            <div className="setting-group" style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
              <label className="group-label">Weather Display</label>
              <div className="checkbox-group" style={{ marginBottom: '12px' }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showWeather ?? false}
                    onChange={(e) => handleSettingsChange({ showWeather: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">⛅ Show Temp/Weather</span>
                </label>
              </div>

              {settings.showWeather && (
                <>
                  <label className="group-label">Condition Icon & Text</label>
                  <RadioGroup
                    value={settings.weatherConditionDisplay || 'auto'}
                    onChange={(value) => handleSettingsChange({ weatherConditionDisplay: value as DisplayMode })}
                    options={[
                      { value: 'always', label: 'Always Show', icon: '👁️' },
                      { value: 'auto', label: 'Auto', icon: '🌧️', description: 'Shows icon/text for rain, storms, snow, etc.' },
                      { value: 'hidden', label: 'Hidden', icon: '🚫' }
                    ]}
                  />
                  <div className="checkbox-group" style={{ marginTop: '10px' }}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={(settings.temperatureUnit ?? 'both') === 'F'}
                        onChange={(e) => handleSettingsChange({ temperatureUnit: e.target.checked ? 'F' : 'both' })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">🌡️ Show °F Only (hide °C)</span>
                    </label>
                  </div>
                </>
              )}
              <div className="checkbox-group" style={{ marginTop: '10px' }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showDate ?? true}
                    onChange={(e) => handleSettingsChange({ showDate: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">📅 Show Date on Overlay</span>
                </label>
              </div>
            </div>

            <div className="setting-group" style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <label className="group-label" style={{ marginBottom: 0 }}>Time, Weather & Location Overlay Scale</label>
                <span style={{ fontSize: '0.9em', fontWeight: 'bold', color: 'var(--accent-color)' }}>
                  {Math.round((settings.timeWeatherLocationScale || 1.0) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0.3"
                max="3.0"
                step="0.1"
                value={settings.timeWeatherLocationScale || 1.0}
                onChange={(e) => handleSettingsChange({ timeWeatherLocationScale: parseFloat(e.target.value) })}
                className="range-input"
                style={{ width: '100%' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8em', opacity: 0.6, marginTop: '4px' }}>
                <span>30% (Tiny)</span>
                <span>100% (Normal)</span>
                <span>300% (Huge)</span>
              </div>
            </div>

            <div className="setting-group" style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
              <label className="group-label">Layout Options</label>
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.swapLocationTimePositions ?? false}
                    onChange={(e) => handleSettingsChange({ swapLocationTimePositions: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">🔄 Swap Time (Left) & Location (Right)</span>
                </label>
              </div>

              {/* Background Toggle */}
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showBackground ?? true}
                    onChange={(e) => handleSettingsChange({ showBackground: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Show Background Box</span>
                </label>
              </div>

              <p className="setting-description" style={{ marginTop: '8px', fontSize: '0.9em', opacity: 0.8 }}>
                When enabled, Location/Weather will appear on the Left, and Time/Date will appear on the Right.
              </p>
            </div>
          </section>

          {/* Map Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>🗺️ Map</h2>
            </div>

            <div className="setting-group">
              <label className="group-label">Display Mode</label>
              <RadioGroup
                value={settings.showMinimap ? 'always' : settings.minimapSpeedBased ? 'speed' : 'hidden'}
                onChange={(value) => {
                  if (value === 'always') {
                    handleSettingsChange({ showMinimap: true, minimapSpeedBased: false });
                  } else if (value === 'speed') {
                    handleSettingsChange({ showMinimap: false, minimapSpeedBased: true });
                  } else {
                    handleSettingsChange({ showMinimap: false, minimapSpeedBased: false });
                  }
                }}
                options={[
                  { value: 'always', label: 'Always Show', icon: '👁️' },
                  { value: 'speed', label: 'Auto on Movement', icon: '🏃' },
                  { value: 'hidden', label: 'Hidden', icon: '🚫' }
                ]}
              />

            </div>

            {(settings.showMinimap || settings.minimapSpeedBased) && (
              <>
                <div className="setting-group">
                  <label className="group-label">Map Style</label>
                  <RadioGroup
                    value={settings.mapStyle || 'auto'}
                    onChange={(value) => handleSettingsChange({ mapStyle: value as any })}
                    options={[
                      { value: 'auto', label: 'Auto (Day/Night)', icon: '🌓' },
                      { value: 'standard', label: 'Standard', icon: '☀️' },
                      { value: 'dark', label: 'Dark Mode', icon: '🌙' },
                      { value: 'gta', label: 'GTA / Schematic', icon: '🚁' }
                    ]}
                  />
                </div>

                <div className="setting-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <label className="group-label" style={{ marginBottom: 0 }}>Map Size</label>
                    <span style={{ fontSize: '0.9em', fontWeight: 'bold', color: 'var(--accent-color)' }}>
                      {settings.minimapScale || 100}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="200"
                    step="10"
                    value={settings.minimapScale || 100}
                    onChange={(e) => handleSettingsChange({ minimapScale: parseInt(e.target.value) })}
                    className="range-input"
                    style={{ width: '100%' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8em', opacity: 0.6, marginTop: '4px' }}>
                    <span>Small</span>
                    <span>Normal</span>
                    <span>Large</span>
                  </div>
                </div>

                <div className="setting-group">
                  <label className="group-label">Map Position ({settings.minimapX || 0}, {settings.minimapY || 0})</label>

                  {/* Side Toggle Buttons */}
                  <div style={{ marginBottom: '12px' }}>
                    <RadioGroup
                      value={settings.minimapPosition || 'left'}
                      onChange={(value) => handleSettingsChange({ minimapPosition: value as 'left' | 'right' })}
                      options={[
                        { value: 'left', label: 'Stick Left Edge', icon: '⬅️' },
                        { value: 'right', label: 'Stick Right Edge', icon: '➡️' }
                      ]}
                    />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>

                    {/* Up Button */}
                    <button
                      className="btn btn-secondary btn-small"
                      style={{ padding: '2px 12px', fontSize: '1.2em', lineHeight: 1 }}
                      onClick={() => handleSettingsChange({ minimapY: (settings.minimapY || 0) + 10 })}
                    >
                      ▲
                    </button>

                    <div style={{ display: 'flex', gap: '8px' }}>
                      {/* Left Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 12px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ minimapX: (settings.minimapX || 0) - 10 })}
                      >
                        ◀
                      </button>

                      {/* Reset Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 8px', fontSize: '0.8em', fontWeight: 'bold' }}
                        onClick={() => handleSettingsChange({ minimapX: 0, minimapY: 0 })}
                      >
                        Reset
                      </button>

                      {/* Right Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 12px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ minimapX: (settings.minimapX || 0) + 10 })}
                      >
                        ▶
                      </button>
                    </div>

                    {/* Down Button */}
                    <button
                      className="btn btn-secondary btn-small"
                      style={{ padding: '2px 12px', fontSize: '1.2em', lineHeight: 1 }}
                      onClick={() => handleSettingsChange({ minimapY: (settings.minimapY || 0) - 10 })}
                    >
                      ▼
                    </button>
                  </div>
                </div>
              </>
            )}

            <div className="setting-group">
              <label className="group-label">Zoom Level</label>
              <RadioGroup
                value={settings.mapZoomLevel}
                onChange={(value) => handleSettingsChange({ mapZoomLevel: value as MapZoomLevel })}
                options={[
                  { value: 'neighbourhood', label: 'Neighbourhood', icon: '🏘️' },
                  { value: 'city', label: 'City', icon: '🏙️' },
                  { value: 'state', label: 'State', icon: '🗺️' },
                  { value: 'country', label: 'Country', icon: '🌍' },
                  { value: 'ocean', label: 'Ocean', icon: '🌊' },
                  { value: 'continental', label: 'Continental', icon: '🌎' }
                ]}
              />
            </div>
          </section>



          {/* Altitude & Speed Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>📊 Altitude & Speed</h2>
            </div>

            <div className="setting-group">
              <label className="group-label">Altitude Display</label>
              <RadioGroup
                value={settings.altitudeDisplay || 'auto'}
                onChange={(value) => handleSettingsChange({ altitudeDisplay: value as DisplayMode })}
                options={[
                  { value: 'always', label: 'Always Show', icon: '👁️' },
                  { value: 'auto', label: 'Auto', icon: '📈', description: 'Shows when elevation >500m (mountains/hills)' },
                  { value: 'hidden', label: 'Hidden', icon: '🚫' }
                ]}
              />
            </div>

            <div className="setting-group">
              <label className="group-label">Speed Display</label>
              <RadioGroup
                value={settings.speedDisplay || 'auto'}
                onChange={(value) => handleSettingsChange({ speedDisplay: value as DisplayMode })}
                options={[
                  { value: 'always', label: 'Always Show', icon: '👁️' },
                  { value: 'auto', label: 'Auto', icon: '🏃', description: 'Shows when ≥10 km/h. Hides when GPS stale (>10s)' },
                  { value: 'hidden', label: 'Hidden', icon: '🚫' }
                ]}
              />
            </div>
          </section>


          {/* Calorie Tracker Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>🔥 Calorie Tracker</h2>
            </div>

            <div className="setting-group">
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showCalorieTracker ?? false}
                    onChange={(e) => handleSettingsChange({ showCalorieTracker: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Show Calorie Burner Overlay</span>
                </label>
                <p className="setting-description" style={{ marginLeft: '28px', fontSize: '0.85em', opacity: 0.7 }}>
                  Displays a red progress bar based on calories burned from walking distance.
                </p>
              </div>
            </div>

            {settings.showCalorieTracker && (
              <>
                <div className="setting-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <label className="group-label" style={{ marginBottom: 0 }}>Daily Calorie Goal</label>
                    <span style={{ fontSize: '0.9em', fontWeight: 'bold', color: 'var(--accent-color)' }}>
                      {settings.calorieGoal || 500} kcal
                    </span>
                  </div>
                  <input
                    type="range"
                    min="100"
                    max="2000"
                    step="50"
                    value={settings.calorieGoal || 500}
                    onChange={(e) => handleSettingsChange({ calorieGoal: parseInt(e.target.value) })}
                    className="range-input"
                    style={{ width: '100%' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8em', opacity: 0.6, marginTop: '4px' }}>
                    <span>100 kcal</span>
                    <span>500 kcal</span>
                    <span>2000 kcal</span>
                  </div>
                </div>

                {/* Scale and Position Controls */}
                <div className="setting-group">
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                    {/* Scale Control */}
                    <div style={{ flex: 1, minWidth: '150px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Scale</label>
                        <span style={{ fontSize: '0.85em' }}>{Math.round((settings.calorieTrackerScale || 1) * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.5"
                        max="2.0"
                        step="0.1"
                        value={settings.calorieTrackerScale || 1}
                        onChange={(e) => handleSettingsChange({ calorieTrackerScale: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </div>

                    {/* Position Controls (D-Pad) */}
                    <div style={{ flex: 1, minWidth: '180px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                      <label style={{ fontSize: '0.85em', opacity: 0.8, marginBottom: '2px' }}>Position ({settings.calorieTrackerX || 0}, {settings.calorieTrackerY || 0})</label>

                      {/* Up Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ calorieTrackerY: (settings.calorieTrackerY || 0) + 10 })}
                      >
                        ▲
                      </button>

                      {/* Left, Reset, Right */}
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ calorieTrackerX: (settings.calorieTrackerX || 0) - 10 })}
                        >
                          ◀
                        </button>
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 8px', fontSize: '0.7em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ calorieTrackerX: 0, calorieTrackerY: 0, calorieTrackerScale: 1 })}
                        >
                          Reset
                        </button>
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ calorieTrackerX: (settings.calorieTrackerX || 0) + 10 })}
                        >
                          ▶
                        </button>
                      </div>

                      {/* Down Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ calorieTrackerY: (settings.calorieTrackerY || 0) - 10 })}
                      >
                        ▼
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>

          {/* Donation Goals & StreamElements Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>💰 Donation Goals & StreamElements</h2>
              <div className="checkbox-group" style={{ marginTop: '8px' }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showDonationGoals ?? false}
                    onChange={(e) => handleSettingsChange({ showDonationGoals: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Show Donation Goals on Overlay</span>
                </label>
              </div>
            </div>

            {settings.showDonationGoals && (
              <>
                <div className="setting-group" style={{ marginBottom: '16px' }}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={settings.donoShowBackground ?? true}
                      onChange={(e) => handleSettingsChange({ donoShowBackground: e.target.checked })}
                    />
                    <span className="checkbox-text">Show Background Box</span>
                  </label>
                  <p className="setting-description" style={{ marginLeft: '28px', fontSize: '0.85em', opacity: 0.7, marginBottom: '12px' }}>
                    Display a dark background box behind your donation goals.
                  </p>
                  
                  <label className="input-label" style={{ fontSize: '0.85em', marginLeft: '28px', display: 'block', marginTop: '12px' }}>Custom Goal Prefix Text</label>
                  <div style={{ marginLeft: '28px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input
                      type="text"
                      className="text-input"
                      value={settings.donoGoalText ?? 'DONO GOAL:'}
                      onChange={(e) => handleSettingsChange({ donoGoalText: e.target.value })}
                      placeholder="e.g. DONO GOAL: or leave empty to hide"
                      style={{ flex: 1, padding: '8px', fontSize: '0.9em' }}
                    />
                  </div>
                  <p className="setting-description" style={{ marginLeft: '28px', fontSize: '0.8em', opacity: 0.6, marginTop: '4px' }}>
                    This text appears before the goal name. Clear it to remove the prefix entirely.
                  </p>
                </div>

                {/* Scale & Position Controls */}
                <div className="setting-group" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '16px', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '1.05em', marginBottom: '12px', opacity: 0.9 }}>Layout & Scale</h3>
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                    {/* Scale Control */}
                    <div style={{ flex: 1, minWidth: '150px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Overlay Scale</label>
                        <span style={{ fontSize: '0.85em' }}>{Math.round((settings.donationGoalsScale || 1) * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.3"
                        max="3.0"
                        step="0.1"
                        value={settings.donationGoalsScale || 1}
                        onChange={(e) => handleSettingsChange({ donationGoalsScale: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </div>

                    {/* Position Controls (D-Pad) */}
                    <div style={{ flex: 1, minWidth: '180px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                      <label style={{ fontSize: '0.85em', opacity: 0.8, marginBottom: '2px' }}>Position ({settings.donationGoalsX || 0}, {settings.donationGoalsY || 0})</label>
                      
                      {/* Up Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ donationGoalsY: (settings.donationGoalsY || 0) + 10 })}
                      >
                        ▲
                      </button>

                      {/* Left, Reset, Right */}
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ donationGoalsX: (settings.donationGoalsX || 0) - 10 })}
                        >
                          ◀
                        </button>
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 8px', fontSize: '0.7em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ donationGoalsX: 0, donationGoalsY: 0 })}
                        >
                          Reset
                        </button>
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ donationGoalsX: (settings.donationGoalsX || 0) + 10 })}
                        >
                          ▶
                        </button>
                      </div>

                      {/* Down Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ donationGoalsY: (settings.donationGoalsY || 0) - 10 })}
                      >
                        ▼
                      </button>
                    </div>
                  </div>
                </div>

                {/* StreamElements Integration */}
                <div className="setting-group" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '16px', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '1.05em', marginBottom: '12px', opacity: 0.9 }}>StreamElements Integration</h3>
                  <div className="checkbox-group" style={{ marginBottom: '12px' }}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.streamElementsEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ streamElementsEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">Enable StreamElements Webhook / Tips</span>
                    </label>
                  </div>

                  {settings.streamElementsEnabled && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label className="input-label" style={{ fontSize: '0.85em' }}>StreamElements JWT Token</label>
                        <input
                          type="password"
                          placeholder="Paste StreamElements JWT token..."
                          className="text-input"
                          value={settings.streamElementsToken || ''}
                          onChange={(e) => handleSettingsChange({ streamElementsToken: e.target.value })}
                          style={{ width: '100%', fontFamily: 'monospace' }}
                        />
                        <span style={{ fontSize: '0.75em', opacity: 0.6 }}>
                          Found in your StreamElements Dashboard under Channel Settings &gt; API Client Token.
                        </span>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <label className="input-label" style={{ fontSize: '0.85em', marginBottom: 0 }}>Twitch Revenue Split (Streamer Cut)</label>
                          <span style={{ fontSize: '0.9em', fontWeight: 'bold', color: 'var(--accent-color)' }}>
                            {settings.twitchRevenueSplit ?? 50}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={settings.twitchRevenueSplit ?? 50}
                          onChange={(e) => handleSettingsChange({ twitchRevenueSplit: parseInt(e.target.value) })}
                          style={{ width: '100%' }}
                        />
                        <span style={{ fontSize: '0.75em', opacity: 0.6 }}>
                          Percentage of Twitch subscription revenue that goes to the streamer (typically 50% for standard affiliates, higher for partner status or special contracts). Bits are always calculated at 100% split ($0.01 per bit).
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Goals List & Creator */}
                <div className="setting-group">
                  <h3 style={{ fontSize: '1.05em', marginBottom: '12px', opacity: 0.9 }}>Goals List</h3>
                  
                  {/* Create Goal Input Form */}
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 2, minWidth: '150px' }}>
                      <label className="input-label" style={{ fontSize: '0.8em' }}>Goal Name</label>
                      <input
                        type="text"
                        placeholder="e.g. Sub Goal, New Mic"
                        className="text-input"
                        value={newGoalName}
                        onChange={(e) => setNewGoalName(e.target.value)}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '80px' }}>
                      <label className="input-label" style={{ fontSize: '0.8em' }}>Target ($)</label>
                      <input
                        type="number"
                        placeholder="100"
                        className="text-input"
                        value={newGoalTarget}
                        onChange={(e) => setNewGoalTarget(e.target.value)}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '80px' }}>
                      <label className="input-label" style={{ fontSize: '0.8em' }}>Starting ($)</label>
                      <input
                        type="number"
                        placeholder="0"
                        className="text-input"
                        value={newGoalCurrent}
                        onChange={(e) => setNewGoalCurrent(e.target.value)}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '100px' }}>
                      <label className="input-label" style={{ fontSize: '0.8em' }}>Disappear (mins)</label>
                      <input
                        type="number"
                        placeholder="0 = Always Show"
                        className="text-input"
                        value={newGoalDuration}
                        onChange={(e) => setNewGoalDuration(e.target.value)}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <button
                      className="btn btn-primary btn-small"
                      style={{ marginTop: '23px' }}
                      onClick={() => {
                        const targetVal = parseFloat(newGoalTarget);
                        const currentVal = parseFloat(newGoalCurrent);
                        const durationVal = parseInt(newGoalDuration);
                        if (newGoalName.trim() && !isNaN(targetVal) && targetVal > 0) {
                          const newGoal = {
                            id: Date.now().toString(),
                            name: newGoalName.trim(),
                            goal: targetVal,
                            current: isNaN(currentVal) ? 0 : currentVal,
                            duration: isNaN(durationVal) || durationVal < 0 ? 0 : durationVal,
                            lastTriggered: Date.now()
                          };
                          const updatedGoals = [...(settings.donationGoals || []), newGoal];
                          handleSettingsChange({ donationGoals: updatedGoals });
                          setNewGoalName('');
                          setNewGoalTarget('');
                          setNewGoalCurrent('0');
                          setNewGoalDuration('0');
                        }
                      }}
                      disabled={!newGoalName.trim() || !newGoalTarget.trim() || parseFloat(newGoalTarget) <= 0}
                    >
                      Add Goal
                    </button>
                  </div>

                  {/* Goal Listing */}
                  {settings.donationGoals && settings.donationGoals.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {settings.donationGoals.map((g) => (
                        <div
                          key={g.id}
                          className="todo-item-admin"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '10px 12px',
                            background: 'rgba(255,255,255,0.02)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '6px'
                          }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <span style={{ fontWeight: 'bold' }}>{g.name}</span>
                            <span style={{ fontSize: '0.85em', opacity: 0.7 }}>
                              Progress: ${g.current.toLocaleString(undefined, { minimumFractionDigits: g.current % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 })} / ${g.goal.toLocaleString(undefined, { minimumFractionDigits: g.goal % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 })}
                            </span>
                            <span style={{ fontSize: '0.75em', opacity: 0.6 }}>
                              Auto-hide: {g.duration && g.duration > 0 ? (() => {
                                const lastTriggered = g.lastTriggered || 0;
                                const durationMs = g.duration * 60 * 1000;
                                const elapsed = timeTick - lastTriggered;
                                const remaining = Math.max(0, durationMs - elapsed);
                                if (remaining > 0) {
                                  const totalSecs = Math.ceil(remaining / 1000);
                                  const mins = Math.floor(totalSecs / 60);
                                  const secs = totalSecs % 60;
                                  return `${g.duration} min${g.duration > 1 ? 's' : ''} (⏱️ ${mins}:${secs.toString().padStart(2, '0')} left)`;
                                }
                                return `${g.duration} min${g.duration > 1 ? 's' : ''} (Hidden)`;
                              })() : 'Always Show'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <button
                              className="btn btn-secondary btn-small"
                              style={{ padding: '4px 8px', fontSize: '0.8em' }}
                              onClick={() => {
                                const newAmountStr = prompt(`Update current progress for "${g.name}":`, g.current.toString());
                                if (newAmountStr !== null) {
                                  const newAmount = parseFloat(newAmountStr);
                                  if (!isNaN(newAmount) && newAmount >= 0) {
                                    const newDurationStr = prompt(`Update auto-hide timer in minutes for "${g.name}" (0 = Always Show):`, (g.duration || 0).toString());
                                    const newDuration = newDurationStr !== null ? parseInt(newDurationStr) : (g.duration || 0);
                                    
                                    const updatedGoals = settings.donationGoals!.map(item =>
                                      item.id === g.id ? { 
                                        ...item, 
                                        current: newAmount,
                                        duration: isNaN(newDuration) || newDuration < 0 ? 0 : newDuration,
                                        lastTriggered: Date.now()
                                      } : item
                                    );
                                    handleSettingsChange({ donationGoals: updatedGoals });
                                  }
                                }
                              }}
                            >
                              ✏️ Edit Goal
                            </button>
                            <button
                              className="todo-delete-btn"
                              onClick={() => {
                                if (confirm(`Are you sure you want to delete the goal "${g.name}"?`)) {
                                  const updatedGoals = settings.donationGoals!.filter(item => item.id !== g.id);
                                  handleSettingsChange({ donationGoals: updatedGoals });
                                }
                              }}
                              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.1em' }}
                              aria-label="Delete Goal"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', opacity: 0.5, fontSize: '0.9em', padding: '16px' }}>
                      No active donation goals. Create one above!
                    </div>
                  )}
                </div>
              </>
            )}
          </section>

          {/* Sub Goals Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>🔔 Twitch Sub Goals</h2>
              <div className="checkbox-group" style={{ marginTop: '8px' }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showSubGoals ?? false}
                    onChange={(e) => handleSettingsChange({ showSubGoals: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Show Sub Goals on Overlay</span>
                </label>
              </div>
            </div>

            {settings.showSubGoals && (
              <div className="settings-grid">
                <div className="setting-group">
                  <label>Total Sub Goal:</label>
                  <input
                    type="number"
                    className="text-input"
                    value={settings.totalSubGoal ?? 100}
                    onChange={(e) => handleSettingsChange({ totalSubGoal: Math.max(1, parseInt(e.target.value) || 100) })}
                  />
                </div>
                <div className="setting-group">
                  <label>Current Total Subs:</label>
                  <input
                    type="number"
                    className="text-input"
                    value={settings.totalSubCurrent ?? 0}
                    onChange={(e) => handleSettingsChange({ totalSubCurrent: Math.max(0, parseInt(e.target.value) || 0) })}
                  />
                </div>
                <div className="setting-group">
                  <label>Daily Sub Goal:</label>
                  <input
                    type="number"
                    className="text-input"
                    value={settings.dailySubGoal ?? 10}
                    onChange={(e) => handleSettingsChange({ dailySubGoal: Math.max(1, parseInt(e.target.value) || 10) })}
                  />
                </div>
                <div className="setting-group">
                  <label>Current Daily Subs:</label>
                  <input
                    type="number"
                    className="text-input"
                    value={settings.dailySubCurrent ?? 0}
                    onChange={(e) => handleSettingsChange({ dailySubCurrent: Math.max(0, parseInt(e.target.value) || 0) })}
                  />
                </div>
                <div className="setting-group">
                  <label>X Position:</label>
                  <input
                    type="number"
                    className="text-input"
                    value={settings.subGoalsX ?? 0}
                    onChange={(e) => handleSettingsChange({ subGoalsX: parseInt(e.target.value) || 0 })}
                  />
                </div>
                <div className="setting-group">
                  <label>Y Position:</label>
                  <input
                    type="number"
                    className="text-input"
                    value={settings.subGoalsY ?? 0}
                    onChange={(e) => handleSettingsChange({ subGoalsY: parseInt(e.target.value) || 0 })}
                  />
                </div>
              </div>
            )}
          </section>

          {/* Bitrate Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>📡 Bitrate & Network</h2>
            </div>

            <div className="setting-group">
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showBitrateWarnings ?? true}
                    onChange={(e) => handleSettingsChange({ showBitrateWarnings: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Enable Low Bitrate Warnings</span>
                </label>
                <p className="setting-description" style={{ marginLeft: '28px', fontSize: '0.85em', opacity: 0.7 }}>
                  Globally enable/disable all bitrate alerts (colors and image pop-ups).
                </p>
              </div>
            </div>

            <div className="setting-group">
              <label className="group-label">Bitrate Display</label>
              <RadioGroup
                value={settings.bitrateDisplay || 'auto'}
                onChange={(value) => handleSettingsChange({ bitrateDisplay: value as DisplayMode })}
                options={[
                  { value: 'always', label: 'Always Show', icon: '👁️' },
                  { value: 'auto', label: 'Auto', icon: '📡', description: 'Shows when bitrate > 0' },
                  { value: 'hidden', label: 'Hidden', icon: '🚫' }
                ]}
              />
            </div>

            <div className="setting-group">
              <label className="group-label">Bitrate Position</label>
              <RadioGroup
                value={settings.bitrateAnchor || 'location'}
                onChange={(value) => handleSettingsChange({ bitrateAnchor: value as 'time' | 'location' })}
                options={[
                  { value: 'location', label: 'With Location', icon: '📍', description: 'Attaches to the location/weather overlay' },
                  { value: 'time', label: 'With Time', icon: '🕒', description: 'Attaches to the time/date overlay' }
                ]}
              />
            </div>

            <div className="setting-group">
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showLowBitrateAlert ?? true}
                    onChange={(e) => handleSettingsChange({ showLowBitrateAlert: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Enable Low Bitrate Text Alert</span>
                </label>
                <p className="setting-description" style={{ marginLeft: '28px', fontSize: '0.85em', opacity: 0.7 }}>
                  Shows a flashing text alert when bitrate drops below {settings.lowBitrateThreshold ?? 1300} Kbps.
                </p>
              </div>

              {/* Font Choice Select */}
              {settings.showLowBitrateAlert && (
                <div style={{ marginTop: '12px', marginBottom: '12px' }}>
                  <label className="group-label">Low Bitrate Text Style / Font</label>
                  <RadioGroup
                    value={settings.lowBitrateAlertFont || 'default'}
                    onChange={(value) => handleSettingsChange({ lowBitrateAlertFont: value as any })}
                    options={[
                      { value: 'default', label: 'Default', icon: '📝', description: 'Bold sans-serif red/yellow warning pill' },
                      { value: 'neon', label: 'Neon Cyberpunk', icon: '💻', description: 'Glowy cyan cyberpunk theme' },
                      { value: 'retro', label: 'Retro Arcade', icon: '🕹️', description: '1980s monospaced double-bordered pixel style' },
                      { value: 'bold', label: 'Bold Striped', icon: '🚧', description: 'Heavy warning stripes style' },
                      { value: 'impact', label: 'Comic Impact', icon: '💥', description: 'Playful comic impact style' }
                    ]}
                  />
                </div>
              )}

              {/* Threshold Controls */}
              <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', marginTop: '12px' }}>
                {/* Low Threshold */}
                <div style={{ flex: 1, minWidth: '150px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Low Threshold</label>
                    <span style={{ fontSize: '0.85em' }}>{settings.lowBitrateThreshold ?? 1300} Kbps</span>
                  </div>
                  <input
                    type="range"
                    min="100"
                    max="10000"
                    step="100"
                    value={settings.lowBitrateThreshold ?? 1300}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      handleSettingsChange({ lowBitrateThreshold: val });
                    }}
                    style={{ width: '100%' }}
                  />
                </div>

                {/* Critical Threshold */}
                <div style={{ flex: 1, minWidth: '150px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Critical Threshold</label>
                    <span style={{ fontSize: '0.85em' }}>{settings.criticalBitrateThreshold ?? 900} Kbps</span>
                  </div>
                  <input
                    type="range"
                    min="100"
                    max="10000"
                    step="100"
                    value={settings.criticalBitrateThreshold ?? 900}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      handleSettingsChange({ criticalBitrateThreshold: val });
                    }}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>

              {/* Scale and Position Controls (only show when alert is enabled) */}
              {settings.showLowBitrateAlert && (
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', marginTop: '12px' }}>
                  {/* Scale Control */}
                  <div style={{ flex: 1, minWidth: '150px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Scale</label>
                      <span style={{ fontSize: '0.85em' }}>{Math.round((settings.lowBitrateAlertScale || 1) * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="2.0"
                      step="0.1"
                      value={settings.lowBitrateAlertScale || 1}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        handleSettingsChange({ lowBitrateAlertScale: val });
                      }}
                      style={{ width: '100%' }}
                    />
                  </div>

                  {/* Position Controls (D-Pad) */}
                  <div style={{ flex: 1, minWidth: '180px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                    <label style={{ fontSize: '0.85em', opacity: 0.8, marginBottom: '2px' }}>Position ({settings.lowBitrateAlertX || 0}, {settings.lowBitrateAlertY || 0})</label>

                    {/* Up Button */}
                    <button
                      className="btn btn-secondary btn-small"
                      style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                      onClick={() => {
                        handleSettingsChange({ lowBitrateAlertY: (settings.lowBitrateAlertY || 0) + 10 });
                      }}
                    >
                      ▲
                    </button>

                    {/* Left, Reset, Right */}
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => {
                          handleSettingsChange({ lowBitrateAlertX: (settings.lowBitrateAlertX || 0) - 10 });
                        }}
                      >
                        ◀
                      </button>
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 8px', fontSize: '0.7em', lineHeight: 1 }}
                        onClick={() => {
                          handleSettingsChange({ lowBitrateAlertX: 0, lowBitrateAlertY: 0, lowBitrateAlertScale: 1 });
                        }}
                      >
                        Reset
                      </button>
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => {
                          handleSettingsChange({ lowBitrateAlertX: (settings.lowBitrateAlertX || 0) + 10 });
                        }}
                      >
                        ▶
                      </button>
                    </div>

                    {/* Down Button */}
                    <button
                      className="btn btn-secondary btn-small"
                      style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                      onClick={() => {
                        handleSettingsChange({ lowBitrateAlertY: (settings.lowBitrateAlertY || 0) - 10 });
                      }}
                    >
                      ▼
                    </button>
                  </div>
                </div>
              )}

              <p className="setting-description" style={{ marginTop: '12px', fontSize: '0.9em', opacity: 0.8 }}>
                Requires <code>NEXT_PUBLIC_NOALBS_STATS_URL</code> to be set in <code>.env.local</code>.
              </p>
            </div>
          </section>

          {/* To-Do List Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>✅ To-Do List</h2>
              <div className="checkbox-group" style={{ marginTop: '8px' }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showTodoList ?? false}
                    onChange={(e) => handleSettingsChange({ showTodoList: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Show on overlay</span>
                </label>
              </div>
            </div>

            <div className="setting-group">
              <label className="group-label">To-Do List Position</label>
              <RadioGroup
                value={settings.todoListPosition || 'left'}
                onChange={(value) => handleSettingsChange({ todoListPosition: value as 'left' | 'right' })}
                options={[
                  { value: 'left', label: 'Top Left', icon: '⬅️', description: 'Below time overlay' },
                  { value: 'right', label: 'Top Right', icon: '➡️', description: 'Below location overlay' }
                ]}
              />
            </div>

            <div className="setting-group">
              <div className="todo-input-group" style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  placeholder="Add a new task..."
                  className="todo-input"
                  style={{ flex: 1 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                      const text = e.currentTarget.value.trim();
                      const parent = e.currentTarget.parentElement;
                      const goalInput = parent?.querySelector('.todo-goal-input') as HTMLInputElement;
                      const goalVal = goalInput && goalInput.value ? parseInt(goalInput.value) : undefined;
                      
                      const newTodo: TodoItem = {
                        id: Date.now().toString(),
                        text,
                        completed: false,
                        ...(goalVal && goalVal > 0 ? { current: 0, goal: goalVal } : {})
                      };
                      const updatedTodos = [...(settings.todos || []), newTodo];
                      handleSettingsChange({ todos: updatedTodos });
                      e.currentTarget.value = '';
                      if (goalInput) goalInput.value = '';
                    }
                  }}
                />
                <input
                  type="number"
                  placeholder="Goal (optional)"
                  className="todo-goal-input"
                  min="1"
                  style={{ width: '120px', padding: '8px 12px', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', color: '#fff' }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const parent = e.currentTarget.parentElement;
                      const textInput = parent?.querySelector('.todo-input') as HTMLInputElement;
                      const goalVal = e.currentTarget.value ? parseInt(e.currentTarget.value) : undefined;
                      if (textInput && textInput.value.trim()) {
                        const text = textInput.value.trim();
                        const newTodo: TodoItem = {
                          id: Date.now().toString(),
                          text,
                          completed: false,
                          ...(goalVal && goalVal > 0 ? { current: 0, goal: goalVal } : {})
                        };
                        const updatedTodos = [...(settings.todos || []), newTodo];
                        handleSettingsChange({ todos: updatedTodos });
                        textInput.value = '';
                        e.currentTarget.value = '';
                      }
                    }
                  }}
                />
                <button
                  className="btn btn-primary btn-small"
                  onClick={(e) => {
                    const parent = e.currentTarget.parentElement;
                    const textInput = parent?.querySelector('.todo-input') as HTMLInputElement;
                    const goalInput = parent?.querySelector('.todo-goal-input') as HTMLInputElement;
                    if (textInput && textInput.value.trim()) {
                      const text = textInput.value.trim();
                      const goalVal = goalInput && goalInput.value ? parseInt(goalInput.value) : undefined;
                      
                      const newTodo: TodoItem = {
                        id: Date.now().toString(),
                        text,
                        completed: false,
                        ...(goalVal && goalVal > 0 ? { current: 0, goal: goalVal } : {})
                      };
                      const updatedTodos = [...(settings.todos || []), newTodo];
                      handleSettingsChange({ todos: updatedTodos });
                      textInput.value = '';
                      if (goalInput) goalInput.value = '';
                    }
                  }}
                >
                  Add
                </button>
              </div>


              {settings.todos && settings.todos.length > 0 && (
                <>
                  <div className="todo-list-actions">
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => {
                        if (confirm('Are you sure you want to delete all tasks?')) {
                          handleSettingsChange({ todos: [] });
                        }
                      }}
                      disabled={!settings.todos || settings.todos.length === 0}
                    >
                      🗑️ Delete All
                    </button>
                  </div>
                  <div className="todo-list">
                    {[...(settings.todos || [])]
                      .sort((a, b) => {
                        // Incomplete tasks first, then completed tasks
                        if (a.completed === b.completed) return 0;
                        return a.completed ? 1 : -1;
                      })
                      .map((todo) => (
                        <div key={todo.id} className="todo-item-admin">
                          <label className="todo-checkbox-label">
                            <input
                              type="checkbox"
                              checked={todo.completed}
                              onChange={() => {
                                const updatedTodos = settings.todos!.map(t => {
                                  if (t.id === todo.id) {
                                    const nextCompleted = !t.completed;
                                    const updated = { ...t, completed: nextCompleted };
                                    if (t.goal !== undefined && t.goal > 0) {
                                      updated.current = nextCompleted ? t.goal : 0;
                                    }
                                    return updated;
                                  }
                                  return t;
                                });
                                handleSettingsChange({ todos: updatedTodos });
                              }}
                              className="todo-checkbox"
                              disabled={editingTodoId === todo.id}
                            />
                            {editingTodoId === todo.id ? (
                              <input
                                type="text"
                                value={editingTodoText}
                                onChange={(e) => setEditingTodoText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    if (editingTodoText.trim()) {
                                      const updatedTodos = settings.todos!.map(t =>
                                        t.id === todo.id ? { ...t, text: editingTodoText.trim() } : t
                                      );
                                      handleSettingsChange({ todos: updatedTodos });
                                    }
                                    setEditingTodoId(null);
                                    setEditingTodoText('');
                                  } else if (e.key === 'Escape') {
                                    setEditingTodoId(null);
                                    setEditingTodoText('');
                                  }
                                }}
                                onBlur={() => {
                                  if (editingTodoText.trim()) {
                                    const updatedTodos = settings.todos!.map(t =>
                                      t.id === todo.id ? { ...t, text: editingTodoText.trim() } : t
                                    );
                                    handleSettingsChange({ todos: updatedTodos });
                                  }
                                  setEditingTodoId(null);
                                  setEditingTodoText('');
                                }}
                                className="todo-edit-input"
                                autoFocus
                              />
                            ) : (
                              <span
                                className={`todo-text-admin ${todo.completed ? 'completed' : ''}`}
                                onDoubleClick={() => {
                                  setEditingTodoId(todo.id);
                                  setEditingTodoText(todo.text);
                                }}
                                style={{ cursor: 'pointer' }}
                                title="Double-click to edit"
                              >
                                {todo.text}
                                {todo.goal !== undefined && todo.goal > 0 && (
                                  <span style={{ fontSize: '0.85em', opacity: 0.7, marginLeft: '6px', fontWeight: 'bold' }}>
                                    ({todo.current ?? 0}/{todo.goal})
                                  </span>
                                )}
                              </span>
                            )}
                          </label>
                          <div className="todo-actions">
                            {editingTodoId !== todo.id && todo.goal !== undefined && todo.goal > 0 && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '6px' }}>
                                <button
                                  className="btn btn-secondary btn-small"
                                  style={{ padding: '2px 8px', minWidth: '24px', fontSize: '0.85em' }}
                                  onClick={() => {
                                    const updatedTodos = settings.todos!.map(t => {
                                      if (t.id === todo.id) {
                                        const newCurrent = Math.max(0, (t.current ?? 0) - 1);
                                        return {
                                          ...t,
                                          current: newCurrent,
                                          completed: newCurrent >= t.goal!
                                        };
                                      }
                                      return t;
                                    });
                                    handleSettingsChange({ todos: updatedTodos });
                                  }}
                                  title="Decrease"
                                >
                                  -
                                </button>
                                <button
                                  className="btn btn-secondary btn-small"
                                  style={{ padding: '2px 8px', minWidth: '24px', fontSize: '0.85em' }}
                                  onClick={() => {
                                    const updatedTodos = settings.todos!.map(t => {
                                      if (t.id === todo.id) {
                                        const newCurrent = Math.min(t.goal!, (t.current ?? 0) + 1);
                                        return {
                                          ...t,
                                          current: newCurrent,
                                          completed: newCurrent >= t.goal!
                                        };
                                      }
                                      return t;
                                    });
                                    handleSettingsChange({ todos: updatedTodos });
                                  }}
                                  title="Increase"
                                >
                                  +
                                </button>
                              </div>
                            )}
                            {editingTodoId !== todo.id && (
                              <button
                                className="todo-edit-btn"
                                onClick={() => {
                                  setEditingTodoId(todo.id);
                                  setEditingTodoText(todo.text);
                                }}
                                aria-label="Edit task"
                              >
                                ✏️
                              </button>
                            )}
                            <button
                              className="todo-delete-btn"
                              onClick={() => {
                                const updatedTodos = settings.todos!.filter(t => t.id !== todo.id);
                                handleSettingsChange({ todos: updatedTodos });
                              }}
                              aria-label="Delete task"
                              disabled={editingTodoId === todo.id}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>
          </section>

          {/* Social Media Rotator Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>📲 Social Media Rotator</h2>
              <div className="checkbox-group" style={{ marginTop: '8px' }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showSocials ?? false}
                    onChange={(e) => handleSettingsChange({ showSocials: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Enable Social Media Rotator</span>
                </label>
              </div>
            </div>

            {settings.showSocials && (
              <>
                {/* Social Channels */}
                <div className="setting-group" style={{ background: 'rgba(255,255,255,0.03)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  <label className="group-label" style={{ marginBottom: '12px' }}>Social Channels</label>
                  
                  {/* YouTube */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
                    <label className="checkbox-label" style={{ width: '130px', flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        checked={settings.socialYoutubeEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialYoutubeEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">YouTube</span>
                    </label>
                    <input
                      type="text"
                      placeholder="YouTube channel name"
                      value={settings.socialYoutubeName || ''}
                      onChange={(e) => handleSettingsChange({ socialYoutubeName: e.target.value })}
                      style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff' }}
                      disabled={!settings.socialYoutubeEnabled}
                    />
                  </div>

                  {/* Instagram */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
                    <label className="checkbox-label" style={{ width: '130px', flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        checked={settings.socialInstagramEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialInstagramEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">Instagram</span>
                    </label>
                    <input
                      type="text"
                      placeholder="Instagram username"
                      value={settings.socialInstagramName || ''}
                      onChange={(e) => handleSettingsChange({ socialInstagramName: e.target.value })}
                      style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff' }}
                      disabled={!settings.socialInstagramEnabled}
                    />
                  </div>

                  {/* TikTok */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
                    <label className="checkbox-label" style={{ width: '130px', flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        checked={settings.socialTiktokEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialTiktokEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">TikTok</span>
                    </label>
                    <input
                      type="text"
                      placeholder="TikTok username"
                      value={settings.socialTiktokName || ''}
                      onChange={(e) => handleSettingsChange({ socialTiktokName: e.target.value })}
                      style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff' }}
                      disabled={!settings.socialTiktokEnabled}
                    />
                  </div>

                  {/* Twitter / X */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <label className="checkbox-label" style={{ width: '130px', flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        checked={settings.socialXEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialXEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">X / Twitter</span>
                    </label>
                    <input
                      type="text"
                      placeholder="X username"
                      value={settings.socialXName || ''}
                      onChange={(e) => handleSettingsChange({ socialXName: e.target.value })}
                      style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff' }}
                      disabled={!settings.socialXEnabled}
                    />
                  </div>
                </div>

                {/* Rotator Interval */}
                <div className="setting-group" style={{ marginTop: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <label className="group-label">Rotation Interval</label>
                    <span style={{ fontSize: '0.9em', fontWeight: 'bold' }}>{settings.socialRotateInterval || 5} seconds</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="60"
                    step="1"
                    value={settings.socialRotateInterval || 5}
                    onChange={(e) => handleSettingsChange({ socialRotateInterval: parseInt(e.target.value) })}
                    style={{ width: '100%' }}
                  />
                  <p className="setting-description" style={{ marginTop: '4px' }}>
                    Choose how many seconds each social media handle displays before rotating to the next.
                  </p>
                </div>

                {/* Text Theme / Style */}
                <div className="setting-group" style={{ marginTop: '16px' }}>
                  <label className="group-label">Rotator Style Theme</label>
                  <RadioGroup
                    value={settings.socialTextTheme || 'default'}
                    onChange={(value) => handleSettingsChange({ socialTextTheme: value as any })}
                    options={[
                      { value: 'default', label: 'Default', icon: '📝', description: 'Bold sans-serif warning pill styling' },
                      { value: 'neon', label: 'Neon Cyberpunk', icon: '💻', description: 'Glowy cyan cyberpunk theme' },
                      { value: 'retro', label: 'Retro Arcade', icon: '🕹️', description: '1980s monospaced double-bordered pixel style' },
                      { value: 'bold', label: 'Bold Striped', icon: '🚧', description: 'Heavy warning stripes style' },
                      { value: 'impact', label: 'Comic Impact', icon: '💥', description: 'Playful comic impact style' }
                    ]}
                  />
                </div>

                {/* Position and Background */}
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '16px' }}>
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <label className="group-label">Position</label>
                    <RadioGroup
                      value={settings.socialPosition || 'top-middle'}
                      onChange={(value) => handleSettingsChange({ socialPosition: value as any })}
                      options={[
                        { value: 'top-middle', label: 'Top Middle', icon: '⬆️' },
                        { value: 'bottom-left', label: 'Bottom Left', icon: '↙️' }
                      ]}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: '200px', display: 'flex', alignItems: 'center' }}>
                    <label className="checkbox-label" style={{ marginTop: '24px' }}>
                      <input
                        type="checkbox"
                        checked={settings.socialShowBackground ?? true}
                        onChange={(e) => handleSettingsChange({ socialShowBackground: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">Show Rotator Background Pill</span>
                    </label>
                  </div>
                </div>
              </>
            )}
          </section>

          {/* URL List Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>🔗 URLs</h2>
              <div className="checkbox-group" style={{ marginTop: '8px' }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showUrls ?? false}
                    onChange={(e) => handleSettingsChange({ showUrls: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Show on overlay</span>
                </label>
              </div>
            </div>

            <div className="setting-group">
              <div className="url-input-group" style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '100px' }}>
                  <label className="input-label" style={{ fontSize: '0.8em' }}>Type</label>
                  <select
                    className="text-input"
                    value={urlTypeInput}
                    onChange={(e) => setUrlTypeInput(e.target.value as 'text' | 'embed')}
                    style={{ width: '100%' }}
                  >
                    <option value="text">Link (Text)</option>
                    <option value="embed">Embed (Browser Source)</option>
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '120px' }}>
                  <label className="input-label" style={{ fontSize: '0.8em' }}>Label</label>
                  <input
                    type="text"
                    placeholder="e.g. Discord"
                    className="text-input"
                    value={urlLabelInput}
                    onChange={(e) => setUrlLabelInput(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 2, minWidth: '200px' }}>
                  <label className="input-label" style={{ fontSize: '0.8em' }}>URL</label>
                  <input
                    type="text"
                    placeholder="e.g. https://..."
                    className="text-input"
                    value={urlAddressInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      setUrlAddressInput(val);
                      // Auto-detect embeddable URLs based on common keywords
                      // This works for any site (Streamelements, Streamlabs, Stromno, etc.) that uses these terms
                      const lowerVal = val.toLowerCase();
                      if ((lowerVal.includes('widget') ||
                        lowerVal.includes('overlay') ||
                        lowerVal.includes('alert') ||
                        lowerVal.includes('embed')) &&
                        urlTypeInput === 'text') {
                        setUrlTypeInput('embed');
                      }
                    }}
                    style={{ width: '100%' }}
                  />
                </div>
                <button
                  className="btn btn-primary btn-small"
                  style={{ marginTop: '23px' }}
                  onClick={() => {
                    if (urlLabelInput.trim() && urlAddressInput.trim()) {
                      let finalUrl = urlAddressInput.trim();

                      // Auto-fix YouTube watch links to embed links
                      if ((finalUrl.includes('youtube.com/watch') || finalUrl.includes('youtu.be/')) && !finalUrl.includes('/embed/')) {
                        const videoId = finalUrl.match(/(?:v=|youtu\.be\/)([\w-]+)/)?.[1];
                        if (videoId) {
                          finalUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
                          // Force type to embed if it wasn't already
                          if (urlTypeInput === 'text') setUrlTypeInput('embed');
                        }
                      }

                      const newUrl: UrlItem = {
                        id: Date.now().toString(),
                        label: urlLabelInput.trim(),
                        url: finalUrl,
                        active: true,
                        type: urlTypeInput,
                        scale: 1,
                        x: 0,
                        y: 0
                      };
                      const updatedUrls = [...(settings.urls || []), newUrl];
                      handleSettingsChange({ urls: updatedUrls });
                      setUrlLabelInput('');
                      setUrlAddressInput('');
                      setUrlTypeInput('text');
                    }
                  }}
                  disabled={!urlLabelInput.trim() || !urlAddressInput.trim()}
                >
                  Add
                </button>
              </div>

              {settings.urls && settings.urls.length > 0 && (
                <div className="url-list">
                  {settings.urls.map((urlItem) => (
                    <div key={urlItem.id} className="todo-item-admin" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px', borderBottom: '1px solid var(--border-color)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, overflow: 'hidden' }}>
                        <label className="todo-checkbox-label" style={{ marginBottom: 0 }}>
                          <input
                            type="checkbox"
                            checked={urlItem.active}
                            onChange={() => {
                              const updatedUrls = settings.urls!.map(u =>
                                u.id === urlItem.id ? { ...u, active: !u.active } : u
                              );
                              handleSettingsChange({ urls: updatedUrls });
                            }}
                            className="todo-checkbox"
                          />
                        </label>
                        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                            <span style={{ fontWeight: 'bold' }}>{urlItem.label}</span>
                            <span style={{ fontSize: '0.7em', padding: '2px 6px', borderRadius: '4px', background: (urlItem.type || 'text') === 'embed' ? 'var(--accent-color)' : 'var(--bg-secondary)', color: 'white' }}>{(urlItem.type || 'text') === 'embed' ? 'EMBED' : 'TEXT'}</span>
                          </div>
                          <span style={{ fontSize: '0.8em', opacity: 0.7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '8px' }}>{urlItem.url}</span>

                          {/* Controls for Scale and Position */}
                          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
                            {/* Scale Control */}
                            <div style={{ flex: 1, minWidth: '120px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                                <label style={{ fontSize: '0.75em', opacity: 0.8 }}>Scale</label>
                                <span style={{ fontSize: '0.75em' }}>{Math.round((urlItem.scale || 1) * 100)}%</span>
                              </div>
                              <input
                                type="range"
                                min="0.1"
                                max="2.0"
                                step="0.1"
                                value={urlItem.scale || 1}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  const updatedUrls = settings.urls!.map(u =>
                                    u.id === urlItem.id ? { ...u, scale: val } : u
                                  );
                                  handleSettingsChange({ urls: updatedUrls });
                                }}
                                style={{ width: '100%' }}
                              />
                            </div>

                            {/* Position Controls (D-Pad) */}
                            <div style={{ flex: 1, minWidth: '150px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                              <label style={{ fontSize: '0.75em', opacity: 0.8, marginBottom: '2px' }}>Position ({urlItem.x || 0}, {urlItem.y || 0})</label>

                              {/* Up Button */}
                              <button
                                className="btn btn-secondary btn-small"
                                style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                                onClick={() => {
                                  const updatedUrls = settings.urls!.map(u =>
                                    u.id === urlItem.id ? { ...u, y: (u.y || 0) - 10 } : u
                                  );
                                  handleSettingsChange({ urls: updatedUrls });
                                }}
                                title="Move Up"
                              >
                                ⬆️
                              </button>

                              <div style={{ display: 'flex', gap: '8px' }}>
                                {/* Left Button */}
                                <button
                                  className="btn btn-secondary btn-small"
                                  style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                                  onClick={() => {
                                    const updatedUrls = settings.urls!.map(u =>
                                      u.id === urlItem.id ? { ...u, x: (u.x || 0) - 10 } : u
                                    );
                                    handleSettingsChange({ urls: updatedUrls });
                                  }}
                                  title="Move Left"
                                >
                                  ⬅️
                                </button>

                                {/* Right Button */}
                                <button
                                  className="btn btn-secondary btn-small"
                                  style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                                  onClick={() => {
                                    const updatedUrls = settings.urls!.map(u =>
                                      u.id === urlItem.id ? { ...u, x: (u.x || 0) + 10 } : u
                                    );
                                    handleSettingsChange({ urls: updatedUrls });
                                  }}
                                  title="Move Right"
                                >
                                  ➡️
                                </button>
                              </div>

                              {/* Down Button */}
                              <button
                                className="btn btn-secondary btn-small"
                                style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                                onClick={() => {
                                  const updatedUrls = settings.urls!.map(u =>
                                    u.id === urlItem.id ? { ...u, y: (u.y || 0) + 10 } : u
                                  );
                                  handleSettingsChange({ urls: updatedUrls });
                                }}
                                title="Move Down"
                              >
                                ⬇️
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="todo-actions">
                        <button
                          className="todo-delete-btn"
                          onClick={() => {
                            const updatedUrls = settings.urls!.filter(u => u.id !== urlItem.id);
                            handleSettingsChange({ urls: updatedUrls });
                          }}
                          aria-label="Delete URL"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

        </div >
      </main >

      {/* Sticky actions for mobile */}
      < div className="admin-sticky-actions" >
        <button className="btn btn-secondary" onClick={openPreview}>👁️ Preview</button>
        <button
          className="btn btn-primary"
          onClick={async () => {
            try {
              await fetch('/api/logout', { method: 'GET', credentials: 'include' });
              router.push('/login');
            } catch (error) {
              console.error('Logout error:', error);
              router.push('/login');
            }
          }}
        >🚪 Logout</button>
      </div >
    </div >
  );
} 