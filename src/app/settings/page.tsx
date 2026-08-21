"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authenticatedFetch } from '@/lib/client-auth';
import { OverlaySettings, DEFAULT_OVERLAY_SETTINGS } from '@/types/settings';
import { API_KEYS } from '@/utils/overlay-constants';
import '@/styles/admin.css';

export default function SettingsConfigPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULT_OVERLAY_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [toast, setToast] = useState<{ type: 'saving' | 'saved' | 'error'; message: string } | null>(null);
  const [syncStatus, setSyncStatus] = useState<'connected' | 'disconnected' | 'syncing'>('disconnected');
  const [isTestingPicWebhook, setIsTestingPicWebhook] = useState(false);
  const [picTestStatus, setPicTestStatus] = useState<{ success?: boolean; message?: string } | null>(null);
  const [isCheckingSeToken, setIsCheckingSeToken] = useState(false);
  const [seTokenStatus, setSeTokenStatus] = useState<{ success?: boolean; message?: string } | null>(null);
  const [isNavigatingToDashboard, setIsNavigatingToDashboard] = useState(false);

  const handleGoToDashboard = (e: React.MouseEvent) => {
    e.preventDefault();
    if (isNavigatingToDashboard) return;
    setIsNavigatingToDashboard(true);
    setTimeout(() => {
      router.push('/');
    }, 280);
  };

  // Debounce save ref
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const latestMergedSettingsRef = useRef<OverlaySettings | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Check authentication on load
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const res = await authenticatedFetch('/api/refresh-session', {
          method: 'POST',
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            setIsAuthenticated(true);
          } else {
            router.push('/login');
          }
        } else {
          router.push('/login');
        }
      } catch (err) {
        console.error('Settings auth check error:', err);
        router.push('/login');
      }
    };
    checkAuth();
  }, [router]);

  // Load existing settings with auto-key detection
  const loadSettings = useCallback(async () => {
    try {
      setSyncStatus('syncing');
      const res = await authenticatedFetch('/api/get-settings');
      if (!res.ok) {
        if (res.status === 401) {
          router.push('/login');
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data) {
        // Auto-populate any keys that are blank from environment variables
        const populatedData: OverlaySettings = {
          ...DEFAULT_OVERLAY_SETTINGS,
          ...data,
          rtirlPullKey: data.rtirlPullKey || API_KEYS.RTIRL || '',
          locationIqKey: data.locationIqKey || API_KEYS.LOCATIONIQ || '',
          openWeatherKey: data.openWeatherKey || API_KEYS.OPENWEATHER || '',
          pulsoidToken: data.pulsoidToken || API_KEYS.PULSOID || '',
          twitchClientId: data.twitchClientId || API_KEYS.TWITCH_CLIENT_ID || 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw',
        };

        // If newly detected keys were added, auto-save to cloud
        const hadMissingKeys = !data.rtirlPullKey && !!API_KEYS.RTIRL ||
          !data.locationIqKey && !!API_KEYS.LOCATIONIQ ||
          !data.openWeatherKey && !!API_KEYS.OPENWEATHER ||
          !data.pulsoidToken && !!API_KEYS.PULSOID;

        setSettings(populatedData);
        setSyncStatus('connected');

        if (hadMissingKeys) {
          authenticatedFetch('/api/save-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(populatedData),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
      setSyncStatus('disconnected');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (isAuthenticated) {
      loadSettings();
    }
  }, [isAuthenticated, loadSettings]);

  // Auto-fill all keys action
  const autoPopulateAllKeys = () => {
    const populated = {
      rtirlPullKey: settings.rtirlPullKey || API_KEYS.RTIRL || '',
      locationIqKey: settings.locationIqKey || API_KEYS.LOCATIONIQ || '',
      openWeatherKey: settings.openWeatherKey || API_KEYS.OPENWEATHER || '',
      pulsoidToken: settings.pulsoidToken || API_KEYS.PULSOID || '',
      twitchClientId: settings.twitchClientId || API_KEYS.TWITCH_CLIENT_ID || 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw',
    };
    handleSettingsChange(populated);
    setToast({ type: 'saved', message: '⚡ API Keys auto-populated & saved from environment!' });
    setTimeout(() => setToast(null), 3000);
  };

  // Auto-save handler
  const handleSettingsChange = useCallback(async (updates: Partial<OverlaySettings>) => {
    const mergedSettings = { ...settings, ...updates };
    setSettings(mergedSettings);
    latestMergedSettingsRef.current = mergedSettings;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    const executeSave = async () => {
      const settingsToSave = latestMergedSettingsRef.current || mergedSettings;
      setToast({ type: 'saving', message: 'Saving config settings...' });
      setSyncStatus('syncing');

      try {
        const res = await authenticatedFetch('/api/save-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settingsToSave),
        });

        if (!res.ok) {
          if (res.status === 401) {
            setToast({ type: 'error', message: 'Session expired. Redirecting to login...' });
            setTimeout(() => router.push('/login'), 1500);
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }

        if (typeof window !== 'undefined') {
          localStorage.setItem('overlay_settings_backup', JSON.stringify(settingsToSave));
        }
        setToast({ type: 'saved', message: 'Config settings auto-saved!' });
        setSyncStatus('connected');
        setTimeout(() => setToast(null), 2000);
      } catch (error) {
        console.error('Save settings error:', error);
        setToast({ type: 'error', message: `Failed to save: ${error instanceof Error ? error.message : 'Unknown error'}` });
        setSyncStatus('disconnected');
        setTimeout(() => setToast(null), 5000);
      }
    };

    const isInstantSaveKey = updates.obsStreamCommandsEnabled !== undefined || updates.obsTelemetryEnabled !== undefined || updates.obsTelemetryInterval !== undefined || updates.picCommandEnabled !== undefined || updates.picShowOnOverlay !== undefined;

    if (isInstantSaveKey) {
      executeSave();
    } else {
      saveTimeoutRef.current = setTimeout(executeSave, mergedSettings.saveDebounceDelay || 300);
    }
  }, [settings, router]);

  // Test Discord Pic Webhook
  const handleTestPicWebhook = async () => {
    if (!settings.discordPicWebhookUrl) {
      setPicTestStatus({ success: false, message: 'Please enter a Discord Webhook URL first.' });
      return;
    }
    setIsTestingPicWebhook(true);
    setPicTestStatus(null);
    try {
      const res = await fetch('/api/pic-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'test',
          webhookUrl: settings.discordPicWebhookUrl,
          pointsCost: settings.picPointsCost ?? 200
        })
      });
      const data = await res.json();
      if (data.success) {
        setPicTestStatus({ success: true, message: '✅ Test snapshot card posted to Discord successfully!' });
      } else {
        setPicTestStatus({ success: false, message: `❌ Discord test failed: ${data.error || 'Check webhook URL'}` });
      }
    } catch (err: any) {
      setPicTestStatus({ success: false, message: `❌ Test error: ${err.message}` });
    } finally {
      setIsTestingPicWebhook(false);
    }
  };

  // Verify StreamElements Token
  const handleCheckSeToken = async () => {
    if (!settings.streamElementsToken) {
      setSeTokenStatus({ success: false, message: 'Please enter a StreamElements JWT token first.' });
      return;
    }
    setIsCheckingSeToken(true);
    setSeTokenStatus(null);
    try {
      const res = await fetch('/api/pic-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_se_token',
          seToken: settings.streamElementsToken
        })
      });
      const data = await res.json();
      if (data.success) {
        setSeTokenStatus({
          success: true,
          message: `✅ Connected to StreamElements channel: "${data.username || data.displayName}" (ID: ${data.channelId})`
        });
      } else {
        setSeTokenStatus({
          success: false,
          message: `❌ ${data.error || 'Token check failed'}`
        });
      }
    } catch (err: any) {
      setSeTokenStatus({ success: false, message: `❌ Error checking token: ${err.message}` });
    } finally {
      setIsCheckingSeToken(false);
    }
  };

  // Export JSON
  const exportSettingsJson = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(settings, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `overlay-config-${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    setToast({ type: 'saved', message: 'Config exported successfully!' });
    setTimeout(() => setToast(null), 2000);
  };

  // Import JSON
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileReader = new FileReader();
    if (e.target.files && e.target.files[0]) {
      fileReader.readAsText(e.target.files[0], "UTF-8");
      fileReader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target?.result as string);
          if (parsed && typeof parsed === 'object') {
            handleSettingsChange(parsed);
            setToast({ type: 'saved', message: 'Config imported and saved successfully!' });
            setTimeout(() => setToast(null), 3000);
          }
        } catch {
          setToast({ type: 'error', message: 'Invalid JSON file format.' });
          setTimeout(() => setToast(null), 4000);
        }
      };
    }
  };

  // Reset to Defaults
  const resetToDefaults = () => {
    if (confirm('Are you sure you want to reset all intervals, timers, and config settings to factory defaults?')) {
      handleSettingsChange(DEFAULT_OVERLAY_SETTINGS);
      setToast({ type: 'saved', message: 'Settings reset to factory defaults!' });
      setTimeout(() => setToast(null), 3000);
    }
  };

  if (!isAuthenticated || isLoading) {
    return (
      <div className="admin-page">
        <div className="loading-screen">
          <div className="loading-content">
            <div className="loading-icon">⚙️</div>
            <div className="loading-text">Loading Configuration Settings...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page page-enter-animation">
      {/* Cool Portal Transition Overlay to Dashboard */}
      {isNavigatingToDashboard && (
        <div className="page-transition-portal">
          <div className="portal-laser-bar" />
          <div className="portal-content-loader">
            <span className="portal-gear-large" style={{ animationDirection: 'reverse' }}>🎛️</span>
            <div className="portal-text">Opening Dashboard...</div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="header-title">
            <span className="title-icon">⚙️</span>
            <h1>Config & Intervals Settings</h1>
            <div className={`sync-status ${syncStatus}`} title={`Database: ${syncStatus}`}>
              {syncStatus === 'connected' && '🟢 Auto-saved'}
              {syncStatus === 'syncing' && '🟡 Saving...'}
              {syncStatus === 'disconnected' && '🔴 Offline'}
            </div>
          </div>
          <div className="header-actions">
            <button
              onClick={handleGoToDashboard}
              className={`btn btn-secondary ${isNavigatingToDashboard ? 'btn-settings-nav navigating' : ''}`}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 'bold', cursor: 'pointer' }}
            >
              ← Dashboard
            </button>
            <button className="btn btn-primary" onClick={() => window.open('/overlay', '_blank')}>
              👁️ Preview
            </button>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                try {
                  await fetch('/api/logout', { method: 'GET', credentials: 'include' });
                  router.push('/login');
                } catch {
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

      {/* Main Container */}
      <main className="main-content">
        <div className="settings-container" style={{ maxWidth: '1000px', margin: '0 auto' }}>

          <div style={{
            padding: '16px 20px',
            marginBottom: '24px',
            background: 'rgba(59, 130, 246, 0.08)',
            border: '1px solid rgba(59, 130, 246, 0.25)',
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px'
          }}>
            <div>
              <h3 style={{ margin: '0 0 4px 0', fontSize: '1.05em', color: '#60a5fa' }}>💡 Real-time Auto-Save</h3>
              <p style={{ margin: 0, fontSize: '0.85em', opacity: 0.8 }}>
                Any setting or API key you modify here is instantly auto-saved to the cloud database and synced to your active overlay without needing to edit config files or restart OBS.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn btn-secondary btn-small" onClick={exportSettingsJson} title="Export current settings to JSON">
                📥 Export JSON
              </button>
              <button className="btn btn-secondary btn-small" onClick={() => fileInputRef.current?.click()} title="Import settings from JSON">
                📤 Import JSON
              </button>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                accept=".json"
                onChange={handleFileUpload}
              />
              <button className="btn btn-danger btn-small" onClick={resetToDefaults} style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#fca5a5' }}>
                🔄 Reset Defaults
              </button>
            </div>
          </div>

          {/* Section 1: Save & Debounce Timers */}
          <section className="settings-section">
            <div className="section-header" style={{ marginBottom: '1.25rem', paddingBottom: '0.875rem', borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <h2>💾 Auto-Save & Debounce Timings</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
              
              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Auto-Save Debounce Delay: <span style={{ color: '#60a5fa' }}>{settings.saveDebounceDelay ?? 300} ms</span>
                </label>
                <input
                  type="range"
                  min="50"
                  max="2000"
                  step="50"
                  value={settings.saveDebounceDelay ?? 300}
                  onChange={(e) => handleSettingsChange({ saveDebounceDelay: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  How long to wait after typing before automatically committing changes to the cloud. (Default: 300ms)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Custom Location Typing Debounce: <span style={{ color: '#60a5fa' }}>{settings.customLocationDebounceDelay ?? 1000} ms</span>
                </label>
                <input
                  type="range"
                  min="300"
                  max="4000"
                  step="100"
                  value={settings.customLocationDebounceDelay ?? 1000}
                  onChange={(e) => handleSettingsChange({ customLocationDebounceDelay: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Delay before auto-saving custom location text inputs. (Default: 1000ms)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Settings SSE Fallback Polling: <span style={{ color: '#60a5fa' }}>{settings.settingsPollingInterval ?? 30} seconds</span>
                </label>
                <input
                  type="range"
                  min="5"
                  max="120"
                  step="5"
                  value={settings.settingsPollingInterval ?? 30}
                  onChange={(e) => handleSettingsChange({ settingsPollingInterval: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Backup polling frequency if the real-time Server-Sent Events stream temporarily disconnects. (Default: 30s)
                </span>
              </div>

            </div>
          </section>

          {/* Section 2: Data & API Polling Intervals */}
          <section className="settings-section">
            <div className="section-header" style={{ marginBottom: '1.25rem', paddingBottom: '0.875rem', borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <h2>⏱️ API Polling & Refresh Rates</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
              
              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Twitch Subscriptions Sync Interval: <span style={{ color: '#a855f7' }}>{settings.twitchSyncInterval ?? 60} seconds</span>
                </label>
                <input
                  type="range"
                  min="15"
                  max="300"
                  step="15"
                  value={settings.twitchSyncInterval ?? 60}
                  onChange={(e) => handleSettingsChange({ twitchSyncInterval: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  How often overlay queries Twitch Helix API for latest sub points. (Default: 60s)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Weather Update Interval: <span style={{ color: '#38bdf8' }}>{settings.weatherUpdateInterval ?? 5} minutes</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="30"
                  step="1"
                  value={settings.weatherUpdateInterval ?? 5}
                  onChange={(e) => handleSettingsChange({ weatherUpdateInterval: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  How often live weather & temperature are refreshed from OpenWeatherMap. (Default: 5 min)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Belabox Bitrate Poll Interval: <span style={{ color: '#4ade80' }}>{settings.bitrateUpdateInterval ?? 10} seconds</span>
                </label>
                <input
                  type="range"
                  min="2"
                  max="60"
                  step="2"
                  value={settings.bitrateUpdateInterval ?? 10}
                  onChange={(e) => handleSettingsChange({ bitrateUpdateInterval: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Polling interval for fetching SRT bitrate stats from Belabox server. (Default: 10s)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  OBS Auto-Switch Polling Interval: <span style={{ color: '#fb923c' }}>{settings.autoSwitchPollInterval ?? 10} seconds</span>
                </label>
                <input
                  type="range"
                  min="3"
                  max="60"
                  step="1"
                  value={settings.autoSwitchPollInterval ?? 10}
                  onChange={(e) => handleSettingsChange({ autoSwitchPollInterval: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Interval for checking bitrate health to trigger automatic OBS scene switching. (Default: 10s)
                </span>
              </div>

              <div className="setting-group" style={{ gridColumn: '1 / -1', padding: '14px 18px', background: 'rgba(83, 252, 25, 0.05)', border: '1px solid rgba(83, 252, 25, 0.25)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                  <label className="input-label" style={{ margin: 0, fontWeight: 'bold', color: '#53FC19', fontSize: '0.95em' }}>
                    ⚡ OBS Stream Commands (!start, !end & !refresh)
                  </label>
                  <span style={{ fontSize: '0.78em', opacity: 0.7, display: 'block', marginTop: '2px' }}>
                    Allow remote chat & cloud signals to trigger broadcast start, stop, or refresh scene cycles.
                  </span>
                </div>
                <label style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={settings.obsStreamCommandsEnabled ?? true}
                    onChange={(e) => handleSettingsChange({ obsStreamCommandsEnabled: e.target.checked })}
                    style={{ cursor: 'pointer', width: '18px', height: '18px', accentColor: '#53FC19' }}
                  />
                  <span style={{ fontSize: '0.85em', color: (settings.obsStreamCommandsEnabled ?? true) ? '#53FC19' : '#ef4444', fontWeight: 'bold' }}>
                    {(settings.obsStreamCommandsEnabled ?? true) ? 'ENABLED' : 'DISABLED'}
                  </span>
                </label>
              </div>

              <div className="setting-group" style={{ gridColumn: '1 / -1', padding: '14px 18px', background: 'rgba(56, 189, 248, 0.05)', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ maxWidth: '100%' }}>
                  <label className="input-label" style={{ margin: 0, fontWeight: 'bold', color: '#38bdf8', fontSize: '0.95em' }}>
                    📊 OBS Remote Health Telemetry (Dropped Frames, CPU, FPS)
                  </label>
                  <span style={{ fontSize: '0.78em', opacity: 0.7, display: 'block', marginTop: '2px' }}>
                    Sync live OBS health metrics to your remote Admin Dashboard. Turn OFF for zero background telemetry requests.
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', maxWidth: '100%' }}>
                  {settings.obsTelemetryEnabled && (
                    <select
                      className="text-input"
                      value={settings.obsTelemetryInterval || 45}
                      onChange={(e) => handleSettingsChange({ obsTelemetryInterval: parseInt(e.target.value, 10) || 45 })}
                      style={{ padding: '4px 8px', fontSize: '0.8em', width: 'auto', maxWidth: '100%' }}
                      title="Select Telemetry Sync Interval"
                    >
                      <option value={15}>⚡ Fast (15s)</option>
                      <option value={30}>⏱️ Normal (30s)</option>
                      <option value={45}>🍃 Eco (45s - Recommended)</option>
                      <option value={60}>💤 Low Data (60s)</option>
                    </select>
                  )}
                  <label style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={settings.obsTelemetryEnabled || false}
                      onChange={(e) => handleSettingsChange({ obsTelemetryEnabled: e.target.checked })}
                      style={{ cursor: 'pointer', width: '18px', height: '18px', accentColor: '#38bdf8', flexShrink: 0 }}
                    />
                    <span style={{ fontSize: '0.85em', color: settings.obsTelemetryEnabled ? '#38bdf8' : 'rgba(255,255,255,0.4)', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                      {settings.obsTelemetryEnabled ? 'ENABLED' : 'DISABLED'}
                    </span>
                  </label>
                </div>
              </div>

            </div>
          </section>

          {/* Section 3: GPS & Minimap Timers */}
          <section className="settings-section">
            <div className="section-header" style={{ marginBottom: '1.25rem', paddingBottom: '0.875rem', borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <h2>🗺️ GPS, Minimap & Speed Timers</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
              
              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Map Refresh - Walking / Slow (&lt;10 km/h): <span style={{ color: '#60a5fa' }}>{settings.mapMinIntervalSlow ?? 20}s</span>
                </label>
                <input
                  type="range"
                  min="5"
                  max="60"
                  step="5"
                  value={settings.mapMinIntervalSlow ?? 20}
                  onChange={(e) => handleSettingsChange({ mapMinIntervalSlow: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Map Refresh - Driving / Medium (10–50 km/h): <span style={{ color: '#60a5fa' }}>{settings.mapMinIntervalMed ?? 10}s</span>
                </label>
                <input
                  type="range"
                  min="3"
                  max="30"
                  step="1"
                  value={settings.mapMinIntervalMed ?? 10}
                  onChange={(e) => handleSettingsChange({ mapMinIntervalMed: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Map Refresh - Fast (&gt;50 km/h): <span style={{ color: '#60a5fa' }}>{settings.mapMinIntervalFast ?? 6}s</span>
                </label>
                <input
                  type="range"
                  min="2"
                  max="20"
                  step="1"
                  value={settings.mapMinIntervalFast ?? 6}
                  onChange={(e) => handleSettingsChange({ mapMinIntervalFast: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  GPS Stale Timeout: <span style={{ color: '#f87171' }}>{settings.gpsStaleTimeout ?? 10} seconds</span>
                </label>
                <input
                  type="range"
                  min="3"
                  max="60"
                  step="1"
                  value={settings.gpsStaleTimeout ?? 10}
                  onChange={(e) => handleSettingsChange({ gpsStaleTimeout: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Time without a GPS packet before position is marked stale. (Default: 10s)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Minimap Hide Delay on Stop: <span style={{ color: '#fbbf24' }}>{settings.minimapHideDelay ?? 10} seconds</span>
                </label>
                <input
                  type="range"
                  min="3"
                  max="60"
                  step="1"
                  value={settings.minimapHideDelay ?? 10}
                  onChange={(e) => handleSettingsChange({ minimapHideDelay: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Delay before speed-based minimap fades out after stopping. (Default: 10s)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Speed Indicator Hide Delay: <span style={{ color: '#fbbf24' }}>{settings.speedHideDelay ?? 10} seconds</span>
                </label>
                <input
                  type="range"
                  min="3"
                  max="60"
                  step="1"
                  value={settings.speedHideDelay ?? 10}
                  onChange={(e) => handleSettingsChange({ speedHideDelay: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Delay before speed indicator fades out after stopping. (Default: 10s)
                </span>
              </div>

            </div>
          </section>

          {/* Section 4: Display & Rotator Timings */}
          <section className="settings-section">
            <div className="section-header" style={{ marginBottom: '1.25rem', paddingBottom: '0.875rem', borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <h2>🎨 Overlay Rotators & Alert Durations</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
              
              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Social Rotator Display Duration: <span style={{ color: '#a855f7' }}>{settings.socialLoopShowDuration ?? 10} seconds</span>
                </label>
                <input
                  type="range"
                  min="3"
                  max="60"
                  step="1"
                  value={settings.socialLoopShowDuration ?? 10}
                  onChange={(e) => handleSettingsChange({ socialLoopShowDuration: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  How long each social media handle stays visible on screen. (Default: 10s)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Social Rotator Pause Duration: <span style={{ color: '#a855f7' }}>{settings.socialLoopHideDuration ?? 5} seconds</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="30"
                  step="1"
                  value={settings.socialLoopHideDuration ?? 5}
                  onChange={(e) => handleSettingsChange({ socialLoopHideDuration: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Pause between social media handle switches. (Default: 5s)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Shoutout Alert Duration: <span style={{ color: '#f43f5e' }}>{settings.shoutoutDuration ?? 15} seconds</span>
                </label>
                <input
                  type="range"
                  min="5"
                  max="60"
                  step="1"
                  value={settings.shoutoutDuration ?? 15}
                  onChange={(e) => handleSettingsChange({ shoutoutDuration: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  How long !so & !shoutout banners display on the overlay. (Default: 15s)
                </span>
              </div>

              <div className="setting-group">
                <label className="input-label" style={{ fontWeight: 'bold' }}>
                  Overlay Fade Timeout: <span style={{ color: '#60a5fa' }}>{settings.overlayFadeTimeout ?? 5} seconds</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="30"
                  step="1"
                  value={settings.overlayFadeTimeout ?? 5}
                  onChange={(e) => handleSettingsChange({ overlayFadeTimeout: parseInt(e.target.value) })}
                  className="slider"
                  style={{ width: '100%', marginTop: '8px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Global fade transition timing for elements. (Default: 5s)
                </span>
              </div>

            </div>
          </section>

          {/* Section 5: API Keys & Integration Overrides */}
          <section className="settings-section">
            <div className="section-header" style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              marginBottom: '1.25rem',
              paddingBottom: '0.875rem',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <h2>🔑 API Keys & Integration Overrides (No Config File Required)</h2>
              <button
                className="btn btn-secondary btn-small"
                onClick={autoPopulateAllKeys}
                style={{ background: 'rgba(168, 85, 247, 0.2)', border: '1px solid #a855f7', color: '#e9d5ff', fontWeight: 'bold' }}
                title="Auto-detect API keys from environment and save"
              >
                ⚡ Auto-Detect & Fill All Keys
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              
              <div>
                <label className="input-label" style={{ fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
                  <span>RealtimeIRL Pull Key (GPS Tracking)</span>
                  {API_KEYS.RTIRL && <span style={{ fontSize: '0.8em', color: '#4ade80' }}>⚡ Key detected in environment</span>}
                </label>
                <input
                  type="password"
                  placeholder="Paste RTIRL Pull Key..."
                  className="text-input"
                  value={settings.rtirlPullKey || ''}
                  onChange={(e) => handleSettingsChange({ rtirlPullKey: e.target.value })}
                  style={{ width: '100%', fontFamily: 'monospace', marginTop: '4px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  RealtimeIRL pull key for GPS tracking. Overrides NEXT_PUBLIC_RTIRL_PULL_KEY directly in cloud database.
                </span>
              </div>

              <div>
                <label className="input-label" style={{ fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
                  <span>LocationIQ API Key (Reverse Geocoding)</span>
                  {API_KEYS.LOCATIONIQ && <span style={{ fontSize: '0.8em', color: '#4ade80' }}>⚡ Key detected in environment</span>}
                </label>
                <input
                  type="password"
                  placeholder="Paste LocationIQ API Key..."
                  className="text-input"
                  value={settings.locationIqKey || ''}
                  onChange={(e) => handleSettingsChange({ locationIqKey: e.target.value })}
                  style={{ width: '100%', fontFamily: 'monospace', marginTop: '4px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Used to convert GPS coordinates to city, street, and neighbourhood names.
                </span>
              </div>

              <div>
                <label className="input-label" style={{ fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
                  <span>OpenWeatherMap API Key (Weather & Timezones)</span>
                  {API_KEYS.OPENWEATHER && <span style={{ fontSize: '0.8em', color: '#4ade80' }}>⚡ Key detected in environment</span>}
                </label>
                <input
                  type="password"
                  placeholder="Paste OpenWeatherMap API Key..."
                  className="text-input"
                  value={settings.openWeatherKey || ''}
                  onChange={(e) => handleSettingsChange({ openWeatherKey: e.target.value })}
                  style={{ width: '100%', fontFamily: 'monospace', marginTop: '4px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Used to retrieve live weather conditions, temperatures, and local timezone.
                </span>
              </div>

              <div>
                <label className="input-label" style={{ fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Pulsoid Token (Heart Rate Monitor)</span>
                  {API_KEYS.PULSOID && <span style={{ fontSize: '0.8em', color: '#4ade80' }}>⚡ Key detected in environment</span>}
                </label>
                <input
                  type="password"
                  placeholder="Paste Pulsoid Token..."
                  className="text-input"
                  value={settings.pulsoidToken || ''}
                  onChange={(e) => handleSettingsChange({ pulsoidToken: e.target.value })}
                  style={{ width: '100%', fontFamily: 'monospace', marginTop: '4px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Live heart rate monitor integration from Pulsoid.
                </span>
              </div>

              <div>
                <label className="input-label" style={{ fontWeight: 'bold' }}>📡 Belabox Publisher Key</label>
                <input
                  type="password"
                  placeholder="Enter your Belabox publisher key..."
                  className="text-input"
                  value={settings.belaboxPublisherKey || ''}
                  onChange={(e) => handleSettingsChange({ belaboxPublisherKey: e.target.value })}
                  style={{ width: '100%', fontFamily: 'monospace', marginTop: '4px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Automatically fetches live bitrate stats from https://stats.srt.belabox.net.
                </span>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label className="input-label" style={{ fontWeight: 'bold' }}>💰 StreamElements JWT Token</label>
                  <button
                    type="button"
                    onClick={handleCheckSeToken}
                    disabled={isCheckingSeToken || !settings.streamElementsToken}
                    style={{
                      fontSize: '0.78em',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: 'rgba(250, 204, 21, 0.15)',
                      border: '1px solid rgba(250, 204, 21, 0.4)',
                      color: '#facc15',
                      cursor: (isCheckingSeToken || !settings.streamElementsToken) ? 'not-allowed' : 'pointer',
                      fontWeight: 'bold'
                    }}
                  >
                    {isCheckingSeToken ? '⏳ Verifying...' : '🔍 Test Token'}
                  </button>
                </div>
                <input
                  type="password"
                  placeholder="Paste StreamElements JWT token (starts with eyJ...)..."
                  className="text-input"
                  value={settings.streamElementsToken || ''}
                  onChange={(e) => handleSettingsChange({ 
                    streamElementsToken: e.target.value,
                    streamElementsEnabled: !!e.target.value.trim()
                  })}
                  style={{ width: '100%', fontFamily: 'monospace', marginTop: '4px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Found in StreamElements Dashboard under Account Settings &gt; Channel Settings &gt; JWT Token (click &quot;Show secrets&quot;).
                </span>
                {seTokenStatus && (
                  <div style={{
                    marginTop: '8px',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    fontSize: '0.82em',
                    fontWeight: 'bold',
                    background: seTokenStatus.success ? 'rgba(83, 252, 25, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    border: `1px solid ${seTokenStatus.success ? 'rgba(83, 252, 25, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
                    color: seTokenStatus.success ? '#53FC19' : '#ef4444'
                  }}>
                    {seTokenStatus.message}
                  </div>
                )}
              </div>

              <div>
                <label className="input-label" style={{ fontWeight: 'bold' }}>Twitch Client ID Override</label>
                <input
                  type="text"
                  placeholder="Twitch Client ID..."
                  className="text-input"
                  value={settings.twitchClientId || ''}
                  onChange={(e) => handleSettingsChange({ twitchClientId: e.target.value })}
                  style={{ width: '100%', fontFamily: 'monospace', marginTop: '4px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Custom Twitch App Client ID if using your own registered Twitch application.
                </span>
              </div>

            </div>
          </section>

          {/* Stream Snapshot (!pic) & Discord Integration Section */}
          <section className="settings-card" style={{ borderLeft: '4px solid #53FC19' }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2>📸 Stream Snapshot (!pic Command) & Discord</h2>
                <p className="card-description">
                  Allows viewers in Twitch chat to spend StreamElements loyalty points to capture a live stream picture and automatically send it to your Discord server pic channel!
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.picCommandEnabled ?? true}
                    onChange={(e) => handleSettingsChange({ picCommandEnabled: e.target.checked })}
                  />
                  <span className="toggle-slider"></span>
                </label>
                <span style={{ fontSize: '0.85em', color: (settings.picCommandEnabled ?? true) ? '#53FC19' : '#ef4444', fontWeight: 'bold' }}>
                  {(settings.picCommandEnabled ?? true) ? 'ENABLED' : 'DISABLED'}
                </span>
              </div>
            </div>

            <div className="form-grid">
              <div>
                <label className="input-label" style={{ fontWeight: 'bold' }}>💬 Discord Pic Channel Webhook URL</label>
                <input
                  type="password"
                  placeholder="https://discord.com/api/webhooks/..."
                  className="text-input"
                  value={settings.discordPicWebhookUrl || ''}
                  onChange={(e) => handleSettingsChange({ discordPicWebhookUrl: e.target.value })}
                  style={{ width: '100%', fontFamily: 'monospace', marginTop: '4px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Create in Discord: Channel Settings &gt; Integrations &gt; Webhooks &gt; New Webhook &gt; Copy Webhook URL.
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
                <div>
                  <label className="input-label" style={{ fontWeight: 'bold' }}>💰 StreamElements Points Cost</label>
                  <input
                    type="number"
                    min="0"
                    max="1000000"
                    step="10"
                    className="text-input"
                    value={settings.picPointsCost ?? 200}
                    onChange={(e) => handleSettingsChange({ picPointsCost: parseInt(e.target.value) || 0 })}
                    style={{ width: '100%', marginTop: '4px' }}
                  />
                  <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                    Points deducted from viewer via StreamElements (Default: 200).
                  </span>
                </div>

                <div>
                  <label className="input-label" style={{ fontWeight: 'bold' }}>⏱️ Command Cooldown (Seconds)</label>
                  <input
                    type="number"
                    min="1"
                    max="300"
                    className="text-input"
                    value={settings.picCooldownSeconds ?? 15}
                    onChange={(e) => handleSettingsChange({ picCooldownSeconds: parseInt(e.target.value) || 15 })}
                    style={{ width: '100%', marginTop: '4px' }}
                  />
                  <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                    Cooldown between !pic executions to prevent spam (Default: 15s).
                  </span>
                </div>
              </div>

              <div>
                <label className="input-label" style={{ fontWeight: 'bold' }}>📢 Custom Chat Reply Template (Optional)</label>
                <input
                  type="text"
                  placeholder="📸 @{user} snapped a stream picture! Check it out in the Discord pic channel! 🖼️"
                  className="text-input"
                  value={settings.picCustomMessage || ''}
                  onChange={(e) => handleSettingsChange({ picCustomMessage: e.target.value })}
                  style={{ width: '100%', marginTop: '4px' }}
                />
                <span style={{ fontSize: '0.75em', opacity: 0.6, marginTop: '4px', display: 'block' }}>
                  Available tags: <code>&#123;user&#125;</code>, <code>&#123;points&#125;</code>.
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                <div>
                  <div style={{ fontWeight: 'bold', fontSize: '0.9em' }}>✨ Show On-Screen Snapshot Toast on Overlay</div>
                  <div style={{ fontSize: '0.75em', opacity: 0.6 }}>Displays a sleek camera snapshot card on stream when !pic is used.</div>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.picShowOnOverlay ?? true}
                    onChange={(e) => handleSettingsChange({ picShowOnOverlay: e.target.checked })}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button
                    type="button"
                    onClick={handleTestPicWebhook}
                    disabled={isTestingPicWebhook || !settings.discordPicWebhookUrl}
                    className="secondary-btn"
                    style={{
                      background: 'rgba(83, 252, 25, 0.15)',
                      borderColor: 'rgba(83, 252, 25, 0.5)',
                      color: '#53FC19',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 16px',
                      cursor: (isTestingPicWebhook || !settings.discordPicWebhookUrl) ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {isTestingPicWebhook ? '⏳ Testing Webhook...' : '📸 Test Snapshot to Discord'}
                  </button>
                  <span style={{ fontSize: '0.78em', opacity: 0.7 }}>
                    Sends a test snapshot card directly to your Discord pic channel.
                  </span>
                </div>

                {picTestStatus && (
                  <div style={{
                    padding: '8px 12px',
                    borderRadius: '6px',
                    fontSize: '0.85em',
                    fontWeight: 'bold',
                    background: picTestStatus.success ? 'rgba(83, 252, 25, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    border: `1px solid ${picTestStatus.success ? 'rgba(83, 252, 25, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
                    color: picTestStatus.success ? '#53FC19' : '#ef4444'
                  }}>
                    {picTestStatus.message}
                  </div>
                )}
              </div>

            </div>
          </section>

        </div>
      </main>
    </div>
  );
}
