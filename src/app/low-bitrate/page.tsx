"use client";

import { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { OverlaySettings, DEFAULT_OVERLAY_SETTINGS, CommandConfigItem, DEFAULT_NOALBS_COMMANDS } from '@/types/settings';
import { fetchBitrateStats } from '@/utils/api-utils';
import { safeObsSwitchScene } from '@/lib/obs-helper';
import type { ObsTelemetryStats } from '@/types/obs-telemetry';
import '@/styles/admin.css';

function LowBitrateContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode = searchParams.get('mode') === 'overlay' ? 'overlay' : 'dashboard';

  const [mode, setMode] = useState<'dashboard' | 'overlay'>(initialMode);
  const [activeTab, setActiveTab] = useState<'switcher' | 'switching' | 'chat_commands'>('switcher');
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
  const [showObsLogs, setShowObsLogs] = useState<boolean>(false);
  const [isScanningScenes, setIsScanningScenes] = useState<boolean>(false);
  const [customSceneMode, setCustomSceneMode] = useState<boolean>(false);

  // Auto-switch State Machine (NOALBS: LIVE | LOW | OFFLINE | IDLE)
  const [autoSwitchState, setAutoSwitchState] = useState<'LIVE' | 'LOW' | 'OFFLINE' | 'IDLE'>('IDLE');
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

  // OBS WebSocket inputs matching NOALBS UI
  const [obsPortInput, setObsPortInput] = useState<string>(String(settings.obsWebsocketPort || 4455));
  const [obsPasswordInput, setObsPasswordInput] = useState<string>('');
  const localObsRef = useRef<any>(null);

  useEffect(() => {
    if (settings.obsWebsocketPort) {
      setObsPortInput(String(settings.obsWebsocketPort));
    }
  }, [settings.obsWebsocketPort]);

  const handleSaveObsWs = async () => {
    const portNum = parseInt(obsPortInput, 10) || 4455;
    const updates: Partial<OverlaySettings> = {
      obsWebsocketPort: portNum,
      obsWebsocketUrl: `ws://127.0.0.1:${portNum}`,
    };
    if (obsPasswordInput.trim()) {
      updates.obsWebsocketPassword = obsPasswordInput.trim();
    }
    await saveSettingsUpdates(updates);
    setObsPasswordInput('');
    showToast('OBS WebSocket settings saved! Match OBS Tools → WebSocket Server Settings.', 'success');
  };

  const handleRemoveObsPassword = async () => {
    await saveSettingsUpdates({ obsWebsocketPassword: '' });
    setObsPasswordInput('');
    showToast('OBS WebSocket password removed.', 'info');
  };

  // Local OBS WebSocket connection on streamer's PC (works in BOTH dashboard & overlay modes)
  useEffect(() => {
    let isActive = true;
    let retryTimer: NodeJS.Timeout;

    const connectLocalObs = async () => {
      if (!isActive) return;
      try {
        const { default: OBSWebSocket } = await import('obs-websocket-js');
        const obs = new OBSWebSocket();
        const wsPort = settings.obsWebsocketPort || 4455;
        const targetUrl = `ws://127.0.0.1:${wsPort}`;
        const targetPass = settings.obsWebsocketPassword || '';

        await obs.connect(targetUrl, targetPass || undefined);
        if (!isActive) { obs.disconnect(); return; }

        localObsRef.current = obs;
        setObsConnected(true);

        const sceneData: any = await obs.call('GetSceneList').catch(() => null);
        const scenes = sceneData?.scenes ? sceneData.scenes.map((s: any) => String(s.sceneName || s.name || '')).filter(Boolean) : [];
        const currentProg = sceneData?.currentProgramSceneName || '';
        if (currentProg) setCurrentScene(currentProg);
        if (scenes.length > 0) setAvailableScenes(scenes);

        fetch('/api/obs-telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ online: true, currentScene: currentProg, scenes })
        }).catch(() => {});

        obs.on('CurrentProgramSceneChanged' as any, (data: any) => {
          const sName = data?.sceneName || data?.currentProgramSceneName;
          if (sName) {
            setCurrentScene(sName);
            fetch('/api/obs-telemetry', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ online: true, currentScene: sName })
            }).catch(() => {});
          }
        });

        obs.on('SceneListChanged' as any, async (d: any) => {
          try {
            const rawScenes = d?.scenes || (await obs.call('GetSceneList'))?.scenes || [];
            const newScenes = rawScenes.map((s: any) => String(s.sceneName || s.name || '')).filter(Boolean);
            if (newScenes.length > 0) {
              setAvailableScenes(newScenes);
              fetch('/api/obs-telemetry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ online: true, scenes: newScenes })
              }).catch(() => {});
            }
          } catch {}
        });

        obs.on('ConnectionClosed', () => {
          localObsRef.current = null;
          setObsConnected(false);
          if (isActive) retryTimer = setTimeout(connectLocalObs, 5000);
        });
      } catch {
        setObsConnected(false);
        if (isActive) retryTimer = setTimeout(connectLocalObs, 5000);
      }
    };

    connectLocalObs();

    return () => {
      isActive = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (localObsRef.current) {
        try { localObsRef.current.disconnect(); } catch {}
        localObsRef.current = null;
      }
    };
  }, [settings.obsWebsocketPort, settings.obsWebsocketPassword]);

  // Cloud Scene Switch Signal Listener when mode === 'overlay'
  const lastProcessedSceneSignalRef = useRef<number>(0);
  useEffect(() => {
    if (mode !== 'overlay') return;
    const signal = settings.obsSceneSwitchSignal;
    if (!signal || !signal.timestamp || !signal.sceneName) return;
    if (signal.timestamp <= lastProcessedSceneSignalRef.current) return;
    lastProcessedSceneSignalRef.current = signal.timestamp;

    if (localObsRef.current) {
      safeObsSwitchScene(localObsRef.current, signal.sceneName).then(ok => {
        if (ok) setCurrentScene(signal.sceneName);
      });
    }
  }, [mode, settings.obsSceneSwitchSignal]);

  // Fast 1.5s signal poller when running inside OBS Browser Source (?mode=overlay)
  useEffect(() => {
    if (mode !== 'overlay') return;
    let isActive = true;
    const pollSignal = async () => {
      if (!isActive || !localObsRef.current) return;
      try {
        const res = await fetch('/api/obs-switch-scene', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data?.signal && data.signal.timestamp > lastProcessedSceneSignalRef.current) {
            lastProcessedSceneSignalRef.current = data.signal.timestamp;
            safeObsSwitchScene(localObsRef.current, data.signal.sceneName).then(ok => {
              if (ok) setCurrentScene(data.signal.sceneName);
            });
          }
        }
      } catch {}
    };

    const interval = setInterval(pollSignal, 1500);
    return () => {
      isActive = false;
      clearInterval(interval);
    };
  }, [mode]);

  // Refs for tracking transitions and preventing re-trigger loops
  const settingsRef = useRef<OverlaySettings>(settings);
  const autoSwitchStateRef = useRef(autoSwitchState);
  const liveCountRef = useRef<number>(0);
  const lowCountRef = useRef<number>(0);
  const offlineCountRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
        if (data.scenes && Array.isArray(data.scenes) && data.scenes.length > 0) {
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

  // 3. Fetch OBS Telemetry (FPS, Dropped Frames, CPU, Scenes)
  const fetchTelemetry = useCallback(async () => {
    try {
      const res = await fetch('/api/obs-telemetry');
      if (res.ok) {
        const data = await res.json();
        setTelemetry(data);
        if (data.scenes && Array.isArray(data.scenes) && data.scenes.length > 0) {
          setAvailableScenes(data.scenes);
        }
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

  // On-demand manual scan of OBS scenes (directly asks local OBS WebSocket + fallback to telemetry)
  const handleScanObsScenes = async () => {
    setIsScanningScenes(true);
    try {
      // 1. Try active local OBS WebSocket instance
      if (localObsRef.current) {
        try {
          const sceneData: any = await localObsRef.current.call('GetSceneList');
          const scenes = sceneData?.scenes ? sceneData.scenes.map((s: any) => String(s.sceneName || s.name || '')).filter(Boolean) : [];
          if (scenes.length > 0) {
            setAvailableScenes(scenes);
            if (sceneData?.currentProgramSceneName) setCurrentScene(sceneData.currentProgramSceneName);
            showToast(`Found ${scenes.length} scenes from OBS!`, 'success');
            setIsScanningScenes(false);
            return;
          }
        } catch (callErr) {
          console.warn('Local OBS call failed, attempting fresh connection:', callErr);
        }
      }

      // 2. Try fresh connection to local OBS WebSocket
      try {
        const { default: OBSWebSocket } = await import('obs-websocket-js');
        const obs = new OBSWebSocket();
        const wsPort = settings.obsWebsocketPort || 4455;
        const targetUrl = `ws://127.0.0.1:${wsPort}`;
        const targetPass = settings.obsWebsocketPassword || '';
        await obs.connect(targetUrl, targetPass || undefined);
        localObsRef.current = obs;
        setObsConnected(true);

        const sceneData: any = await obs.call('GetSceneList').catch(() => null);
        const scenes = sceneData?.scenes ? sceneData.scenes.map((s: any) => String(s.sceneName || s.name || '')).filter(Boolean) : [];
        if (scenes.length > 0) {
          setAvailableScenes(scenes);
          if (sceneData?.currentProgramSceneName) setCurrentScene(sceneData.currentProgramSceneName);
          fetch('/api/obs-telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ online: true, currentScene: sceneData?.currentProgramSceneName, scenes })
          }).catch(() => {});
          showToast(`Connected to OBS: Detected ${scenes.length} scenes!`, 'success');
          setIsScanningScenes(false);
          return;
        }
      } catch (connErr) {
        console.warn('Direct WebSocket scan failed, checking telemetry fallback:', connErr);
      }

      // 3. Fallback: Query telemetry KV endpoint
      const res = await fetch('/api/obs-telemetry');
      if (res.ok) {
        const data = await res.json();
        if (data.scenes && Array.isArray(data.scenes) && data.scenes.length > 0) {
          setAvailableScenes(data.scenes);
          showToast(`Loaded ${data.scenes.length} scenes from OBS overlay telemetry!`, 'success');
          setIsScanningScenes(false);
          return;
        }
      }

      showToast('Could not reach OBS. Make sure OBS is open with Tools → WebSocket Server Settings enabled (Port 4455).', 'info');
    } catch (err: any) {
      showToast(`Scan error: ${err?.message || err}`, 'error');
    } finally {
      setIsScanningScenes(false);
    }
  };

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

  const manualOverrideUntilRef = useRef<number>(0);

  // 5. Scene Switching Execution
  const switchScene = async (sceneName: string, reason: string = 'Manual') => {
    if (!sceneName) {
      showToast('Scene name not configured.', 'error');
      return false;
    }
    setIsSwitchingScene(true);
    const logText = `Switching to: "${sceneName}" (${reason})...`;
    setLastSwitchLog(logText);

    // If manual switch to a non-live scene (e.g. low, offline), pause auto-switching for 45s
    const isLiveTarget = sceneName.toLowerCase().includes('live') || sceneName.toLowerCase() === (settings.obsLiveSceneName || 'live').toLowerCase();
    if (!isLiveTarget) {
      manualOverrideUntilRef.current = Date.now() + 45000;
      setAutoSwitchState(sceneName.toLowerCase().includes('low') ? 'LOW' : 'OFFLINE');
      setLastSwitchLog(`[${new Date().toLocaleTimeString()}] ⏸️ Pausing auto-switch for 45s to stay on: "${sceneName}"`);
    } else {
      manualOverrideUntilRef.current = 0;
      setAutoSwitchState('LIVE');
    }

    try {
      const now = Date.now();
      saveSettingsUpdates({ obsSceneSwitchSignal: { sceneName, timestamp: now } });

      if (localObsRef.current) {
        safeObsSwitchScene(localObsRef.current, sceneName).then(ok => {
          if (ok) setCurrentScene(sceneName);
        });
      }

      const res = await fetch('/api/obs-switch-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sceneName,
          obsUrl: settings.obsWebsocketUrl || `ws://127.0.0.1:${settings.obsWebsocketPort || 4455}`,
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

      // NOALBS "Only while streaming" setting: Leave OBS alone when you aren't live
      if (currentSettings.obsSwitchOnlyWhileStreaming && telemetry && telemetry.online && !telemetry.streaming) {
        setAutoSwitchState('IDLE');
        return;
      }

      // If manual scene switch is active, hold on the selected scene and skip auto-switch
      if (Date.now() < manualOverrideUntilRef.current) {
        return;
      }

      const lowThreshold = currentSettings.obsLowBitrateThreshold ?? 1100;
      const offThreshold = currentSettings.obsOfflineBitrateThreshold ?? 400;
      const rttLowThreshold = currentSettings.obsRttThreshold ?? 2500;
      const rttBrbThreshold = currentSettings.obsRttOfflineThreshold ?? 3500;

      const lowTriggerEnabled = currentSettings.obsLowBitrateTriggerEnabled !== false;
      const offTriggerEnabled = currentSettings.obsOfflineBitrateTriggerEnabled !== false;
      const rttTriggerEnabled = currentSettings.rttTriggerEnabled !== false;
      const rttLowTriggerEnabled = currentSettings.obsRttLowTriggerEnabled !== false;
      const rttBrbTriggerEnabled = currentSettings.obsRttOfflineTriggerEnabled !== false;

      // NOALBS Checks before switching: Bad checks in a row before leaving LIVE (default 5, one check per second)
      const checksBeforeSwitch = currentSettings.obsChecksBeforeSwitching ?? currentSettings.obsSwitchDelaySeconds ?? 5;
      const delaySec = checksBeforeSwitch;
      const offDelaySec = checksBeforeSwitch;

      // NOALBS Instant Recovery: Go back to LIVE the moment the feed recovers (1 check) or wait delaySec
      const isInstantRecovery = currentSettings.obsInstantRecovery !== false;
      const liveRecoveryDelay = isInstantRecovery ? 1 : delaySec;

      const liveScene = currentSettings.obsLiveSceneName || 'live';
      const lowScene = currentSettings.obsLowSceneName || 'low';
      const offlineScene = currentSettings.obsOfflineSceneName || 'offline';

      // NOALBS Direct State Evaluation:
      // 1. BRB / OFFLINE (Bitrate <= BRB threshold or feed gone, or RTT >= BRB RTT threshold)
      const isBrbByBitrate = offTriggerEnabled && (bitrate <= offThreshold);
      const isBrbByRtt = rttTriggerEnabled && rttBrbTriggerEnabled && rtt !== null && rtt >= rttBrbThreshold;
      const shouldBeOffline = bitrate === 0 || isBrbByBitrate || isBrbByRtt;

      // 2. LOW (Not offline, and Bitrate <= LOW threshold or RTT >= LOW RTT threshold)
      const isLowByBitrate = lowTriggerEnabled && (bitrate <= lowThreshold);
      const isLowByRtt = rttTriggerEnabled && rttLowTriggerEnabled && rtt !== null && rtt >= rttLowThreshold;
      const shouldBeLow = !shouldBeOffline && (isLowByBitrate || isLowByRtt);

      // 3. LIVE (Bitrate above LOW threshold, RTT below limit)
      const shouldBeLive = !shouldBeOffline && !shouldBeLow;

      // A. Evaluate OFFLINE / BRB
      if (shouldBeOffline) {
        lowCountRef.current = 0;
        liveCountRef.current = 0;
        offlineCountRef.current += 1;

        if (offlineCountRef.current >= offDelaySec && autoSwitchStateRef.current !== 'OFFLINE') {
          setAutoSwitchState('OFFLINE');
          const reason = isBrbByRtt
            ? `Critical latency spike (RTT: ${rtt}ms >= ${rttBrbThreshold}ms)`
            : `Bitrate dropped to ${bitrate} kbps (<= ${offThreshold} kbps)`;
          switchScene(offlineScene, reason);
        }
      }
      // B. Evaluate LOW BITRATE
      else if (shouldBeLow) {
        offlineCountRef.current = 0;
        liveCountRef.current = 0;
        lowCountRef.current += 1;

        if (lowCountRef.current >= delaySec && autoSwitchStateRef.current !== 'LOW') {
          setAutoSwitchState('LOW');
          const reason = isLowByRtt
            ? `High latency detected (RTT: ${rtt}ms >= ${rttLowThreshold}ms)`
            : `Bitrate dropped to ${bitrate} kbps (<= ${lowThreshold} kbps)`;
          switchScene(lowScene, reason);
        }
      }
      // C. Evaluate LIVE (Stream Healthy)
      else if (shouldBeLive) {
        offlineCountRef.current = 0;
        lowCountRef.current = 0;
        liveCountRef.current += 1;

        if (liveCountRef.current >= liveRecoveryDelay && autoSwitchStateRef.current !== 'LIVE') {
          setAutoSwitchState('LIVE');
          switchScene(liveScene, `Bitrate recovered (${bitrate} kbps, RTT: ${rtt ?? 0}ms)`);
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

    const maxBitrate = Math.max(6000, ...bitrateHistory, settings.obsLowBitrateThreshold || 2500);
    const lowThresh = settings.obsLowBitrateThreshold || 1100;
    const brbThresh = settings.obsOfflineBitrateThreshold || 400;

    const getY = (val: number) => height - (val / maxBitrate) * (height - 24) - 12;

    // Threshold lines: Low Bitrate (Yellow) and BRB (Red)
    const lowY = getY(lowThresh);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(234, 179, 8, 0.5)';
    ctx.setLineDash([4, 4]);
    ctx.moveTo(0, lowY);
    ctx.lineTo(width, lowY);
    ctx.stroke();

    const brbY = getY(brbThresh);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
    ctx.setLineDash([4, 4]);
    ctx.moveTo(0, brbY);
    ctx.lineTo(width, brbY);
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
  }, [bitrateHistory, settings.obsLowBitrateThreshold, settings.obsOfflineBitrateThreshold]);

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

  // Filter commands by role and search (memoized for performance)
  const filteredCommands = useMemo(() => {
    return activeCommandsList.filter(cmd => {
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
  }, [activeCommandsList, commandsRoleFilter, commandSearchQuery]);

  // Role count helpers (memoized)
  const { countAll, countAdmins, countMods, countEveryone } = useMemo(() => ({
    countAll: activeCommandsList.length,
    countAdmins: activeCommandsList.filter(c => c.role === 'Admins').length,
    countMods: activeCommandsList.filter(c => c.role === 'Moderators').length,
    countEveryone: activeCommandsList.filter(c => c.role === 'Everyone').length,
  }), [activeCommandsList]);

  // OBS WebSocket Card Component matching NOALBS UI Screenshot
  const renderObsWebSocketCard = () => (
    <div
      style={{
        background: '#0e121b',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '12px',
        padding: '24px',
        marginBottom: '24px',
      }}
    >
      <div style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: '0 0 4px 0', color: '#fff' }}>
          OBS WebSocket
        </h3>
        <p style={{ margin: 0, fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.4 }}>
          How the browser source reaches OBS on your computer. Match OBS&apos;s Tools → WebSocket Server Settings.
        </p>
      </div>

      {/* Port & Password Inputs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) 1fr', gap: '16px', marginBottom: '12px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#e2e8f0', marginBottom: '6px' }}>
            Port
          </label>
          <input
            type="number"
            value={obsPortInput}
            onChange={(e) => setObsPortInput(e.target.value)}
            placeholder="4455"
            style={{
              width: '100%',
              padding: '10px 14px',
              background: 'rgba(0, 0, 0, 0.4)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.95rem',
              outline: 'none',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#e2e8f0', marginBottom: '6px' }}>
            Password
          </label>
          <input
            type="password"
            value={obsPasswordInput}
            onChange={(e) => setObsPasswordInput(e.target.value)}
            placeholder={settings.obsWebsocketPassword ? 'Saved — type to replace' : 'Enter password (optional)'}
            style={{
              width: '100%',
              padding: '10px 14px',
              background: 'rgba(0, 0, 0, 0.4)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.95rem',
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Security Note */}
      <div style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: '16px' }}>
        The password is stored encrypted and only ever sent to your browser source.
      </div>

      {/* Save and Remove password buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '18px' }}>
        <button
          onClick={handleSaveObsWs}
          style={{
            padding: '9px 24px',
            backgroundColor: '#6366f1',
            border: 'none',
            borderRadius: '8px',
            color: '#fff',
            fontWeight: 600,
            fontSize: '0.9rem',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(99, 102, 241, 0.35)',
          }}
        >
          Save
        </button>

        {Boolean(settings.obsWebsocketPassword) && (
          <button
            onClick={handleRemoveObsPassword}
            style={{
              padding: '9px 18px',
              backgroundColor: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '8px',
              color: '#e2e8f0',
              fontSize: '0.9rem',
              cursor: 'pointer',
            }}
          >
            Remove password
          </button>
        )}
      </div>

      {/* Connection Loopback Status & Copy Browser Source Pill */}
      <div
        style={{
          background: obsConnected ? 'rgba(34, 197, 94, 0.08)' : 'rgba(245, 158, 11, 0.08)',
          border: `1px solid ${obsConnected ? 'rgba(34, 197, 94, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
          borderRadius: '8px',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: obsConnected ? '#22c55e' : '#f59e0b',
              boxShadow: `0 0 8px ${obsConnected ? '#22c55e' : '#f59e0b'}`,
            }}
          />
          <strong style={{ fontSize: '0.86rem', color: obsConnected ? '#4ade80' : '#fbbf24' }}>
            {obsConnected
              ? `CONNECTED TO OBS (Port ${settings.obsWebsocketPort || 4455})`
              : 'WAITING FOR OBS BROWSER SOURCE'}
          </strong>
        </div>
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(255, 255, 255, 0.7)', lineHeight: 1.4 }}>
          {obsConnected
            ? `Your Browser Source is actively running inside OBS on 127.0.0.1:${settings.obsWebsocketPort || 4455}. Automatic low-bitrate switching and chat commands are live!`
            : 'To connect, add your overlay URL as a Browser Source inside OBS Studio. It communicates with OBS locally on your PC without needing port forwarding.'}
        </p>
        {!obsConnected && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
            <button
              className="btn btn-small"
              onClick={copyObsLink}
              style={{ fontSize: '0.75rem', padding: '5px 12px', background: 'rgba(255,255,255,0.1)' }}
            >
              📋 Copy Overlay Browser Source Link
            </button>
            <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
              Add to OBS scenes as a Browser Source (1920x1080)
            </span>
          </div>
        )}
      </div>
    </div>
  );

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
                  Auto-Switch Status
                </div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: autoSwitchState === 'LIVE' ? '#4ade80' : autoSwitchState === 'LOW' ? '#fbbf24' : '#ef4444' }}>
                  {autoSwitchState === 'LIVE' ? '🟢 LIVE' : autoSwitchState === 'LOW' ? '🟡 LOW BITRATE' : autoSwitchState === 'OFFLINE' ? '🔴 BRB / OFFLINE' : 'MONITORING'}
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: '32px', width: '100%', height: '4px', background: 'rgba(255, 255, 255, 0.08)', borderRadius: '4px', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: autoSwitchState === 'LIVE' ? '100%' : autoSwitchState === 'LOW' ? '50%' : '15%',
                background: autoSwitchState === 'LIVE' ? '#22c55e' : autoSwitchState === 'LOW' ? '#eab308' : '#ef4444',
                transition: 'all 0.4s ease',
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

      {/* Navigation Sub-Tabs: Switcher Studio vs Switching vs Chat & Commands */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '24px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '12px', flexWrap: 'wrap' }}>
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
          onClick={() => setActiveTab('switching')}
          style={{
            padding: '10px 20px',
            borderRadius: '8px',
            fontSize: '0.95rem',
            fontWeight: 700,
            cursor: 'pointer',
            transition: 'all 0.2s',
            background: activeTab === 'switching' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.04)',
            color: activeTab === 'switching' ? '#4ade80' : 'rgba(255, 255, 255, 0.7)',
            border: activeTab === 'switching' ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>🔄</span> Switching
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
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
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

            {/* Twitch Account Connection */}
            <div style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '10px', padding: '14px 16px' }}>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase' }}>Twitch Account</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: (settings.twitchToken || settings.twitchUsername) ? '#22c55e' : 'rgba(255,255,255,0.3)' }} />
                <strong style={{ fontSize: '1.05rem', color: (settings.twitchToken || settings.twitchUsername) ? '#c084fc' : '#94a3b8' }}>
                  {(settings.twitchToken || settings.twitchUsername) ? `@${settings.twitchUsername || 'Connected'}` : 'DISCONNECTED'}
                </strong>
              </div>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginTop: '2px' }}>
                {(settings.twitchToken || settings.twitchUsername) ? 'Twitch Connected • Chat Ready' : 'Connect account in Settings'}
              </div>
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
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: currentBitrate && currentBitrate > (settings.obsLowBitrateThreshold || 1100) ? '#4ade80' : currentBitrate && currentBitrate > (settings.obsOfflineBitrateThreshold || 400) ? '#f59e0b' : '#ef4444', marginTop: '4px' }}>
                {currentBitrate !== null ? `${currentBitrate.toLocaleString()} kbps` : 'OFFLINE'}
              </div>
              <div style={{ fontSize: '0.75rem', color: currentRtt !== null && currentRtt >= (settings.obsRttThreshold ?? 2500) ? '#f87171' : '#38bdf8', marginTop: '2px', fontWeight: 600 }}>
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
                    background: autoSwitchState === 'LIVE' ? 'rgba(34, 197, 94, 0.2)' : autoSwitchState === 'LOW' ? 'rgba(245, 158, 11, 0.2)' : autoSwitchState === 'OFFLINE' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                    color: autoSwitchState === 'LIVE' ? '#4ade80' : autoSwitchState === 'LOW' ? '#fbbf24' : autoSwitchState === 'OFFLINE' ? '#f87171' : 'rgba(255, 255, 255, 0.6)',
                  }}
                >
                  {autoSwitchState === 'LIVE' ? '🟢 LIVE' : autoSwitchState === 'LOW' ? '🟡 LOW' : autoSwitchState === 'OFFLINE' ? '🔴 BRB' : 'IDLE'}
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

            </div>

            {/* COLUMN 2: OBS Studio WebSocket & Telemetry Diagnostics */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {/* OBS WebSocket Card matching NOALBS UI */}
              {renderObsWebSocketCard()}

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
                    <span style={{ color: '#4ade80' }}>-- Live (&gt;{settings.obsLowBitrateThreshold ?? 1100}k)</span>
                    <span style={{ color: '#facc15' }}>-- Low (&le;{settings.obsLowBitrateThreshold ?? 1100}k)</span>
                    <span style={{ color: '#ef4444' }}>-- BRB (&le;{settings.obsOfflineBitrateThreshold ?? 400}k)</span>
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

                {/* OBS Health Telemetry Enable / Disable & Interval Settings */}
                <div style={{ marginTop: '16px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '10px', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <label style={{ margin: 0, color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.95em', fontWeight: 'bold' }}>
                      <span>📊</span> OBS Health Telemetry (Dropped Frames, CPU, FPS)
                    </label>
                    <span style={{ fontSize: '0.8em', opacity: 0.7 }}>
                      (Syncs live OBS stats to dashboard)
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', maxWidth: '100%' }}>
                    {settings.obsTelemetryEnabled && (
                      <select
                        value={settings.obsTelemetryInterval || 45}
                        onChange={(e) => saveSettingsUpdates({ obsTelemetryInterval: parseInt(e.target.value, 10) || 45 })}
                        style={{
                          padding: '4px 10px',
                          fontSize: '0.8em',
                          background: 'rgba(0,0,0,0.5)',
                          border: '1px solid rgba(255,255,255,0.15)',
                          borderRadius: '6px',
                          color: '#fff',
                          outline: 'none',
                          cursor: 'pointer'
                        }}
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
                        onChange={(e) => saveSettingsUpdates({ obsTelemetryEnabled: e.target.checked })}
                        style={{ cursor: 'pointer', width: '18px', height: '18px', accentColor: '#38bdf8', flexShrink: 0 }}
                      />
                      <span style={{ fontSize: '0.85em', color: settings.obsTelemetryEnabled ? '#38bdf8' : 'rgba(255,255,255,0.4)', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                        {settings.obsTelemetryEnabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                    </label>
                  </div>
                </div>

                {/* Live OBS Studio Telemetry Bar (Shown when enabled) */}
                {settings.obsTelemetryEnabled && (
                  <div style={{
                    marginTop: '12px',
                    padding: '12px 16px',
                    borderRadius: '10px',
                    background: telemetry?.online ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.02)',
                    border: telemetry?.online ? '1px solid rgba(83, 252, 25, 0.3)' : '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <span style={{ fontSize: '0.85em', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px', color: telemetry?.online ? '#53FC19' : 'rgba(255,255,255,0.6)' }}>
                        <span>{telemetry?.online ? '🟢' : '⚪'}</span>
                        <span>OBS Studio Telemetry {telemetry?.online ? '(Live Cloud Sync)' : '(Waiting for OBS / Overlay)'}</span>
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        {(currentScene || telemetry?.currentScene) && (
                          <span style={{ fontSize: '0.8em', color: '#60a5fa', background: 'rgba(59, 130, 246, 0.15)', border: '1px solid rgba(59, 130, 246, 0.3)', padding: '2px 8px', borderRadius: '4px', fontWeight: 'bold' }}>
                            🎬 Scene: {currentScene || telemetry?.currentScene}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setShowObsLogs(prev => !prev)}
                          style={{
                            fontSize: '0.78em',
                            background: showObsLogs ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                            color: showObsLogs ? '#38bdf8' : 'rgba(255, 255, 255, 0.85)',
                            border: showObsLogs ? '1px solid rgba(56, 189, 248, 0.5)' : '1px solid rgba(255, 255, 255, 0.15)',
                            padding: '3px 9px',
                            borderRadius: '5px',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            transition: 'all 0.2s ease'
                          }}
                          title="View OBS Event and Diagnostic Logs"
                        >
                          <span>📜</span>
                          <span>{showObsLogs ? 'Hide Logs' : 'View Logs'}</span>
                          {telemetry?.logs && telemetry.logs.length > 0 && (
                            <span style={{ background: '#38bdf8', color: '#000', fontSize: '0.75em', padding: '1px 5px', borderRadius: '10px', fontWeight: 'bold' }}>
                              {Math.min(25, telemetry.logs.length)}
                            </span>
                          )}
                        </button>
                      </div>
                    </div>

                    {telemetry?.online ? (
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
                        gap: '8px',
                        paddingTop: '6px',
                        borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                        fontFamily: 'monospace',
                        fontSize: '0.85em'
                      }}>
                        {/* Dropped Frames */}
                        <div style={{ padding: '6px 10px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px' }}>
                          <div style={{ fontSize: '0.75em', opacity: 0.6, textTransform: 'uppercase' }}>Dropped Frames</div>
                          <div style={{
                            fontWeight: 'bold',
                            color: (telemetry.droppedFramesPercent ?? 0) > 2 ? '#ef4444' : ((telemetry.droppedFramesPercent ?? 0) > 0.5 ? '#f59e0b' : '#4ade80')
                          }}>
                            {telemetry.droppedFrames ?? 0} ({telemetry.droppedFramesPercent?.toFixed(1) ?? '0.0'}%)
                          </div>
                        </div>

                        {/* Output Bitrate */}
                        <div style={{ padding: '6px 10px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px' }}>
                          <div style={{ fontSize: '0.75em', opacity: 0.6, textTransform: 'uppercase' }}>OBS Bitrate</div>
                          <div style={{ fontWeight: 'bold', color: '#4ade80' }}>
                            📶 {telemetry.outputBitrateKbps ? `${telemetry.outputBitrateKbps.toLocaleString()} kbps` : (currentBitrate ? `${currentBitrate.toLocaleString()} kbps` : '0 kbps')}
                          </div>
                        </div>

                        {/* Stream Uptime */}
                        <div style={{ padding: '6px 10px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px' }}>
                          <div style={{ fontSize: '0.75em', opacity: 0.6, textTransform: 'uppercase' }}>Live Uptime</div>
                          <div style={{ fontWeight: 'bold', color: telemetry.streaming ? '#60a5fa' : 'rgba(255,255,255,0.4)' }}>
                            📡 {telemetry.streaming ? (telemetry.uptimeTimecode || 'LIVE') : '00:00:00'}
                          </div>
                        </div>

                        {/* CPU Usage */}
                        <div style={{ padding: '6px 10px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px' }}>
                          <div style={{ fontSize: '0.75em', opacity: 0.6, textTransform: 'uppercase' }}>CPU Usage</div>
                          <div style={{
                            fontWeight: 'bold',
                            color: (telemetry.cpuUsagePercent ?? 0) > 50 ? '#ef4444' : ((telemetry.cpuUsagePercent ?? 0) > 20 ? '#f59e0b' : '#38bdf8')
                          }}>
                            🖥️ {telemetry.cpuUsagePercent ? `${telemetry.cpuUsagePercent.toFixed(1)}%` : '0%'}
                          </div>
                        </div>

                        {/* FPS */}
                        <div style={{ padding: '6px 10px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px' }}>
                          <div style={{ fontSize: '0.75em', opacity: 0.6, textTransform: 'uppercase' }}>Framerate</div>
                          <div style={{ fontWeight: 'bold', color: '#e2e8f0' }}>
                            🎯 {telemetry.fps ? `${Math.round(telemetry.fps)} FPS` : '60.0 FPS'}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {telemetry?.error ? (
                          <div style={{ fontSize: '0.8em', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
                            ⚠️ {telemetry.error}
                          </div>
                        ) : (
                          <div style={{ fontSize: '0.8em', color: 'rgba(255, 255, 255, 0.45)', fontStyle: 'italic' }}>
                            Overlay browser source in OBS will automatically stream Dropped Frames, Uptime, CPU %, and FPS to this dashboard when OBS is running.
                          </div>
                        )}
                      </div>
                    )}

                    {/* Collapsible OBS Event & Diagnostic Log Viewer */}
                    {showObsLogs && (
                      <div style={{
                        marginTop: '8px',
                        padding: '10px 12px',
                        background: '#090d16',
                        border: '1px solid rgba(56, 189, 248, 0.25)',
                        borderRadius: '8px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', borderBottom: '1px solid rgba(255, 255, 255, 0.07)', paddingBottom: '6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.82em', fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '5px' }}>
                              <span>📋</span> Current OBS Logs (Recent {Math.min(25, telemetry?.logs?.length || 0)})
                            </span>
                            {telemetry?.obsVersion && (
                              <span style={{ fontSize: '0.72em', opacity: 0.75, background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: '4px' }}>
                                OBS v{telemetry.obsVersion} {telemetry.platform ? `(${telemetry.platform})` : ''}
                              </span>
                            )}
                            {typeof telemetry?.memoryUsageMb === 'number' && (
                              <span style={{ fontSize: '0.72em', opacity: 0.75, background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: '4px' }}>
                                RAM: {telemetry.memoryUsageMb} MB
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <button
                              type="button"
                              onClick={() => {
                                const format12h = (msg: string, ts?: number) => {
                                  if (/^\[\d{1,2}:\d{2}\s+(AM|PM)\]/i.test(msg)) return msg;
                                  const clean = msg.replace(/^\d{1,2}:\d{2}(:\d{2})?(\.\d{1,3})?\s*(AM|PM)?:\s*/i, '').replace(/^\[\d{1,2}:\d{2}(:\d{2})?(\.\d{1,3})?\s*(AM|PM)?\]\s*/i, '');
                                  if (ts) {
                                    const d = new Date(ts);
                                    let h = d.getHours();
                                    const ampm = h >= 12 ? 'PM' : 'AM';
                                    h = h % 12 || 12;
                                    const m = String(d.getMinutes()).padStart(2, '0');
                                    return `[${h}:${m} ${ampm}] ${clean}`;
                                  }
                                  return clean;
                                };
                                const recentLogs = (telemetry?.logs || []).slice(-25);
                                const logText = recentLogs.map(l => format12h(l.message, l.timestamp)).join('\n') || 'No logs recorded yet.';
                                navigator.clipboard.writeText(logText);
                                showToast('📋 25 recent OBS logs copied to clipboard!', 'success');
                              }}
                              style={{
                                fontSize: '0.72em',
                                background: 'rgba(255, 255, 255, 0.08)',
                                color: '#fff',
                                border: '1px solid rgba(255, 255, 255, 0.15)',
                                padding: '3px 8px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontWeight: 'bold'
                              }}
                            >
                              📋 Copy Logs
                            </button>
                          </div>
                        </div>

                        <div style={{
                          maxHeight: '220px',
                          overflowY: 'auto',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '3px',
                          fontFamily: 'Consolas, "Courier New", monospace',
                          fontSize: '0.78em',
                          background: '#040711',
                          padding: '8px 10px',
                          borderRadius: '6px',
                          border: '1px solid rgba(255, 255, 255, 0.05)'
                        }}>
                          {telemetry?.logs && telemetry.logs.length > 0 ? (
                            telemetry.logs.slice(-25).map((logItem, idx) => {
                              let displayMsg = logItem.message;
                              if (!/^\[\d{1,2}:\d{2}\s+(AM|PM)\]/i.test(displayMsg)) {
                                const clean = displayMsg.replace(/^\d{1,2}:\d{2}(:\d{2})?(\.\d{1,3})?\s*(AM|PM)?:\s*/i, '').replace(/^\[\d{1,2}:\d{2}(:\d{2})?(\.\d{1,3})?\s*(AM|PM)?\]\s*/i, '');
                                if (logItem.timestamp) {
                                  const d = new Date(logItem.timestamp);
                                  let h = d.getHours();
                                  const ampm = h >= 12 ? 'PM' : 'AM';
                                  h = h % 12 || 12;
                                  const m = String(d.getMinutes()).padStart(2, '0');
                                  displayMsg = `[${h}:${m} ${ampm}] ${clean}`;
                                } else {
                                  displayMsg = clean;
                                }
                              }

                              const hasNonZeroDropped = /(?:⚠️\s*Dropped frames|frame drop spike|render lag|\bDropped:\s*[1-9]\d*|\+\d+\s*dropped)/i.test(displayMsg);
                              const isActualError = logItem.level === 'error' && !/Dropped:\s*0\s*\(/i.test(displayMsg);
                              const isFrameDropError = hasNonZeroDropped || isActualError;

                              const isWarn = !isFrameDropError && (
                                logItem.level === 'warn' ||
                                /====\s*Streaming Stop\s*====|====\s*Recording Stop\s*====|User stopped the stream|MUTED|disconnected|Connection closed/i.test(displayMsg)
                              );

                              const isSuccess = !isFrameDropError && !isWarn && (
                                logItem.level === 'success' ||
                                /====\s*Streaming Start\s*====|====\s*Recording Start\s*====|Connection successful|Connected to OBS|UNMUTED/i.test(displayMsg)
                              );

                              const timeMatch = displayMsg.match(/^(\[\d{1,2}:\d{2}\s+[AP]M\])\s*(.*)$/);
                              const timePart = timeMatch ? timeMatch[1] : '';
                              const restPart = timeMatch ? timeMatch[2] : displayMsg;

                              let tagColor = '#94a3b8';
                              if (isFrameDropError) {
                                tagColor = '#ef4444';
                              } else if (isWarn) {
                                tagColor = '#fbbf24';
                              } else if (isSuccess) {
                                tagColor = '#4ade80';
                              } else if (restPart.startsWith('[system-health]')) {
                                tagColor = '#38bdf8';
                              } else if (restPart.startsWith('[scene-manager]')) {
                                tagColor = '#c084fc';
                              } else if (restPart.startsWith('[audio-subsystem]')) {
                                tagColor = '#f472b6';
                              } else if (restPart.startsWith('[video-pipeline]')) {
                                tagColor = '#2dd4bf';
                              } else if (restPart.startsWith('[obs-startup]') || restPart.startsWith('[obs-websocket]')) {
                                tagColor = '#60a5fa';
                              } else if (restPart.startsWith('[rtmp stream')) {
                                tagColor = '#f59e0b';
                              }

                              return (
                                <div key={logItem.id || idx} style={{ lineHeight: 1.4, wordBreak: 'break-word', whiteSpace: 'pre-wrap', display: 'flex', gap: '6px' }}>
                                  {timePart && (
                                    <span style={{ color: 'rgba(255, 255, 255, 0.4)', flexShrink: 0, userSelect: 'none' }}>
                                      {timePart}
                                    </span>
                                  )}
                                  <span style={{ color: tagColor, fontWeight: isFrameDropError ? 'bold' : 'normal' }}>
                                    {restPart}
                                  </span>
                                </div>
                              );
                            })
                          ) : (
                            <div style={{ color: 'rgba(255, 255, 255, 0.45)', fontStyle: 'italic', padding: '8px 0' }}>
                              No OBS logs recorded yet. Logs will stream directly from OBS Studio when the overlay browser source is loaded in OBS.
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* OBS Stream Commands Toggle */}
                <div style={{ marginTop: '16px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(83, 252, 25, 0.25)', borderRadius: '10px', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <label style={{ margin: 0, color: '#53FC19', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.95em', fontWeight: 'bold' }}>
                      <span>⚡</span> OBS Stream Commands (!start, !end &amp; !refresh)
                    </label>
                    <span style={{ fontSize: '0.8em', opacity: 0.7 }}>
                      (Allow chat/remote commands to control stream)
                    </span>
                  </div>
                  <label style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={settings.obsStreamCommandsEnabled ?? true}
                      onChange={(e) => saveSettingsUpdates({ obsStreamCommandsEnabled: e.target.checked })}
                      style={{ cursor: 'pointer', width: '18px', height: '18px', accentColor: '#53FC19' }}
                    />
                    <span style={{ fontSize: '0.85em', color: (settings.obsStreamCommandsEnabled ?? true) ? '#53FC19' : '#ef4444', fontWeight: 'bold' }}>
                      {(settings.obsStreamCommandsEnabled ?? true) ? 'ENABLED' : 'DISABLED'}
                    </span>
                  </label>
                </div>
              </section>

            </div>

          </div>
        </>
      )}

      {/* =====================================================================
          TAB 2: SWITCHING (NOALBS SCENE SWITCHING DASHBOARD)
          ===================================================================== */}
      {activeTab === 'switching' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          
          {/* Switching Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 4px', color: '#fff' }}>
                Switching
              </h2>
              <p style={{ margin: 0, opacity: 0.7, fontSize: '0.88rem' }}>
                When and how NOALBS switches scenes for {settings.twitchUsername ? `@${settings.twitchUsername}` : 'your stream'}.
              </p>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', padding: '8px 16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)' }}>
              <span style={{ fontSize: '0.88rem', fontWeight: 700, color: settings.obsAutoSwitchSceneToggle ? '#4ade80' : 'rgba(255,255,255,0.5)' }}>
                Auto-Switch: {settings.obsAutoSwitchSceneToggle ? 'ACTIVE' : 'OFF'}
              </span>
              <input
                type="checkbox"
                checked={settings.obsAutoSwitchSceneToggle ?? false}
                onChange={(e) => saveSettingsUpdates({ obsAutoSwitchSceneToggle: e.target.checked })}
                style={{ width: '18px', height: '18px', accentColor: '#22c55e' }}
              />
            </label>
          </div>

          {/* 2-Column NOALBS Switching Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: '22px', alignItems: 'start' }}>
            
            {/* COLUMN 1: Triggers & Target Scenes */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              {/* CARD 1: Bitrate triggers */}
              <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '22px' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 6px', color: '#fff' }}>
                  Bitrate triggers
                </h3>
                <p style={{ margin: '0 0 16px', opacity: 0.7, fontSize: '0.82rem', lineHeight: 1.45 }}>
                  Measured on the highest-priority server that is receiving video. Set LOW where your picture starts to fall apart (the default 800 kbps suits most streams); with BRB off, NOALBS goes to BRB only when the feed is gone.
                </p>

                {/* Progress / Range Visual Bar */}
                {(() => {
                  const offThresh = settings.obsOfflineBitrateThreshold ?? 400;
                  const lowThresh = settings.obsLowBitrateThreshold ?? 1100;
                  const redPct = Math.min(100, (offThresh / 8000) * 100);
                  const yelPct = Math.min(100, (lowThresh / 8000) * 100);
                  return (
                    <div style={{ position: 'relative', height: '14px', borderRadius: '7px', background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${redPct}%, #eab308 ${redPct}%, #eab308 ${yelPct}%, #22c55e ${yelPct}%, #22c55e 100%)`, marginBottom: '6px' }} />
                  );
                })()}

                {/* Bar Ticks */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', marginBottom: '18px', padding: '0 2px' }}>
                  <span>0</span>
                  <span>2,000</span>
                  <span>4,000</span>
                  <span>6,000</span>
                  <span>8,000+ kbps</span>
                </div>

                {/* Sliders & Inputs: Switch to LOW / Switch to BRB */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '18px' }}>
                  {/* LOW Bitrate Slider & Input */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(250, 204, 21, 0.2)', borderRadius: '10px', padding: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#facc15', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#facc15', display: 'inline-block' }} />
                        Switch to LOW at or below
                      </span>
                      <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={settings.obsLowBitrateTriggerEnabled ?? true}
                          onChange={(e) => saveSettingsUpdates({ obsLowBitrateTriggerEnabled: e.target.checked })}
                          style={{ width: '16px', height: '16px', accentColor: '#eab308' }}
                        />
                      </label>
                    </div>
                    {/* Range Slider */}
                    <input
                      type="range"
                      min={200}
                      max={6000}
                      step={50}
                      value={settings.obsLowBitrateThreshold ?? 1100}
                      onChange={(e) => saveSettingsUpdates({ obsLowBitrateThreshold: Number(e.target.value) || 0 })}
                      style={{ width: '100%', accentColor: '#facc15', cursor: 'pointer', height: '6px', marginBottom: '10px' }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="number"
                        min={0}
                        max={20000}
                        step={50}
                        value={settings.obsLowBitrateThreshold ?? 1100}
                        onChange={(e) => saveSettingsUpdates({ obsLowBitrateThreshold: Number(e.target.value) || 0 })}
                        style={{ flex: 1, padding: '8px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', fontWeight: 700 }}
                      />
                      <span style={{ fontSize: '0.82rem', opacity: 0.6 }}>kbps</span>
                    </div>
                  </div>

                  {/* BRB Bitrate Slider & Input */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '10px', padding: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#f87171', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                        Switch to BRB at or below
                      </span>
                      <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={settings.obsOfflineBitrateTriggerEnabled ?? true}
                          onChange={(e) => saveSettingsUpdates({ obsOfflineBitrateTriggerEnabled: e.target.checked })}
                          style={{ width: '16px', height: '16px', accentColor: '#ef4444' }}
                        />
                      </label>
                    </div>
                    {/* Range Slider */}
                    <input
                      type="range"
                      min={0}
                      max={2500}
                      step={25}
                      value={settings.obsOfflineBitrateThreshold ?? 400}
                      onChange={(e) => saveSettingsUpdates({ obsOfflineBitrateThreshold: Number(e.target.value) || 0 })}
                      style={{ width: '100%', accentColor: '#ef4444', cursor: 'pointer', height: '6px', marginBottom: '10px' }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        step={25}
                        value={settings.obsOfflineBitrateThreshold ?? 400}
                        onChange={(e) => saveSettingsUpdates({ obsOfflineBitrateThreshold: Number(e.target.value) || 0 })}
                        style={{ flex: 1, padding: '8px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', fontWeight: 700 }}
                      />
                      <span style={{ fontSize: '0.82rem', opacity: 0.6 }}>kbps</span>
                    </div>
                  </div>
                </div>

                {/* 3 Status Summary Boxes */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                  {/* LIVE */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(34, 197, 94, 0.25)', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 800, color: '#4ade80', marginBottom: '4px' }}>
                      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                      LIVE
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)' }}>
                      above {(settings.obsLowBitrateThreshold ?? 1100).toLocaleString()} kbps
                    </div>
                  </div>

                  {/* LOW */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(234, 179, 8, 0.25)', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 800, color: '#facc15', marginBottom: '4px' }}>
                      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#eab308', display: 'inline-block' }} />
                      LOW
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)' }}>
                      {((settings.obsOfflineBitrateThreshold ?? 400) + 1).toLocaleString()} kbps to {(settings.obsLowBitrateThreshold ?? 1100).toLocaleString()} kbps
                    </div>
                  </div>

                  {/* BRB */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 800, color: '#f87171', marginBottom: '4px' }}>
                      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                      BRB
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)' }}>
                      {(settings.obsOfflineBitrateThreshold ?? 400).toLocaleString()} kbps or less, or no feed
                    </div>
                  </div>
                </div>
              </div>

              {/* CARD 2: Latency (RTT) triggers */}
              <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '22px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: '#fff' }}>
                    Latency (RTT) triggers
                  </h3>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.8rem', color: (settings.rttTriggerEnabled ?? true) ? '#38bdf8' : 'rgba(255,255,255,0.4)' }}>
                    <input
                      type="checkbox"
                      checked={settings.rttTriggerEnabled ?? true}
                      onChange={(e) => saveSettingsUpdates({ rttTriggerEnabled: e.target.checked })}
                      style={{ width: '16px', height: '16px', accentColor: '#38bdf8' }}
                    />
                    <span>{(settings.rttTriggerEnabled ?? true) ? 'Active' : 'Off'}</span>
                  </label>
                </div>
                <p style={{ margin: '0 0 16px', opacity: 0.7, fontSize: '0.82rem' }}>
                  Catch a struggling uplink before the bitrate drops. Only SRT servers report RTT.
                </p>

                {/* Progress / Range Visual Bar */}
                {(() => {
                  const rttLow = settings.obsRttThreshold ?? 2500;
                  const rttBrb = settings.obsRttOfflineThreshold ?? 3500;
                  const grnPct = Math.min(100, (rttLow / 5000) * 100);
                  const yelPct = Math.min(100, (rttBrb / 5000) * 100);
                  return (
                    <div style={{ position: 'relative', height: '14px', borderRadius: '7px', background: `linear-gradient(to right, #22c55e 0%, #22c55e ${grnPct}%, #eab308 ${grnPct}%, #eab308 ${yelPct}%, #ef4444 ${yelPct}%, #ef4444 100%)`, marginBottom: '6px' }} />
                  );
                })()}

                {/* Bar Ticks */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', marginBottom: '18px', padding: '0 2px' }}>
                  <span>0</span>
                  <span>1,250</span>
                  <span>2,500</span>
                  <span>3,750</span>
                  <span>5,000+ ms</span>
                </div>

                {/* Sliders & Inputs: Switch to LOW at or above / Switch to BRB at or above */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '18px' }}>
                  {/* LOW RTT Slider & Input */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(250, 204, 21, 0.2)', borderRadius: '10px', padding: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#facc15', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#facc15', display: 'inline-block' }} />
                        Switch to LOW at or above
                      </span>
                      <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={settings.obsRttLowTriggerEnabled ?? true}
                          onChange={(e) => saveSettingsUpdates({ obsRttLowTriggerEnabled: e.target.checked })}
                          style={{ width: '16px', height: '16px', accentColor: '#eab308' }}
                        />
                      </label>
                    </div>
                    {/* Range Slider */}
                    <input
                      type="range"
                      min={200}
                      max={6000}
                      step={50}
                      value={settings.obsRttThreshold ?? 2500}
                      onChange={(e) => saveSettingsUpdates({ obsRttThreshold: Number(e.target.value) || 0 })}
                      style={{ width: '100%', accentColor: '#facc15', cursor: 'pointer', height: '6px', marginBottom: '10px' }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="number"
                        min={0}
                        max={15000}
                        step={50}
                        value={settings.obsRttThreshold ?? 2500}
                        onChange={(e) => saveSettingsUpdates({ obsRttThreshold: Number(e.target.value) || 0 })}
                        style={{ flex: 1, padding: '8px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', fontWeight: 700 }}
                      />
                      <span style={{ fontSize: '0.82rem', opacity: 0.6 }}>ms</span>
                    </div>
                  </div>

                  {/* BRB RTT Slider & Input */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '10px', padding: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#f87171', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                        Switch to BRB at or above
                      </span>
                      <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={settings.obsRttOfflineTriggerEnabled ?? true}
                          onChange={(e) => saveSettingsUpdates({ obsRttOfflineTriggerEnabled: e.target.checked })}
                          style={{ width: '16px', height: '16px', accentColor: '#ef4444' }}
                        />
                      </label>
                    </div>
                    {/* Range Slider */}
                    <input
                      type="range"
                      min={500}
                      max={8000}
                      step={50}
                      value={settings.obsRttOfflineThreshold ?? 3500}
                      onChange={(e) => saveSettingsUpdates({ obsRttOfflineThreshold: Number(e.target.value) || 0 })}
                      style={{ width: '100%', accentColor: '#ef4444', cursor: 'pointer', height: '6px', marginBottom: '10px' }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="number"
                        min={0}
                        max={20000}
                        step={50}
                        value={settings.obsRttOfflineThreshold ?? 3500}
                        onChange={(e) => saveSettingsUpdates({ obsRttOfflineThreshold: Number(e.target.value) || 0 })}
                        style={{ flex: 1, padding: '8px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.9rem', fontWeight: 700 }}
                      />
                      <span style={{ fontSize: '0.82rem', opacity: 0.6 }}>ms</span>
                    </div>
                  </div>
                </div>

                {/* 3 Status Summary Boxes for RTT */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                  {/* LIVE */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(34, 197, 94, 0.25)', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 800, color: '#4ade80', marginBottom: '4px' }}>
                      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                      LIVE
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)' }}>
                      below {(settings.obsRttThreshold ?? 2500).toLocaleString()} ms
                    </div>
                  </div>

                  {/* LOW */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(234, 179, 8, 0.25)', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 800, color: '#facc15', marginBottom: '4px' }}>
                      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#eab308', display: 'inline-block' }} />
                      LOW
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)' }}>
                      {(settings.obsRttThreshold ?? 2500).toLocaleString()} ms to {(settings.obsRttOfflineThreshold ?? 3500).toLocaleString()} ms
                    </div>
                  </div>

                  {/* BRB */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 800, color: '#f87171', marginBottom: '4px' }}>
                      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                      BRB
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)' }}>
                      {(settings.obsRttOfflineThreshold ?? 3500).toLocaleString()} ms or higher
                    </div>
                  </div>
                </div>
              </div>

              {/* CARD 3: Target Scene Names Dropdowns (All scenes detected + Fallback Presets + Manual Typing) */}
              {(() => {
                const defaultPresets = [
                  'live', 'low', 'offline', 'refresh', 'starting', 'ending', 'privacy',
                  'Live', 'Low Bitrate', 'BRB', 'Starting Soon', 'Stream Ending', 'Just Chatting', 'Gameplay', 'Screen Share'
                ];
                const getOptionsForScene = (currentValue: string) => {
                  if (availableScenes.length > 0) {
                    return Array.from(new Set([currentValue, ...availableScenes])).filter(Boolean);
                  }
                  return Array.from(new Set([currentValue, ...defaultPresets])).filter(Boolean);
                };

                return (
                  <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '22px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
                      <div>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: '#fff' }}>
                          Target Scene Names
                        </h3>
                        <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
                          Choose from all scenes detected in OBS for each automatic trigger
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={handleScanObsScenes}
                          disabled={isScanningScenes}
                          style={{
                            padding: '6px 12px',
                            background: 'rgba(56, 189, 248, 0.15)',
                            border: '1px solid #38bdf8',
                            borderRadius: '6px',
                            color: '#38bdf8',
                            fontSize: '0.78rem',
                            fontWeight: 700,
                            cursor: isScanningScenes ? 'not-allowed' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px'
                          }}
                        >
                          <span>🔄</span>
                          {isScanningScenes ? 'Scanning OBS...' : 'Rescan OBS Scenes'}
                        </button>

                        <button
                          type="button"
                          onClick={() => setCustomSceneMode(prev => !prev)}
                          style={{
                            padding: '6px 10px',
                            background: customSceneMode ? 'rgba(147, 51, 234, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.15)',
                            borderRadius: '6px',
                            color: '#fff',
                            fontSize: '0.78rem',
                            cursor: 'pointer'
                          }}
                        >
                          {customSceneMode ? '📋 Use Dropdowns' : '✏️ Type Manually'}
                        </button>

                        {availableScenes.length > 0 ? (
                          <span style={{ fontSize: '0.75rem', color: '#4ade80', background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.3)', padding: '3px 8px', borderRadius: '6px', fontWeight: 700 }}>
                            ✓ {availableScenes.length} scenes detected
                          </span>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: '#facc15', background: 'rgba(250, 204, 21, 0.1)', border: '1px solid rgba(250, 204, 21, 0.3)', padding: '3px 8px', borderRadius: '6px', fontWeight: 700 }}>
                            Preset scenes (Click Rescan to detect OBS)
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '14px' }}>
                      {/* LIVE SCENE */}
                      <div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: 600, color: '#4ade80', marginBottom: '6px' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                          Live Scene:
                        </label>
                        {customSceneMode ? (
                          <input
                            type="text"
                            value={settings.obsLiveSceneName || 'live'}
                            onChange={(e) => saveSettingsUpdates({ obsLiveSceneName: e.target.value })}
                            placeholder="e.g. Live"
                            style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                          />
                        ) : (
                          <select
                            value={settings.obsLiveSceneName || 'live'}
                            onChange={(e) => saveSettingsUpdates({ obsLiveSceneName: e.target.value })}
                            style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                          >
                            {getOptionsForScene(settings.obsLiveSceneName || 'live').map(sc => (
                              <option key={sc} value={sc} style={{ background: '#1e293b' }}>
                                {sc}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      {/* LOW SCENE */}
                      <div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: 600, color: '#facc15', marginBottom: '6px' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#eab308', display: 'inline-block' }} />
                          Low Scene:
                        </label>
                        {customSceneMode ? (
                          <input
                            type="text"
                            value={settings.obsLowSceneName || 'low'}
                            onChange={(e) => saveSettingsUpdates({ obsLowSceneName: e.target.value })}
                            placeholder="e.g. low"
                            style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                          />
                        ) : (
                          <select
                            value={settings.obsLowSceneName || 'low'}
                            onChange={(e) => saveSettingsUpdates({ obsLowSceneName: e.target.value })}
                            style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                          >
                            {getOptionsForScene(settings.obsLowSceneName || 'low').map(sc => (
                              <option key={sc} value={sc} style={{ background: '#1e293b' }}>
                                {sc}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      {/* BRB / OFFLINE SCENE */}
                      <div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: 600, color: '#f87171', marginBottom: '6px' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                          BRB / Offline Scene:
                        </label>
                        {customSceneMode ? (
                          <input
                            type="text"
                            value={settings.obsOfflineSceneName || 'offline'}
                            onChange={(e) => saveSettingsUpdates({ obsOfflineSceneName: e.target.value })}
                            placeholder="e.g. offline"
                            style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                          />
                        ) : (
                          <select
                            value={settings.obsOfflineSceneName || 'offline'}
                            onChange={(e) => saveSettingsUpdates({ obsOfflineSceneName: e.target.value })}
                            style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                          >
                            {getOptionsForScene(settings.obsOfflineSceneName || 'offline').map(sc => (
                              <option key={sc} value={sc} style={{ background: '#1e293b' }}>
                                {sc}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      {/* REFRESH SCENE */}
                      <div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: 600, color: '#38bdf8', marginBottom: '6px' }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#38bdf8', display: 'inline-block' }} />
                          Refresh Scene:
                        </label>
                        {customSceneMode ? (
                          <input
                            type="text"
                            value={settings.obsRefreshSceneName || 'refresh'}
                            onChange={(e) => saveSettingsUpdates({ obsRefreshSceneName: e.target.value })}
                            placeholder="e.g. refresh"
                            style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                          />
                        ) : (
                          <select
                            value={settings.obsRefreshSceneName || 'refresh'}
                            onChange={(e) => saveSettingsUpdates({ obsRefreshSceneName: e.target.value })}
                            style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                          >
                            {getOptionsForScene(settings.obsRefreshSceneName || 'refresh').map(sc => (
                              <option key={sc} value={sc} style={{ background: '#1e293b' }}>
                                {sc}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>

                    {/* Switch Delay & Secondary scenes */}
                    <div style={{ marginTop: '16px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '14px' }}>
                      <div>
                        <label style={{ fontSize: '0.8rem', opacity: 0.8, display: 'block', marginBottom: '6px' }}>
                          Switch Delay:
                        </label>
                        <select
                          value={settings.obsSwitchDelaySeconds ?? 3}
                          onChange={(e) => saveSettingsUpdates({ obsSwitchDelaySeconds: Number(e.target.value) || 3 })}
                          style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.85rem' }}
                        >
                          <option value={1} style={{ background: '#1e293b' }}>1 Second (Instant)</option>
                          <option value={2} style={{ background: '#1e293b' }}>2 Seconds</option>
                          <option value={3} style={{ background: '#1e293b' }}>3 Seconds (Recommended)</option>
                          <option value={5} style={{ background: '#1e293b' }}>5 Seconds</option>
                        </select>
                      </div>

                      <div>
                        <label style={{ fontSize: '0.8rem', opacity: 0.8, display: 'block', marginBottom: '6px' }}>
                          Starting Scene:
                        </label>
                        {customSceneMode ? (
                          <input
                            type="text"
                            value={settings.obsStartingSceneName || 'starting'}
                            onChange={(e) => saveSettingsUpdates({ obsStartingSceneName: e.target.value })}
                            placeholder="e.g. starting"
                            style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.85rem' }}
                          />
                        ) : (
                          <select
                            value={settings.obsStartingSceneName || 'starting'}
                            onChange={(e) => saveSettingsUpdates({ obsStartingSceneName: e.target.value })}
                            style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.85rem' }}
                          >
                            {getOptionsForScene(settings.obsStartingSceneName || 'starting').map(sc => (
                              <option key={sc} value={sc} style={{ background: '#1e293b' }}>{sc}</option>
                            ))}
                          </select>
                        )}
                      </div>

                      <div>
                        <label style={{ fontSize: '0.8rem', opacity: 0.8, display: 'block', marginBottom: '6px' }}>
                          Ending Scene:
                        </label>
                        {customSceneMode ? (
                          <input
                            type="text"
                            value={settings.obsEndingSceneName || 'ending'}
                            onChange={(e) => saveSettingsUpdates({ obsEndingSceneName: e.target.value })}
                            placeholder="e.g. ending"
                            style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.85rem' }}
                          />
                        ) : (
                          <select
                            value={settings.obsEndingSceneName || 'ending'}
                            onChange={(e) => saveSettingsUpdates({ obsEndingSceneName: e.target.value })}
                            style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.85rem' }}
                          >
                            {getOptionsForScene(settings.obsEndingSceneName || 'ending').map(sc => (
                              <option key={sc} value={sc} style={{ background: '#1e293b' }}>{sc}</option>
                            ))}
                          </select>
                        )}
                      </div>

                      <div>
                        <label style={{ fontSize: '0.8rem', opacity: 0.8, display: 'block', marginBottom: '6px' }}>
                          Privacy Scene:
                        </label>
                        {customSceneMode ? (
                          <input
                            type="text"
                            value={settings.obsPrivacySceneName || 'privacy'}
                            onChange={(e) => saveSettingsUpdates({ obsPrivacySceneName: e.target.value })}
                            placeholder="e.g. privacy"
                            style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.85rem' }}
                          />
                        ) : (
                          <select
                            value={settings.obsPrivacySceneName || 'privacy'}
                            onChange={(e) => saveSettingsUpdates({ obsPrivacySceneName: e.target.value })}
                            style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.85rem' }}
                          >
                            {getOptionsForScene(settings.obsPrivacySceneName || 'privacy').map(sc => (
                              <option key={sc} value={sc} style={{ background: '#1e293b' }}>{sc}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

            </div>

            {/* COLUMN 2: Switching Settings & Start/End/Raids (Matching NOALBS Screenshots) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              {/* CARD 1: Switching (Exact match to media_1793565718597_16d6a16a.png) */}
              <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '22px' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 16px', color: '#fff' }}>
                  Switching
                </h3>

                {/* 1. Auto switch */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Auto switch
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Switch scenes automatically using the triggers.
                    </div>
                  </div>
                  <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={settings.obsAutoSwitchSceneToggle ?? false}
                      onChange={(e) => saveSettingsUpdates({ obsAutoSwitchSceneToggle: e.target.checked })}
                      style={{ width: '22px', height: '22px', accentColor: '#9146FF' }}
                    />
                  </label>
                </div>

                {/* 2. Only while streaming */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Only while streaming
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Leave OBS alone when you aren&apos;t live.
                    </div>
                  </div>
                  <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={settings.obsSwitchOnlyWhileStreaming ?? true}
                      onChange={(e) => saveSettingsUpdates({ obsSwitchOnlyWhileStreaming: e.target.checked })}
                      style={{ width: '22px', height: '22px', accentColor: '#9146FF' }}
                    />
                  </label>
                </div>

                {/* 3. Instant recovery */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Instant recovery
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Go back to LIVE the moment the feed recovers.
                    </div>
                  </div>
                  <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={settings.obsInstantRecovery ?? true}
                      onChange={(e) => saveSettingsUpdates({ obsInstantRecovery: e.target.checked })}
                      style={{ width: '22px', height: '22px', accentColor: '#9146FF' }}
                    />
                  </label>
                </div>

                {/* 4. Chat notification */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                      <span style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff' }}>
                        Chat notification
                      </span>
                      <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#38bdf8', background: 'rgba(56, 189, 248, 0.12)', border: '1px solid rgba(56, 189, 248, 0.25)', padding: '2px 7px', borderRadius: '12px' }}>
                        Needs chat bot
                      </span>
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Post in chat when a scene switches automatically. Pick the channels on the Chat page.
                    </div>
                  </div>
                  <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={settings.obsChatAlertsEnabled ?? true}
                      onChange={(e) => saveSettingsUpdates({ obsChatAlertsEnabled: e.target.checked })}
                      style={{ width: '22px', height: '22px', accentColor: '#9146FF' }}
                    />
                  </label>
                </div>

                {/* 5. Checks before switching */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Checks before switching
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Bad checks in a row before leaving LIVE; one check per second.
                    </div>
                  </div>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={settings.obsChecksBeforeSwitching ?? 5}
                    onChange={(e) => saveSettingsUpdates({ obsChecksBeforeSwitching: Number(e.target.value) || 5 })}
                    style={{ width: '64px', padding: '6px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.95rem', fontWeight: 700, textAlign: 'center' }}
                  />
                </div>
              </div>

              {/* CARD 2: Start, end & raids (Exact match to media_1793565680806_64deaffe.jpg) */}
              <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '22px' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 16px', color: '#fff' }}>
                  Start, end & raids
                </h3>

                {/* 1. Starting scene on go-live */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Starting scene on go-live
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Show the Starting scene when the stream starts.
                    </div>
                  </div>
                  <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={settings.obsStartingSceneOnGoLive ?? false}
                      onChange={(e) => saveSettingsUpdates({ obsStartingSceneOnGoLive: e.target.checked })}
                      style={{ width: '22px', height: '22px', accentColor: '#9146FF' }}
                    />
                  </label>
                </div>

                {/* 2. Ending scene on stream stop */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Ending scene on stream stop
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Switch to the Ending scene when the stream stops.
                    </div>
                  </div>
                  <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={settings.obsEndingSceneOnStreamStop ?? false}
                      onChange={(e) => saveSettingsUpdates({ obsEndingSceneOnStreamStop: e.target.checked })}
                      style={{ width: '22px', height: '22px', accentColor: '#9146FF' }}
                    />
                  </label>
                </div>

                {/* 3. Auto stop stream on raid */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Auto stop stream on raid
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Enable/disable stopping the stream on a raid.
                    </div>
                  </div>
                  <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={settings.obsAutoStopStreamOnRaid ?? false}
                      onChange={(e) => saveSettingsUpdates({ obsAutoStopStreamOnRaid: e.target.checked })}
                      style={{ width: '22px', height: '22px', accentColor: '#9146FF' }}
                    />
                  </label>
                </div>
              </div>

              {/* CARD 3: Engine Live Status */}
              <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '22px' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 14px', color: '#fff' }}>
                  Engine Live Status
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: '0.74rem', opacity: 0.6, textTransform: 'uppercase' }}>Current State</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: autoSwitchState === 'LIVE' ? '#4ade80' : autoSwitchState === 'LOW' ? '#fbbf24' : autoSwitchState === 'OFFLINE' ? '#f87171' : 'rgba(255,255,255,0.6)' }}>
                      {autoSwitchState === 'LIVE' ? '🟢 LIVE' : autoSwitchState === 'LOW' ? '🟡 LOW BITRATE' : autoSwitchState === 'OFFLINE' ? '🔴 BRB / OFFLINE' : '⏸️ IDLE'}
                    </div>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: '0.74rem', opacity: 0.6, textTransform: 'uppercase' }}>Ingest Bitrate</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: currentBitrate && currentBitrate > 0 ? '#38bdf8' : '#ef4444' }}>
                      {currentBitrate !== null ? `${currentBitrate.toLocaleString()} kbps` : 'OFFLINE'}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)', background: 'rgba(0,0,0,0.3)', padding: '8px 12px', borderRadius: '6px' }}>
                  <strong>Trigger Log:</strong> {lastSwitchLog || 'Normal stream ingest'}
                </div>
              </div>

            </div>

          </div>

        </div>
      )}

      {/* =====================================================================
          TAB 3: CHAT & COMMANDS (DIRECT INSPIRATION FROM USER SCREENSHOTS)
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
              {(settings.twitchToken || settings.twitchUsername) ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(145,70,255,0.25)', borderRadius: '8px', padding: '12px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: '#9146FF', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1.1rem' }}>
                      T
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>
                          @{settings.twitchUsername || 'Twitch Streamer'}
                        </span>
                        <span style={{ fontSize: '0.72rem', background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', border: '1px solid rgba(34, 197, 94, 0.3)', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● CONNECTED
                        </span>
                      </div>
                      <div style={{ fontSize: '0.78rem', opacity: 0.6 }}>Twitch Channel • Commands Active</div>
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
                      onClick={() => {
                        if (confirm('Disconnect Twitch account?')) {
                          saveSettingsUpdates({ twitchUsername: '', twitchToken: '', twitchBroadcasterId: '' });
                        }
                      }}
                      style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '1rem', padding: '4px' }}
                      title="Disconnect Twitch"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ width: '32px', height: '32px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontWeight: 'bold' }}>T</div>
                    <span style={{ fontSize: '0.88rem', color: 'rgba(255,255,255,0.6)' }}>No Twitch channel connected</span>
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={() => router.push('/twitch-auth')}
                    style={{ fontSize: '0.82rem', padding: '6px 14px', background: '#9146FF', borderColor: '#7c25f8' }}
                  >
                    🔗 Connect Twitch
                  </button>
                </div>
              )}

              {/* Kick Channel Item (Only rendered if kickChannelName is configured) */}
              {settings.kickChannelName ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(83,252,25,0.25)', borderRadius: '8px', padding: '12px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: '#53FC19', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1.1rem' }}>
                      K
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>
                          @{settings.kickChannelName}
                        </span>
                        <span style={{ fontSize: '0.72rem', background: 'rgba(83, 252, 25, 0.15)', color: '#53FC19', border: '1px solid rgba(83, 252, 25, 0.3)', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● CONNECTED
                        </span>
                      </div>
                      <div style={{ fontSize: '0.78rem', opacity: 0.6 }}>Kick Channel</div>
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
                      title="Remove Kick channel"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ) : null}
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>NOALBSbot</span>
                      {(settings.twitchToken || settings.twitchUsername) && (
                        <span style={{ fontSize: '0.72rem', background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', border: '1px solid rgba(34, 197, 94, 0.3)', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● ACTIVE ON @{settings.twitchUsername || 'TWITCH'}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.6 }}>Shared NOALBS bot</div>
                  </div>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() => showToast('Twitch bot ready and listening to chat commands', 'success')}
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>NOALBS</span>
                      {settings.kickChannelName && (
                        <span style={{ fontSize: '0.72rem', background: 'rgba(83, 252, 25, 0.15)', color: '#53FC19', border: '1px solid rgba(83, 252, 25, 0.3)', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● ACTIVE ON @{settings.kickChannelName}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.6 }}>Shared NOALBS bot</div>
                  </div>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() => showToast('Kick bot connection ready', 'info')}
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

          {/* OBS WebSocket Card in Settings Tab */}
          {renderObsWebSocketCard()}

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
