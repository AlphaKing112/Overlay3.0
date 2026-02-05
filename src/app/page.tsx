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

  useEffect(() => { loadSettings(); }, [loadSettings]);

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

          {/* Location Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>📍 Location</h2>
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
                <div className="custom-location-input">
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

          {/* Weather Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>🌤️ Weather</h2>
            </div>

            <div className="setting-group">
              <div className="checkbox-group" style={{ marginBottom: '16px' }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showWeather ?? false}
                    onChange={(e) => handleSettingsChange({ showWeather: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Show Temp/Weather</span>
                </label>
              </div>

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
              <div className="todo-input-group">
                <input
                  type="text"
                  placeholder="Add a new task..."
                  className="todo-input"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                      const newTodo: TodoItem = {
                        id: Date.now().toString(),
                        text: e.currentTarget.value.trim(),
                        completed: false
                      };
                      const updatedTodos = [...(settings.todos || []), newTodo];
                      handleSettingsChange({ todos: updatedTodos });
                      e.currentTarget.value = '';
                    }
                  }}
                />
                <button
                  className="btn btn-primary btn-small"
                  onClick={(e) => {
                    const input = e.currentTarget.previousElementSibling as HTMLInputElement;
                    if (input && input.value.trim()) {
                      const newTodo: TodoItem = {
                        id: Date.now().toString(),
                        text: input.value.trim(),
                        completed: false
                      };
                      const updatedTodos = [...(settings.todos || []), newTodo];
                      handleSettingsChange({ todos: updatedTodos });
                      input.value = '';
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
                                const updatedTodos = settings.todos!.map(t =>
                                  t.id === todo.id ? { ...t, completed: !t.completed } : t
                                );
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
                              </span>
                            )}
                          </label>
                          <div className="todo-actions">
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

        </div>
      </main>

      {/* Sticky actions for mobile */}
      <div className="admin-sticky-actions">
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
      </div>
    </div>
  );
} 