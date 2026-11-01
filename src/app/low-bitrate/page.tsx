"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { OverlaySettings, DEFAULT_OVERLAY_SETTINGS, CommandConfigItem, DEFAULT_NOALBS_COMMANDS } from '@/types/settings';
import { fetchBitrateStats } from '@/utils/api-utils';
import type { ObsTelemetryStats } from '@/types/obs-telemetry';
import '@/styles/admin.css';

function LowBitrateContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode = searchParams.get('mode') === 'overlay' ? 'overlay' : 'dashboard';

  const [mode, setMode] = useState<'dashboard' | 'overlay'>(initialMode);
  const [activeTab, setActiveTab] = useState<'switcher' | 'chat_commands'>('switcher');
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULT_OVERLAY_SETTINGS);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Bitrate and Stream Telemetry State
  const [currentBitrate, setCurrentBitrate] = useState<number | null>(null);
  const [currentRtt, setCurrentRtt] = useState<number | null>(null);
  const [bitrateHistory, setBitrateHistory] = useState<number[]>([]);
  const [obsConnected, setObsConnected] = useState<boolean>(false);
  const [currentScene, setCurrentScene] = useState<string>('');
  const [availableScenes, setAvailableScenes] = useState<string[]>([]);
  const [telemetry, setTelemetry] = useState<ObsTelemetryStats | null>(null);
  const [isSwitchingScene, setIsSwitchingScene] = useState<boolean>(false);

  // Auto-switch State Machine
  const [autoSwitchState, setAutoSwitchState] = useState<'LIVE' | 'LOW' | 'OFFLINE' | 'RECOVERING' | 'IDLE'>('IDLE');
  const [recoveryCountdown, setRecoveryCountdown] = useState<number>(0);
  const [lastSwitchLog, setLastSwitchLog] = useState<string>('Ready.');

  // NOALBS Terminal / Command Console State
  const [commandInput, setCommandInput] = useState<string>('');
  const [commandLogs, setCommandLogs] = useState<Array<{ id: string; time: string; text: string; type: 'cmd' | 'res' | 'err' }>>([
    { id: 'init-1', time: new Date().toLocaleTimeString(), text: 'NOALBS Stream Engine initialized. Ready for commands.', type: 'res' },
    { id: 'init-2', time: new Date().toLocaleTimeString(), text: 'Type !help or click any command chip below to execute.', type: 'res' },
  ]);
  const [isExecutingCommand, setIsExecutingCommand] = useState<boolean>(false);

  // Chat & Commands Section State
  const [commandsRoleFilter, setCommandsRoleFilter] = useState<'All' | 'Admins' | 'Moderators' | 'Everyone'>('All');
  const [commandSearchQuery, setCommandSearchQuery] = useState<string>('');
  const [editingAliasCmdId, setEditingAliasCmdId] = useState<string | null>(null);
  const [newAliasValue, setNewAliasValue] = useState<string>('');
  const [addingChannelType, setAddingChannelType] = useState<'twitch' | 'kick' | null>(null);
  const [channelInputText, setChannelInputText] = useState<string>('');

  // Refs for tracking transitions and preventing re-trigger loops
  const settingsRef = useRef<OverlaySettings>(settings);
  const autoSwitchStateRef = useRef(autoSwitchState);
  const lowCountRef = useRef<number>(0);
  const recoveryCountRef = useRef<number>(0);
  const offlineCountRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    autoSwitchStateRef.current = autoSwitchState;
  }, [autoSwitchState]);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // 1. Fetch initial settings
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/get-settings', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setSettings(prev => ({ ...prev, ...data }));
      }
    } catch (err) {
      console.warn('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // 2. Fetch OBS Scenes & Connection Status
  const refreshObsScenes = useCallback(async () => {
    try {
      const res = await fetch('/api/obs-switch-scene');
      if (res.ok) {
        const data = await res.json();
        setObsConnected(Boolean(data.connected));
        if (data.scenes && Array.isArray(data.scenes)) {
          setAvailableScenes(data.scenes);
        }
        if (data.currentScene) {
          setCurrentScene(data.currentScene);
        }
      } else {
        setObsConnected(false);
      }
    } catch {
      setObsConnected(false);
    }
  }, []);

  useEffect(() => {
    refreshObsScenes();
    const sceneInterval = setInterval(refreshObsScenes, 5000);
    return () => clearInterval(sceneInterval);
  }, [refreshObsScenes]);

  // 3. Fetch OBS Telemetry (FPS, Dropped Frames, CPU)
  const fetchTelemetry = useCallback(async () => {
    try {
      const res = await fetch('/api/obs-telemetry');
      if (res.ok) {
        const data = await res.json();
        setTelemetry(data);
        if (data.currentScene) {
          setCurrentScene(data.currentScene);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchTelemetry();
    const telInterval = setInterval(fetchTelemetry, 4000);
    return () => clearInterval(telInterval);
  }, [fetchTelemetry]);

  // 4. Save settings changes
  const saveSettingsUpdates = async (updates: Partial<OverlaySettings>) => {
    setSaving(true);
    setSettings(prev => ({ ...prev, ...updates }));
    try {
      const res = await fetch('/api/save-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: updates })
      });
      if (res.ok) {
        showToast('Settings saved & synced to overlay!', 'success');
      } else {
        showToast('Failed to save settings to cloud.', 'error');
      }
    } catch (err: any) {
      showToast(`Save error: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // 5. Scene Switching Execution
  const switchScene = async (sceneName: string, reason: string = 'Manual') => {
    if (!sceneName) {
      showToast('Scene name not configured.', 'error');
      return false;
    }
    setIsSwitchingScene(true);
    const logText = `Switching to: "${sceneName}" (${reason})...`;
    setLastSwitchLog(logText);

    try {
      const res = await fetch('/api/obs-switch-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sceneName,
          obsUrl: settings.obsWebsocketUrl,
          obsPassword: settings.obsWebsocketPassword
        })
      });

      const data = await res.json();
      if (data.success) {
        setCurrentScene(sceneName);
        const successLog = `✅ Program Scene is now: "${sceneName}"`;
        setLastSwitchLog(successLog);
        showToast(successLog, 'success');
        return true;
      } else {
        const failLog = `❌ Failed: ${data.error || 'Could not switch scene'}`;
        setLastSwitchLog(failLog);
        showToast(failLog, 'error');
        return false;
      }
    } catch (err: any) {
      const errLog = `❌ Network Error: ${err.message}`;
      setLastSwitchLog(errLog);
      showToast(errLog, 'error');
      return false;
    } finally {
      setIsSwitchingScene(false);
    }
  };

  // 6. Execute Refresh Cycle (!refresh)
  const triggerRefreshCycle = async () => {
    setIsSwitchingScene(true);
    const refreshScene = settings.obsRefreshSceneName || 'refresh';
    const liveScene = settings.obsLiveSceneName || 'live';
    setLastSwitchLog(`🔄 Running !refresh cycle: "${refreshScene}" for 6s then returning to "${liveScene}"...`);
    showToast(`🔄 Feed reset sequence initiated (switching to ${refreshScene})...`, 'info');

    try {
      const res = await fetch('/api/noalbs/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: '!fix' })
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || 'Stream refresh completed successfully!', 'success');
        setLastSwitchLog(data.message || 'Refresh cycle completed.');
        refreshObsScenes();
      } else {
        showToast(data.error || 'Refresh cycle failed.', 'error');
      }
    } catch (err: any) {
      showToast(`Refresh error: ${err.message}`, 'error');
    } finally {
      setIsSwitchingScene(false);
    }
  };

  // 7. Command Execution Helper
  const runCommand = async (cmdText: string) => {
    if (!cmdText.trim()) return;
    const cleanCmd = cmdText.trim();
    const timeStr = new Date().toLocaleTimeString();

    setCommandLogs(prev => [...prev, { id: `cmd-${Date.now()}`, time: timeStr, text: `> ${cleanCmd}`, type: 'cmd' }]);
    setCommandInput('');
    setIsExecutingCommand(true);

    try {
      const res = await fetch('/api/noalbs/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cleanCmd })
      });

      const data = await res.json();
      const resTime = new Date().toLocaleTimeString();

      if (data.success) {
        setCommandLogs(prev => [...prev, { id: `res-${Date.now()}`, time: resTime, text: data.message || 'Command executed.', type: 'res' }]);
        refreshObsScenes();
        fetchSettings();
      } else {
        setCommandLogs(prev => [...prev, { id: `err-${Date.now()}`, time: resTime, text: data.error || 'Execution failed.', type: 'err' }]);
      }
    } catch (err: any) {
      setCommandLogs(prev => [...prev, { id: `err-${Date.now()}`, time: new Date().toLocaleTimeString(), text: `Error: ${err.message}`, type: 'err' }]);
    } finally {
      setIsExecutingCommand(false);
    }
  };

  // Scroll terminal to bottom
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [commandLogs]);

  // 8. Stream Bitrate & RTT Poller + NOALBS Automatic Switcher Engine
  useEffect(() => {
    let isCancelled = false;

    const pollBitrateAndEvaluate = async () => {
      const currentSettings = settingsRef.current;
      let bitrate = 0;
      let rtt: number | null = null;

      // Fetch bitrate from Belabox or fallback
      if (currentSettings.belaboxPublisherKey) {
        try {
          const stats = await fetchBitrateStats(`https://stats.srt.belabox.net/${currentSettings.belaboxPublisherKey}`, currentSettings.belaboxPublisherKey);
          if (stats) {
            bitrate = stats.bitrateKbps || 0;
            if (stats.rttMs !== undefined) rtt = stats.rttMs;
          }
        } catch {}
      } else {
        const telBitrate = telemetry?.outputBitrateKbps;
        if (telBitrate) {
          bitrate = telBitrate;
        }
      }

      if (isCancelled) return;

      setCurrentBitrate(bitrate);
      setCurrentRtt(rtt);
      setBitrateHistory(prev => [...prev.slice(-59), bitrate]);

      // NOALBS State Machine Evaluation
      if (!currentSettings.obsAutoSwitchSceneToggle) {
        setAutoSwitchState('IDLE');
        return;
      }

      const lowThreshold = currentSettings.obsLowBitrateThreshold ?? 1300;
      const recThreshold = currentSettings.obsRecoveryBitrateThreshold ?? 2000;
      const offThreshold = currentSettings.obsOfflineBitrateThreshold ?? 100;
      const rttThreshold = currentSettings.obsRttThreshold ?? 2500;
      const rttRecThreshold = currentSettings.obsRttRecoveryThreshold ?? 1500;
      const isRttHigh = (currentSettings.rttTriggerEnabled !== false) && rtt !== null && rtt > rttThreshold;

      const delaySec = currentSettings.obsSwitchDelaySeconds ?? 3;
      const recDelaySec = currentSettings.obsRecoveryDelaySeconds ?? 5;
      const offDelaySec = currentSettings.obsOfflineDelaySeconds ?? 5;

      const liveScene = currentSettings.obsLiveSceneName || 'live';
      const lowScene = currentSettings.obsLowSceneName || 'low';
      const offlineScene = currentSettings.obsOfflineSceneName || 'offline';

      const isBitrateOffline = bitrate <= offThreshold;
      const isBitrateLow = (bitrate > offThreshold && bitrate < lowThreshold) || isRttHigh;
      const isBitrateHealthy = bitrate >= recThreshold && (!currentSettings.rttTriggerEnabled || rtt === null || rtt <= rttRecThreshold);

      // A. Evaluate OFFLINE
      if (isBitrateOffline) {
        recoveryCountRef.current = 0;
        lowCountRef.current = 0;
        offlineCountRef.current += 1;

        if (offlineCountRef.current >= offDelaySec && autoSwitchStateRef.current !== 'OFFLINE') {
          setAutoSwitchState('OFFLINE');
          switchScene(offlineScene, `Bitrate dropped to ${bitrate} kbps`);
        }
      }
      // B. Evaluate LOW BITRATE (Bitrate drop OR High RTT latency)
      else if (isBitrateLow) {
        offlineCountRef.current = 0;
        recoveryCountRef.current = 0;
        lowCountRef.current += 1;

        if (lowCountRef.current >= delaySec && autoSwitchStateRef.current !== 'LOW' && autoSwitchStateRef.current !== 'OFFLINE') {
          setAutoSwitchState('LOW');
          const reason = isRttHigh
            ? `High latency detected (RTT: ${rtt}ms > ${rttThreshold}ms)`
            : `Bitrate dropped to ${bitrate} kbps (< ${lowThreshold}k)`;
          switchScene(lowScene, reason);
        }
      }
      // C. Evaluate RECOVERY
      else if (isBitrateHealthy) {
        offlineCountRef.current = 0;
        lowCountRef.current = 0;

        if (autoSwitchStateRef.current === 'LOW' || autoSwitchStateRef.current === 'OFFLINE' || autoSwitchStateRef.current === 'RECOVERING') {
          recoveryCountRef.current += 1;
          const remaining = Math.max(0, recDelaySec - recoveryCountRef.current);
          setRecoveryCountdown(remaining);
          setAutoSwitchState('RECOVERING');

          if (recoveryCountRef.current >= recDelaySec) {
            setAutoSwitchState('LIVE');
            recoveryCountRef.current = 0;
            setRecoveryCountdown(0);
            switchScene(liveScene, `Bitrate & RTT recovered (Rate: ${bitrate} kbps, RTT: ${rtt ?? 0}ms)`);
          }
        } else {
          setAutoSwitchState('LIVE');
        }
      }
    };

    pollBitrateAndEvaluate();
    const interval = setInterval(pollBitrateAndEvaluate, 1000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [telemetry]);

  // 9. Draw Realtime Bitrate History Sparkline Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (bitrateHistory.length < 2) return;

    const maxBitrate = Math.max(6000, ...bitrateHistory, settings.obsRecoveryBitrateThreshold || 2500);
    const lowThresh = settings.obsLowBitrateThreshold || 1300;
    const recThresh = settings.obsRecoveryBitrateThreshold || 2000;

    const getY = (val: number) => height - (val / maxBitrate) * (height - 24) - 12;

    // Threshold lines
    const lowY = getY(lowThresh);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(249, 115, 22, 0.4)';
    ctx.setLineDash([4, 4]);
    ctx.moveTo(0, lowY);
    ctx.lineTo(width, lowY);
    ctx.stroke();

    const recY = getY(recThresh);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.4)';
    ctx.setLineDash([4, 4]);
    ctx.moveTo(0, recY);
    ctx.lineTo(width, recY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Wave Area Fill
    const step = width / (bitrateHistory.length - 1);
    ctx.beginPath();
    ctx.moveTo(0, height);

    bitrateHistory.forEach((val, i) => {
      const x = i * step;
      const y = getY(val);
      if (i === 0) ctx.lineTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.lineTo(width, height);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0.02)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Main line
    ctx.beginPath();
    bitrateHistory.forEach((val, i) => {
      const x = i * step;
      const y = getY(val);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Current point
    const lastX = width;
    const lastY = getY(bitrateHistory[bitrateHistory.length - 1]);
    ctx.beginPath();
    ctx.arc(lastX - 2, lastY, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#38bdf8';
    ctx.stroke();
  }, [bitrateHistory, settings.obsLowBitrateThreshold, settings.obsRecoveryBitrateThreshold]);

  // Copy OBS Browser Source link helper
  const copyObsLink = () => {
    if (typeof window === 'undefined') return;
    const origin = window.location.origin;
    const url = `${origin}/low-bitrate?mode=overlay`;
    navigator.clipboard.writeText(url);
    showToast('📋 OBS Browser Source URL copied! Width: 1920, Height: 1080', 'success');
  };

  // Chat & Commands Helpers
  const activeCommandsList: CommandConfigItem[] = settings.noalbsCommandsList && settings.noalbsCommandsList.length > 0
    ? settings.noalbsCommandsList
    : DEFAULT_NOALBS_COMMANDS;

  const toggleCommandEnabled = (cmdId: string) => {
    const updated = activeCommandsList.map(cmd => {
      if (cmd.id === cmdId) {
        return { ...cmd, enabled: !cmd.enabled };
      }
      return cmd;
    });
    saveSettingsUpdates({ noalbsCommandsList: updated });
  };

  const updateCommandRole = (cmdId: string, role: 'Admins' | 'Moderators' | 'Everyone') => {
    const updated = activeCommandsList.map(cmd => {
      if (cmd.id === cmdId) {
        return { ...cmd, role };
      }
      return cmd;
    });
    saveSettingsUpdates({ noalbsCommandsList: updated });
  };

  const addAliasToCommand = (cmdId: string, aliasName: string) => {
    if (!aliasName.trim()) return;
    const cleanAlias = aliasName.trim().startsWith('!') ? aliasName.trim().toLowerCase() : `!${aliasName.trim().toLowerCase()}`;
    const updated = activeCommandsList.map(cmd => {
      if (cmd.id === cmdId) {
        const currentAliases = cmd.aliases || [];
        if (!currentAliases.includes(cleanAlias)) {
          return { ...cmd, aliases: [...currentAliases, cleanAlias] };
        }
      }
      return cmd;
    });
    saveSettingsUpdates({ noalbsCommandsList: updated });
    setEditingAliasCmdId(null);
    setNewAliasValue('');
  };

  const removeAliasFromCommand = (cmdId: string, aliasToRemove: string) => {
    const updated = activeCommandsList.map(cmd => {
      if (cmd.id === cmdId) {
        return { ...cmd, aliases: (cmd.aliases || []).filter(a => a !== aliasToRemove) };
      }
      return cmd;
    });
    saveSettingsUpdates({ noalbsCommandsList: updated });
  };

  // Filter commands by role and search
  const filteredCommands = activeCommandsList.filter(cmd => {
    if (commandsRoleFilter !== 'All' && cmd.role !== commandsRoleFilter) {
      return false;
    }
    if (commandSearchQuery.trim()) {
      const q = commandSearchQuery.toLowerCase().trim();
      const matchName = cmd.name.toLowerCase().includes(q);
      const matchDesc = cmd.description.toLowerCase().includes(q);
      const matchAliases = (cmd.aliases || []).some(a => a.toLowerCase().includes(q));
      return matchName || matchDesc || matchAliases;
    }
    return true;
  });

  // Role count helpers
  const countAll = activeCommandsList.length;
  const countAdmins = activeCommandsList.filter(c => c.role === 'Admins').length;
  const countMods = activeCommandsList.filter(c => c.role === 'Moderators').length;
  const countEveryone = activeCommandsList.filter(c => c.role === 'Everyone').length;

  // =========================================================================
  // MODE 2: OBS BROWSER SOURCE OVERLAY VIEW (?mode=overlay)
  // =========================================================================
  if (mode === 'overlay') {
    const lowMsg = settings.obsLowBitrateMessage || 'WEAK SIGNAL • RECONNECTING';
    const showStats = settings.obsLowBitrateShowStats !== false;

    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          backgroundColor: 'rgba(5, 7, 12, 0.94)',
          color: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
          fontFamily: 'var(--font-inter), sans-serif',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `radial-gradient(circle at 50% 50%, rgba(56, 189, 248, 0.12) 0%, transparent 65%),
                              linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
                              linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px)`,
            backgroundSize: '100% 100%, 40px 40px, 40px 40px',
            pointerEvents: 'none',
          }}
        />

        <div
          style={{
            position: 'absolute',
            top: '32px',
            left: '48px',
            right: '48px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            paddingBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span
              style={{
                display: 'inline-block',
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                backgroundColor: '#f59e0b',
                boxShadow: '0 0 12px #f59e0b',
                animation: 'pulse 1.5s infinite',
              }}
            />
            <span style={{ fontSize: '1.1rem', fontWeight: 700, letterSpacing: '1px', color: '#f59e0b' }}>
              LOW BITRATE SLATE // STANDBY
            </span>
          </div>
          <div style={{ fontSize: '0.9rem', color: 'rgba(255, 255, 255, 0.6)', letterSpacing: '0.5px' }}>
            {settings.twitchUsername ? `@${settings.twitchUsername}` : 'IRL BROADCAST'}
          </div>
        </div>

        <div
          style={{
            maxWidth: '820px',
            width: '90%',
            background: 'rgba(15, 23, 42, 0.75)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
            borderRadius: '16px',
            padding: '48px 40px',
            boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6), 0 0 30px rgba(245, 158, 11, 0.15)',
            backdropFilter: 'blur(16px)',
            textAlign: 'center',
            position: 'relative',
            zIndex: 10,
          }}
        >
          <div style={{ marginBottom: '24px' }}>
            <svg width="68" height="68" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 16px rgba(245, 158, 11, 0.6))' }}>
              <path d="M2 20h.01" />
              <path d="M7 20v-4" />
              <path d="M12 20v-8" />
              <path d="M17 20V8" />
              <path d="M22 4v16" />
            </svg>
          </div>

          <h1
            style={{
              fontSize: '2.4rem',
              fontWeight: 800,
              letterSpacing: '1.5px',
              textTransform: 'uppercase',
              color: '#ffffff',
              marginBottom: '12px',
              textShadow: '0 0 20px rgba(245, 158, 11, 0.3)',
            }}
          >
            {lowMsg}
          </h1>

          <p style={{ fontSize: '1.05rem', color: 'rgba(255, 255, 255, 0.75)', maxWidth: '580px', margin: '0 auto 28px', lineHeight: 1.6 }}>
            Cellular connection experiencing packet drop or high latency. Stream audio and video will automatically restore once connection stabilizes.
          </p>

          {showStats && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                gap: '20px',
                flexWrap: 'wrap',
                marginTop: '16px',
              }}
            >
              <div
                style={{
                  background: 'rgba(0, 0, 0, 0.4)',
                  padding: '12px 24px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase', marginBottom: '4px' }}>
                  Current Ingest
                </div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: currentBitrate && currentBitrate > 0 ? '#38bdf8' : '#ef4444' }}>
                  {currentBitrate !== null ? `${currentBitrate.toLocaleString()} kbps` : 'OFFLINE'}
                </div>
              </div>

              {currentRtt !== null && (
                <div
                  style={{
                    background: 'rgba(0, 0, 0, 0.4)',
                    padding: '12px 24px',
                    borderRadius: '10px',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                  }}
                >
                  <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase', marginBottom: '4px' }}>
                    Latency (RTT)
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: currentRtt < (settings.obsRttThreshold ?? 2500) ? '#4ade80' : '#f59e0b' }}>
                    {currentRtt} ms
                  </div>
                </div>
              )}

              <div
                style={{
                  background: 'rgba(0, 0, 0, 0.4)',
                  padding: '12px 24px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase', marginBottom: '4px' }}>
                  Auto-Recovery
                </div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: autoSwitchState === 'RECOVERING' ? '#4ade80' : '#38bdf8' }}>
                  {autoSwitchState === 'RECOVERING' ? `Returning (${recoveryCountdown}s)...` : 'Monitoring...'}
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: '32px', width: '100%', height: '4px', background: 'rgba(255, 255, 255, 0.08)', borderRadius: '4px', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: autoSwitchState === 'RECOVERING' ? `${(((settings.obsRecoveryDelaySeconds || 5) - recoveryCountdown) / (settings.obsRecoveryDelaySeconds || 5)) * 100}%` : '40%',
                background: 'linear-gradient(90deg, #38bdf8, #f59e0b)',
                transition: 'width 0.4s ease',
              }}
            />
          </div>
        </div>

        <button
          onClick={() => setMode('dashboard')}
          style={{
            position: 'absolute',
            bottom: '24px',
            background: 'rgba(0, 0, 0, 0.6)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: '20px',
            cursor: 'pointer',
            fontSize: '0.85rem',
            zIndex: 30,
          }}
        >
          Exit Overlay View (Return to Studio Dashboard)
        </button>
      </div>
    );
  }

  // =========================================================================
  // MODE 1: STUDIO DASHBOARD & NOALBS CONTROL CENTER
  // =========================================================================
  return (
    <div className="admin-container" style={{ maxWidth: '1440px', margin: '0 auto', padding: '24px 20px 60px' }}>
      {/* Toast Notification */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: '24px',
            right: '24px',
            zIndex: 9999,
            padding: '12px 24px',
            borderRadius: '8px',
            background: toast.type === 'success' ? '#15803d' : toast.type === 'error' ? '#b91c1c' : '#0369a1',
            color: '#fff',
            fontWeight: '600',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            border: '1px solid rgba(255,255,255,0.2)',
          }}
        >
          {toast.message}
        </div>
      )}

      {/* Top Header & Navigation */}
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          paddingBottom: '20px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          marginBottom: '20px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '1.8rem' }}>⚡</span>
            <h1 style={{ fontSize: '1.6rem', fontWeight: 800, margin: 0, color: '#fff' }}>
              NOALBS Low Bitrate & Scene Switcher
            </h1>
            <span
              style={{
                fontSize: '0.75rem',
                background: 'rgba(56, 189, 248, 0.15)',
                color: '#38bdf8',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                padding: '3px 8px',
                borderRadius: '6px',
                fontWeight: 700,
              }}
            >
              v3.0 ENGINE
            </span>
          </div>
          <p style={{ margin: '4px 0 0', opacity: 0.7, fontSize: '0.88rem' }}>
            Automatic bitrate monitoring, fallback scene transitions, OBS WebSocket controls, and chat commands.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={() => setMode('overlay')}
            title="Preview the OBS Low Bitrate Browser Source page"
            style={{ background: '#f59e0b', borderColor: '#d97706', color: '#000', fontWeight: 'bold' }}
          >
            👁️ Preview Low Scene
          </button>
          <button
            className="btn btn-secondary"
            onClick={copyObsLink}
            title="Copy URL to paste as Browser Source in your OBS Low Bitrate scene"
            style={{ background: 'rgba(34, 197, 94, 0.15)', borderColor: 'rgba(34, 197, 94, 0.35)', color: '#4ade80', fontWeight: 'bold' }}
          >
            📋 Copy OBS Link
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => router.push('/settings')}
            title="Configure all overlay settings"
          >
            ⚙️ Settings
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => router.push('/')}
            title="Return to Main Admin Control Panel"
          >
            🏠 Home
          </button>
        </div>
      </header>

      {/* Navigation Sub-Tabs: Switcher Studio vs Chat & Commands */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '24px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '12px' }}>
        <button
          onClick={() => setActiveTab('switcher')}
          style={{
            padding: '10px 20px',
            borderRadius: '8px',
            fontSize: '0.95rem',
            fontWeight: 700,
            cursor: 'pointer',
            transition: 'all 0.2s',
            background: activeTab === 'switcher' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255, 255, 255, 0.04)',
            color: activeTab === 'switcher' ? '#38bdf8' : 'rgba(255, 255, 255, 0.7)',
            border: activeTab === 'switcher' ? '1px solid rgba(56, 189, 248, 0.4)' : '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>⚡</span> Switcher Studio & Health Monitor
        </button>

        <button
          onClick={() => setActiveTab('chat_commands')}
          style={{
            padding: '10px 20px',
            borderRadius: '8px',
            fontSize: '0.95rem',
            fontWeight: 700,
            cursor: 'pointer',
            transition: 'all 0.2s',
            background: activeTab === 'chat_commands' ? 'rgba(145, 70, 255, 0.25)' : 'rgba(255, 255, 255, 0.04)',
            color: activeTab === 'chat_commands' ? '#c084fc' : 'rgba(255, 255, 255, 0.7)',
            border: activeTab === 'chat_commands' ? '1px solid rgba(145, 70, 255, 0.5)' : '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>💬</span> Chat & Commands ({activeCommandsList.length})
        </button>
      </div>

      {/* =====================================================================
          TAB 1: SWITCHER STUDIO & HEALTH MONITOR
          ===================================================================== */}
      {activeTab === 'switcher' && (
        <>
          {/* Realtime Status Badges Bar */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
              gap: '12px',
              marginBottom: '24px',
            }}
          >
            {/* OBS WebSocket Status */}
            <div style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '10px', padding: '14px 16px' }}>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase' }}>OBS WebSocket</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: obsConnected ? '#22c55e' : '#ef4444' }} />
                <strong style={{ fontSize: '1.05rem', color: obsConnected ? '#4ade80' : '#f87171' }}>
                  {obsConnected ? 'CONNECTED' : 'DISCONNECTED'}
                </strong>
              </div>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginTop: '2px' }}>{settings.obsWebsocketUrl || 'ws://127.0.0.1:4455'}</div>
            </div>

            {/* Current Active Scene */}
            <div style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '10px', padding: '14px 16px' }}>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase' }}>Program Scene</div>
              <div style={{ fontSize: '1.15rem', fontWeight: 700, color: '#38bdf8', marginTop: '4px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {currentScene || 'Detecting...'}
              </div>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginTop: '2px' }}>Live in OBS Studio</div>
            </div>

            {/* Ingest Bitrate & RTT */}
            <div style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '10px', padding: '14px 16px' }}>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase' }}>Ingest Bitrate & RTT</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: currentBitrate && currentBitrate >= (settings.obsRecoveryBitrateThreshold || 2000) ? '#4ade80' : currentBitrate && currentBitrate >= (settings.obsLowBitrateThreshold || 1300) ? '#f59e0b' : '#ef4444', marginTop: '4px' }}>
                {currentBitrate !== null ? `${currentBitrate.toLocaleString()} kbps` : 'OFFLINE'}
              </div>
              <div style={{ fontSize: '0.75rem', color: currentRtt !== null && currentRtt > (settings.obsRttThreshold ?? 2500) ? '#f87171' : '#38bdf8', marginTop: '2px', fontWeight: 600 }}>
                {currentRtt !== null ? `RTT: ${currentRtt} ms (Trigger: ${settings.obsRttThreshold ?? 2500}ms)` : 'Belabox / SRT Ingest'}
              </div>
            </div>

            {/* Auto-Switch State Machine */}
            <div style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '10px', padding: '14px 16px' }}>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase' }}>Auto-Switch State</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    background: autoSwitchState === 'LIVE' ? 'rgba(34, 197, 94, 0.2)' : autoSwitchState === 'LOW' ? 'rgba(245, 158, 11, 0.2)' : autoSwitchState === 'RECOVERING' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                    color: autoSwitchState === 'LIVE' ? '#4ade80' : autoSwitchState === 'LOW' ? '#fbbf24' : autoSwitchState === 'RECOVERING' ? '#38bdf8' : '#f87171',
                  }}
                >
                  {autoSwitchState === 'RECOVERING' ? `RECOVERING (${recoveryCountdown}s)` : autoSwitchState}
                </span>
              </div>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginTop: '2px' }}>
                {settings.obsAutoSwitchSceneToggle ? 'Auto-Switching is ACTIVE' : 'Switcher is DISABLED'}
              </div>
            </div>
          </div>

          {/* Main 2-Column Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(480px, 1fr))', gap: '24px' }}>
            
            {/* COLUMN 1: Scene Switching Studio & Stream Monitor */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              
              {/* Quick Scene Switch Grid */}
              <section className="settings-section" style={{ padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <div>
                    <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, color: '#fff' }}>
                      🎬 Scene Switching Studio
                    </h2>
                    <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
                      One-click instant scene triggers for OBS Studio
                    </span>
                  </div>
                  <button
                    className="btn btn-small"
                    onClick={refreshObsScenes}
                    style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                    title="Refresh scenes from OBS WebSocket"
                  >
                    🔄 Refresh Scenes
                  </button>
                </div>

                {/* Quick Switch Buttons */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '16px' }}>
                  <button
                    className="btn"
                    onClick={() => switchScene(settings.obsLiveSceneName || 'live', 'Quick button')}
                    disabled={isSwitchingScene}
                    style={{
                      background: currentScene.toLowerCase() === (settings.obsLiveSceneName || 'live').toLowerCase() ? '#15803d' : 'rgba(34, 197, 94, 0.15)',
                      border: '1px solid rgba(34, 197, 94, 0.4)',
                      color: '#4ade80',
                      padding: '14px 8px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <span style={{ fontSize: '1.2rem' }}>🟢</span>
                    <strong>LIVE</strong>
                    <span style={{ fontSize: '0.72rem', opacity: 0.8 }}>{settings.obsLiveSceneName || 'live'}</span>
                  </button>

                  <button
                    className="btn"
                    onClick={() => switchScene(settings.obsLowSceneName || 'low', 'Quick button')}
                    disabled={isSwitchingScene}
                    style={{
                      background: currentScene.toLowerCase() === (settings.obsLowSceneName || 'low').toLowerCase() ? '#b45309' : 'rgba(245, 158, 11, 0.15)',
                      border: '1px solid rgba(245, 158, 11, 0.4)',
                      color: '#fbbf24',
                      padding: '14px 8px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <span style={{ fontSize: '1.2rem' }}>🟡</span>
                    <strong>LOW BITRATE</strong>
                    <span style={{ fontSize: '0.72rem', opacity: 0.8 }}>{settings.obsLowSceneName || 'low'}</span>
                  </button>

                  <button
                    className="btn"
                    onClick={() => switchScene(settings.obsOfflineSceneName || 'offline', 'Quick button')}
                    disabled={isSwitchingScene}
                    style={{
                      background: currentScene.toLowerCase() === (settings.obsOfflineSceneName || 'offline').toLowerCase() ? '#b91c1c' : 'rgba(239, 68, 68, 0.15)',
                      border: '1px solid rgba(239, 68, 68, 0.4)',
                      color: '#f87171',
                      padding: '14px 8px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <span style={{ fontSize: '1.2rem' }}>🔴</span>
                    <strong>OFFLINE / BRB</strong>
                    <span style={{ fontSize: '0.72rem', opacity: 0.8 }}>{settings.obsOfflineSceneName || 'offline'}</span>
                  </button>
                </div>

                {/* Secondary Buttons Row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '16px' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={triggerRefreshCycle}
                    disabled={isSwitchingScene}
                    title="Executes feed reset cycle: cuts to refresh scene for 6s then returns to live"
                    style={{ padding: '10px 4px', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}
                  >
                    <span>🔄</span>
                    <strong>!REFRESH</strong>
                  </button>

                  <button
                    className="btn btn-secondary"
                    onClick={() => switchScene(settings.obsStartingSceneName || 'starting', 'Starting button')}
                    disabled={isSwitchingScene}
                    style={{ padding: '10px 4px', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}
                  >
                    <span>🎬</span>
                    <strong>STARTING</strong>
                  </button>

                  <button
                    className="btn btn-secondary"
                    onClick={() => switchScene(settings.obsEndingSceneName || 'ending', 'Ending button')}
                    disabled={isSwitchingScene}
                    style={{ padding: '10px 4px', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}
                  >
                    <span>🏁</span>
                    <strong>ENDING</strong>
                  </button>

                  <button
                    className="btn btn-secondary"
                    onClick={() => switchScene(settings.obsPrivacySceneName || 'privacy', 'Privacy button')}
                    disabled={isSwitchingScene}
                    style={{ padding: '10px 4px', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}
                  >
                    <span>🔒</span>
                    <strong>PRIVACY</strong>
                  </button>
                </div>

                {/* Custom Scene Selector Dropdown */}
                {availableScenes.length > 0 && (
                  <div style={{ marginTop: '12px', background: 'rgba(0,0,0,0.25)', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <label style={{ fontSize: '0.8rem', opacity: 0.7, display: 'block', marginBottom: '6px' }}>
                      Detected OBS Scenes ({availableScenes.length}):
                    </label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <select
                        className="form-control"
                        value={currentScene}
                        onChange={(e) => switchScene(e.target.value, 'Dropdown selection')}
                        style={{ flex: 1, padding: '8px', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px' }}
                      >
                        <option value="" disabled>-- Select a Scene in OBS --</option>
                        {availableScenes.map(sc => (
                          <option key={sc} value={sc} style={{ background: '#1e293b' }}>
                            {sc} {sc === currentScene ? ' (ACTIVE)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                <div style={{ marginTop: '10px', fontSize: '0.75rem', color: '#94a3b8', background: 'rgba(0,0,0,0.3)', padding: '6px 10px', borderRadius: '4px', wordBreak: 'break-all' }}>
                  <strong>Log:</strong> {lastSwitchLog}
                </div>
              </section>

              {/* Realtime Bitrate History Sparkline Chart */}
              <section className="settings-section" style={{ padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div>
                    <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, color: '#fff' }}>
                      📈 Realtime Bitrate History (60s)
                    </h2>
                    <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
                      Visual stream health curve with threshold triggers
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', fontSize: '0.75rem' }}>
                    <span style={{ color: '#4ade80' }}>-- Recovery ({settings.obsRecoveryBitrateThreshold ?? 2000}k)</span>
                    <span style={{ color: '#f59e0b' }}>-- Low ({settings.obsLowBitrateThreshold ?? 1300}k)</span>
                  </div>
                </div>

                <div style={{ width: '100%', height: '140px', position: 'relative', background: 'rgba(0,0,0,0.4)', borderRadius: '8px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <canvas
                    ref={canvasRef}
                    width={560}
                    height={140}
                    style={{ width: '100%', height: '100%', display: 'block' }}
                  />
                </div>

                {/* Dropped Frames & OBS Health */}
                {telemetry && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginTop: '12px', textAlign: 'center' }}>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: '6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>FPS</div>
                      <strong style={{ fontSize: '0.9rem', color: '#38bdf8' }}>{telemetry.fps ? Math.round(telemetry.fps) : '60'}</strong>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: '6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>Dropped Frames</div>
                      <strong style={{ fontSize: '0.9rem', color: (telemetry.droppedFrames || 0) > 0 ? '#f87171' : '#4ade80' }}>
                        {telemetry.droppedFrames ?? 0} ({telemetry.droppedFramesPercent?.toFixed(1) ?? '0.0'}%)
                      </strong>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: '6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>CPU Usage</div>
                      <strong style={{ fontSize: '0.9rem', color: '#fff' }}>{telemetry.cpuUsagePercent ? `${telemetry.cpuUsagePercent.toFixed(1)}%` : '0%'}</strong>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: '6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>Uptime</div>
                      <strong style={{ fontSize: '0.9rem', color: '#fff' }}>{telemetry.uptimeTimecode || '00:00:00'}</strong>
                    </div>
                  </div>
                )}
              </section>

            </div>

            {/* COLUMN 2: Auto-Switch Configuration with RTT Trigger */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              
              <section className="settings-section" style={{ padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <div>
                    <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, color: '#fff' }}>
                      🤖 Auto-Switch & RTT Triggers
                    </h2>
                    <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
                      Bitrate thresholds, RTT latency limits, and scene mappings
                    </span>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={settings.obsAutoSwitchSceneToggle ?? false}
                      onChange={(e) => saveSettingsUpdates({ obsAutoSwitchSceneToggle: e.target.checked })}
                      style={{ width: '18px', height: '18px', accentColor: '#22c55e' }}
                    />
                    <span style={{ fontWeight: 'bold', fontSize: '0.85rem', color: settings.obsAutoSwitchSceneToggle ? '#4ade80' : '#f87171' }}>
                      {settings.obsAutoSwitchSceneToggle ? 'ENABLED' : 'DISABLED'}
                    </span>
                  </label>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {/* Low Bitrate Threshold */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '4px' }}>
                      <span>Low Bitrate Trigger:</span>
                      <strong style={{ color: '#fbbf24' }}>{settings.obsLowBitrateThreshold ?? 1300} kbps</strong>
                    </div>
                    <input
                      type="range"
                      min={300}
                      max={4000}
                      step={50}
                      value={settings.obsLowBitrateThreshold ?? 1300}
                      onChange={(e) => saveSettingsUpdates({ obsLowBitrateThreshold: parseInt(e.target.value, 10) })}
                      style={{ width: '100%', accentColor: '#f59e0b' }}
                    />
                    <span style={{ fontSize: '0.72rem', opacity: 0.6 }}>Bitrate below which OBS cuts to Low Bitrate scene.</span>
                  </div>

                  {/* Recovery Threshold */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '4px' }}>
                      <span>Recovery Bitrate Trigger:</span>
                      <strong style={{ color: '#4ade80' }}>{settings.obsRecoveryBitrateThreshold ?? 2000} kbps</strong>
                    </div>
                    <input
                      type="range"
                      min={600}
                      max={6000}
                      step={50}
                      value={settings.obsRecoveryBitrateThreshold ?? 2000}
                      onChange={(e) => saveSettingsUpdates({ obsRecoveryBitrateThreshold: parseInt(e.target.value, 10) })}
                      style={{ width: '100%', accentColor: '#22c55e' }}
                    />
                    <span style={{ fontSize: '0.72rem', opacity: 0.6 }}>Bitrate required to recover and return to Live scene.</span>
                  </div>

                  {/* RTT LATENCY TRIGGER SECTION */}
                  <div style={{ background: 'rgba(56, 189, 248, 0.05)', border: '1px solid rgba(56, 189, 248, 0.2)', padding: '12px 14px', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '1rem' }}>⏱️</span>
                        <strong style={{ fontSize: '0.88rem', color: '#38bdf8' }}>RTT Latency Trigger (NOALBS)</strong>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.8rem' }}>
                        <input
                          type="checkbox"
                          checked={settings.rttTriggerEnabled ?? true}
                          onChange={(e) => saveSettingsUpdates({ rttTriggerEnabled: e.target.checked })}
                          style={{ width: '16px', height: '16px', accentColor: '#38bdf8' }}
                        />
                        <span style={{ color: (settings.rttTriggerEnabled ?? true) ? '#38bdf8' : 'rgba(255,255,255,0.4)' }}>
                          {(settings.rttTriggerEnabled ?? true) ? 'Active' : 'Off'}
                        </span>
                      </label>
                    </div>

                    <div style={{ marginBottom: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '4px' }}>
                        <span>Low Scene RTT Trigger:</span>
                        <strong style={{ color: '#f59e0b' }}>{settings.obsRttThreshold ?? 2500} ms</strong>
                      </div>
                      <input
                        type="range"
                        min={500}
                        max={5000}
                        step={100}
                        value={settings.obsRttThreshold ?? 2500}
                        onChange={(e) => saveSettingsUpdates({ obsRttThreshold: parseInt(e.target.value, 10) })}
                        style={{ width: '100%', accentColor: '#38bdf8' }}
                      />
                      <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>Switches to Low Bitrate scene if latency spikes above this limit.</span>
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '4px' }}>
                        <span>Recovery RTT Threshold:</span>
                        <strong style={{ color: '#4ade80' }}>{settings.obsRttRecoveryThreshold ?? 1500} ms</strong>
                      </div>
                      <input
                        type="range"
                        min={300}
                        max={3000}
                        step={100}
                        value={settings.obsRttRecoveryThreshold ?? 1500}
                        onChange={(e) => saveSettingsUpdates({ obsRttRecoveryThreshold: parseInt(e.target.value, 10) })}
                        style={{ width: '100%', accentColor: '#22c55e' }}
                      />
                      <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>Latency must drop below this threshold before returning Live.</span>
                    </div>
                  </div>

                  {/* Delays Grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div>
                      <label style={{ fontSize: '0.8rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>
                        Low Switch Delay:
                      </label>
                      <select
                        className="form-control"
                        value={settings.obsSwitchDelaySeconds ?? 3}
                        onChange={(e) => saveSettingsUpdates({ obsSwitchDelaySeconds: parseInt(e.target.value, 10) })}
                        style={{ width: '100%', padding: '6px', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' }}
                      >
                        <option value={1} style={{ background: '#1e293b' }}>1 Second (Instant)</option>
                        <option value={2} style={{ background: '#1e293b' }}>2 Seconds</option>
                        <option value={3} style={{ background: '#1e293b' }}>3 Seconds (Recommended)</option>
                        <option value={5} style={{ background: '#1e293b' }}>5 Seconds</option>
                      </select>
                    </div>

                    <div>
                      <label style={{ fontSize: '0.8rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>
                        Recovery Delay:
                      </label>
                      <select
                        className="form-control"
                        value={settings.obsRecoveryDelaySeconds ?? 5}
                        onChange={(e) => saveSettingsUpdates({ obsRecoveryDelaySeconds: parseInt(e.target.value, 10) })}
                        style={{ width: '100%', padding: '6px', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' }}
                      >
                        <option value={3} style={{ background: '#1e293b' }}>3 Seconds</option>
                        <option value={5} style={{ background: '#1e293b' }}>5 Seconds (Standard)</option>
                        <option value={8} style={{ background: '#1e293b' }}>8 Seconds</option>
                        <option value={10} style={{ background: '#1e293b' }}>10 Seconds (Safe)</option>
                      </select>
                    </div>
                  </div>

                  {/* Scene Names Configuration */}
                  <div style={{ marginTop: '8px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px' }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 'bold', marginBottom: '8px', color: '#38bdf8' }}>
                      Target Scene Names in OBS:
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <div>
                        <label style={{ fontSize: '0.75rem', opacity: 0.7 }}>Live Scene:</label>
                        <input
                          type="text"
                          className="form-control"
                          value={settings.obsLiveSceneName ?? 'live'}
                          onChange={(e) => saveSettingsUpdates({ obsLiveSceneName: e.target.value })}
                          placeholder="live"
                          style={{ width: '100%', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' }}
                        />
                      </div>

                      <div>
                        <label style={{ fontSize: '0.75rem', opacity: 0.7 }}>Low Scene:</label>
                        <input
                          type="text"
                          className="form-control"
                          value={settings.obsLowSceneName ?? 'low'}
                          onChange={(e) => saveSettingsUpdates({ obsLowSceneName: e.target.value })}
                          placeholder="low"
                          style={{ width: '100%', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' }}
                        />
                      </div>

                      <div>
                        <label style={{ fontSize: '0.75rem', opacity: 0.7 }}>Offline Scene:</label>
                        <input
                          type="text"
                          className="form-control"
                          value={settings.obsOfflineSceneName ?? 'offline'}
                          onChange={(e) => saveSettingsUpdates({ obsOfflineSceneName: e.target.value })}
                          placeholder="offline"
                          style={{ width: '100%', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' }}
                        />
                      </div>

                      <div>
                        <label style={{ fontSize: '0.75rem', opacity: 0.7 }}>Refresh Scene:</label>
                        <input
                          type="text"
                          className="form-control"
                          value={settings.obsRefreshSceneName ?? 'refresh'}
                          onChange={(e) => saveSettingsUpdates({ obsRefreshSceneName: e.target.value })}
                          placeholder="refresh"
                          style={{ width: '100%', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' }}
                        />
                      </div>
                    </div>
                  </div>

                </div>
              </section>

              {/* Quick CLI Box */}
              <section className="settings-section" style={{ padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, color: '#fff' }}>
                    💻 Quick Command Terminal
                  </h2>
                  <span style={{ fontSize: '0.75rem', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '2px 8px', borderRadius: '4px' }}>
                    CLI Ready
                  </span>
                </div>

                <div
                  style={{
                    height: '140px',
                    background: '#090d16',
                    border: '1px solid rgba(56, 189, 248, 0.25)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    overflowY: 'auto',
                    fontFamily: 'monospace',
                    fontSize: '0.8rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  {commandLogs.map(log => (
                    <div key={log.id} style={{ display: 'flex', gap: '8px', color: log.type === 'cmd' ? '#38bdf8' : log.type === 'err' ? '#f87171' : '#4ade80' }}>
                      <span style={{ opacity: 0.5 }}>[{log.time}]</span>
                      <span style={{ wordBreak: 'break-all' }}>{log.text}</span>
                    </div>
                  ))}
                  <div ref={terminalEndRef} />
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    runCommand(commandInput);
                  }}
                  style={{ display: 'flex', gap: '8px', marginTop: '10px' }}
                >
                  <input
                    type="text"
                    value={commandInput}
                    onChange={(e) => setCommandInput(e.target.value)}
                    placeholder="Run command (e.g. !bitrate, !rtrigger 2000, !switch live)..."
                    disabled={isExecutingCommand}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: '6px',
                      color: '#fff',
                      fontFamily: 'monospace',
                      fontSize: '0.85rem',
                    }}
                  />
                  <button
                    type="submit"
                    disabled={isExecutingCommand || !commandInput.trim()}
                    className="btn btn-primary"
                    style={{ padding: '8px 16px', fontWeight: 'bold' }}
                  >
                    Run
                  </button>
                </form>
              </section>

            </div>

          </div>
        </>
      )}

      {/* =====================================================================
          TAB 2: CHAT & COMMANDS (DIRECT INSPIRATION FROM USER SCREENSHOTS)
          ===================================================================== */}
      {activeTab === 'chat_commands' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* Section Header */}
          <div>
            <h2 style={{ fontSize: '1.4rem', fontWeight: 800, margin: '0 0 4px', color: '#fff' }}>
              Chat & commands
            </h2>
            <p style={{ margin: 0, opacity: 0.7, fontSize: '0.9rem' }}>
              What viewers and mods can do from chat.
            </p>
          </div>

          {/* CARD 1: CHANNELS */}
          <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '24px' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 6px', color: '#fff' }}>Channels</h3>
            <p style={{ margin: '0 0 16px', opacity: 0.7, fontSize: '0.85rem' }}>
              Connect your channel to use chat commands with this switcher. Turn on alerts to have its automatic scene switches posted in chat.
            </p>

            <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setAddingChannelType('twitch')}
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '0.85rem', padding: '7px 14px' }}
              >
                + Add Twitch channel
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setAddingChannelType('kick')}
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '0.85rem', padding: '7px 14px' }}
              >
                + Add Kick channel
              </button>
            </div>

            {/* Modal / Inline Add Channel Prompt */}
            {addingChannelType && (
              <div style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(145,70,255,0.3)', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '0.85rem', color: '#c084fc' }}>Add {addingChannelType === 'twitch' ? 'Twitch' : 'Kick'} Username:</span>
                <input
                  type="text"
                  value={channelInputText}
                  onChange={(e) => setChannelInputText(e.target.value)}
                  placeholder="channel username"
                  style={{ flex: 1, padding: '6px 10px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', color: '#fff' }}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    if (channelInputText.trim()) {
                      if (addingChannelType === 'twitch') {
                        saveSettingsUpdates({ twitchUsername: channelInputText.trim() });
                      } else {
                        saveSettingsUpdates({ kickChannelName: channelInputText.trim() });
                      }
                      setAddingChannelType(null);
                      setChannelInputText('');
                    }
                  }}
                  style={{ padding: '6px 14px', fontSize: '0.85rem' }}
                >
                  Save
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => { setAddingChannelType(null); setChannelInputText(''); }}
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Connected Channels List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Twitch Channel Item */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: '#9146FF', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1.1rem' }}>
                    T
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>
                      {settings.twitchUsername || 'LauraEclipsetv'}
                    </div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.6 }}>Twitch</div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button
                    onClick={() => saveSettingsUpdates({ twitchAlertsEnabled: !(settings.twitchAlertsEnabled ?? true) })}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: (settings.twitchAlertsEnabled ?? true) ? 'rgba(145, 70, 255, 0.15)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${(settings.twitchAlertsEnabled ?? true) ? 'rgba(145, 70, 255, 0.4)' : 'rgba(255,255,255,0.1)'}`,
                      color: (settings.twitchAlertsEnabled ?? true) ? '#c084fc' : 'rgba(255,255,255,0.5)',
                      padding: '6px 14px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '0.82rem',
                      fontWeight: 600,
                    }}
                  >
                    <span>{(settings.twitchAlertsEnabled ?? true) ? '🔔 Alerts on' : '🔕 Alerts off'}</span>
                  </button>
                  <button
                    onClick={() => saveSettingsUpdates({ twitchUsername: '' })}
                    style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '1rem', padding: '4px' }}
                    title="Remove channel"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Kick Channel Item */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: '#53FC19', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1.1rem' }}>
                    K
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>
                      {settings.kickChannelName || settings.twitchUsername || 'LauraEclipsetv'}
                    </div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.6 }}>Kick</div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button
                    onClick={() => saveSettingsUpdates({ kickAlertsEnabled: !(settings.kickAlertsEnabled ?? true) })}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: (settings.kickAlertsEnabled ?? true) ? 'rgba(83, 252, 25, 0.15)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${(settings.kickAlertsEnabled ?? true) ? 'rgba(83, 252, 25, 0.4)' : 'rgba(255,255,255,0.1)'}`,
                      color: (settings.kickAlertsEnabled ?? true) ? '#53FC19' : 'rgba(255,255,255,0.5)',
                      padding: '6px 14px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '0.82rem',
                      fontWeight: 600,
                    }}
                  >
                    <span>{(settings.kickAlertsEnabled ?? true) ? '🔔 Alerts on' : '🔕 Alerts off'}</span>
                  </button>
                  <button
                    onClick={() => saveSettingsUpdates({ kickChannelName: '' })}
                    style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '1rem', padding: '4px' }}
                    title="Remove channel"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* CARD 2: BOT */}
          <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '24px' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 6px', color: '#fff' }}>Bot</h3>
            <p style={{ margin: '0 0 16px', opacity: 0.7, fontSize: '0.85rem' }}>
              Who replies in chat, for every switcher in this workspace.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
              {/* Twitch Bot */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: '#9146FF', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                    T
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>NOALBSbot</div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.6 }}>Shared NOALBS bot</div>
                  </div>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() => showToast('Twitch OAuth connection modal ready', 'info')}
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '0.82rem', padding: '6px 14px' }}
                >
                  Use your own bot
                </button>
              </div>

              {/* Kick Bot */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: '#53FC19', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                    K
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>NOALBS</div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.6 }}>Shared NOALBS bot</div>
                  </div>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() => showToast('Kick bot connection modal ready', 'info')}
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '0.82rem', padding: '6px 14px' }}
                >
                  Use your own bot
                </button>
              </div>
            </div>

            <div style={{ fontSize: '0.78rem', color: 'rgba(255, 255, 255, 0.5)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>ⓘ</span> Using your own bot? Sign in as the bot account when asked, not as yourself.
            </div>
          </div>

          {/* CARD 3: SETTINGS (PREFIX, BOT LANGUAGE, REPLY MODE, TOGGLES) */}
          <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '24px' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 16px', color: '#fff' }}>Settings</h3>

            {/* Inputs Row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '20px' }}>
              <div>
                <label style={{ fontSize: '0.82rem', fontWeight: 600, display: 'block', marginBottom: '6px', color: 'rgba(255,255,255,0.8)' }}>
                  Command prefix
                </label>
                <input
                  type="text"
                  value={settings.obsCommandPrefix || '!'}
                  onChange={(e) => saveSettingsUpdates({ obsCommandPrefix: e.target.value })}
                  style={{ width: '100%', padding: '8px 12px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem' }}
                />
              </div>

              <div>
                <label style={{ fontSize: '0.82rem', fontWeight: 600, display: 'block', marginBottom: '6px', color: 'rgba(255,255,255,0.8)' }}>
                  Bot language
                </label>
                <select
                  value={settings.obsBotLanguage || 'English'}
                  onChange={(e) => saveSettingsUpdates({ obsBotLanguage: e.target.value })}
                  style={{ width: '100%', padding: '8px 12px', background: '#131924', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem' }}
                >
                  <option value="English">English</option>
                  <option value="Spanish">Spanish</option>
                  <option value="German">German</option>
                  <option value="French">French</option>
                  <option value="Portuguese">Portuguese</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: '0.82rem', fontWeight: 600, display: 'block', marginBottom: '6px', color: 'rgba(255,255,255,0.8)' }}>
                  Reply mode
                </label>
                <select
                  value={settings.obsReplyMode || 'Reply'}
                  onChange={(e) => saveSettingsUpdates({ obsReplyMode: e.target.value })}
                  style={{ width: '100%', padding: '8px 12px', background: '#131924', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem' }}
                >
                  <option value="Reply">Reply</option>
                  <option value="Mention">Mention (@user)</option>
                  <option value="Plain">Plain chat</option>
                </select>
              </div>
            </div>

            {/* Public Commands Toggle Row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.92rem', color: '#fff' }}>Public commands</div>
                <div style={{ fontSize: '0.8rem', opacity: 0.6, marginTop: '2px' }}>
                  Let everyone in chat use commands like !bitrate.
                </div>
              </div>
              <label style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.obsCommandsPublicEnabled ?? true}
                  onChange={(e) => saveSettingsUpdates({ obsCommandsPublicEnabled: e.target.checked })}
                  style={{ width: '20px', height: '20px', accentColor: '#9146FF' }}
                />
              </label>
            </div>

            {/* Moderator Commands Toggle Row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.92rem', color: '#fff' }}>Moderator commands</div>
                <div style={{ fontSize: '0.8rem', opacity: 0.6, marginTop: '2px' }}>
                  Let your moderators run moderator commands.
                </div>
              </div>
              <label style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.obsCommandsModEnabled ?? true}
                  onChange={(e) => saveSettingsUpdates({ obsCommandsModEnabled: e.target.checked })}
                  style={{ width: '20px', height: '20px', accentColor: '#9146FF' }}
                />
              </label>
            </div>
          </div>

          {/* CARD 4: COMMANDS (FILTER TABS, ALIAS EDITORS, ROLE SELECTORS, TOGGLES) */}
          <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '24px' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 6px', color: '#fff' }}>Commands</h3>
            <p style={{ margin: '0 0 16px', opacity: 0.7, fontSize: '0.84rem', lineHeight: 1.5 }}>
              Turn commands on or off, choose who may use them and add shorter names. Roles build on each other (Everyone → Subscribers → VIPs → Moderators → Admins): a command for Subscribers also works for VIPs, moderators and admins. Admins are the channel owner and every member of this workspace, on the accounts linked to their NOALBS sign-in.
            </p>

            {/* Filter Tabs & Search Bar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                {[
                  { key: 'All', label: `All ${countAll}` },
                  { key: 'Admins', label: `Admins (${countAdmins})` },
                  { key: 'Moderators', label: `Moderators (${countMods})` },
                  { key: 'Everyone', label: `Everyone (${countEveryone})` },
                ].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setCommandsRoleFilter(tab.key as any)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '20px',
                      fontSize: '0.82rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      border: commandsRoleFilter === tab.key ? '1px solid #9146FF' : '1px solid rgba(255,255,255,0.1)',
                      background: commandsRoleFilter === tab.key ? 'rgba(145, 70, 255, 0.25)' : 'rgba(255,255,255,0.03)',
                      color: commandsRoleFilter === tab.key ? '#fff' : 'rgba(255,255,255,0.65)',
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <input
                type="text"
                value={commandSearchQuery}
                onChange={(e) => setCommandSearchQuery(e.target.value)}
                placeholder="Search commands..."
                style={{ padding: '6px 14px', borderRadius: '20px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontSize: '0.82rem', width: '200px' }}
              />
            </div>

            {/* Commands List Rows */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {filteredCommands.map((cmd, idx) => (
                <div
                  key={cmd.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '16px 0',
                    borderTop: idx > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                    gap: '16px',
                    flexWrap: 'wrap',
                  }}
                >
                  {/* Left: Command Name */}
                  <div style={{ width: '130px', flexShrink: 0 }}>
                    <code style={{ fontSize: '0.98rem', fontWeight: 800, color: '#fff', fontFamily: 'monospace' }}>
                      {cmd.name}
                    </code>
                  </div>

                  {/* Middle: Description & Aliases */}
                  <div style={{ flex: 1, minWidth: '220px' }}>
                    <div style={{ fontSize: '0.84rem', color: 'rgba(255,255,255,0.85)', marginBottom: '6px' }}>
                      {cmd.description}
                    </div>

                    {/* Aliases Tags */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      {(cmd.aliases || []).map(alias => (
                        <span
                          key={alias}
                          style={{
                            fontSize: '0.74rem',
                            background: 'rgba(145, 70, 255, 0.15)',
                            border: '1px solid rgba(145, 70, 255, 0.3)',
                            color: '#c084fc',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                        >
                          {alias}
                          <button
                            onClick={() => removeAliasFromCommand(cmd.id, alias)}
                            style={{ background: 'transparent', border: 'none', color: '#c084fc', cursor: 'pointer', padding: 0, fontSize: '0.7rem' }}
                            title="Remove alias"
                          >
                            ✕
                          </button>
                        </span>
                      ))}

                      {/* Add Alias Button / Input */}
                      {editingAliasCmdId === cmd.id ? (
                        <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                          <input
                            type="text"
                            value={newAliasValue}
                            onChange={(e) => setNewAliasValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') addAliasToCommand(cmd.id, newAliasValue);
                              if (e.key === 'Escape') setEditingAliasCmdId(null);
                            }}
                            placeholder="!alias"
                            autoFocus
                            style={{ width: '80px', padding: '2px 6px', background: 'rgba(255,255,255,0.08)', border: '1px solid #9146FF', borderRadius: '4px', color: '#fff', fontSize: '0.74rem' }}
                          />
                          <button
                            onClick={() => addAliasToCommand(cmd.id, newAliasValue)}
                            style={{ fontSize: '0.7rem', padding: '2px 6px', background: '#9146FF', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer' }}
                          >
                            Add
                          </button>
                          <button
                            onClick={() => setEditingAliasCmdId(null)}
                            style={{ fontSize: '0.7rem', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingAliasCmdId(cmd.id); setNewAliasValue(''); }}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'rgba(255, 255, 255, 0.45)',
                            fontSize: '0.74rem',
                            cursor: 'pointer',
                            padding: '2px 4px',
                          }}
                        >
                          + Alias
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Right: Role Dropdown & Enable/Disable Toggle */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexShrink: 0 }}>
                    <select
                      value={cmd.role}
                      onChange={(e) => updateCommandRole(cmd.id, e.target.value as any)}
                      style={{
                        padding: '6px 12px',
                        background: '#131924',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                      }}
                    >
                      <option value="Everyone">Everyone {cmd.defaultRole === 'Everyone' ? '(default)' : ''}</option>
                      <option value="Moderators">Moderators {cmd.defaultRole === 'Moderators' ? '(default)' : ''}</option>
                      <option value="Admins">Admins {cmd.defaultRole === 'Admins' ? '(default)' : ''}</option>
                    </select>

                    <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={cmd.enabled}
                        onChange={() => toggleCommandEnabled(cmd.id)}
                        style={{ width: '20px', height: '20px', accentColor: '#9146FF' }}
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}

    </div>
  );
}

export default function LowBitratePage() {
  return (
    <Suspense fallback={<div style={{ padding: '40px', color: '#fff', textAlign: 'center' }}>Loading NOALBS Engine...</div>}>
      <LowBitrateContent />
    </Suspense>
  );
}
