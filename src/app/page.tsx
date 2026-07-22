"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { authenticatedFetch } from '@/lib/client-auth';
import { OverlaySettings, DEFAULT_OVERLAY_SETTINGS, LocationDisplayMode, MapZoomLevel, DisplayMode, TodoItem, UrlItem } from '@/types/settings';
import OBSWebSocket from 'obs-websocket-js';
import { fetchBitrateStats } from '@/utils/api-utils';
import * as workerTimers from 'worker-timers';
import { parseCoordinateString, distanceInMeters } from '@/utils/location-utils';
import { DistanceTracker } from '@/components/DistanceTracker';
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
  const lastSyncedToken = useRef<string | null>(null);

  // OBS State
  const obsRef = useRef<OBSWebSocket | null>(null);
  const [obsStatus, setObsStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
  const [obsUrlInput, setObsUrlInput] = useState('ws://127.0.0.1:4455');
  const [obsPasswordInput, setObsPasswordInput] = useState('');
  const [obsScenes, setObsScenes] = useState<{ sceneName: string }[]>([]);
  const [obsCurrentScene, setObsCurrentScene] = useState<string>('');
  const [obsErrorLog, setObsErrorLog] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStreamingToggling, setIsStreamingToggling] = useState(false);

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
        // Session expired — redirect to login so they can re-authenticate
        if (res.status === 401) {
          setToast({ type: 'error', message: 'Session expired. Redirecting to login...' });
          setTimeout(() => router.push('/login'), 1500);
          return;
        }
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


  const syncFromTwitch = useCallback(async () => {
    const clientId = 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw'; // Hardcoded client ID for Lazesk Overlay
    if (!settings.twitchToken || !settings.twitchBroadcasterId) {
      setToast({ type: 'error', message: 'Please connect to Twitch first.' });
      setTimeout(() => setToast(null), 3000);
      return;
    }
    
    setToast({ type: 'saving', message: 'Syncing from Twitch...' });
    
    try {
      const res = await fetch(`/api/twitch-subs?broadcasterId=${settings.twitchBroadcasterId}&token=${settings.twitchToken}&clientId=${clientId}`);
      
      if (!res.ok) {
        let errorMsg = `HTTP ${res.status}`;
        try {
          const errorData = await res.json();
          errorMsg = errorData.error || errorMsg;
        } catch (e) {
          // fallback to status text
        }
        throw new Error(errorMsg);
      }
      
      const result = await res.json();
      const subTotal = result.total ?? 0;
      
      handleSettingsChange({
        totalSubCurrent: subTotal
      });
      
      setToast({ type: 'saved', message: `Synced successfully! Found ${subTotal} subscribers.` });
      setTimeout(() => setToast(null), 3000);
    } catch (error) {
      console.error('Twitch sync error:', error);
      setToast({ type: 'error', message: `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}` });
      setTimeout(() => setToast(null), 5000);
    }
  }, [settings.twitchToken, settings.twitchBroadcasterId, handleSettingsChange]);

  // Auto-sync Twitch when token changes (safely)
  useEffect(() => {
    if (settings.twitchToken && settings.twitchBroadcasterId) {
      if (lastSyncedToken.current !== settings.twitchToken) {
        lastSyncedToken.current = settings.twitchToken;
        syncFromTwitch();
      }
    }
  }, [settings.twitchToken, settings.twitchBroadcasterId, syncFromTwitch]);

  const openPreview = () => {
    window.open('/overlay', '_blank');
  };

  // Sync OBS settings on load
  useEffect(() => {
    if (settings.obsWebsocketUrl) {
      setObsUrlInput(settings.obsWebsocketUrl);
    }
    if (settings.obsWebsocketPassword) {
      setObsPasswordInput(settings.obsWebsocketPassword);
    }
  }, [settings.obsWebsocketUrl, settings.obsWebsocketPassword]);

  // OBS Connect Function
  const connectToOBS = async () => {
    // Always tear down the old instance before creating a fresh one.
    // Reusing a stale OBSWebSocket whose socket already closed triggers
    // the internal onclose handler on the dead socket — call stack error.
    if (obsRef.current) {
      try { obsRef.current.removeAllListeners(); } catch { /* ignore */ }
      try { await obsRef.current.disconnect(); } catch { /* ignore */ }
      obsRef.current = null;
    }

    const obs = new OBSWebSocket();
    // Register listeners BEFORE connecting so onclose is always handled.
    obs.on('ConnectionClosed', () => { setObsStatus('disconnected'); setIsStreaming(false); });
    obs.on('ConnectionError', () => { setObsStatus('disconnected'); setIsStreaming(false); });
    obs.on('CurrentProgramSceneChanged', (data) => {
      setObsCurrentScene(data.sceneName);
    });
    obs.on('SceneListChanged', (data) => {
      setObsScenes(data.scenes.map((s: any) => ({ sceneName: s.sceneName as string })));
    });
    obs.on('StreamStateChanged' as any, (data: any) => {
      setIsStreaming(data.outputActive ?? false);
    });
    obsRef.current = obs;

    setObsStatus('connecting');
    try {
      const connectPromise = obs.connect(obsUrlInput, obsPasswordInput || undefined);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Connection timed out after 5 seconds. Check your IP/DDNS, port forwarding, and firewall.")), 5000)
      );
      await Promise.race([connectPromise, timeoutPromise]);
      setObsStatus('connected');
      setObsErrorLog(null);
      try {
        const data = await obs.call('GetSceneList');
        setObsScenes(data.scenes.map((s: any) => ({ sceneName: s.sceneName as string })));
        setObsCurrentScene(data.currentProgramSceneName);
      } catch (err: any) {
        console.warn("Failed to fetch scenes", err?.message || err);
      }
      // Fetch initial stream status
      try {
        const streamStatus = await obs.call('GetStreamStatus' as any) as any;
        setIsStreaming(streamStatus?.outputActive ?? false);
      } catch (err) {
        // Older OBS versions may not support this
      }
      // Save the settings if connection is successful
      handleSettingsChange({
        obsWebsocketUrl: obsUrlInput,
        obsWebsocketPassword: obsPasswordInput
      });
      setToast({ type: 'saved', message: 'Connected to OBS successfully!' });
      setTimeout(() => setToast(null), 2000);
    } catch (error: any) {
      console.warn('OBS Connection Error:', error?.message || error);
      setObsStatus('disconnected');
      setObsErrorLog(error?.message || String(error) || 'Unknown connection error');
      setToast({ type: 'error', message: 'Failed to connect to OBS.' });
      setTimeout(() => setToast(null), 3000);
    }
  };

  // OBS Disconnect Function
  const disconnectFromOBS = async () => {
    if (obsRef.current) {
      try { obsRef.current.removeAllListeners(); } catch { /* ignore */ }
      try { await obsRef.current.disconnect(); } catch { /* ignore */ }
      obsRef.current = null;
    }
    setObsStatus('disconnected');
    setIsStreaming(false);
    setObsScenes([]);
    setObsCurrentScene('');
  };

  // Auto-connect to OBS on initial load if settings are present.
  // IMPORTANT: obsStatus is intentionally NOT in the dependency array.
  // Adding it caused a reconnect loop: ConnectionClosed → obsStatus='disconnected'
  // → effect re-fires → connect() on a stale socket → onclose call stack error.
  // This effect fires only when the URL/password/syncStatus change (i.e. initial load).
  useEffect(() => {
    if (!settings.obsWebsocketUrl || syncStatus !== 'connected') return;

    const autoConnect = async () => {
      // Always tear down the old instance before creating a fresh one.
      // Reusing a stale OBSWebSocket whose socket already closed triggers the
      // internal onclose handler on the dead socket → call stack error in OBS.
      if (obsRef.current) {
        try { obsRef.current.removeAllListeners(); } catch { /* ignore */ }
        try { await obsRef.current.disconnect(); } catch { /* ignore */ }
        obsRef.current = null;
      }

      const obs = new OBSWebSocket();
      // Register listeners BEFORE connecting so onclose is always handled.
      obs.on('ConnectionClosed', () => setObsStatus('disconnected'));
      obs.on('ConnectionError', () => setObsStatus('disconnected'));
      obs.on('CurrentProgramSceneChanged', (data) => {
        setObsCurrentScene(data.sceneName);
      });
      obs.on('SceneListChanged', (data) => {
        setObsScenes(data.scenes.map((s: any) => ({ sceneName: s.sceneName as string })));
      });
      obsRef.current = obs;

      try {
        const connectPromise = obs.connect(settings.obsWebsocketUrl, settings.obsWebsocketPassword || undefined);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timed out.")), 5000));
        await Promise.race([connectPromise, timeoutPromise]);
        setObsStatus('connected');
        setObsErrorLog(null);
        try {
          const data = await obs.call('GetSceneList');
          setObsScenes(data.scenes.map((s: any) => ({ sceneName: s.sceneName as string })));
          setObsCurrentScene(data.currentProgramSceneName);
        } catch (err: any) {
          console.warn("Failed to fetch initial scenes", err?.message || err);
        }
      } catch (error: any) {
        // Silent fail on auto-connect — surface error for debugging only
        setObsErrorLog(error?.message || String(error) || 'Unknown connection error');
        setObsStatus('disconnected');
      }
    };

    autoConnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.obsWebsocketUrl, settings.obsWebsocketPassword, syncStatus]);

  // ===== OBS AUTO-SWITCH BACKEND INTEGRATION =====
  const [autoSwitchStatus, setAutoSwitchStatus] = useState<string>('Idle');

  useEffect(() => {
    // 1. Tell backend to start or stop when the toggle changes
    if (settings.obsAutoSwitchSceneToggle && settings.obsWebsocketUrl) {
      fetch('/api/auto-switch-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', settings })
      }).catch(() => {});
    } else {
      fetch('/api/auto-switch-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      }).catch(() => {});
    }
  }, [settings.obsAutoSwitchSceneToggle, settings.obsWebsocketUrl, settings.obsLiveSceneName, settings.obsOfflineSceneName, settings.belaboxPublisherKey]);

  useEffect(() => {
    // 2. Poll the backend for the current status to display in the UI
    let isActive = true;
    const pollBackend = async () => {
      if (!isActive) return;
      if (!settings.obsAutoSwitchSceneToggle) {
        setAutoSwitchStatus('Toggle is OFF');
        return;
      }
      try {
        const res = await fetch('/api/auto-switch-service');
        if (res.ok) {
          const data = await res.json();
          setAutoSwitchStatus(data.statusLog || 'Running in background...');
        }
      } catch (e) {
        setAutoSwitchStatus('Backend unreachable');
      }
      if (isActive) {
        setTimeout(pollBackend, 3000);
      }
    };
    pollBackend();
    return () => { isActive = false; };
  }, [settings.obsAutoSwitchSceneToggle]);
  // ===== END OBS AUTO-SWITCH BACKEND INTEGRATION =====




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
            <div className={`sync-status ${syncStatus}`} title={`Database: ${syncStatus}`}>
              {syncStatus === 'connected' && '🟢'}
              {syncStatus === 'syncing' && '🟡'}
              {syncStatus === 'disconnected' && '🔴'}
            </div>
            <div className={`sync-status ${obsStatus}`} title={`OBS: ${obsStatus}`} style={{ marginLeft: '10px' }}>
              OBS: {obsStatus === 'connected' && '🟢'}
              {obsStatus === 'connecting' && '🟡'}
              {obsStatus === 'disconnected' && '🔴'}
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

          {/* OBS Connection Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>🎥 OBS Websocket</h2>
            </div>
            <div className="setting-group">
              <label className="group-label">Connection URL</label>
              <input
                type="text"
                value={obsUrlInput}
                onChange={(e) => setObsUrlInput(e.target.value)}
                placeholder="ws://127.0.0.1:4455"
                className="text-input"
              />
            </div>
            <div className="setting-group" style={{ marginTop: '12px' }}>
              <label className="group-label">Password</label>
              <input
                type="password"
                value={obsPasswordInput}
                onChange={(e) => setObsPasswordInput(e.target.value)}
                placeholder="Leave blank if no password"
                className="text-input"
              />
            </div>
            <div className="setting-group" style={{ marginTop: '12px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              {obsStatus === 'connected' ? (
                <button className="btn" style={{ background: 'rgba(255,80,80,0.15)', border: '1px solid rgba(255,80,80,0.4)', color: '#ff6b6b' }} onClick={disconnectFromOBS}>
                  Disconnect
                </button>
              ) : (
                <button className="btn btn-primary" onClick={connectToOBS} disabled={obsStatus === 'connecting'}>
                  {obsStatus === 'connecting' ? 'Connecting...' : 'Connect to OBS'}
                </button>
              )}
              {obsStatus === 'connected' && (
                <button
                  className="btn"
                  disabled={isStreamingToggling}
                  onClick={async () => {
                    if (!obsRef.current) return;
                    setIsStreamingToggling(true);
                    const wasStreaming = isStreaming;
                    try {
                      if (wasStreaming) {
                        await obsRef.current.call('StopStream' as any);
                      } else {
                        await obsRef.current.call('StartStream' as any);
                      }
                      // Optimistically flip immediately — OBS takes several seconds to
                      // fully connect so polling GetStreamStatus too soon returns false
                      setIsStreaming(!wasStreaming);
                    } catch (err: any) {
                      console.warn('Stream toggle error:', err);
                      setToast({ type: 'error', message: `Stream error: ${err?.message || 'Unknown error'}` });
                      setTimeout(() => setToast(null), 4000);
                    } finally {
                      setIsStreamingToggling(false);
                    }
                  }}
                  style={{
                    background: isStreamingToggling
                      ? 'rgba(100,100,100,0.5)'
                      : isStreaming
                        ? 'linear-gradient(135deg, #dc2626, #b91c1c)'
                        : 'linear-gradient(135deg, #16a34a, #15803d)',
                    color: '#fff',
                    border: isStreaming ? '1px solid rgba(248,113,113,0.4)' : '1px solid rgba(74,222,128,0.4)',
                    fontWeight: 700,
                    letterSpacing: '0.03em',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    minWidth: '160px',
                    justifyContent: 'center',
                    transition: 'background 0.3s ease',
                  }}
                >
                  {isStreamingToggling ? (
                    <>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#facc15', boxShadow: '0 0 6px #facc15', animation: 'pulse 1s infinite' }} />
                      {isStreaming ? 'Stopping...' : 'Starting...'}
                    </>
                  ) : isStreaming ? (
                    <>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#f87171', boxShadow: '0 0 8px #f87171' }} />
                      🔴 Stop Stream
                    </>
                  ) : (
                    <>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 8px #4ade80' }} />
                      ▶ Start Stream
                    </>
                  )}
                </button>
              )}
            </div>

            {obsErrorLog && (
              <div className="setting-group" style={{ marginTop: '12px', padding: '12px', backgroundColor: 'rgba(255, 0, 0, 0.1)', border: '1px solid rgba(255, 0, 0, 0.3)', borderRadius: '8px' }}>
                <label className="group-label" style={{ color: '#ff6b6b' }}>⚠️ Connection Error</label>
                <div style={{ fontSize: '0.85em', color: '#ffc9c9', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {obsErrorLog}
                </div>
                <div style={{ fontSize: '0.8em', color: '#ff9999', marginTop: '8px' }}>
                  <strong>Tips:</strong>
                  <ul style={{ paddingLeft: '20px', marginTop: '4px', marginBottom: 0 }}>
                    <li>Ensure you are using your PC's local IP (e.g. 192.168.x.x) on your phone.</li>
                    <li>Ensure OBS is open and WebSocket Server is enabled (Tools &gt; WebSocket Server Settings).</li>
                    <li>If you deployed to Vercel (https://), mobile browsers block connecting to a local insecure websocket (ws://). Run the Admin panel locally (http://192.168.x.x:3000) from your PC to bypass this.</li>
                  </ul>
                </div>
              </div>
            )}

            {obsStatus === 'connected' && obsScenes.length > 0 && (
              <>
                <div className="setting-group" style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
                  <label className="group-label">OBS Scenes</label>
                  <RadioGroup
                    value={obsCurrentScene}
                    onChange={async (value) => {
                      try {
                        await obsRef.current?.call('SetCurrentProgramScene', { sceneName: value });
                        setObsCurrentScene(value);
                      } catch (e: any) {
                        console.warn("Failed to set scene", e?.message || e);
                      }
                    }}
                    options={obsScenes.map(scene => ({
                      value: scene.sceneName,
                      label: scene.sceneName,
                      icon: '🎬'
                    }))}
                  />
                </div>
                
                {/* Auto Switch Scene Toggle */}
                <div className="setting-group" style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
                  <div className="toggle-wrapper" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <label className="group-label" style={{ margin: 0 }}>Auto-switch Scenes</label>
                      <div className="setting-description" style={{ fontSize: '0.8em', color: 'var(--text-secondary)', marginTop: '4px' }}>
                        Automatically switch to specific scenes when your stream connects or disconnects.
                      </div>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={settings.obsAutoSwitchSceneToggle || false}
                        onChange={(e) => handleSettingsChange({ obsAutoSwitchSceneToggle: e.target.checked })}
                      />
                      <span className="slider"></span>
                    </label>
                  </div>
                  
                  {settings.obsAutoSwitchSceneToggle && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
                      <div>
                        <label className="group-label" style={{ fontSize: '0.9em' }}>Select Offline Scene</label>
                        <select
                          className="text-input"
                          value={settings.obsOfflineSceneName || ''}
                          onChange={(e) => handleSettingsChange({ obsOfflineSceneName: e.target.value })}
                          style={{ marginTop: '8px' }}
                        >
                          <option value="">-- Select a Scene --</option>
                          {obsScenes.map(scene => (
                            <option key={scene.sceneName} value={scene.sceneName}>
                              {scene.sceneName}
                            </option>
                          ))}
                        </select>
                      </div>
                      
                      <div>
                        <label className="group-label" style={{ fontSize: '0.9em' }}>Select Live Scene</label>
                        <select
                          className="text-input"
                          value={settings.obsLiveSceneName || ''}
                          onChange={(e) => handleSettingsChange({ obsLiveSceneName: e.target.value })}
                          style={{ marginTop: '8px' }}
                        >
                          <option value="">-- Select a Scene --</option>
                          {obsScenes.map(scene => (
                            <option key={scene.sceneName} value={scene.sceneName}>
                              {scene.sceneName}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Live Status Display */}
                      <div style={{
                        background: 'rgba(0,0,0,0.3)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        padding: '10px 14px',
                        fontSize: '0.82em',
                        color: autoSwitchStatus.startsWith('✅') ? '#4ade80' : autoSwitchStatus.startsWith('❌') ? '#f87171' : 'var(--text-secondary)',
                        fontFamily: 'monospace'
                      }}>
                        <strong style={{ color: 'var(--text-primary)' }}>Auto-Switch Status: </strong>{autoSwitchStatus}
                      </div>

                      {/* Debugger toggle */}
                      <div className="toggle-wrapper" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '4px' }}>
                        <div>
                          <label className="group-label" style={{ margin: 0, fontSize: '0.9em' }}>Show Debugger on Overlay</label>
                          <div className="setting-description" style={{ fontSize: '0.78em', color: 'var(--text-secondary)', marginTop: '2px' }}>
                            Displays a real-time debug panel on the overlay screen. Turn off when not needed.
                          </div>
                        </div>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={settings.obsAutoSwitchDebugger || false}
                            onChange={(e) => handleSettingsChange({ obsAutoSwitchDebugger: e.target.checked })}
                          />
                          <span className="slider"></span>
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>

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

            {/* Master Time/Weather/Location toggle */}
            <div className="setting-group" style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
              <div className="toggle-wrapper" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <label className="group-label" style={{ margin: 0 }}>🕐 Time, Weather &amp; Location Overlay</label>
                  <div className="setting-description" style={{ fontSize: '0.8em', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    Show or hide the entire time, weather and location block (including its background).
                  </div>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.showTimeWeatherLocation ?? true}
                    onChange={(e) => handleSettingsChange({ showTimeWeatherLocation: e.target.checked })}
                  />
                  <span className="slider"></span>
                </label>
              </div>
            </div>

            {(settings.showTimeWeatherLocation ?? true) && (<>
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
                  <label className="group-label">Condition Icon &amp; Text</label>
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
                  <div className="checkbox-group" style={{ marginTop: '10px' }}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.showWeatherWarnings ?? true}
                        onChange={(e) => handleSettingsChange({ showWeatherWarnings: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">⚠️ Show Weather Warnings</span>
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
                <label className="group-label" style={{ marginBottom: 0 }}>Time, Weather &amp; Location Overlay Scale</label>
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
                  <span className="checkbox-text">🔄 Swap Time (Left) &amp; Location (Right)</span>
                </label>
              </div>

              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.combineDateTimeWithLocation ?? false}
                    onChange={(e) => handleSettingsChange({ combineDateTimeWithLocation: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">🧩 Combine Time/Date into Location/Weather Box</span>
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
            </>)}
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
                      { value: 'gta', label: 'GTA / Schematic', icon: '🚁' },
                      { value: 'gta5', label: 'GTA 5 Map', icon: '🗺️' }
                    ]}
                  />
                </div>

                <div className="setting-group">
                  <label className="group-label">Map Shape</label>
                  <RadioGroup
                    value={settings.minimapShape || 'circle'}
                    onChange={(value) => handleSettingsChange({ minimapShape: value as 'circle' | 'square' })}
                    options={[
                      { value: 'circle', label: 'Circle Map', icon: '⭕', description: 'Classic circular radar style' },
                      { value: 'square', label: 'Square Map', icon: '🔳', description: 'Modern squared card style' }
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
              <label className="group-label">Zoom Level Presets</label>
              <RadioGroup
                value={settings.mapZoomLevel}
                onChange={(value) => {
                  const presetZoomMap: Record<string, number> = {
                    neighbourhood: 15,
                    city: 13,
                    state: 8,
                    country: 5,
                    ocean: 3,
                    continental: 1,
                  };
                  const zoomNum = presetZoomMap[value] || 15;
                  handleSettingsChange({ mapZoomLevel: value as MapZoomLevel, customMapZoom: zoomNum });
                }}
                options={[
                  { value: 'neighbourhood', label: 'Neighbourhood (15x)', icon: '🏘️' },
                  { value: 'city', label: 'City (13x)', icon: '🏙️' },
                  { value: 'state', label: 'State (8x)', icon: '🗺️' },
                  { value: 'country', label: 'Country (5x)', icon: '🌍' },
                  { value: 'ocean', label: 'Ocean (3x)', icon: '🌊' },
                  { value: 'continental', label: 'Continental (1x)', icon: '🌎' }
                ]}
              />
            </div>

            <div className="setting-group" style={{ marginTop: '16px', background: 'rgba(255,255,255,0.03)', padding: '16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <label className="group-label" style={{ margin: 0, fontSize: '0.95rem' }}>🔍 Custom Zoom Scale</label>
                <span style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#38bdf8', fontFamily: 'monospace', background: 'rgba(56,189,248,0.1)', padding: '2px 8px', borderRadius: '6px' }}>
                  {(settings.customMapZoom ?? 15).toFixed(1)}x
                </span>
              </div>
              <input
                type="range"
                min="1"
                max="20"
                step="0.25"
                value={settings.customMapZoom ?? 15}
                onChange={(e) => handleSettingsChange({ customMapZoom: parseFloat(e.target.value) })}
                style={{ width: '100%', accentColor: '#38bdf8', height: '6px', cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75em', color: '#94a3b8', marginTop: '6px' }}>
                <span>1x (Continental)</span>
                <span>10x (State/City)</span>
                <span>20x (Max Zoom)</span>
              </div>
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

          {/* Distance Goal Progress Bar Section */}
          <section className="settings-section">
            <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2>🛼 Distance Goal Progress Bar</h2>
              <span className="badge" style={{ background: 'rgba(0, 255, 102, 0.15)', color: '#00ff66', border: '1px solid rgba(0, 255, 102, 0.3)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.8em', fontWeight: 'bold' }}>
                Walk / Skate / Run
              </span>
            </div>

            <div className="setting-group">
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.showDistanceTracker ?? false}
                    onChange={(e) => handleSettingsChange({ showDistanceTracker: e.target.checked })}
                    className="checkbox-input"
                  />
                  <span className="checkbox-text">Show Distance Progress Bar Overlay</span>
                </label>
                <p className="setting-description" style={{ marginLeft: '28px', fontSize: '0.85em', opacity: 0.7 }}>
                  Displays a sleek, animated glassmorphic progress bar overlay as you travel to your destination.
                </p>
              </div>
            </div>

            {settings.showDistanceTracker && (
              <>
                {/* Live Preview Box */}
                {(() => {
                  const unit = settings.distanceUnit || 'mi';
                  const unitFactor = unit === 'km' ? 0.001 : unit === 'm' ? 1.0 : (1 / 1609.344);
                  let previewCurrent = settings.distanceCurrent ?? 154;
                  let previewGoal = settings.distanceGoal ?? 378;

                  if (settings.distanceMode === 'destination') {
                    const destLat = settings.destinationLat ?? 40.7577;
                    const destLon = settings.destinationLon ?? -73.8252;
                    const startLat = settings.startLat ?? (destLat - 0.05);
                    const startLon = settings.startLon ?? (destLon - 0.05);

                    const totalM = distanceInMeters(startLat, startLon, destLat, destLon);
                    previewGoal = Math.round((totalM * unitFactor) * 10) / 10 || 1;
                    previewCurrent = (settings.distanceCurrent !== undefined && settings.distanceCurrent !== 0)
                      ? settings.distanceCurrent
                      : Math.round((previewGoal * 0.4) * 10) / 10;
                  }

                  const pct = previewGoal > 0 ? Math.min(Math.max((previewCurrent / previewGoal) * 100, 0), 100) : 0;

                  return (
                    <div style={{ marginBottom: '20px', padding: '16px', background: 'rgba(0, 0, 0, 0.4)', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                      <div style={{ fontSize: '0.85em', fontWeight: 'bold', color: 'rgba(255, 255, 255, 0.6)', marginBottom: '12px', display: 'flex', justifyContent: 'space-between' }}>
                        <span>LIVE OVERLAY PREVIEW</span>
                        <span>{pct.toFixed(1)}% Completed</span>
                      </div>
                      <div style={{ padding: '10px 0', overflowX: 'auto', display: 'flex', justifyContent: 'center' }}>
                        <DistanceTracker
                          current={previewCurrent}
                          goal={previewGoal}
                          title={settings.distanceTitle || ''}
                          locationText={settings.destinationName ? `TO: ${settings.destinationName.toUpperCase()}` : ''}
                          currentLocationText={(settings.distanceShowCurrentLocation ?? true) ? 'IN: FLUSHING, NY' : ''}
                          icon={settings.distanceIcon || '🛼'}
                          visible={true}
                          color={settings.distanceColor || 'neon-green'}
                          styleVariant={settings.distanceStyle || 'default'}
                          fontStyle={settings.distanceFont || 'default'}
                          scale={1}
                          x={0}
                          y={0}
                          isDemo={true}
                        />
                      </div>
                    </div>
                  );
                })()}

                {/* Mode Selector: Manual vs GPS Destination */}
                <div className="setting-group" style={{ background: 'rgba(255, 255, 255, 0.04)', padding: '16px', borderRadius: '10px', marginBottom: '16px' }}>
                  <label className="group-label" style={{ marginBottom: '10px', color: '#00ff66', fontWeight: 'bold' }}>📍 Tracking Mode</label>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <button
                      className={`btn ${settings.distanceMode !== 'destination' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => handleSettingsChange({ distanceMode: 'manual' })}
                      style={{ flex: 1, minWidth: '160px', padding: '10px', fontWeight: 'bold' }}
                    >
                      📊 Manual / Step Counter
                    </button>
                    <button
                      className={`btn ${settings.distanceMode === 'destination' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => handleSettingsChange({ distanceMode: 'destination' })}
                      style={{ flex: 1, minWidth: '160px', padding: '10px', fontWeight: 'bold' }}
                    >
                      🎯 Realtime GPS Destination
                    </button>
                  </div>
                </div>

                {/* GPS Destination Target Controls */}
                {settings.distanceMode === 'destination' ? (
                  <div className="setting-group" style={{ background: 'rgba(0, 255, 102, 0.05)', border: '1px solid rgba(0, 255, 102, 0.2)', padding: '16px', borderRadius: '10px', marginBottom: '16px' }}>
                    <label className="group-label" style={{ marginBottom: '12px', color: '#00ff66', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>🎯 Destination GPS Coords & Trip Setup</span>
                      <span style={{ fontSize: '0.85em', opacity: 0.8, color: '#ffffff' }}>Auto-calculates progress from GPS</span>
                    </label>

                    {/* Destination Name */}
                    <div style={{ marginBottom: '14px' }}>
                      <label style={{ display: 'block', fontSize: '0.85em', opacity: 0.8, marginBottom: '6px' }}>Destination Name / Label</label>
                      <input
                        type="text"
                        placeholder="e.g. Flushing, NY"
                        value={settings.destinationName || ''}
                        onChange={(e) => handleSettingsChange({ destinationName: e.target.value })}
                        className="text-input"
                        style={{ width: '100%' }}
                      />
                    </div>

                    {/* Quick Paste Coords from Google Maps */}
                    <div style={{ marginBottom: '14px', background: 'rgba(0, 255, 102, 0.08)', padding: '10px 12px', borderRadius: '8px', border: '1px dashed rgba(0, 255, 102, 0.3)' }}>
                      <label style={{ display: 'block', fontSize: '0.85em', color: '#00ff66', fontWeight: 'bold', marginBottom: '4px' }}>
                        📋 Quick Paste Google Maps Coords (Decimal or DMS)
                      </label>
                      <input
                        type="text"
                        placeholder="Paste e.g. 40°45'27.8&quot;N 73°49'30.8&quot;W or 40.757727, -73.825222"
                        onChange={(e) => {
                          const parsed = parseCoordinateString(e.target.value);
                          if (parsed) {
                            handleSettingsChange({
                              destinationLat: parsed.lat,
                              destinationLon: parsed.lon,
                            });
                          }
                        }}
                        className="text-input"
                        style={{ width: '100%', fontSize: '0.9em' }}
                      />
                      <span style={{ fontSize: '0.75em', opacity: 0.7, marginTop: '4px', display: 'block' }}>
                        Paste any Google Maps format (DMS or Decimal) to auto-fill Destination Latitude & Longitude below!
                      </span>
                    </div>

                    {/* Coordinates Inputs: Destination Lat/Lon & Start Lat/Lon */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', marginBottom: '14px' }}>
                      {/* Destination Coords */}
                      <div style={{ background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                        <label style={{ display: 'block', fontSize: '0.85em', color: '#00ff66', fontWeight: 'bold', marginBottom: '8px' }}>🏁 Destination Coords</label>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <div>
                            <span style={{ fontSize: '0.75em', opacity: 0.7 }}>Latitude</span>
                            <input
                              type="number"
                              step="any"
                              value={settings.destinationLat ?? 40.763621}
                              onChange={(e) => handleSettingsChange({ destinationLat: parseFloat(e.target.value) || 0 })}
                              className="text-input"
                              style={{ width: '100%', fontSize: '0.9em' }}
                            />
                          </div>
                          <div>
                            <span style={{ fontSize: '0.75em', opacity: 0.7 }}>Longitude</span>
                            <input
                              type="number"
                              step="any"
                              value={settings.destinationLon ?? -73.828090}
                              onChange={(e) => handleSettingsChange({ destinationLon: parseFloat(e.target.value) || 0 })}
                              className="text-input"
                              style={{ width: '100%', fontSize: '0.9em' }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Start Coords */}
                      <div style={{ background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                        <label style={{ display: 'block', fontSize: '0.85em', color: '#00d2ff', fontWeight: 'bold', marginBottom: '8px' }}>🚀 Journey Start Coords (Auto-set on start)</label>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <div>
                            <span style={{ fontSize: '0.75em', opacity: 0.7 }}>Latitude</span>
                            <input
                              type="number"
                              step="any"
                              placeholder="Auto-captured"
                              value={settings.startLat ?? ''}
                              onChange={(e) => handleSettingsChange({ startLat: e.target.value ? parseFloat(e.target.value) : undefined })}
                              className="text-input"
                              style={{ width: '100%', fontSize: '0.9em' }}
                            />
                          </div>
                          <div>
                            <span style={{ fontSize: '0.75em', opacity: 0.7 }}>Longitude</span>
                            <input
                              type="number"
                              step="any"
                              placeholder="Auto-captured"
                              value={settings.startLon ?? ''}
                              onChange={(e) => handleSettingsChange({ startLon: e.target.value ? parseFloat(e.target.value) : undefined })}
                              className="text-input"
                              style={{ width: '100%', fontSize: '0.9em' }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Unit Selector */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                      <div>
                        <label style={{ fontSize: '0.85em', opacity: 0.8, marginRight: '8px' }}>Distance Unit:</label>
                        <select
                          value={settings.distanceUnit || 'mi'}
                          onChange={(e) => handleSettingsChange({ distanceUnit: e.target.value as 'mi' | 'km' | 'm' })}
                          className="text-input"
                          style={{ padding: '4px 10px' }}
                        >
                          <option value="mi">Miles (mi)</option>
                          <option value="km">Kilometers (km)</option>
                          <option value="m">Meters (m)</option>
                        </select>
                      </div>

                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-primary btn-small"
                          onClick={() => {
                            handleSettingsChange({
                              startLat: undefined,
                              startLon: undefined,
                              distanceCurrent: 0,
                            });
                          }}
                          style={{ padding: '6px 12px', fontSize: '0.85em', background: '#00d2ff', color: '#000', fontWeight: 'bold' }}
                        >
                          🚀 Reset & Start New Journey
                        </button>

                        <button
                          className="btn btn-secondary btn-small"
                          onClick={() => {
                            if (navigator.geolocation) {
                              navigator.geolocation.getCurrentPosition(
                                (pos) => {
                                  handleSettingsChange({
                                    startLat: parseFloat(pos.coords.latitude.toFixed(5)),
                                    startLon: parseFloat(pos.coords.longitude.toFixed(5)),
                                  });
                                },
                                (err) => console.warn(err)
                              );
                            }
                          }}
                          style={{ padding: '6px 12px', fontSize: '0.85em' }}
                        >
                          📍 Set Browser GPS as Start
                        </button>
                      </div>
                    </div>

                    {/* Auto-set start location toggle */}
                    <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={settings.autoSetStartOnGps ?? true}
                          onChange={(e) => handleSettingsChange({ autoSetStartOnGps: e.target.checked })}
                          className="checkbox-input"
                        />
                        <span className="checkbox-text" style={{ fontSize: '0.88em' }}>Auto-set Start Coords from first RealtimeIRL GPS signal when starting stream</span>
                      </label>
                    </div>
                  </div>
                ) : (
                  /* Manual Mode Distance Controls */
                  <div className="setting-group" style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '16px', borderRadius: '10px', marginBottom: '16px' }}>
                    <label className="group-label" style={{ marginBottom: '12px', color: '#00ff66', fontWeight: 'bold' }}>⚡ Distance Controls</label>
                    
                    {/* Current & Goal Inputs */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', marginBottom: '16px' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.85em', opacity: 0.8, marginBottom: '6px' }}>Current Distance</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={settings.distanceCurrent ?? 154}
                          onChange={(e) => handleSettingsChange({ distanceCurrent: parseFloat(e.target.value) || 0 })}
                          className="text-input"
                          style={{ width: '100%', fontSize: '1.1em', fontWeight: 'bold' }}
                        />
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.85em', opacity: 0.8, marginBottom: '6px' }}>Goal Distance</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          value={settings.distanceGoal ?? 378}
                          onChange={(e) => handleSettingsChange({ distanceGoal: parseFloat(e.target.value) || 1 })}
                          className="text-input"
                          style={{ width: '100%', fontSize: '1.1em', fontWeight: 'bold' }}
                        />
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.85em', opacity: 0.8, marginBottom: '6px' }}>Distance Unit</label>
                        <select
                          value={settings.distanceUnit || 'mi'}
                          onChange={(e) => handleSettingsChange({ distanceUnit: e.target.value as 'mi' | 'km' | 'm' })}
                          className="text-input"
                          style={{ width: '100%' }}
                        >
                          <option value="mi">Miles (mi)</option>
                          <option value="km">Kilometers (km)</option>
                          <option value="m">Meters (m)</option>
                        </select>
                      </div>
                    </div>

                    {/* Quick Distance Add Buttons */}
                    <div>
                      <label style={{ display: 'block', fontSize: '0.8em', opacity: 0.7, marginBottom: '6px' }}>Quick Add Distance:</label>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {[0.1, 0.5, 1.0, 5.0, 10.0].map((inc) => (
                          <button
                            key={inc}
                            className="btn btn-secondary btn-small"
                            onClick={() => handleSettingsChange({ distanceCurrent: Math.round(((settings.distanceCurrent || 0) + inc) * 10) / 10 })}
                            style={{ padding: '6px 12px', fontWeight: 'bold' }}
                          >
                            +{inc} {settings.distanceUnit || 'mi'}
                          </button>
                        ))}
                        <button
                          className="btn btn-danger btn-small"
                          onClick={() => handleSettingsChange({ distanceCurrent: 0 })}
                          style={{ padding: '6px 12px' }}
                        >
                          Reset to 0
                        </button>
                      </div>
                    </div>

                    {/* Auto GPS Checkbox */}
                    <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={settings.distanceAutoGps ?? false}
                          onChange={(e) => handleSettingsChange({ distanceAutoGps: e.target.checked })}
                          className="checkbox-input"
                        />
                        <span className="checkbox-text" style={{ fontSize: '0.9em' }}>Auto-increment distance from live GPS movement</span>
                      </label>
                    </div>
                  </div>
                )}

                {/* Customization: Title & Icon */}
                <div className="setting-group" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
                  <div>
                    <label className="group-label">Title / Subtitle Label</label>
                    <input
                      type="text"
                      placeholder="Leave blank for no title (e.g. DAY 6/14)"
                      value={settings.distanceTitle || ''}
                      onChange={(e) => handleSettingsChange({ distanceTitle: e.target.value })}
                      className="text-input"
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div>
                    <label className="group-label">Activity Icon</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        placeholder="🛼"
                        value={settings.distanceIcon || ''}
                        onChange={(e) => handleSettingsChange({ distanceIcon: e.target.value })}
                        className="text-input"
                        style={{ width: '60px', textAlign: 'center', fontSize: '1.2em' }}
                      />
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', flex: 1 }}>
                        {['🛼', '🚶', '🏃', '🚲', '🥾', '📍', '🏆'].map((presetIcon) => (
                          <button
                            key={presetIcon}
                            className={`btn btn-small ${settings.distanceIcon === presetIcon ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => handleSettingsChange({ distanceIcon: presetIcon })}
                            style={{ padding: '4px 8px', fontSize: '1.1em' }}
                          >
                            {presetIcon}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Style & Color Theme */}
                <div className="setting-group" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
                  <div>
                    <label className="group-label">Color Accent</label>
                    <select
                      value={settings.distanceColor || 'neon-green'}
                      onChange={(e) => handleSettingsChange({ distanceColor: e.target.value as any })}
                      className="text-input"
                      style={{ width: '100%' }}
                    >
                      <option value="neon-green">🟢 Neon Green (Default)</option>
                      <option value="electric-blue">🔵 Electric Blue</option>
                      <option value="cyber-pink">🩷 Cyber Pink</option>
                      <option value="sunset-orange">🟠 Sunset Orange</option>
                      <option value="gold">🟡 Gold / Trophy</option>
                    </select>
                  </div>

                  <div>
                    <label className="group-label">Visual Style</label>
                    <select
                      value={settings.distanceStyle || 'default'}
                      onChange={(e) => handleSettingsChange({ distanceStyle: e.target.value as any })}
                      className="text-input"
                      style={{ width: '100%' }}
                    >
                      <option value="default">Glass Pill (Standard)</option>
                      <option value="compact">Compact Pill</option>
                      <option value="borderless">Borderless Glass</option>
                      <option value="no-background">No Background (Transparent)</option>
                    </select>
                  </div>

                  <div>
                    <label className="group-label">Font Style</label>
                    <select
                      value={settings.distanceFont || 'default'}
                      onChange={(e) => handleSettingsChange({ distanceFont: e.target.value as any })}
                      className="text-input"
                      style={{ width: '100%' }}
                    >
                      <option value="default">Default Monospace</option>
                      <option value="neon">Playful (Comic)</option>
                      <option value="retro">Retro Arcade Pixel</option>
                      <option value="bold">Bold Thick</option>
                      <option value="impact">Impact Condensed</option>
                    </select>
                  </div>

                  <div>
                    <label className="group-label">Live Location Label</label>
                    <label className="checkbox-label" style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)', borderRadius: '6px', display: 'flex', alignItems: 'center', cursor: 'pointer', height: '42px' }}>
                      <input
                        type="checkbox"
                        checked={settings.distanceShowCurrentLocation ?? true}
                        onChange={(e) => handleSettingsChange({ distanceShowCurrentLocation: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text" style={{ fontSize: '0.85em', color: '#fff' }}>
                        Include Live Current Area
                      </span>
                    </label>
                  </div>
                </div>

                {/* Scale and Position Controls */}
                <div className="setting-group">
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '14px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                    {/* Scale Control */}
                    <div style={{ flex: 1, minWidth: '150px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Scale</label>
                        <span style={{ fontSize: '0.85em', fontWeight: 'bold' }}>{Math.round((settings.distanceScale || 1) * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.5"
                        max="2.0"
                        step="0.05"
                        value={settings.distanceScale || 1}
                        onChange={(e) => handleSettingsChange({ distanceScale: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </div>

                    {/* Position Controls (D-Pad) */}
                    <div style={{ flex: 1, minWidth: '180px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                      <label style={{ fontSize: '0.85em', opacity: 0.8, marginBottom: '2px' }}>
                        Position ({settings.distanceX || 0}, {settings.distanceY || 0})
                      </label>

                      {/* Up Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ distanceY: (settings.distanceY || 0) - 10 })}
                      >
                        ▲
                      </button>

                      {/* Left, Reset, Right */}
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ distanceX: (settings.distanceX || 0) - 10 })}
                        >
                          ◀
                        </button>
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 8px', fontSize: '0.7em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ distanceX: 0, distanceY: 0, distanceScale: 1 })}
                        >
                          Reset
                        </button>
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ distanceX: (settings.distanceX || 0) + 10 })}
                        >
                          ▶
                        </button>
                      </div>

                      {/* Down Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ distanceY: (settings.distanceY || 0) + 10 })}
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
                        onClick={() => handleSettingsChange({ donationGoalsY: (settings.donationGoalsY || 0) - 10 })}
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
                        onClick={() => handleSettingsChange({ donationGoalsY: (settings.donationGoalsY || 0) + 10 })}
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
                            flexWrap: 'wrap',
                            gap: '12px',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px',
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
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                            <button
                              className="btn btn-secondary btn-small"
                              style={{ padding: '4px 8px', fontSize: '0.8em' }}
                              onClick={() => {
                                if (confirm(`Are you sure you want to reset the progress for "${g.name}" to 0?`)) {
                                  const updatedGoals = settings.donationGoals!.map(item =>
                                    item.id === g.id ? { ...item, current: 0 } : item
                                  );
                                  handleSettingsChange({ donationGoals: updatedGoals });
                                }
                              }}
                            >
                              🔄 Reset
                            </button>
                            <button
                              className="btn btn-secondary btn-small"
                              style={{ padding: '4px 8px', fontSize: '0.8em' }}
                              onClick={() => {
                                const newAmountStr = prompt(`Update current progress for "${g.name}":`, g.current.toString());
                                if (newAmountStr !== null) {
                                  const newAmount = parseFloat(newAmountStr);
                                  if (!isNaN(newAmount) && newAmount >= 0) {
                                    const updatedGoals = settings.donationGoals!.map(item =>
                                      item.id === g.id ? { 
                                        ...item, 
                                        current: newAmount,
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
                              className="btn btn-secondary btn-small"
                              style={{ padding: '4px 8px', fontSize: '0.8em' }}
                              onClick={() => {
                                const newDurationStr = prompt(`Update auto-hide timer in minutes for "${g.name}" (0 = Always Show):`, (g.duration || 0).toString());
                                if (newDurationStr !== null) {
                                  const newDuration = parseInt(newDurationStr);
                                  const validDuration = isNaN(newDuration) || newDuration < 0 ? 0 : newDuration;
                                  const updatedGoals = settings.donationGoals!.map(item =>
                                    item.id === g.id ? { 
                                      ...item, 
                                      duration: validDuration,
                                      lastTriggered: validDuration > 0 ? Date.now() : item.lastTriggered
                                    } : item
                                  );
                                  handleSettingsChange({ donationGoals: updatedGoals });
                                }
                              }}
                            >
                              ⏱️ Edit Duration
                            </button>
                            <button
                              className="btn btn-secondary btn-small"
                              onClick={() => {
                                if (confirm(`Are you sure you want to delete the goal "${g.name}"?`)) {
                                  const updatedGoals = settings.donationGoals!.filter(item => item.id !== g.id);
                                  handleSettingsChange({ donationGoals: updatedGoals });
                                }
                              }}
                              style={{ 
                                padding: '4px',
                                width: '28px',
                                height: '28px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '1.1em',
                                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                                color: '#ef4444',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                cursor: 'pointer'
                              }}
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
              <>
                {/* Twitch API Integration */}
                <div className="setting-group" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '16px', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '1.05em', marginBottom: '12px', opacity: 0.9 }}>Twitch API Integration</h3>
                  
                  {settings.twitchToken ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: 'rgba(46, 204, 113, 0.1)', padding: '16px', borderRadius: '8px', border: '1px solid rgba(46, 204, 113, 0.2)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                          <span style={{ fontSize: '1.2em', marginRight: '8px' }}>✅</span>
                          <span style={{ fontWeight: 'bold' }}>Connected to Twitch</span>
                          {settings.twitchUsername && (
                            <div style={{ fontSize: '0.85em', opacity: 0.8, marginTop: '4px', marginLeft: '32px' }}>
                              Logged in as <span style={{ color: '#9146FF', fontWeight: 'bold' }}>{settings.twitchUsername}</span>
                            </div>
                          )}
                        </div>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '8px 16px', fontSize: '0.85em' }}
                          onClick={() => {
                            if (confirm('Are you sure you want to disconnect from Twitch?')) {
                              handleSettingsChange({
                                twitchToken: '',
                                twitchBroadcasterId: '',
                                twitchUsername: ''
                              });
                            }
                          }}
                        >
                          Disconnect
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <p style={{ fontSize: '0.85em', opacity: 0.8, marginBottom: '8px' }}>
                        Connect your Twitch account to automatically sync your live subscriber count.
                      </p>
                      <button
                        className="btn btn-primary"
                        style={{ background: '#9146FF', color: 'white', padding: '12px', fontSize: '1em', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                        onClick={() => {
                          const clientId = 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw';
                          const redirectUri = window.location.origin + '/twitch-auth';
                          const scope = 'channel:read:subscriptions';
                          const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${scope}`;
                          window.location.href = authUrl;
                        }}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
                        </svg>
                        Connect with Twitch
                      </button>
                    </div>
                  )}
                </div>
                
                <div className="settings-grid">
                  <div className="setting-group">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <label style={{ margin: 0 }}>Total Sub Goal:</label>
                    <label className="checkbox-label" style={{ fontSize: '0.85em' }}>
                      <input
                        type="checkbox"
                        checked={settings.showTotalSubGoal ?? true}
                        onChange={(e) => handleSettingsChange({ showTotalSubGoal: e.target.checked })}
                        className="checkbox-input"
                      />
                      Show
                    </label>
                  </div>
                  <input
                    type="number"
                    className="text-input"
                    value={settings.totalSubGoal ?? 100}
                    onChange={(e) => handleSettingsChange({ totalSubGoal: Math.max(1, parseInt(e.target.value) || 100) })}
                  />
                </div>
                 <div className="setting-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ margin: 0 }}>Current Total Subs:</label>
                  </div>
                  <input
                    type="number"
                    className="text-input"
                    value={settings.totalSubCurrent ?? 0}
                    disabled={!!settings.twitchToken}
                    style={{ 
                      opacity: settings.twitchToken ? 0.5 : 1, 
                      cursor: settings.twitchToken ? 'not-allowed' : 'text',
                      backgroundColor: settings.twitchToken ? 'rgba(255,255,255,0.05)' : undefined
                    }}
                    onChange={(e) => handleSettingsChange({ totalSubCurrent: Math.max(0, parseInt(e.target.value) || 0) })}
                  />
                </div>
                <div className="setting-group">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <label style={{ margin: 0 }}>Daily Sub Goal:</label>
                    <label className="checkbox-label" style={{ fontSize: '0.85em' }}>
                      <input
                        type="checkbox"
                        checked={settings.showDailySubGoal ?? true}
                        onChange={(e) => handleSettingsChange({ showDailySubGoal: e.target.checked })}
                        className="checkbox-input"
                      />
                      Show
                    </label>
                  </div>
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
                    disabled={!!settings.twitchToken}
                    style={{ 
                      opacity: settings.twitchToken ? 0.5 : 1, 
                      cursor: settings.twitchToken ? 'not-allowed' : 'text',
                      backgroundColor: settings.twitchToken ? 'rgba(255,255,255,0.05)' : undefined
                    }}
                    onChange={(e) => handleSettingsChange({ dailySubCurrent: Math.max(0, parseInt(e.target.value) || 0) })}
                  />
                </div>
              </div>
              
              {/* Scale & Position Controls */}
              <div className="setting-group" style={{ marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                <h3 style={{ fontSize: '1.05em', marginBottom: '12px', opacity: 0.9 }}>Layout & Scale</h3>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                  {/* Style Control */}
                  <div style={{ flex: 1, minWidth: '150px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Display Style</label>
                    </div>
                    <select
                      value={settings.subGoalsStyle || 'default'}
                      onChange={(e) => handleSettingsChange({ subGoalsStyle: e.target.value as any })}
                      className="text-input"
                      style={{ width: '100%', padding: '8px 10px', fontSize: '0.9em', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: '#fff' }}
                    >
                      <option value="default" style={{ background: '#1a1a1a', color: '#fff' }}>Show Bars & Background</option>
                      <option value="no-bars" style={{ background: '#1a1a1a', color: '#fff' }}>Hide Bars (Background Only)</option>
                      <option value="no-background" style={{ background: '#1a1a1a', color: '#fff' }}>Hide Background (Bars Only)</option>
                      <option value="text-only" style={{ background: '#1a1a1a', color: '#fff' }}>Text Only (Hide Bars & Background)</option>
                    </select>
                  </div>

                  {/* Font Control */}
                  <div style={{ flex: 1, minWidth: '150px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Font Style</label>
                    </div>
                    <select
                      value={settings.subGoalsFont || 'default'}
                      onChange={(e) => handleSettingsChange({ subGoalsFont: e.target.value as any })}
                      className="text-input"
                      style={{ width: '100%', padding: '8px 10px', fontSize: '0.9em', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: '#fff' }}
                    >
                      <option value="default" style={{ background: '#1a1a1a', color: '#fff' }}>Default Font</option>
                      <option value="neon" style={{ background: '#1a1a1a', color: '#fff', fontFamily: '"Comic Sans MS", cursive, sans-serif' }}>Playful (Comic)</option>
                      <option value="retro" style={{ background: '#1a1a1a', color: '#fff', fontFamily: '"Courier New", Courier, monospace' }}>Retro (Monospace)</option>
                      <option value="bold" style={{ background: '#1a1a1a', color: '#fff', fontWeight: 'bold' }}>Bold (Thick)</option>
                      <option value="impact" style={{ background: '#1a1a1a', color: '#fff', fontFamily: 'Impact, sans-serif' }}>Impact (Condensed)</option>
                    </select>
                  </div>

                  {/* Text Stroke Control */}
                  <div style={{ flex: 1, minWidth: '150px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Text Outline</label>
                    </div>
                    <label className="checkbox-label" style={{ padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '4px', display: 'flex', alignItems: 'center', cursor: 'pointer', height: '36px' }}>
                      <input
                        type="checkbox"
                        checked={settings.subGoalsShowStroke ?? true}
                        onChange={(e) => handleSettingsChange({ subGoalsShowStroke: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text" style={{ fontSize: '0.9em', color: '#fff' }}>Drop Shadow</span>
                    </label>
                  </div>

                  {/* Scale Control */}
                  <div style={{ flex: 1, minWidth: '150px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Overlay Scale</label>
                      <span style={{ fontSize: '0.85em' }}>{Math.round((settings.subGoalsScale || 1) * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.3"
                      max="3.0"
                      step="0.1"
                      value={settings.subGoalsScale || 1}
                      onChange={(e) => handleSettingsChange({ subGoalsScale: parseFloat(e.target.value) })}
                      style={{ width: '100%' }}
                    />
                  </div>

                  {/* Position Controls (D-Pad) */}
                  <div style={{ flex: 1, minWidth: '180px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                    <label style={{ fontSize: '0.85em', opacity: 0.8, marginBottom: '2px' }}>Position ({settings.subGoalsX || 0}, {settings.subGoalsY || 0})</label>
                    
                    {/* Up Button */}
                    <button
                      className="btn btn-secondary btn-small"
                      style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                      onClick={() => handleSettingsChange({ subGoalsY: (settings.subGoalsY || 0) - 10 })}
                    >
                      ▲
                    </button>

                    {/* Left, Reset, Right */}
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ subGoalsX: (settings.subGoalsX || 0) - 10 })}
                      >
                        ◀
                      </button>
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 8px', fontSize: '0.7em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ subGoalsX: 0, subGoalsY: 0 })}
                      >
                        Reset
                      </button>
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ subGoalsX: (settings.subGoalsX || 0) + 10 })}
                      >
                        ▶
                      </button>
                    </div>

                    {/* Down Button */}
                    <button
                      className="btn btn-secondary btn-small"
                      style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                      onClick={() => handleSettingsChange({ subGoalsY: (settings.subGoalsY || 0) + 10 })}
                    >
                      ▼
                    </button>
                  </div>
                </div>
              </div>
            </>
            )}
          </section>

          {/* Bitrate Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>📡 Bitrate & Network</h2>
            </div>

            <div className="setting-group" style={{ marginBottom: '24px' }}>
              <label className="group-label">Belabox Publisher Key</label>
              <input
                type="password"
                placeholder="Enter your publisher key"
                className="text-input"
                value={settings.belaboxPublisherKey || ''}
                onChange={(e) => handleSettingsChange({ belaboxPublisherKey: e.target.value })}
                style={{ width: '100%' }}
              />
              <div style={{ fontSize: '0.8em', opacity: 0.7, marginTop: '8px' }}>
                Automatically fetches from https://stats.srt.belabox.net
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
              <div style={{ marginTop: '12px', marginBottom: '12px' }}>
              <label className="group-label">Low Bitrate Text Style / Font</label>
              <RadioGroup
                value={settings.lowBitrateAlertFont || 'default'}
                onChange={(value) => handleSettingsChange({ lowBitrateAlertFont: value as any })}
                options={[
                  { value: 'disabled', label: 'Disabled', icon: '❌', description: 'Do not show text popup' },
                  { value: 'basic', label: 'Basic Text', icon: '📝', description: 'Simple white text, no background' },
                  { value: 'default', label: 'Default Pill', icon: '💊', description: 'Bold red/yellow warning pill' },
                  { value: 'neon', label: 'Neon Cyberpunk', icon: '💻', description: 'Glowy cyan cyberpunk theme' },
                  { value: 'retro', label: 'Retro Arcade', icon: '🕹️', description: '1980s monospaced pixel style' },
                  { value: 'bold', label: 'Bold Striped', icon: '🚧', description: 'Heavy warning stripes style' },
                  { value: 'impact', label: 'Comic Impact', icon: '💥', description: 'Playful comic impact style' }
                ]}
              />
            </div>

              {/* Threshold Controls */}
              {settings.lowBitrateAlertFont !== 'disabled' && (
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
            )}

            {/* Scale and Position Controls (only show when alert is enabled) */}
            {settings.lowBitrateAlertFont !== 'disabled' && (
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
                Requires the Belabox Publisher Key to be set in the Bitrate section.
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
              <label className="group-label">List Header / Title (Optional)</label>
              <input
                type="text"
                placeholder="Leave blank for no title (e.g. TODAY'S TASKS)"
                value={settings.todoTitle || ''}
                onChange={(e) => handleSettingsChange({ todoTitle: e.target.value })}
                className="text-input"
                style={{ width: '100%' }}
              />
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

            {/* To-Do List Scale & Position Controls */}
            <div className="setting-group">
              <label className="group-label">Scale & Position Fine-Tuning</label>
              <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '14px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                {/* Scale Control */}
                <div style={{ flex: 1, minWidth: '150px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Scale</label>
                    <span style={{ fontSize: '0.85em', fontWeight: 'bold' }}>{Math.round((settings.todoScale || 1) * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.05"
                    value={settings.todoScale || 1}
                    onChange={(e) => handleSettingsChange({ todoScale: parseFloat(e.target.value) })}
                    style={{ width: '100%' }}
                  />
                </div>

                {/* Position Controls (D-Pad) */}
                <div style={{ flex: 1, minWidth: '180px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                  <label style={{ fontSize: '0.85em', opacity: 0.8, marginBottom: '2px' }}>
                    Position Offset ({settings.todoX || 0}, {settings.todoY || 0})
                  </label>

                  {/* Up Button */}
                  <button
                    className="btn btn-secondary btn-small"
                    style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                    onClick={() => handleSettingsChange({ todoY: (settings.todoY || 0) + 10 })}
                  >
                    ▲
                  </button>

                  {/* Left, Reset, Right */}
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      className="btn btn-secondary btn-small"
                      style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                      onClick={() => handleSettingsChange({ todoX: (settings.todoX || 0) - 10 })}
                    >
                      ◀
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      style={{ padding: '2px 8px', fontSize: '0.7em', lineHeight: 1 }}
                      onClick={() => handleSettingsChange({ todoX: 0, todoY: 0, todoScale: 1 })}
                    >
                      Reset
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                      onClick={() => handleSettingsChange({ todoX: (settings.todoX || 0) + 10 })}
                    >
                      ▶
                    </button>
                  </div>

                  {/* Down Button */}
                  <button
                    className="btn btn-secondary btn-small"
                    style={{ padding: '2px 10px', fontSize: '1.2em', lineHeight: 1 }}
                    onClick={() => handleSettingsChange({ todoY: (settings.todoY || 0) - 10 })}
                  >
                    ▼
                  </button>
                </div>
              </div>
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
                  <label className="group-label" style={{ marginBottom: '12px' }}>Global Social Username</label>
                  <input
                    type="text"
                    placeholder="Enter your username (e.g. NICKLEE)"
                    value={settings.socialName || ''}
                    onChange={(e) => handleSettingsChange({ socialName: e.target.value })}
                    style={{ width: '100%', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff', marginBottom: '20px', fontSize: '1.1em' }}
                  />

                  <label className="group-label" style={{ marginBottom: '12px' }}>Enable Platforms</label>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px' }}>
                    {/* Kick */}
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.socialKickEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialKickEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">Kick</span>
                    </label>

                    {/* Twitch */}
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.socialTwitchEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialTwitchEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">Twitch</span>
                    </label>

                    {/* YouTube */}
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.socialYoutubeEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialYoutubeEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">YouTube</span>
                    </label>

                    {/* Instagram */}
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.socialInstagramEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialInstagramEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">Instagram</span>
                    </label>

                    {/* TikTok */}
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.socialTiktokEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialTiktokEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">TikTok</span>
                    </label>

                    {/* X / Twitter */}
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.socialXEnabled ?? false}
                        onChange={(e) => handleSettingsChange({ socialXEnabled: e.target.checked })}
                        className="checkbox-input"
                      />
                      <span className="checkbox-text">X / Twitter</span>
                    </label>
                  </div>
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

                {/* Font Family */}
                <div className="setting-group" style={{ marginTop: '16px' }}>
                  <label className="group-label">Font Family</label>
                  <RadioGroup
                    value={settings.socialFontFamily || 'Impact'}
                    onChange={(value) => handleSettingsChange({ socialFontFamily: value as string })}
                    options={[
                      { value: 'Impact', label: 'Impact (Default Kick)', icon: 'Aa' },
                      { value: 'var(--font-anton)', label: 'Anton (Heavy Block)', icon: 'Aa' },
                      { value: 'var(--font-bebas)', label: 'Bebas Neue (Tall/Clean)', icon: 'Aa' },
                      { value: 'var(--font-oswald)', label: 'Oswald (Structured)', icon: 'Aa' },
                      { value: 'var(--font-russo)', label: 'Russo One (Tech/Wide)', icon: 'Aa' },
                      { value: 'var(--font-righteous)', label: 'Righteous (Modern/Round)', icon: 'Aa' },
                      { value: 'var(--font-marker)', label: 'Permanent Marker (Handwritten)', icon: 'Aa' },
                      { value: 'var(--font-bangers)', label: 'Bangers (Comic Book)', icon: 'Aa' }
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
                        { value: 'bottom-middle', label: 'Bottom Middle', icon: '⬇️' }
                      ]}
                    />
                  </div>
                  <div className="setting-group" style={{ flex: 1, minWidth: '200px' }}>
                    <label className="group-label">Offset Position ({settings.socialX || 0}, {settings.socialY || 0})</label>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                      {/* Up Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 12px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ socialY: (settings.socialY || 0) + 10 })}
                      >
                        ▲
                      </button>

                      <div style={{ display: 'flex', gap: '8px' }}>
                        {/* Left Button */}
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 12px', fontSize: '1.2em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ socialX: (settings.socialX || 0) - 10 })}
                        >
                          ◀
                        </button>

                        {/* Reset Button */}
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 8px', fontSize: '0.8em', fontWeight: 'bold' }}
                          onClick={() => handleSettingsChange({ socialX: 0, socialY: 0 })}
                        >
                          Reset
                        </button>

                        {/* Right Button */}
                        <button
                          className="btn btn-secondary btn-small"
                          style={{ padding: '2px 12px', fontSize: '1.2em', lineHeight: 1 }}
                          onClick={() => handleSettingsChange({ socialX: (settings.socialX || 0) + 10 })}
                        >
                          ▶
                        </button>
                      </div>

                      {/* Down Button */}
                      <button
                        className="btn btn-secondary btn-small"
                        style={{ padding: '2px 12px', fontSize: '1.2em', lineHeight: 1 }}
                        onClick={() => handleSettingsChange({ socialY: (settings.socialY || 0) - 10 })}
                      >
                        ▼
                      </button>
                    </div>
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
                
                {/* Scale */}
                <div style={{ marginTop: '16px', maxWidth: '300px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <label style={{ fontSize: '0.85em', opacity: 0.8 }}>Scale</label>
                    <span style={{ fontSize: '0.85em' }}>{Math.round((settings.socialScale || 1) * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.1"
                    className="range-slider"
                    value={settings.socialScale || 1}
                    onChange={(e) => handleSettingsChange({ socialScale: parseFloat(e.target.value) })}
                    style={{ width: '100%' }}
                  />
                </div>
                {/* Animation Loop */}
                <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
                  <label className="checkbox-label" style={{ marginBottom: '12px' }}>
                    <input
                      type="checkbox"
                      checked={settings.socialLoopAnimation ?? false}
                      onChange={(e) => handleSettingsChange({ socialLoopAnimation: e.target.checked })}
                      className="checkbox-input"
                    />
                    <span className="checkbox-text">Enable Show/Hide Animation Loop</span>
                  </label>

                  {settings.socialLoopAnimation && (
                    <div style={{ display: 'flex', gap: '16px', marginTop: '12px' }}>
                      <div style={{ flex: 1 }}>
                        <label className="group-label" style={{ fontSize: '0.85em', opacity: 0.8 }}>Show Duration (mins)</label>
                        <input
                          type="number"
                          className="text-input"
                          min="1"
                          value={settings.socialLoopShowDuration ?? 15}
                          onChange={(e) => handleSettingsChange({ socialLoopShowDuration: Math.max(1, parseInt(e.target.value) || 15) })}
                          style={{ marginTop: '4px' }}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label className="group-label" style={{ fontSize: '0.85em', opacity: 0.8 }}>Hide Duration (mins)</label>
                        <input
                          type="number"
                          className="text-input"
                          min="1"
                          value={settings.socialLoopHideDuration ?? 15}
                          onChange={(e) => handleSettingsChange({ socialLoopHideDuration: Math.max(1, parseInt(e.target.value) || 15) })}
                          style={{ marginTop: '4px' }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>

          {/* URL List Section */}
          <section className="settings-section">
            <div className="section-header">
              <h2>🔗 URLs</h2>
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