"use client";

import { useState, useEffect, useRef, useCallback, useMemo, memo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { OverlaySettings, DEFAULT_OVERLAY_SETTINGS, CommandConfigItem, DEFAULT_NOALBS_COMMANDS } from '@/types/settings';
import { fetchBitrateStats } from '@/utils/api-utils';
import { safeObsSwitchScene, safeObsStreamControlResult, safeObsRefreshCycle, getObsSceneItems, toggleObsSceneItem, removeObsSceneItem, type ObsSceneItemInfo } from '@/lib/obs-helper';
import { API_KEYS } from '@/utils/overlay-constants';
import type { ObsTelemetryStats } from '@/types/obs-telemetry';
import '@/styles/admin.css';

// Reusable purple toggle switch (memoized to prevent re-renders on ticker updates)
const PurpleToggle = memo(function PurpleToggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      style={{
        position: 'relative',
        width: '44px',
        height: '24px',
        borderRadius: '9999px',
        background: checked ? '#9146FF' : 'rgba(255, 255, 255, 0.18)',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background-color 0.2s ease, opacity 0.2s ease',
        padding: 0,
        outline: 'none',
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        display: 'inline-block',
        verticalAlign: 'middle',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '3px',
          left: checked ? '23px' : '3px',
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          background: '#ffffff',
          transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        }}
      />
    </button>
  );
});

// Hoisted pure helper functions outside component body to prevent recreation on each render
function cleanDisplayMessage(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/^[\s\u200B\uFE0F\u00A0]*(?:[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF]|[\u2000-\u32FF]|\u2600-\u26FF|✅|✔|✓|☑|❌|ℹ|ℹ️|🔒|🎬|🔄|⚡|⚠️|🛑|🚨|[\?❓])+\s*/u, '')
    .replace(/^(?:Program Scene is now: )*Program Scene is now: /g, 'Program Scene is now: ')
    .trim();
}

function isSpecialSceneName(name: string, s: OverlaySettings): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  const starting = (s.obsStartingSceneName || 'starting').trim().toLowerCase();
  const ending = (s.obsEndingSceneName || 'ending').trim().toLowerCase();
  const privacy = (s.obsPrivacySceneName || 'privacy').trim().toLowerCase();
  const refresh = (s.obsRefreshSceneName || 'refresh').trim().toLowerCase();

  return n === starting || n === ending || n === privacy || n === refresh ||
         n === 'starting' || n === 'ending' || n === 'privacy' || n === 'refresh' ||
         n.includes('starting') || n.includes('ending') || n.includes('priv') || n.includes('pause') ||
         (n.includes('refresh') && !n.includes('live'));
}

function isStartingSceneName(name: string, s: OverlaySettings): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  const starting = (s.obsStartingSceneName || 'starting').trim().toLowerCase();
  return n === starting || n === 'starting' || n.includes('starting') || n.includes('starting soon');
}

function isEndingSceneName(name: string, s: OverlaySettings): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  const ending = (s.obsEndingSceneName || 'ending').trim().toLowerCase();
  return n === ending || n === 'ending' || n.includes('ending');
}

function isPrivacySceneName(name: string, s: OverlaySettings): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  const privacy = (s.obsPrivacySceneName || 'privacy').trim().toLowerCase();
  return n === privacy || n === 'privacy' || n.includes('priv') || n.includes('pause');
}

function isRefreshSceneName(name: string, s: OverlaySettings): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  const refresh = (s.obsRefreshSceneName || 'refresh').trim().toLowerCase();
  return n === refresh || n === 'refresh' || (n.includes('refresh') && !n.includes('live'));
}

function isLiveSceneName(name: string, s: OverlaySettings): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  if (isSpecialSceneName(n, s)) return false;
  const live = (s.obsLiveSceneName || 'live').trim().toLowerCase();
  return n === live || (n.includes('live') && !n.includes('vertical'));
}

function isLowSceneName(name: string, s: OverlaySettings): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  if (isSpecialSceneName(n, s)) return false;
  const low = (s.obsLowSceneName || 'low').trim().toLowerCase();
  return n === low || n.includes('low');
}

function isOfflineSceneName(name: string, s: OverlaySettings): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  if (isSpecialSceneName(n, s)) return false;
  const offline = (s.obsOfflineSceneName || 'offline').trim().toLowerCase();
  return n === offline || (n.includes('offline') && !n.includes('vertical')) || n.includes('brb') || n.includes('be right back');
}

const DEFAULT_SCENE_PRESETS = [
  'live', 'low', 'offline', 'refresh', 'starting', 'ending', 'privacy',
  'Live', 'Low Bitrate', 'BRB', 'Offline', 'Starting Soon', 'Stream Ending', 'Stream Offline',
  'Just Chatting', 'Gameplay', 'Screen Share', 'Be Right Back', 'Reconnecting', 'Pause'
];

function getSourceIcon(kind: string = '', name: string = ''): string {
  const k = (kind || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (k === 'browser_source' || /(chat|overlay|alert|widget|hud|botrix|streamelements)/i.test(n)) return '🌐';
  if (k === 'ffmpeg_source' || k === 'vlc_source' || /(bela|belabox|srt|feed|stream|irl)/i.test(n)) return '📡';
  if (k.includes('monitor') || k.includes('display') || /(display|screen|desktop|monitor)/i.test(n)) return '🖥️';
  if (k.includes('window') || /(window|app|game)/i.test(n)) return '🪟';
  if (k.includes('dshow') || k.includes('video_capture') || /(cam|camera|webcam|c920|facecam)/i.test(n)) return '📷';
  if (k.includes('wasapi') || k.includes('audio') || k.includes('pulse') || /(mic|audio|sound|spotify|voice)/i.test(n)) return '🎙️';
  if (k.includes('image') || /(image|logo|photo|banner)/i.test(n)) return '🖼️';
  if (k.includes('text') || /(text|title|label)/i.test(n)) return '📝';
  if (k.includes('color') || /(color|bg|background)/i.test(n)) return '🎨';
  if (k.includes('group') || /(group|folder)/i.test(n)) return '📁';
  return '📦';
}

function getSourceKindBadge(kind: string = '', name: string = ''): { label: string; color: string; bg: string } {
  const k = (kind || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (k === 'browser_source' || /(chat|overlay|alert|widget)/i.test(n)) {
    return { label: 'Browser', color: '#c084fc', bg: 'rgba(192, 132, 252, 0.12)' };
  }
  if (k === 'ffmpeg_source' || k === 'vlc_source' || /(bela|belabox|srt)/i.test(n)) {
    return { label: 'Media Stream', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.12)' };
  }
  if (k.includes('monitor') || k.includes('display') || /(display|monitor)/i.test(n)) {
    return { label: 'Display Capture', color: '#4ade80', bg: 'rgba(74, 222, 128, 0.12)' };
  }
  if (k.includes('window') || k.includes('game')) {
    return { label: 'Window / Game', color: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.12)' };
  }
  if (k.includes('dshow') || /(cam|camera)/i.test(n)) {
    return { label: 'Camera', color: '#f43f5e', bg: 'rgba(244, 63, 94, 0.12)' };
  }
  if (k.includes('audio') || k.includes('wasapi')) {
    return { label: 'Audio', color: '#fb923c', bg: 'rgba(251, 146, 60, 0.12)' };
  }
  if (k.includes('image')) {
    return { label: 'Image', color: '#e879f9', bg: 'rgba(232, 121, 249, 0.12)' };
  }
  if (k.includes('text')) {
    return { label: 'Text', color: '#facc15', bg: 'rgba(250, 204, 21, 0.12)' };
  }
  return { label: kind ? kind.replace(/_source|_input|_v2/g, '') : 'Source', color: '#94a3b8', bg: 'rgba(255, 255, 255, 0.06)' };
}

function LowBitrateContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode = searchParams.get('mode') === 'overlay' ? 'overlay' : 'dashboard';

  const [mode, setMode] = useState<'dashboard' | 'overlay'>(initialMode);
  const [activeTab, setActiveTab] = useState<'switcher' | 'chat_commands' | 'switcher_options'>('switcher');
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULT_OVERLAY_SETTINGS);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; type: 'success' | 'error' | 'info'; timestamp: number }>>([]);

  // Bitrate and Stream Telemetry State
  const [currentBitrate, setCurrentBitrate] = useState<number | null>(null);
  const [currentRtt, setCurrentRtt] = useState<number | null>(null);
  const [bitrateHistory, setBitrateHistory] = useState<number[]>([]);
  const [obsConnected, setObsConnected] = useState<boolean>(false);
  const [currentScene, setCurrentScene] = useState<string>('');
  const [availableScenes, setAvailableScenes] = useState<string[]>([]);
  const [telemetry, setTelemetry] = useState<ObsTelemetryStats | null>(null);
  const telemetryRef = useRef<ObsTelemetryStats | null>(null);
  telemetryRef.current = telemetry;

  // Memoized scene updater with strict equality check to prevent needless re-renders
  const updateAvailableScenes = useCallback((scenes: string[]) => {
    if (!scenes || !Array.isArray(scenes)) return;
    setAvailableScenes(prev => {
      if (prev.length === scenes.length && prev.every((s, i) => s === scenes[i])) {
        return prev;
      }
      return scenes;
    });
  }, []);
  const [isSwitchingScene, setIsSwitchingScene] = useState<boolean>(false);
  const [showObsLogs, setShowObsLogs] = useState<boolean>(false);
  const [isScanningScenes, setIsScanningScenes] = useState<boolean>(false);
  const [customSceneMode, setCustomSceneMode] = useState<boolean>(false);

  // Sources (Scene Items) State for Active Scene
  const [sceneSources, setSceneSources] = useState<ObsSceneItemInfo[]>([]);
  const [isLoadingSources, setIsLoadingSources] = useState<boolean>(false);
  const [togglingSourceId, setTogglingSourceId] = useState<number | null>(null);
  const [removingSourceId, setRemovingSourceId] = useState<number | null>(null);
  const loadSceneSourcesRef = useRef<(targetScene?: string) => Promise<void>>(() => Promise.resolve());

  // OBS Action Controls State (Fix Feed, Record, Start Stream)
  const [localStreaming, setLocalStreaming] = useState<boolean | null>(null);
  const [localRecording, setLocalRecording] = useState<boolean | null>(null);
  const isStreaming = localStreaming !== null ? localStreaming : Boolean(telemetry?.streaming);
  const isRecording = localRecording !== null ? localRecording : Boolean(telemetry?.recording);
  const isObsOnline = obsConnected || Boolean(telemetry?.online);
  const [isFixingFeed, setIsFixingFeed] = useState<boolean>(false);
  const [isRefreshingFeed, setIsRefreshingFeed] = useState<boolean>(false);
  const [isTogglingRecord, setIsTogglingRecord] = useState<boolean>(false);
  const [isTogglingStream, setIsTogglingStream] = useState<boolean>(false);

  // Auto-switch State Machine (LIVE | LOW | OFFLINE | IDLE)
  const [autoSwitchState, setAutoSwitchState] = useState<'LIVE' | 'LOW' | 'OFFLINE' | 'IDLE'>('IDLE');
  const [lastSwitchLog, setLastSwitchLog] = useState<string>('Ready.');

  // Terminal / Command Console State
  const [commandInput, setCommandInput] = useState<string>('');
  const [commandLogs, setCommandLogs] = useState<Array<{ id: string; time: string; text: string; type: 'cmd' | 'res' | 'err' }>>([
    { id: 'init-1', time: new Date().toLocaleTimeString(), text: 'Switcher Stream Engine initialized. Ready for commands.', type: 'res' },
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
  const [isTestingEndChat, setIsTestingEndChat] = useState<boolean>(false);

  const handleTestEndStreamMessage = async () => {
    const msg = (settings.obsEndingChatMessage || 'Thanks for watching everyone! Stream is now ending. See you next time! ❤️').trim();
    if (!msg) {
      showToast('Please enter an end stream message first.', 'error');
      return;
    }
    setIsTestingEndChat(true);
    try {
      const res = await fetch('/api/twitch-announcement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        showToast('Test end-stream message posted to Twitch chat!', 'success');
      } else {
        showToast(`Could not send: ${data?.reason || data?.error || 'Check Twitch connection in Settings'}`, 'error');
      }
    } catch (err: any) {
      showToast(`Error sending test message: ${err.message}`, 'error');
    } finally {
      setIsTestingEndChat(false);
    }
  };
  const [showManualBotInput, setShowManualBotInput] = useState<boolean>(false);
  const [manualBotUsername, setManualBotUsername] = useState<string>('');
  const [manualBotToken, setManualBotToken] = useState<string>('');

  const handleConnectCustomBot = () => {
    const clientId = API_KEYS?.TWITCH_CLIENT_ID || 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw';
    const redirectUri = window.location.origin + '/twitch-auth';
    const scope = encodeURIComponent('channel:read:subscriptions moderator:manage:announcements user:write:chat chat:edit chat:read clips:edit');
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${scope}&state=bot&force_verify=true`;
    window.location.href = authUrl;
  };

  // OBS WebSocket inputs
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

        // Ground-truth status poller directly from local OBS WebSocket
        const syncObsOutputStatus = async () => {
          if (!isActive || !localObsRef.current) return;
          try {
            const streamData: any = await obs.call('GetStreamStatus').catch(() => null);
            const recordData: any = await obs.call('GetRecordStatus').catch(() => null);

            const live = streamData !== null ? Boolean(streamData?.outputActive) : null;
            const rec = recordData !== null ? Boolean(recordData?.outputActive) : null;
            const uptime = streamData?.outputTimecode;

            if (live !== null) {
              setLocalStreaming(prev => prev === live ? prev : live);
              wasStreamingRef.current = live;
            }
            if (rec !== null) {
              setLocalRecording(prev => prev === rec ? prev : rec);
            }

            if (live !== null || rec !== null) {
              setTelemetry(prev => {
                const nextStreaming = live !== null ? live : (prev?.streaming ?? false);
                const nextRecording = rec !== null ? rec : (prev?.recording ?? false);
                const nextUptime = uptime || prev?.uptimeTimecode || '00:00:00';
                if (
                  prev &&
                  prev.streaming === nextStreaming &&
                  prev.recording === nextRecording &&
                  prev.uptimeTimecode === nextUptime
                ) {
                  return prev;
                }
                return prev ? {
                  ...prev,
                  streaming: nextStreaming,
                  recording: nextRecording,
                  uptimeTimecode: nextUptime
                } : {
                  online: true,
                  streaming: nextStreaming,
                  recording: nextRecording,
                  scenes: [],
                  updatedAt: Date.now(),
                  uptimeTimecode: nextUptime
                } as ObsTelemetryStats;
              });
            }
          } catch {}
        };

        const sceneData: any = await obs.call('GetSceneList').catch(() => null);
        const scenes = sceneData?.scenes ? sceneData.scenes.map((s: any) => String(s.sceneName || s.name || '')).filter(Boolean) : [];
        const currentProg = sceneData?.currentProgramSceneName || '';
        if (currentProg) {
          setCurrentScene(prev => prev === currentProg ? prev : currentProg);
          currentSceneRef.current = currentProg;
          loadSceneSourcesRef.current(currentProg);
          if (isLiveSceneName(currentProg, settingsRef.current)) {
            setAutoSwitchState('LIVE');
          } else if (isLowSceneName(currentProg, settingsRef.current)) {
            setAutoSwitchState('LOW');
          } else if (isOfflineSceneName(currentProg, settingsRef.current)) {
            setAutoSwitchState('OFFLINE');
          }
        }
        if (scenes.length > 0) updateAvailableScenes(scenes);

        await syncObsOutputStatus();
        const statusPollTimer = setInterval(syncObsOutputStatus, 1500);

        fetch('/api/obs-telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ online: true, streaming: Boolean(wasStreamingRef.current), currentScene: currentProg, scenes })
        }).catch(() => {});

        obs.on('CurrentProgramSceneChanged' as any, (data: any) => {
          const sName = data?.sceneName || data?.currentProgramSceneName;
          if (sName) {
            setCurrentScene(prev => prev === sName ? prev : sName);
            currentSceneRef.current = sName;
            lastManualSceneSwitchTimeRef.current = Date.now();
            loadSceneSourcesRef.current(sName);

            if (isSpecialSceneName(sName, settingsRef.current)) {
              const startSceneNorm = (settingsRef.current.obsStartingSceneName || 'starting').trim().toLowerCase();
              const isStartingName = sName.trim().toLowerCase() === startSceneNorm || sName.toLowerCase().includes('starting');
              if (isStartingName && startingCheckStartRef.current > 0) {
                manualOverrideUntilRef.current = 0;
              } else {
                manualOverrideUntilRef.current = Date.now() + 86400000;
              }
              setAutoSwitchState('IDLE');
              setLastSwitchLog(`[${new Date().toLocaleTimeString()}] 🔒 On Special Scene "${sName}" — Auto-switching PAUSED`);
            } else if (isLiveSceneName(sName, settingsRef.current)) {
              manualOverrideUntilRef.current = 0;
              startingCheckStartRef.current = 0;
              setIsCheckingStartingBelabox(false);
              setStartingCheckRemainingSeconds(0);
              setAutoSwitchState('LIVE');
            } else if (isLowSceneName(sName, settingsRef.current)) {
              setAutoSwitchState('LOW');
            } else if (isOfflineSceneName(sName, settingsRef.current)) {
              setAutoSwitchState('OFFLINE');
            }

            fetch('/api/obs-telemetry', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ online: true, streaming: Boolean(wasStreamingRef.current), currentScene: sName })
            }).catch(() => {});
          }
        });

        obs.on('SceneListChanged' as any, async (d: any) => {
          try {
            const rawScenes = d?.scenes || (await obs.call('GetSceneList'))?.scenes || [];
            const newScenes = rawScenes.map((s: any) => String(s.sceneName || s.name || '')).filter(Boolean);
            if (newScenes.length > 0) {
              updateAvailableScenes(newScenes);
              fetch('/api/obs-telemetry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ online: true, scenes: newScenes })
              }).catch(() => {});
            }
          } catch {}
        });

        // Instant source visibility sync when toggled directly inside OBS Studio
        obs.on('SceneItemEnableStateChanged' as any, (data: any) => {
          const sName = data?.sceneName;
          const itemId = Number(data?.sceneItemId);
          const isEnabled = Boolean(data?.sceneItemEnabled);
          if (!sName || sName === currentSceneRef.current) {
            setSceneSources(prev => prev.map(item => item.id === itemId ? { ...item, enabled: isEnabled } : item));
          }
        });

        // Instant reload when sources are added, removed, or reordered in OBS Studio
        obs.on('SceneItemListChanged' as any, (data: any) => {
          const sName = data?.sceneName;
          if (!sName || sName === currentSceneRef.current) {
            loadSceneSourcesRef.current(currentSceneRef.current);
          }
        });

        obs.on('StreamStateChanged' as any, (data: any) => {
          const outputState = String(data?.outputState || '');
          const isLive = Boolean(data?.outputActive);

          // If OBS is actively connecting to stream, show loading and NEVER switch to ending!
          if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTING') {
            setIsTogglingStream(true);
            return;
          }

          // If OBS is actively disconnecting, show loading
          if (outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPING') {
            setIsTogglingStream(true);
            return;
          }

          setLocalStreaming(isLive);
          setIsTogglingStream(false);
          setTelemetry(prev => prev ? { ...prev, streaming: isLive } : { online: true, streaming: isLive } as any);
          fetch('/api/obs-telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ online: true, streaming: isLive })
          }).catch(() => {});

          const wasLiveBefore = wasStreamingRef.current;
          wasStreamingRef.current = isLive;

          if (isLive) {
            // Stream just went live! Switch to configured starting scene if enabled
            if (!wasLiveBefore && (settingsRef.current.obsStartingSceneOnGoLive ?? true)) {
              const startScene = settingsRef.current.obsStartingSceneName || 'starting';
              const checkSec = Math.max(60, settingsRef.current.obsStartingSceneCheckSeconds ?? 60);
              startingCheckStartRef.current = Date.now();
              manualOverrideUntilRef.current = 0;
              setIsCheckingStartingBelabox(true);
              setStartingCheckRemainingSeconds(checkSec);
              currentSceneRef.current = startScene;
              setCurrentScene(startScene);
              switchScene(startScene, 'Stream Started');
            }
          } else {
            startingCheckStartRef.current = 0;
            setIsCheckingStartingBelabox(false);
            setStartingCheckRemainingSeconds(0);
            if (wasLiveBefore) {
              if (settingsRef.current.obsEndingChatMessageEnabled && settingsRef.current.obsEndingChatMessage) {
                const endMsg = settingsRef.current.obsEndingChatMessage.trim();
                if (endMsg) {
                  fetch('/api/twitch-announcement', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: endMsg, dedupKey: 'end_stream_chat' })
                  }).catch(() => {});
                }
              }
            }
          }
        });

        obs.on('RecordStateChanged' as any, (data: any) => {
          const isRec = Boolean(data?.outputActive);
          setLocalRecording(isRec);
          setTelemetry(prev => prev ? { ...prev, recording: isRec } : { online: true, recording: isRec } as any);
          fetch('/api/obs-telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ online: true, recording: isRec })
          }).catch(() => {});
        });

        obs.on('ConnectionClosed', () => {
          clearInterval(statusPollTimer);
          localObsRef.current = null;
          setObsConnected(false);
          setLocalStreaming(null);
          setLocalRecording(null);
          if (isActive) retryTimer = setTimeout(connectLocalObs, 5000);
        });
      } catch {
        setObsConnected(false);
        setLocalStreaming(null);
        setLocalRecording(null);
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
  const desktopCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mobileCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentSceneRef = useRef(currentScene);
  const currentBitrateRef = useRef<number | null>(currentBitrate);
  const belaboxFetchFailuresRef = useRef<number>(0);
  const lastManualSceneSwitchTimeRef = useRef<number>(0);
  const wasStreamingRef = useRef<boolean>(false);
  const startingCheckStartRef = useRef<number>(0);
  const [isCheckingStartingBelabox, setIsCheckingStartingBelabox] = useState<boolean>(false);
  const [startingCheckRemainingSeconds, setStartingCheckRemainingSeconds] = useState<number>(0);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    autoSwitchStateRef.current = autoSwitchState;
  }, [autoSwitchState]);

  useEffect(() => {
    currentSceneRef.current = currentScene;
  }, [currentScene]);

  useEffect(() => {
    currentBitrateRef.current = currentBitrate;
  }, [currentBitrate]);

  // Synchronize autoSwitchState when currentScene updates from OBS or telemetry
  useEffect(() => {
    if (!currentScene) return;
    if (isLiveSceneName(currentScene, settingsRef.current)) {
      if (autoSwitchStateRef.current === 'IDLE') {
        setAutoSwitchState('LIVE');
      }
    } else if (isLowSceneName(currentScene, settingsRef.current)) {
      if (autoSwitchStateRef.current === 'IDLE') {
        setAutoSwitchState('LOW');
      }
    } else if (isOfflineSceneName(currentScene, settingsRef.current)) {
      if (autoSwitchStateRef.current === 'IDLE') {
        setAutoSwitchState('OFFLINE');
      }
    }
  }, [currentScene]);

  // Derived switcher display state that accurately reflects the current OBS scene and auto-switching activity
  const switcherDisplayState = useMemo(() => {
    const scene = (currentScene || '').trim();
    const isAutoSwitchActive = Boolean(settings.obsAutoSwitchSceneToggle);

    if (isCheckingStartingBelabox) {
      return {
        badgeText: `⏱️ CHECKING BELABOX (${startingCheckRemainingSeconds}s)`,
        shortBadge: `⏱️ CHECKING (${startingCheckRemainingSeconds}s)`,
        subText: `Waiting for feed to go live (${startingCheckRemainingSeconds}s left)`,
        color: '#c084fc',
        bg: 'rgba(168, 85, 247, 0.2)',
        border: 'rgba(192, 132, 252, 0.4)',
        progressPercent: 30,
        progressBarColor: '#a855f7',
        stateKey: 'STARTING_CHECK'
      };
    }

    const isStarting = isStartingSceneName(scene, settings);
    const isEnding = isEndingSceneName(scene, settings);
    const isPrivacy = isPrivacySceneName(scene, settings);
    const isRefresh = isRefreshSceneName(scene, settings);

    if (isStarting) {
      return {
        badgeText: '🎬 STARTING',
        shortBadge: '🎬 STARTING',
        subText: isAutoSwitchActive ? 'Auto-switch holding on Starting Scene' : 'On Starting Scene',
        color: '#c084fc',
        bg: 'rgba(192, 132, 252, 0.2)',
        border: 'rgba(192, 132, 252, 0.4)',
        progressPercent: 20,
        progressBarColor: '#c084fc',
        stateKey: 'STARTING'
      };
    }

    if (isEnding) {
      return {
        badgeText: '🛑 ENDING',
        shortBadge: '🛑 ENDING',
        subText: 'Auto-switching paused on Ending Scene',
        color: '#f43f5e',
        bg: 'rgba(244, 63, 94, 0.2)',
        border: 'rgba(244, 63, 94, 0.4)',
        progressPercent: 10,
        progressBarColor: '#f43f5e',
        stateKey: 'ENDING'
      };
    }

    if (isPrivacy) {
      return {
        badgeText: '🔒 PRIVACY',
        shortBadge: '🔒 PRIVACY',
        subText: 'Auto-switching paused on Privacy Scene',
        color: '#fb923c',
        bg: 'rgba(251, 146, 60, 0.2)',
        border: 'rgba(251, 146, 60, 0.4)',
        progressPercent: 15,
        progressBarColor: '#fb923c',
        stateKey: 'PRIVACY'
      };
    }

    if (isRefresh) {
      return {
        badgeText: '🔄 REFRESH',
        shortBadge: '🔄 REFRESH',
        subText: 'Refreshing feed in OBS...',
        color: '#38bdf8',
        bg: 'rgba(56, 189, 248, 0.2)',
        border: 'rgba(56, 189, 248, 0.4)',
        progressPercent: 25,
        progressBarColor: '#38bdf8',
        stateKey: 'REFRESH'
      };
    }

    const isLive = isLiveSceneName(scene, settings) || autoSwitchState === 'LIVE';
    const isLow = isLowSceneName(scene, settings) || autoSwitchState === 'LOW';
    const isOff = isOfflineSceneName(scene, settings) || autoSwitchState === 'OFFLINE';

    if (isOff && !isLive && !isLow) {
      return {
        badgeText: '🔴 BRB / OFFLINE',
        shortBadge: '🔴 BRB',
        subText: isAutoSwitchActive ? 'Feed offline — Auto-reconnect active' : 'On BRB / Offline (manual)',
        color: '#f87171',
        bg: 'rgba(239, 68, 68, 0.2)',
        border: 'rgba(239, 68, 68, 0.4)',
        progressPercent: 15,
        progressBarColor: '#ef4444',
        stateKey: 'OFFLINE'
      };
    }

    if (isLow && !isLive) {
      return {
        badgeText: '🟡 LOW BITRATE',
        shortBadge: '🟡 LOW',
        subText: isAutoSwitchActive ? 'Feed degraded — Auto-recovery active' : 'On Low Bitrate (manual)',
        color: '#fbbf24',
        bg: 'rgba(245, 158, 11, 0.2)',
        border: 'rgba(245, 158, 11, 0.4)',
        progressPercent: 50,
        progressBarColor: '#eab308',
        stateKey: 'LOW'
      };
    }

    if (isLive) {
      return {
        badgeText: '🟢 LIVE',
        shortBadge: '🟢 LIVE',
        subText: isAutoSwitchActive ? 'Auto-Switching is ACTIVE' : 'Switcher is DISABLED',
        color: '#4ade80',
        bg: 'rgba(34, 197, 94, 0.2)',
        border: 'rgba(34, 197, 94, 0.4)',
        progressPercent: 100,
        progressBarColor: '#22c55e',
        stateKey: 'LIVE'
      };
    }

    if (scene) {
      return {
        badgeText: `🎬 ${scene}`,
        shortBadge: `🎬 ${scene.length > 14 ? scene.substring(0, 12) + '…' : scene}`,
        subText: 'Custom scene — Auto-switch paused',
        color: '#818cf8',
        bg: 'rgba(129, 140, 248, 0.2)',
        border: 'rgba(129, 140, 248, 0.4)',
        progressPercent: 40,
        progressBarColor: '#818cf8',
        stateKey: 'CUSTOM'
      };
    }

    if (!isAutoSwitchActive) {
      return {
        badgeText: '⏸️ DISABLED',
        shortBadge: '⏸️ DISABLED',
        subText: 'Switcher is DISABLED in options',
        color: 'rgba(255, 255, 255, 0.5)',
        bg: 'rgba(255, 255, 255, 0.08)',
        border: 'rgba(255, 255, 255, 0.15)',
        progressPercent: 0,
        progressBarColor: 'rgba(255, 255, 255, 0.2)',
        stateKey: 'IDLE'
      };
    }

    return {
      badgeText: isObsOnline ? '⚪ MONITORING' : '⚪ CONNECTING',
      shortBadge: isObsOnline ? '⚪ MONITORING' : 'STANDBY',
      subText: isObsOnline ? 'Auto-Switching is ACTIVE' : 'Connecting to OBS WebSocket...',
      color: isObsOnline ? '#38bdf8' : 'rgba(255, 255, 255, 0.7)',
      bg: isObsOnline ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255, 255, 255, 0.1)',
      border: isObsOnline ? 'rgba(56, 189, 248, 0.3)' : 'rgba(255, 255, 255, 0.2)',
      progressPercent: isObsOnline ? 20 : 0,
      progressBarColor: isObsOnline ? '#38bdf8' : 'rgba(255, 255, 255, 0.3)',
      stateKey: 'IDLE'
    };
  }, [currentScene, autoSwitchState, isCheckingStartingBelabox, startingCheckRemainingSeconds, settings, isObsOnline]);

  // Dedicated 1-second countdown ticker for Belabox starting check UI
  useEffect(() => {
    if (!isCheckingStartingBelabox || startingCheckStartRef.current === 0) {
      return;
    }
    const checkWindowSec = Math.max(60, settingsRef.current.obsStartingSceneCheckSeconds ?? 60);
    const checkDurationMs = checkWindowSec * 1000;

    const tick = () => {
      if (startingCheckStartRef.current === 0) return;
      const elapsedMs = Math.max(0, Date.now() - startingCheckStartRef.current);
      const remainingSec = Math.max(0, Math.ceil((checkDurationMs - elapsedMs) / 1000));
      setStartingCheckRemainingSeconds(remainingSec);
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isCheckingStartingBelabox]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback((rawMessage: string, type: 'success' | 'error' | 'info' = 'success', durationMs: number = 4500) => {
    if (!rawMessage) return;
    // Strip any leading icons, checkmarks or emoji symbols so toasts never double-render icons
    const cleanMessage = cleanDisplayMessage(rawMessage);
    if (!cleanMessage) return;

    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newToast = {
      id,
      message: cleanMessage,
      type,
      timestamp: Date.now()
    };

    setToasts(prev => {
      // Don't flood with identical duplicate messages in quick succession (<2s)
      const recentDup = prev.find(t => t.message === cleanMessage && Date.now() - t.timestamp < 2000);
      if (recentDup) return prev;
      return [...prev.slice(-3), newToast];
    });

    setTimeout(() => {
      removeToast(id);
    }, durationMs);
  }, [removeToast]);

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
        const conn = Boolean(data.connected);
        setObsConnected(prev => prev === conn ? prev : conn);
        if (data.scenes && Array.isArray(data.scenes) && data.scenes.length > 0) {
          updateAvailableScenes(data.scenes);
        }
        // Protect against stale cloud KV overwriting fresh user scene choices
        const isRecentlySwitched = Date.now() - lastManualSceneSwitchTimeRef.current < 8000;
        if (data.currentScene && !localObsRef.current && !isRecentlySwitched) {
          setCurrentScene(prev => prev === data.currentScene ? prev : data.currentScene);
        }
      } else {
        setObsConnected(prev => prev === false ? prev : false);
      }
    } catch {
      setObsConnected(prev => prev === false ? prev : false);
    }
  }, [updateAvailableScenes]);

  useEffect(() => {
    let isCancelled = false;
    let sceneTimer: NodeJS.Timeout;

    const runSceneRefresh = async () => {
      await refreshObsScenes();
      if (isCancelled) return;
      const delay = (typeof document !== 'undefined' && document.hidden) ? 12000 : 5000;
      sceneTimer = setTimeout(runSceneRefresh, delay);
    };

    runSceneRefresh();
    return () => {
      isCancelled = true;
      clearTimeout(sceneTimer);
    };
  }, [refreshObsScenes]);

  // 3. Fetch OBS Telemetry (FPS, Dropped Frames, CPU, Scenes)
  const fetchTelemetry = useCallback(async () => {
    try {
      const res = await fetch('/api/obs-telemetry');
      if (res.ok) {
        const data = await res.json();
        const nextStreaming = localStreaming !== null ? localStreaming : Boolean(data.streaming);
        const nextRecording = localRecording !== null ? localRecording : Boolean(data.recording);
        setTelemetry(prev => {
          const nextUptime = data.uptimeTimecode || prev?.uptimeTimecode || '00:00:00';
          if (
            prev &&
            prev.online === data.online &&
            prev.streaming === nextStreaming &&
            prev.recording === nextRecording &&
            prev.fps === data.fps &&
            prev.cpuUsagePercent === data.cpuUsagePercent &&
            prev.droppedFrames === data.droppedFrames &&
            prev.outputBitrateKbps === data.outputBitrateKbps &&
            prev.currentScene === data.currentScene &&
            prev.uptimeTimecode === nextUptime &&
            prev.scenes?.length === data.scenes?.length
          ) {
            return prev;
          }
          return {
            ...data,
            streaming: nextStreaming,
            recording: nextRecording,
            uptimeTimecode: nextUptime
          };
        });
        if (data.scenes && Array.isArray(data.scenes) && data.scenes.length > 0) {
          updateAvailableScenes(data.scenes);
        }
        // Protect against stale cloud telemetry overwriting active user scene
        const isRecentlySwitched = Date.now() - lastManualSceneSwitchTimeRef.current < 8000;
        if (data.currentScene && !localObsRef.current && !isRecentlySwitched) {
          setCurrentScene(prev => prev === data.currentScene ? prev : data.currentScene);
        }
        // Sync sources from cloud telemetry on mobile devices (where localObsRef is disconnected)
        if (data.currentSceneSources && Array.isArray(data.currentSceneSources) && data.currentSceneSources.length > 0) {
          if (!localObsRef.current) {
            setSceneSources(prev => {
              if (
                prev.length === data.currentSceneSources.length &&
                prev.every((p: any, idx: number) => p.id === data.currentSceneSources[idx]?.id && p.enabled === data.currentSceneSources[idx]?.enabled)
              ) {
                return prev;
              }
              return data.currentSceneSources;
            });
          }
        }
      }
    } catch {}
  }, [localStreaming, localRecording, updateAvailableScenes]);

  useEffect(() => {
    let isCancelled = false;
    let telTimer: NodeJS.Timeout;

    const runTelemetryPoll = async () => {
      await fetchTelemetry();
      if (isCancelled) return;
      const delay = (typeof document !== 'undefined' && document.hidden) ? 4000 : 1500;
      telTimer = setTimeout(runTelemetryPoll, delay);
    };

    runTelemetryPoll();
    return () => {
      isCancelled = true;
      clearTimeout(telTimer);
    };
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
            updateAvailableScenes(scenes);
            if (sceneData?.currentProgramSceneName) setCurrentScene(prev => prev === sceneData.currentProgramSceneName ? prev : sceneData.currentProgramSceneName);
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
          updateAvailableScenes(scenes);
          if (sceneData?.currentProgramSceneName) setCurrentScene(prev => prev === sceneData.currentProgramSceneName ? prev : sceneData.currentProgramSceneName);
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
          updateAvailableScenes(data.scenes);
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

  // 3b. Load scene sources / scene items for active scene
  const loadSceneSources = useCallback(async (targetScene?: string) => {
    const sceneToLoad = targetScene || currentSceneRef.current || telemetryRef.current?.currentScene;
    if (!sceneToLoad) return;
    setIsLoadingSources(true);
    try {
      // 1. Direct local OBS WebSocket call if available (< 2ms)
      if (localObsRef.current) {
        const items = await getObsSceneItems(localObsRef.current, sceneToLoad);
        if (items && items.length > 0) {
          setSceneSources(items);
          setIsLoadingSources(false);
          // Push to cloud telemetry so mobile devices (phones) get the updated source list immediately
          fetch('/api/obs-telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ online: true, currentScene: sceneToLoad, currentSceneSources: items })
          }).catch(() => {});
          return;
        }
      }

      // 2. Fallback via /api/obs-sources (queries cloud KV on mobile devices)
      const res = await fetch(`/api/obs-sources?sceneName=${encodeURIComponent(sceneToLoad)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.sources) && data.sources.length > 0) {
          setSceneSources(data.sources);
        }
      }
    } catch (err) {
      console.warn('Failed to load scene sources:', err);
    } finally {
      setIsLoadingSources(false);
    }
  }, []);

  loadSceneSourcesRef.current = loadSceneSources;

  // Auto-load sources when currentScene changes
  useEffect(() => {
    if (currentScene) {
      loadSceneSources(currentScene);
    }
  }, [currentScene, loadSceneSources]);

  // Toggle individual source visibility (SetSceneItemEnabled)
  const handleToggleSource = async (item: ObsSceneItemInfo) => {
    const targetScene = currentSceneRef.current || currentScene;
    if (!targetScene) {
      showToast('No active scene selected.', 'error');
      return;
    }

    const nextState = !item.enabled;
    setTogglingSourceId(item.id);

    // Optimistic UI update for instant feedback (< 1ms)
    setSceneSources(prev => prev.map(s => s.id === item.id ? { ...s, enabled: nextState } : s));

    try {
      let directSuccess = false;
      if (localObsRef.current) {
        directSuccess = await toggleObsSceneItem(
          localObsRef.current,
          targetScene,
          item.id,
          nextState,
          item.name
        );
      }

      if (!directSuccess) {
        // Fallback: Call API route to relay or broadcast signal to OBS
        const res = await fetch('/api/obs-sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sceneName: targetScene,
            sceneItemId: item.id,
            enabled: nextState,
            sourceName: item.name,
            obsUrl: settingsRef.current.obsWebsocketUrl || `ws://127.0.0.1:${settingsRef.current.obsWebsocketPort || 4455}`,
            obsPassword: settingsRef.current.obsWebsocketPassword
          })
        });
        const result = await res.json();
        if (!result.success) {
          // Revert optimistic update
          setSceneSources(prev => prev.map(s => s.id === item.id ? { ...s, enabled: item.enabled } : s));
          showToast(result.error || 'Failed to toggle source visibility', 'error');
          return;
        }
      }

      showToast(`Source "${item.name}" is now ${nextState ? 'visible 👁️' : 'hidden 🙈'}`, 'info');
    } catch (err: any) {
      // Revert optimistic update
      setSceneSources(prev => prev.map(s => s.id === item.id ? { ...s, enabled: item.enabled } : s));
      showToast(`Toggle failed: ${err.message}`, 'error');
    } finally {
      setTogglingSourceId(null);
    }
  };

  // Toggle all sources in the active scene
  const handleToggleAllSources = async (enableAll: boolean) => {
    const targetScene = currentSceneRef.current || currentScene;
    if (!targetScene || sceneSources.length === 0) return;

    // Optimistic update
    setSceneSources(prev => prev.map(s => ({ ...s, enabled: enableAll })));

    for (const item of sceneSources) {
      if (item.enabled === enableAll) continue;
      if (localObsRef.current) {
        toggleObsSceneItem(localObsRef.current, targetScene, item.id, enableAll, item.name).catch(() => {});
      } else {
        fetch('/api/obs-sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sceneName: targetScene,
            sceneItemId: item.id,
            enabled: enableAll,
            sourceName: item.name
          })
        }).catch(() => {});
      }
    }
    showToast(`All sources in "${targetScene}" set to ${enableAll ? 'Visible' : 'Hidden'}`, 'info');
  };

  // Remove individual source (RemoveSceneItem)
  const handleRemoveSource = async (item: ObsSceneItemInfo) => {
    const targetScene = currentSceneRef.current || currentScene;
    if (!targetScene) {
      showToast('No active scene selected.', 'error');
      return;
    }

    const confirmMsg = `Remove source "${item.name}" from scene "${targetScene}"?`;
    if (typeof window !== 'undefined' && !window.confirm(confirmMsg)) {
      return;
    }

    setRemovingSourceId(item.id);

    // Optimistic UI update: immediately remove from list
    const previousSources = [...sceneSources];
    setSceneSources(prev => prev.filter(s => s.id !== item.id));

    try {
      let directSuccess = false;
      if (localObsRef.current) {
        directSuccess = await removeObsSceneItem(
          localObsRef.current,
          targetScene,
          item.id,
          item.name
        );
      }

      if (!directSuccess) {
        // Fallback: Call API route to relay or broadcast signal to OBS
        const res = await fetch('/api/obs-sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'remove',
            sceneName: targetScene,
            sceneItemId: item.id,
            sourceName: item.name,
            obsUrl: settingsRef.current.obsWebsocketUrl || `ws://127.0.0.1:${settingsRef.current.obsWebsocketPort || 4455}`,
            obsPassword: settingsRef.current.obsWebsocketPassword
          })
        });
        const result = await res.json();
        if (!result.success) {
          // Revert optimistic update
          setSceneSources(previousSources);
          showToast(result.error || 'Failed to remove source', 'error');
          return;
        }
      }

      // Update cloud telemetry
      fetch('/api/obs-telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          online: true,
          currentScene: targetScene,
          currentSceneSources: previousSources.filter(s => s.id !== item.id)
        })
      }).catch(() => {});

      showToast(`Source "${item.name}" removed from "${targetScene}" 🗑️`, 'success');
    } catch (err: any) {
      // Revert optimistic update
      setSceneSources(previousSources);
      showToast(`Remove failed: ${err.message}`, 'error');
    } finally {
      setRemovingSourceId(null);
    }
  };

  // 4. Save settings changes
  const saveSettingsUpdates = async (updates: Partial<OverlaySettings>, options?: { silent?: boolean }) => {
    setSaving(true);
    setSettings(prev => ({ ...prev, ...updates }));
    try {
      const res = await fetch('/api/save-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: updates })
      });
      if (res.ok) {
        if (!options?.silent) {
          showToast('Settings saved & synced to overlay!', 'success');
        }
      } else {
        if (!options?.silent) {
          showToast('Failed to save settings to cloud.', 'error');
        }
      }
    } catch (err: any) {
      if (!options?.silent) {
        showToast(`Save error: ${err.message}`, 'error');
      }
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

    const currentSettings = settingsRef.current;
    const now = Date.now();
    lastManualSceneSwitchTimeRef.current = now;

    // 1. Instant Optimistic State Update (< 1ms)
    setCurrentScene(sceneName);
    currentSceneRef.current = sceneName;
    loadSceneSourcesRef.current(sceneName);
    setIsSwitchingScene(true);
    // Quick 80ms throttle so user can click between scenes (starting -> ending) with 0 delay!
    setTimeout(() => setIsSwitchingScene(false), 80);

    const logText = `Switching to: "${sceneName}" (${reason})...`;
    setLastSwitchLog(logText);

    const isSpecial = isSpecialSceneName(sceneName, currentSettings);
    const isLiveTarget = isLiveSceneName(sceneName, currentSettings);
    const isLowTarget = isLowSceneName(sceneName, currentSettings);
    const isOfflineTarget = isOfflineSceneName(sceneName, currentSettings);
    const startSceneNorm = (currentSettings.obsStartingSceneName || 'starting').trim().toLowerCase();
    const isStartingTarget = sceneName.trim().toLowerCase() === startSceneNorm || sceneName.toLowerCase().includes('starting');

    if (reason && (reason.includes('Stream Started') || reason.includes('Starting check') || reason.includes('Enforcing Starting Scene'))) {
      // Keep checking
    } else {
      startingCheckStartRef.current = 0;
      setIsCheckingStartingBelabox(false);
      setStartingCheckRemainingSeconds(0);
    }

    if (isSpecial) {
      // Special scene (Starting, Ending, Privacy, Refresh):
      if (isStartingTarget && (startingCheckStartRef.current > 0 || (reason && reason.includes('Stream Started')))) {
        manualOverrideUntilRef.current = 0;
      } else {
        manualOverrideUntilRef.current = now + 86400000;
      }
      setAutoSwitchState('IDLE');
      setLastSwitchLog(`[${new Date().toLocaleTimeString()}] 🔒 On Special Scene "${sceneName}" — Auto-switching PAUSED`);
    } else if (isLiveTarget) {
      // Streamer manually chose LIVE: hold for 20s grace period so camera feed can connect before auto-evaluating
      manualOverrideUntilRef.current = now + 20000;
      lowCountRef.current = 0;
      offlineCountRef.current = 0;
      liveCountRef.current = 0;
      setAutoSwitchState('LIVE');
      setLastSwitchLog(`[${new Date().toLocaleTimeString()}] 🟢 Switched to LIVE (manual hold for 20s)`);
    } else if (isLowTarget) {
      manualOverrideUntilRef.current = now + 60000;
      setAutoSwitchState('LOW');
      setLastSwitchLog(`[${new Date().toLocaleTimeString()}] ⏸️ Switched to Low Bitrate (holding for 60s)`);
    } else if (isOfflineTarget) {
      manualOverrideUntilRef.current = now + 60000;
      setAutoSwitchState('OFFLINE');
      setLastSwitchLog(`[${new Date().toLocaleTimeString()}] ⏸️ Switched to BRB/Offline (holding for 60s)`);
    } else {
      // Custom detected OBS scene: pause auto-switching so streamer stays on it
      manualOverrideUntilRef.current = now + 86400000;
      setAutoSwitchState('IDLE');
      setLastSwitchLog(`[${new Date().toLocaleTimeString()}] 🔒 On Custom Scene "${sceneName}" — Auto-switching PAUSED`);
    }

    // 2. Direct Local OBS WebSocket Execution (Fastest: < 3ms inside local network)
    let directSuccess = false;
    if (localObsRef.current) {
      try {
        directSuccess = await safeObsSwitchScene(localObsRef.current, sceneName);
        if (directSuccess) {
          setCurrentScene(sceneName);
          currentSceneRef.current = sceneName;
          const successLog = `Program Scene is now: "${sceneName}"`;
          setLastSwitchLog(`[${new Date().toLocaleTimeString()}] ✅ ${successLog}`);
          showToast(successLog, 'success');
        }
      } catch (wsErr) {
        console.warn('Direct OBS switch warning:', wsErr);
      }
    }

    // 3. Cloud synchronization & Browser Source relay (non-blocking in background)
    saveSettingsUpdates({ obsSceneSwitchSignal: { sceneName, timestamp: now } }, { silent: true }).catch(() => {});

    // If already executed directly via local OBS WS, do NOT re-trigger cloud switch API!
    if (directSuccess) {
      return true;
    }

    // Fallback if local OBS WebSocket wasn't connected in this browser tab: await cloud API relay
    try {
      const res = await fetch('/api/obs-switch-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sceneName,
          obsUrl: currentSettings.obsWebsocketUrl || `ws://127.0.0.1:${currentSettings.obsWebsocketPort || 4455}`,
          obsPassword: currentSettings.obsWebsocketPassword
        })
      });

      const data = await res.json();
      if (data.success) {
        setCurrentScene(sceneName);
        currentSceneRef.current = sceneName;
        const successLog = `Program Scene is now: "${sceneName}"`;
        setLastSwitchLog(`[${new Date().toLocaleTimeString()}] ✅ ${successLog}`);
        showToast(successLog, 'success');
        return true;
      } else {
        const failLog = `Failed: ${data.error || 'Could not switch scene'}`;
        setLastSwitchLog(`[${new Date().toLocaleTimeString()}] ❌ ${failLog}`);
        showToast(failLog, 'error');
        return false;
      }
    } catch (err: any) {
      const errLog = `Network Error: ${err.message}`;
      setLastSwitchLog(`[${new Date().toLocaleTimeString()}] ❌ ${errLog}`);
      showToast(errLog, 'error');
      return false;
    } finally {
      setIsSwitchingScene(false);
    }
  };

  // 6. Execute Fix Feed (!fix) — In-place Belabox/media source reconnect, ZERO scene changes!
  const handleFixFeed = async () => {
    setIsFixingFeed(true);
    const liveScene = currentScene || settings.obsLiveSceneName || 'live';
    setLastSwitchLog(`🔧 Reconnecting stream sources on air ("${liveScene}")...`);
    showToast(`🔧 Reconnecting Belabox & stream sources on active scene...`, 'info');

    let executedDirectly = false;
    if (localObsRef.current) {
      try {
        const res = await safeObsStreamControlResult(localObsRef.current, 'fix', { liveScene });
        if (res.success) {
          executedDirectly = true;
          showToast(res.message || 'Stream feed fixed successfully!', 'success');
          setLastSwitchLog(res.message || 'Feed sources reconnected.');
          refreshObsScenes();
        }
      } catch (err) {
        console.warn('Direct OBS fix feed failed:', err);
      }
    }

    if (!executedDirectly) {
      try {
        await saveSettingsUpdates({
          obsStreamCommandSignal: { action: 'fix', timestamp: Date.now() }
        }, { silent: true });

        const res = await fetch('/api/noalbs/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: '!fix', fromDashboard: true })
        });
        const data = await res.json();
        if (data.success) {
          if (data.sources && data.sources.length > 0) {
            showToast(data.message || `Reconnecting ${data.sources.join(', ')}`, 'success');
          } else if (data.sources && data.sources.length === 0) {
            showToast(data.message || `Nothing to fix: no stream source is playing on ${data.scene || liveScene}`, 'info');
          } else {
            showToast(data.message || 'Stream feed fixed successfully!', 'success');
          }
          setLastSwitchLog(data.message || 'Feed sources reconnected.');
          refreshObsScenes();
        } else {
          showToast(data.error || 'Fix feed failed.', 'error');
        }
      } catch (err: any) {
        showToast(`Fix feed error: ${err.message}`, 'error');
      }
    }
    setIsFixingFeed(false);
  };

  // 6b. Refresh Sequence (!refresh) — Switches to refresh scene for 6s then returns to live
  const handleRefreshCycle = async () => {
    setIsRefreshingFeed(true);
    manualOverrideUntilRef.current = Date.now() + 15000;
    const refreshScene = settings.obsRefreshSceneName || 'refresh';
    const liveScene = settings.obsLiveSceneName || 'live';
    setLastSwitchLog(`🔄 Executing refresh cycle: "${refreshScene}" -> "${liveScene}" (6s reload)...`);
    showToast(`Refreshing feed: cutting to "${refreshScene}" for 6s...`, 'info');

    let executedDirectly = false;
    if (localObsRef.current) {
      try {
        const res = await safeObsRefreshCycle(localObsRef.current, refreshScene, liveScene, 6000);
        if (res.success) {
          executedDirectly = true;
          setCurrentScene(liveScene);
          currentSceneRef.current = liveScene;
          showToast(`Refresh cycle completed! Back on "${liveScene}".`, 'success');
          setLastSwitchLog(`[${new Date().toLocaleTimeString()}] ✅ Refresh sequence finished on "${liveScene}".`);
          refreshObsScenes();
        }
      } catch (err) {
        console.warn('Direct OBS refresh cycle failed:', err);
      }
    }

    if (!executedDirectly) {
      try {
        await saveSettingsUpdates({
          obsStreamCommandSignal: { action: 'refresh', timestamp: Date.now() }
        }, { silent: true });

        const res = await fetch('/api/noalbs/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: '!refresh', fromDashboard: true })
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || 'Stream refresh sequence completed!', 'success');
          setLastSwitchLog(data.message || 'Refresh cycle finished.');
          refreshObsScenes();
        } else {
          showToast(data.error || 'Refresh cycle failed.', 'error');
        }
      } catch (err: any) {
        showToast(`Refresh error: ${err.message}`, 'error');
      }
    }
    setIsRefreshingFeed(false);
  };

  const triggerRefreshCycle = handleRefreshCycle;

  // 6b. Toggle Video Recording (!rec)
  const handleToggleRecord = async () => {
    setIsTogglingRecord(true);
    const willRecord = !isRecording;
    showToast(willRecord ? '⏺ Starting video recording in OBS...' : '⏹ Stopping video recording in OBS...', 'info');

    let executedDirectly = false;
    if (localObsRef.current) {
      try {
        const res = await safeObsStreamControlResult(localObsRef.current, willRecord ? 'start_record' : 'stop_record');
        if (res.success) {
          executedDirectly = true;
          setLocalRecording(willRecord);
          setTelemetry(prev => prev ? { ...prev, recording: willRecord } : { online: true, recording: willRecord } as any);
          showToast(willRecord ? '⏺ OBS Recording started!' : '⏹ OBS Recording stopped.', 'success');
          fetch('/api/obs-telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ online: true, recording: willRecord })
          }).catch(() => {});
        }
      } catch (err) {
        console.warn('Direct OBS record control failed:', err);
      }
    }

    if (!executedDirectly) {
      try {
        await saveSettingsUpdates({
          obsStreamCommandSignal: { action: willRecord ? 'start_record' : 'stop_record', timestamp: Date.now() }
        }, { silent: true });

        const res = await fetch('/api/noalbs/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: '!rec', fromDashboard: true })
        });
        const data = await res.json();
        if (data.success) {
          setLocalRecording(willRecord);
          showToast(data.message || (willRecord ? '⏺ OBS Recording started!' : '⏹ OBS Recording stopped.'), 'success');
          setTelemetry(prev => prev ? { ...prev, recording: willRecord } : null);
        } else {
          showToast(data.error || 'Failed to toggle recording.', 'error');
        }
      } catch (err: any) {
        showToast(`Record error: ${err.message}`, 'error');
      }
    }
    setIsTogglingRecord(false);
  };

  // 6c. Toggle Live Streaming Broadcast (!start / !stop)
  const handleToggleStream = async () => {
    const willStream = !isStreaming;
    if (!willStream && typeof window !== 'undefined' && !window.confirm('Are you sure you want to STOP broadcasting to stream?')) {
      return;
    }

    setIsTogglingStream(true);
    showToast(willStream ? 'Starting stream broadcast in OBS...' : 'Stopping stream broadcast in OBS...', 'info');

    let executedDirectly = false;
    // 1. Send DIRECT command to local OBS Studio WebSocket (instant)
    if (localObsRef.current) {
      try {
        const res = await safeObsStreamControlResult(localObsRef.current, willStream ? 'start' : 'stop');
        if (res.success) {
          executedDirectly = true;
        } else {
          console.warn('Direct OBS stream control failed, falling back to cloud signal:', res.error);
        }
      } catch (err: any) {
        console.warn('Direct OBS stream call error:', err);
      }
    }

    // 2. Cloud signal fallback ONLY if not executed directly via local WebSocket
    if (!executedDirectly) {
      try {
        const action = willStream ? 'start' : 'stop';
        await saveSettingsUpdates({
          obsStreamCommandSignal: { action, timestamp: Date.now() }
        }, { silent: true });

        const res = await fetch('/api/noalbs/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: willStream ? '!start' : '!stop', fromDashboard: true })
        });
        const data = await res.json();
        if (!data.success) {
          showToast(data.error || 'Failed to control stream.', 'error');
          setIsTogglingStream(false);
          return;
        }
      } catch (err: any) {
        showToast(`Stream error: ${err.message}`, 'error');
        setIsTogglingStream(false);
        return;
      }
    }

    // 3. Keep button in loading state until OBS confirms the new stream state
    let pollCount = 0;
    const confirmInterval = setInterval(async () => {
      pollCount++;
      let currentActive: boolean | null = null;
      if (localObsRef.current) {
        try {
          const statusData: any = await localObsRef.current.call('GetStreamStatus');
          currentActive = Boolean(statusData?.outputActive);
        } catch {}
      }

      if (currentActive === willStream || pollCount >= 18) {
        clearInterval(confirmInterval);
        setIsTogglingStream(false);
        const finalState = currentActive !== null ? currentActive : willStream;
        setLocalStreaming(finalState);
        wasStreamingRef.current = finalState;
        setTelemetry(prev => prev ? { ...prev, streaming: finalState } : { online: true, streaming: finalState } as any);
        fetch('/api/obs-telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ online: true, streaming: finalState })
        }).catch(() => {});
        showToast(finalState ? 'OBS Stream is now LIVE!' : 'OBS Stream has ended.', 'success');

        // Fallback starting scene trigger (only if StreamStateChanged didn't already fire it)
        if (finalState && startingCheckStartRef.current === 0 && (settingsRef.current.obsStartingSceneOnGoLive ?? true)) {
          const cur = (currentSceneRef.current || '').trim().toLowerCase();
          const liveNorm = (settingsRef.current.obsLiveSceneName || 'live').trim().toLowerCase();
          if (cur !== liveNorm && !cur.includes('live')) {
            const startScene = settingsRef.current.obsStartingSceneName || 'starting';
            const checkSec = Math.max(60, settingsRef.current.obsStartingSceneCheckSeconds ?? 60);
            startingCheckStartRef.current = Date.now();
            manualOverrideUntilRef.current = 0;
            setIsCheckingStartingBelabox(true);
            setStartingCheckRemainingSeconds(checkSec);
            currentSceneRef.current = startScene;
            setCurrentScene(startScene);
            switchScene(startScene, 'Stream Started');
          }
        } else if (!finalState) {
          startingCheckStartRef.current = 0;
          setIsCheckingStartingBelabox(false);
          setStartingCheckRemainingSeconds(0);
        }
      }
    }, 400);
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
        body: JSON.stringify({ command: cleanCmd, fromDashboard: true })
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

  // 7b. Listen for Cloud Stream Command Signals (e.g. !fix, !refresh triggered via chat/cloud)
  const lastProcessedSignalRef = useRef<number>(Date.now());
  useEffect(() => {
    const signal = settings.obsStreamCommandSignal;
    if (!signal || !signal.timestamp || !signal.action) return;
    if (signal.timestamp <= lastProcessedSignalRef.current || (Date.now() - signal.timestamp > 15000)) {
      return;
    }
    lastProcessedSignalRef.current = signal.timestamp;

    if (signal.action === 'fix') {
      handleFixFeed();
    } else if (signal.action === 'refresh') {
      handleRefreshCycle();
    }
  }, [settings.obsStreamCommandSignal]);


  // 8. Stream Bitrate & RTT Poller + Automatic Switcher Engine
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
            belaboxFetchFailuresRef.current = 0;
          } else {
            belaboxFetchFailuresRef.current++;
            if (belaboxFetchFailuresRef.current < 3 && currentBitrateRef.current !== null && currentBitrateRef.current > 0) {
              bitrate = currentBitrateRef.current;
            }
          }
        } catch {
          belaboxFetchFailuresRef.current++;
          if (belaboxFetchFailuresRef.current < 3 && currentBitrateRef.current !== null && currentBitrateRef.current > 0) {
            bitrate = currentBitrateRef.current;
          }
        }
      } else {
        const telBitrate = telemetryRef.current?.outputBitrateKbps;
        if (telBitrate) {
          bitrate = telBitrate;
        }
      }

      if (isCancelled) return;

      setCurrentBitrate(prev => prev === bitrate ? prev : bitrate);
      setCurrentRtt(prev => prev === rtt ? prev : rtt);
      setBitrateHistory(prev => [...prev.slice(-59), bitrate]);

      const curScene = (currentSceneRef.current || '').trim().toLowerCase();

      // 1. Belabox Go-Live Check on Stream Start (Runs immediately, never blocked by toggles or special scene pause)
      if (startingCheckStartRef.current > 0) {
        manualOverrideUntilRef.current = 0; // Clear any manual override during starting check

        const liveScene = currentSettings.obsLiveSceneName || 'live';
        const offlineScene = currentSettings.obsOfflineSceneName || 'offline';
        const liveSceneNorm = liveScene.trim().toLowerCase();
        // If OBS is already on the live scene, the transition already occurred!
        if (curScene && (curScene === liveSceneNorm || (curScene.includes('live') && !curScene.includes('vertical')))) {
          startingCheckStartRef.current = 0;
          setIsCheckingStartingBelabox(false);
          setStartingCheckRemainingSeconds(0);
          setAutoSwitchState('LIVE');
          return;
        }

        const checkWindowSec = Math.max(60, currentSettings.obsStartingSceneCheckSeconds ?? 60);
        const checkDurationMs = checkWindowSec * 1000;
        const elapsedMs = Math.max(0, Date.now() - startingCheckStartRef.current);
        const remainingSec = Math.max(0, Math.ceil((checkDurationMs - elapsedMs) / 1000));
        setStartingCheckRemainingSeconds(remainingSec);

        if (elapsedMs >= checkDurationMs) {
          // Timeout reached: switch to offline scene
          startingCheckStartRef.current = 0;
          setIsCheckingStartingBelabox(false);
          setStartingCheckRemainingSeconds(0);
          setAutoSwitchState('OFFLINE');
          setLastSwitchLog(`[${new Date().toLocaleTimeString()}] ⏹️ Belabox did not go live within ${checkWindowSec}s. Switching to offline scene.`);
          switchScene(offlineScene, `Belabox did not go live within check window (${checkWindowSec}s)`);
          showToast(`Belabox did not go live within ${Math.round(checkWindowSec / 60)} min. Switched to '${offlineScene}'.`, 'info');
          return;
        }

        const recThreshold = currentSettings.obsRecoveryBitrateThreshold ?? 2000;
        const rttThreshold = currentSettings.obsRttThreshold ?? 2500;
        const rttOk = !currentSettings.rttTriggerEnabled || rtt === null || rtt < rttThreshold;
        const isBelaboxLive = bitrate !== null && bitrate >= recThreshold && rttOk;

        if (isBelaboxLive) {
          const minDelayMs = (currentSettings.obsStartingSceneMinDelaySeconds ?? 0) * 1000;
          if (elapsedMs >= minDelayMs) {
            startingCheckStartRef.current = 0;
            setIsCheckingStartingBelabox(false);
            setStartingCheckRemainingSeconds(0);
            manualOverrideUntilRef.current = 0;
            setAutoSwitchState('LIVE');
            switchScene(liveScene, `Belabox is LIVE (${bitrate} kbps)! Transitioned from starting scene`);
            showToast(`Belabox is LIVE! Switched to '${liveScene}'`, 'success');
            return;
          }
        }

        // Still checking Belabox on starting scene, do not auto-switch to low or offline
        return;
      }

      // 2. Normal State Machine Evaluation
      if (!currentSettings.obsAutoSwitchSceneToggle) {
        setAutoSwitchState('IDLE');
        return;
      }

      // "Only while streaming" setting: Leave OBS alone when you aren't live
      const curTel = telemetryRef.current;
      const isObsStreaming = localStreaming !== null
        ? localStreaming
        : (curTel ? Boolean(curTel.streaming) : false);

      if (currentSettings.obsSwitchOnlyWhileStreaming && !isObsStreaming) {
        setAutoSwitchState('IDLE');
        return;
      }

      // If manual scene switch is active, hold on the selected scene and skip auto-switch
      if (Date.now() < manualOverrideUntilRef.current) {
        return;
      }

      // Check current scene: if OBS is on a Special Scene (starting, ending, privacy, refresh), NEVER auto-switch!
      if (!curScene || isSpecialSceneName(curScene, currentSettings)) {
        return;
      }

      const isCurLow = isLowSceneName(curScene, currentSettings);
      const isCurOffline = isOfflineSceneName(curScene, currentSettings);
      const isCurLive = isLiveSceneName(curScene, currentSettings);

      // If OBS is on an unmanaged custom scene (e.g. Chatting or Intermission), leave OBS alone!
      if (!isCurLow && !isCurOffline && !isCurLive) {
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

      // Checks before switching: Bad checks in a row before leaving LIVE (default 3, one check per second)
      const checksBeforeSwitch = Math.min(
        currentSettings.obsChecksBeforeSwitching ?? 3,
        currentSettings.obsSwitchDelaySeconds ?? 3
      );
      const delaySec = checksBeforeSwitch;
      // Require at least 3 consecutive confirmed bad checks before leaving LIVE
      const offDelaySec = Math.max(3, checksBeforeSwitch);

      // Instant Recovery: Go back to LIVE the moment the feed recovers (1 check) or wait delaySec
      const isInstantRecovery = currentSettings.obsInstantRecovery !== false;
      const liveRecoveryDelay = isInstantRecovery ? 1 : delaySec;

      const liveScene = currentSettings.obsLiveSceneName || 'live';
      const lowScene = currentSettings.obsLowSceneName || 'low';
      const offlineScene = currentSettings.obsOfflineSceneName || 'offline';

      // Direct State Evaluation:
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

      const wasLiveOrLow = autoSwitchStateRef.current === 'LIVE' || autoSwitchStateRef.current === 'LOW' || isCurLive || isCurLow;

      // A. Evaluate OFFLINE / BRB
      if (shouldBeOffline) {
        lowCountRef.current = 0;
        liveCountRef.current = 0;
        offlineCountRef.current += 1;

        if ((wasLiveOrLow || isCurLive || isCurLow) && offlineCountRef.current >= offDelaySec && !isCurOffline) {
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

        if ((wasLiveOrLow || isCurLive) && lowCountRef.current >= delaySec && !isCurLow && !isCurOffline) {
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

        // Recover to LIVE if OBS was in LOW or OFFLINE, or activate LIVE when healthy feed detected
        const needsRecovery = (autoSwitchStateRef.current === 'LOW' || autoSwitchStateRef.current === 'OFFLINE' || isCurLow || isCurOffline) && !isSpecialSceneName(curScene, currentSettings);

        if (liveCountRef.current >= liveRecoveryDelay && (needsRecovery || isCurLow || isCurOffline) && !isCurLive) {
          setAutoSwitchState('LIVE');
          switchScene(liveScene, `Bitrate recovered (${bitrate} kbps, RTT: ${rtt ?? 0}ms)`);
        }
      }
    };

    pollBitrateAndEvaluate();
    let pollTimer: NodeJS.Timeout;
    const scheduleNextPoll = () => {
      const delay = (typeof document !== 'undefined' && document.hidden) ? 3000 : 1000;
      pollTimer = setTimeout(async () => {
        await pollBitrateAndEvaluate();
        if (!isCancelled) scheduleNextPoll();
      }, delay);
    };
    scheduleNextPoll();

    return () => {
      isCancelled = true;
      clearTimeout(pollTimer);
    };
  }, []);

  // 9. Draw Realtime Bitrate History Sparkline Canvas (Desktop & Mobile)
  useEffect(() => {
    if (typeof document !== 'undefined' && document.hidden) return;

    let animId: number;

    const drawSparkline = (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const parentW = canvas.parentElement?.clientWidth || 560;
      if (canvas.width !== parentW) {
        canvas.width = parentW;
      }

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
        ctx.lineTo(x, y);
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
    };

    animId = requestAnimationFrame(() => {
      drawSparkline(desktopCanvasRef.current);
      drawSparkline(mobileCanvasRef.current);
    });

    return () => cancelAnimationFrame(animId);
  }, [bitrateHistory, settings.obsLowBitrateThreshold, settings.obsOfflineBitrateThreshold]);

  // Copy OBS Browser Source link helper
  const copyObsLink = () => {
    if (typeof window === 'undefined') return;
    const origin = window.location.origin;
    const url = `${origin}/overlay`;
    navigator.clipboard.writeText(url);
    showToast(`📋 OBS Browser Source URL copied: ${url} (Width: 1920, Height: 1080)`, 'success');
  };

  // Chat & Commands Helpers
  const activeCommandsList: CommandConfigItem[] = useMemo(() => {
    const rawList = settings.noalbsCommandsList && settings.noalbsCommandsList.length > 0
      ? [...settings.noalbsCommandsList]
      : [...DEFAULT_NOALBS_COMMANDS];

    // Exclude !clip, !pic, and !so from the switcher page
    const list = rawList.filter(c =>
      c.id !== 'clip' && c.name !== '!clip' &&
      c.id !== 'pic' && c.name !== '!pic' &&
      c.id !== 'so' && c.name !== '!so'
    );

    // Ensure !fix command is always present
    if (!list.some(c => c.id === 'fix' || c.name === '!fix')) {
      const fixCmd: CommandConfigItem = {
        id: 'fix',
        name: '!fix',
        description: 'Reconnect the stream sources on the scene on air',
        defaultRole: 'Moderators',
        role: 'Moderators',
        enabled: true,
        aliases: ['!f']
      };
      const offlineIdx = list.findIndex(c => c.id === 'offline' || c.name === '!offline');
      if (offlineIdx !== -1) {
        list.splice(offlineIdx + 1, 0, fixCmd);
      } else {
        list.push(fixCmd);
      }
    }
    return list;
  }, [settings.noalbsCommandsList]);

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

  // OBS WebSocket Card Component
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
      <div className="obs-ws-inputs-grid">
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
            backgroundColor: '#9146FF',
            border: 'none',
            borderRadius: '8px',
            color: '#fff',
            fontWeight: 600,
            fontSize: '0.9rem',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(145, 70, 255, 0.35)',
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
          background: isObsOnline ? 'rgba(34, 197, 94, 0.08)' : 'rgba(245, 158, 11, 0.08)',
          border: `1px solid ${isObsOnline ? 'rgba(34, 197, 94, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
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
              backgroundColor: isObsOnline ? '#22c55e' : '#f59e0b',
              boxShadow: `0 0 8px ${isObsOnline ? '#22c55e' : '#f59e0b'}`,
            }}
          />
          <strong style={{ fontSize: '0.86rem', color: isObsOnline ? '#4ade80' : '#fbbf24' }}>
            {isObsOnline
              ? (obsConnected ? `CONNECTED TO OBS (Port ${settings.obsWebsocketPort || 4455})` : 'CONNECTED TO OBS (Cloud Relay)')
              : 'WAITING FOR OBS BROWSER SOURCE'}
          </strong>
        </div>
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'rgba(255, 255, 255, 0.7)', lineHeight: 1.4 }}>
          {isObsOnline
            ? (obsConnected
              ? `Your Browser Source is actively running inside OBS on 127.0.0.1:${settings.obsWebsocketPort || 4455}. Automatic low-bitrate switching and chat commands are live!`
              : 'OBS Studio is synced via Cloud Relay. Real-time scene status and controls are live on your phone!')
            : 'To connect, add your overlay URL as a Browser Source or Custom Browser Dock inside OBS Studio.'}
        </p>
        {!isObsOnline && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
            <button
              className="btn btn-small"
              onClick={copyObsLink}
              style={{ fontSize: '0.75rem', padding: '5px 12px', background: 'rgba(255,255,255,0.1)' }}
            >
              📋 Copy Overlay Browser Source Link (/overlay)
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
                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: switcherDisplayState.color }}>
                  {switcherDisplayState.badgeText}
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: '32px', width: '100%', height: '4px', background: 'rgba(255, 255, 255, 0.08)', borderRadius: '4px', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${switcherDisplayState.progressPercent}%`,
                background: switcherDisplayState.progressBarColor,
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

  // Realtime Bitrate History Sparkline & Stream Telemetry Card (Reusable for Desktop & Mobile)
  const renderBitrateHistoryCard = (canvasRefToUse: React.RefObject<HTMLCanvasElement | null>) => (
    <section className="settings-section" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, color: '#fff' }}>
            📈 Realtime Bitrate History (60s)
          </h2>
          <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
            Visual stream health curve with threshold triggers
          </span>
        </div>
        <div style={{ display: 'flex', gap: '12px', fontSize: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ color: '#4ade80' }}>-- Live (&gt;{settings.obsLowBitrateThreshold ?? 1100}k)</span>
          <span style={{ color: '#facc15' }}>-- Low (&le;{settings.obsLowBitrateThreshold ?? 1100}k)</span>
          <span style={{ color: '#ef4444' }}>-- BRB (&le;{settings.obsOfflineBitrateThreshold ?? 400}k)</span>
        </div>
      </div>

      <div style={{ width: '100%', height: '140px', position: 'relative', background: 'rgba(0,0,0,0.4)', borderRadius: '8px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        <canvas
          ref={canvasRefToUse}
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
              {telemetry?.mediaFeedSource && (
                <span style={{
                  fontSize: '0.8em',
                  color: telemetry.mediaFeedLive ? '#53FC19' : '#f87171',
                  background: telemetry.mediaFeedLive ? 'rgba(83, 252, 25, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                  border: telemetry.mediaFeedLive ? '1px solid rgba(83, 252, 25, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  fontWeight: 'bold',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px'
                }}>
                  <span>{telemetry.mediaFeedLive ? '▶️' : '⏹️'}</span>
                  <span>{telemetry.mediaFeedSource}: {telemetry.mediaFeedLive ? 'LIVE' : (telemetry.mediaFeedState ? telemetry.mediaFeedState.replace('OBS_MEDIA_STATE_', '') : 'OFFLINE')}</span>
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
                <div style={{ fontSize: '0.75em', opacity: 0.6, textTransform: 'uppercase' }}>OBS Output</div>
                <div style={{ fontWeight: 'bold', color: '#38bdf8' }}>
                  {telemetry.outputBitrateKbps !== undefined ? `${telemetry.outputBitrateKbps.toLocaleString()} kbps` : '--'}
                </div>
              </div>

              {/* Active FPS */}
              <div style={{ padding: '6px 10px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px' }}>
                <div style={{ fontSize: '0.75em', opacity: 0.6, textTransform: 'uppercase' }}>Active FPS</div>
                <div style={{
                  fontWeight: 'bold',
                  color: (telemetry.fps ?? 60) < 50 ? '#ef4444' : ((telemetry.fps ?? 60) < 58 ? '#f59e0b' : '#4ade80')
                }}>
                  {telemetry.fps !== undefined ? `${telemetry.fps.toFixed(1)} fps` : '--'}
                </div>
              </div>

              {/* CPU Usage */}
              <div style={{ padding: '6px 10px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px' }}>
                <div style={{ fontSize: '0.75em', opacity: 0.6, textTransform: 'uppercase' }}>CPU Usage</div>
                <div style={{
                  fontWeight: 'bold',
                  color: (telemetry.cpuUsagePercent ?? 0) > 80 ? '#ef4444' : ((telemetry.cpuUsagePercent ?? 0) > 50 ? '#f59e0b' : '#38bdf8')
                }}>
                  {telemetry.cpuUsagePercent !== undefined ? `${telemetry.cpuUsagePercent}%` : '--'}
                </div>
              </div>

              {/* Stream Uptime */}
              <div style={{ padding: '6px 10px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px' }}>
                <div style={{ fontSize: '0.75em', opacity: 0.6, textTransform: 'uppercase' }}>Uptime</div>
                <div style={{ fontWeight: 'bold', color: telemetry.streaming ? '#4ade80' : 'rgba(255, 255, 255, 0.4)' }}>
                  {telemetry.uptimeTimecode || (telemetry.streaming ? 'Streaming' : 'Offline')}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: '0.8em', opacity: 0.65, fontStyle: 'italic', padding: '4px 0' }}>
              Detailed frame-by-frame stats stream to cloud whenever the overlay is loaded in OBS.
            </div>
          )}

          {/* Diagnostic Log Window */}
          {showObsLogs && (
            <div style={{
              marginTop: '6px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              paddingTop: '8px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '0.75em', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#94a3b8', fontWeight: 'bold' }}>
                  Realtime OBS Stream Diagnostics
                </span>
                <span style={{ fontSize: '0.72em', color: 'rgba(255, 255, 255, 0.4)' }}>
                  Auto-refreshes with stream events
                </span>
              </div>
              <div style={{
                maxHeight: '160px',
                overflowY: 'auto',
                background: 'rgba(0, 0, 0, 0.65)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: '6px',
                padding: '8px 12px',
                fontFamily: 'monospace',
                fontSize: '0.76em',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px'
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
    </section>
  );

  // =========================================================================
  // MODE 1: STUDIO DASHBOARD & CONTROL CENTER
  // =========================================================================
  return (
    <div className="admin-container low-bitrate-container">
      {/* Stacked Toast Notifications Container */}
      <div
        style={{
          position: 'fixed',
          top: '20px',
          right: '16px',
          zIndex: 99999,
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          maxWidth: 'min(420px, calc(100vw - 32px))',
          pointerEvents: 'none'
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => removeToast(t.id)}
            style={{
              padding: '12px 18px',
              borderRadius: '8px',
              background: t.type === 'success' ? '#15803d' : t.type === 'error' ? '#b91c1c' : '#0369a1',
              color: '#fff',
              fontWeight: 600,
              fontSize: '0.92rem',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              border: '1px solid rgba(255,255,255,0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              pointerEvents: 'auto',
              cursor: 'pointer',
              animation: 'toastSlideIn 0.25s ease-out',
              transition: 'all 0.2s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, wordBreak: 'break-word' }}>
              {t.type === 'info' && <span style={{ fontSize: '1.15em' }}>ℹ️</span>}
              {t.type === 'success' && <span style={{ fontSize: '1.15em' }}>✅</span>}
              {t.type === 'error' && <span style={{ fontSize: '1.15em' }}>❌</span>}
              <span>{cleanDisplayMessage(t.message)}</span>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeToast(t.id);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'rgba(255,255,255,0.65)',
                cursor: 'pointer',
                fontSize: '1rem',
                lineHeight: 1,
                padding: '2px 4px',
                borderRadius: '4px'
              }}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

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
              Low Bitrate & Scene Switcher
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

        <div className="top-nav-header-buttons">
          <button
            className="btn btn-secondary"
            onClick={copyObsLink}
            title="Copy URL (https://overlay3.vercel.app/overlay) to paste as Browser Source in OBS"
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

      {/* Navigation Sub-Tabs & Action Buttons Bar */}
      <div className="switcher-subnav-bar">
        <div className="switcher-tabs-group">
          <button
            type="button"
            onClick={() => setActiveTab('switcher')}
            className={`switcher-tab-btn ${activeTab === 'switcher' ? 'active-switcher' : ''}`}
            style={{
              padding: '10px 18px',
              borderRadius: '8px',
              fontSize: '0.95rem',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'all 0.2s',
              background: activeTab === 'switcher' ? 'rgba(34, 197, 94, 0.22)' : 'rgba(255, 255, 255, 0.04)',
              color: activeTab === 'switcher' ? '#4ade80' : 'rgba(255, 255, 255, 0.7)',
              border: activeTab === 'switcher' ? '1px solid rgba(34, 197, 94, 0.45)' : '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span style={{ flexShrink: 0 }}>⚡</span>
            <span className="switcher-tab-label">
              <span>Switcher</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('chat_commands')}
            className={`switcher-tab-btn ${activeTab === 'chat_commands' ? 'active-chat' : ''}`}
            style={{
              padding: '10px 18px',
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
              gap: '6px',
            }}
          >
            <span style={{ flexShrink: 0 }}>💬</span>
            <span className="switcher-tab-label">
              <span className="switcher-tab-text-desktop">Chat & Commands</span>
              <span className="switcher-tab-text-mobile">Commands</span>{' '}
              <span className="switcher-tab-badge">({activeCommandsList.length})</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('switcher_options')}
            className={`switcher-tab-btn ${activeTab === 'switcher_options' ? 'active-options' : ''}`}
            style={{
              padding: '10px 18px',
              borderRadius: '8px',
              fontSize: '0.95rem',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'all 0.2s',
              background: activeTab === 'switcher_options' ? 'rgba(56, 189, 248, 0.22)' : 'rgba(255, 255, 255, 0.04)',
              color: activeTab === 'switcher_options' ? '#38bdf8' : 'rgba(255, 255, 255, 0.7)',
              border: activeTab === 'switcher_options' ? '1px solid rgba(56, 189, 248, 0.5)' : '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span style={{ flexShrink: 0 }}>⚙️</span>
            <span className="switcher-tab-label">
              <span className="switcher-tab-text-desktop">Switcher Options</span>
              <span className="switcher-tab-text-mobile">Options</span>
            </span>
          </button>
        </div>

        {/* OBS Quick Control Action Buttons (Fix feed, Record, Start stream) */}
        <div className="switcher-action-buttons">
          {/* Fix feed button */}
          <button
            type="button"
            className="switcher-action-btn"
            onClick={handleFixFeed}
            disabled={isFixingFeed}
            title="Reconnect the stream sources on the scene on air (!fix)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '9px 16px',
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              borderRadius: '8px',
              color: '#e2e8f0',
              fontSize: '0.88rem',
              fontWeight: 600,
              cursor: isFixingFeed ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
              opacity: isFixingFeed ? 0.6 : 1,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(-45deg)', flexShrink: 0 }}>
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <span>{isFixingFeed ? 'Fixing feed...' : 'Fix feed'}</span>
          </button>

          {/* Record button */}
          <button
            type="button"
            className="switcher-action-btn"
            onClick={handleToggleRecord}
            disabled={isTogglingRecord}
            title={isRecording ? 'Stop video recording in OBS (!rec)' : 'Start video recording in OBS (!rec)'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '9px 16px',
              background: isRecording ? 'rgba(239, 68, 68, 0.18)' : 'rgba(255, 255, 255, 0.05)',
              border: `1px solid ${isRecording ? 'rgba(239, 68, 68, 0.5)' : 'rgba(255, 255, 255, 0.14)'}`,
              borderRadius: '8px',
              color: isRecording ? '#f87171' : '#e2e8f0',
              fontSize: '0.88rem',
              fontWeight: 600,
              cursor: isTogglingRecord ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
              opacity: isTogglingRecord ? 0.6 : 1,
            }}
          >
            <span style={{
              width: '9px',
              height: '9px',
              borderRadius: '50%',
              backgroundColor: isRecording ? '#ef4444' : '#64748b',
              boxShadow: isRecording ? '0 0 8px #ef4444' : 'none',
              display: 'inline-block',
              flexShrink: 0,
            }} />
            <span>{isTogglingRecord ? 'Updating...' : isRecording ? 'Stop record' : 'Record'}</span>
          </button>

          {/* Start stream / End stream button */}
          <button
            type="button"
            className="switcher-action-btn"
            onClick={handleToggleStream}
            disabled={isTogglingStream}
            title={isStreaming ? 'End broadcasting in OBS (!stop)' : 'Start broadcasting in OBS (!start)'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '9px 18px',
              background: isStreaming ? '#dc2626' : '#5c54a4',
              border: `1px solid ${isStreaming ? '#ef4444' : 'rgba(145, 70, 255, 0.6)'}`,
              borderRadius: '8px',
              color: '#ffffff',
              fontSize: '0.88rem',
              fontWeight: 700,
              cursor: isTogglingStream ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
              boxShadow: isStreaming ? '0 0 16px rgba(220, 38, 38, 0.55)' : '0 2px 10px rgba(92, 84, 164, 0.35)',
              opacity: isTogglingStream ? 0.75 : 1,
            }}
          >
            {isStreaming ? (
              <>
                {isTogglingStream ? (
                  <span style={{
                    width: '12px',
                    height: '12px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: '#ffffff',
                    borderRadius: '50%',
                    display: 'inline-block',
                    animation: 'spin 0.8s linear infinite'
                  }} />
                ) : (
                  <>
                    <span style={{
                      width: '9px',
                      height: '9px',
                      borderRadius: '50%',
                      backgroundColor: '#ffffff',
                      boxShadow: '0 0 8px #ffffff',
                      display: 'inline-block',
                      animation: 'pulse 1.5s infinite'
                    }} />
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="5" y="5" width="14" height="14" rx="2" />
                    </svg>
                  </>
                )}
                <span>{isTogglingStream ? 'Ending stream...' : 'End stream'}</span>
              </>
            ) : (
              <>
                {isTogglingStream ? (
                  <span style={{
                    width: '12px',
                    height: '12px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: '#ffffff',
                    borderRadius: '50%',
                    display: 'inline-block',
                    animation: 'spin 0.8s linear infinite'
                  }} />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="6 4 20 12 6 20 6 4" />
                  </svg>
                )}
                <span>{isTogglingStream ? 'Starting stream...' : 'Start stream'}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* =====================================================================
          TAB 1: SWITCHER (COMPLETE SWITCHING DASHBOARD, STUDIO & OPTIONS)
          ===================================================================== */}
      {activeTab === 'switcher' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {/* Realtime Status Badges Bar */}
          <div className="status-badges-grid">
            {/* OBS WebSocket Status */}
            <div style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '10px', padding: '14px 16px' }}>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase' }}>OBS WebSocket</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: isObsOnline ? '#22c55e' : '#ef4444' }} />
                <strong style={{ fontSize: '1.05rem', color: isObsOnline ? '#4ade80' : '#f87171' }}>
                  {isObsOnline ? (obsConnected ? 'CONNECTED' : 'CONNECTED (Cloud)') : 'DISCONNECTED'}
                </strong>
              </div>
              <div style={{ fontSize: '0.72rem', opacity: 0.6, marginTop: '2px' }}>
                {obsConnected
                  ? (settings.obsWebsocketUrl || `ws://127.0.0.1:${settings.obsWebsocketPort || 4455}`)
                  : (telemetry?.online ? 'Connected via OBS Studio' : 'OBS Studio offline / not reachable')}
              </div>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
                  Auto-Switch State
                </span>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    background: switcherDisplayState.bg,
                    color: switcherDisplayState.color,
                    border: `1px solid ${switcherDisplayState.border}`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {switcherDisplayState.shortBadge}
                </span>
              </div>
              <div style={{ fontSize: '0.72rem', opacity: 0.65, marginTop: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <span>{switcherDisplayState.subText}</span>
                {isCheckingStartingBelabox && (
                  <button
                    type="button"
                    onClick={() => {
                      startingCheckStartRef.current = 0;
                      setIsCheckingStartingBelabox(false);
                      setStartingCheckRemainingSeconds(0);
                      showToast('Belabox check stopped.', 'info');
                    }}
                    style={{
                      background: 'rgba(255,255,255,0.08)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      color: '#ffaaaa',
                      fontSize: '0.7rem',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Mobile View: Realtime Bitrate History Sparkline Chart */}
          <div className="switcher-bitrate-mobile">
            {renderBitrateHistoryCard(mobileCanvasRef)}
          </div>

          {/* Quick Scene Switch Grid (Scene Switching Studio) */}
          <section className="settings-section" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, color: '#fff' }}>
                    🎬 Scene Switching Studio
                  </h2>
                  <span style={{
                    fontSize: '0.75rem',
                    padding: '3px 9px',
                    borderRadius: '6px',
                    background: currentScene ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                    border: currentScene ? '1px solid rgba(34, 197, 94, 0.45)' : '1px solid rgba(255, 255, 255, 0.12)',
                    color: currentScene ? '#4ade80' : 'rgba(255, 255, 255, 0.55)',
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}>
                    <span style={{ display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: currentScene ? '#22c55e' : '#888', boxShadow: currentScene ? '0 0 6px #22c55e' : 'none' }} />
                    {currentScene ? `Active Scene: "${currentScene}"` : 'No Scene Active'}
                  </span>
                </div>
                <span style={{ fontSize: '0.8rem', opacity: 0.7, display: 'block', marginTop: '3px' }}>
                  One-click instant scene triggers for OBS Studio
                </span>
              </div>
              <button
                className="btn btn-secondary btn-small btn-refresh-scenes"
                onClick={refreshObsScenes}
                style={{ fontSize: '0.78rem', padding: '6px 14px', background: 'rgba(255, 255, 255, 0.12)', border: '1px solid rgba(255, 255, 255, 0.25)', color: '#ffffff', fontWeight: 700 }}
                title="Refresh scenes from OBS WebSocket"
              >
                <span style={{ color: '#ffffff', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  🔄 Refresh Scenes
                </span>
              </button>
            </div>

                {(() => {
                  const liveScene = (settings.obsLiveSceneName || 'live').trim();
                  const lowScene = (settings.obsLowSceneName || 'low').trim();
                  const offlineScene = (settings.obsOfflineSceneName || 'offline').trim();
                  const refreshScene = (settings.obsRefreshSceneName || 'refresh').trim();
                  const startingScene = (settings.obsStartingSceneName || 'starting').trim();
                  const endingScene = (settings.obsEndingSceneName || 'ending').trim();
                  const privacyScene = (settings.obsPrivacySceneName || 'privacy').trim();

                  const currentNorm = (currentScene || '').trim().toLowerCase();
                  const isLiveActive = !!currentNorm && currentNorm === liveScene.toLowerCase();
                  const isLowActive = !!currentNorm && currentNorm === lowScene.toLowerCase();
                  const isOfflineActive = !!currentNorm && currentNorm === offlineScene.toLowerCase();
                  const isRefreshActive = (!!currentNorm && currentNorm === refreshScene.toLowerCase()) || isRefreshingFeed;
                  const isStartingActive = !!currentNorm && currentNorm === startingScene.toLowerCase();
                  const isEndingActive = !!currentNorm && currentNorm === endingScene.toLowerCase();
                  const isPrivacyActive = !!currentNorm && currentNorm === privacyScene.toLowerCase();

                  return (
                    <>
                      {/* Quick Switch Buttons */}
                      <div className="scene-buttons-primary">
                        <button
                          className="btn"
                          onClick={() => switchScene(liveScene, 'Quick button')}
                          disabled={isSwitchingScene}
                          style={{
                            background: isLiveActive
                              ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.35) 0%, rgba(21, 128, 61, 0.75) 100%)'
                              : 'rgba(34, 197, 94, 0.08)',
                            border: isLiveActive ? '2px solid #22c55e' : '1px solid rgba(34, 197, 94, 0.3)',
                            boxShadow: isLiveActive ? '0 0 16px rgba(34, 197, 94, 0.55), inset 0 0 8px rgba(34, 197, 94, 0.25)' : 'none',
                            color: isLiveActive ? '#ffffff' : '#4ade80',
                            transform: isLiveActive ? 'scale(1.02)' : 'scale(1)',
                            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                            padding: '14px 8px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '4px',
                            position: 'relative',
                            cursor: isSwitchingScene ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {isLiveActive && (
                            <span style={{ position: 'absolute', top: '5px', right: '5px', background: '#22c55e', color: '#052e16', fontSize: '0.62rem', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', letterSpacing: '0.5px' }}>
                              ● ON AIR
                            </span>
                          )}
                          <span style={{ fontSize: '1.25rem' }}>🟢</span>
                          <strong style={{ fontSize: '0.95rem', letterSpacing: '0.5px' }}>LIVE</strong>
                          <span style={{ fontSize: '0.72rem', opacity: isLiveActive ? 1 : 0.75, fontWeight: isLiveActive ? 600 : 400 }}>{liveScene}</span>
                        </button>

                        <button
                          className="btn"
                          onClick={() => switchScene(lowScene, 'Quick button')}
                          disabled={isSwitchingScene}
                          style={{
                            background: isLowActive
                              ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.35) 0%, rgba(180, 83, 9, 0.75) 100%)'
                              : 'rgba(245, 158, 11, 0.08)',
                            border: isLowActive ? '2px solid #f59e0b' : '1px solid rgba(245, 158, 11, 0.3)',
                            boxShadow: isLowActive ? '0 0 16px rgba(245, 158, 11, 0.55), inset 0 0 8px rgba(245, 158, 11, 0.25)' : 'none',
                            color: isLowActive ? '#ffffff' : '#fbbf24',
                            transform: isLowActive ? 'scale(1.02)' : 'scale(1)',
                            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                            padding: '14px 8px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '4px',
                            position: 'relative',
                            cursor: isSwitchingScene ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {isLowActive && (
                            <span style={{ position: 'absolute', top: '5px', right: '5px', background: '#f59e0b', color: '#451a03', fontSize: '0.62rem', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', letterSpacing: '0.5px' }}>
                              ● ACTIVE
                            </span>
                          )}
                          <span style={{ fontSize: '1.25rem' }}>🟡</span>
                          <strong style={{ fontSize: '0.95rem', letterSpacing: '0.5px' }}>LOW BITRATE</strong>
                          <span style={{ fontSize: '0.72rem', opacity: isLowActive ? 1 : 0.75, fontWeight: isLowActive ? 600 : 400 }}>{lowScene}</span>
                        </button>

                        <button
                          className="btn"
                          onClick={() => switchScene(offlineScene, 'Quick button')}
                          disabled={isSwitchingScene}
                          style={{
                            background: isOfflineActive
                              ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.35) 0%, rgba(185, 28, 28, 0.75) 100%)'
                              : 'rgba(239, 68, 68, 0.08)',
                            border: isOfflineActive ? '2px solid #ef4444' : '1px solid rgba(239, 68, 68, 0.3)',
                            boxShadow: isOfflineActive ? '0 0 16px rgba(239, 68, 68, 0.55), inset 0 0 8px rgba(239, 68, 68, 0.25)' : 'none',
                            color: isOfflineActive ? '#ffffff' : '#f87171',
                            transform: isOfflineActive ? 'scale(1.02)' : 'scale(1)',
                            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                            padding: '14px 8px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '4px',
                            position: 'relative',
                            cursor: isSwitchingScene ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {isOfflineActive && (
                            <span style={{ position: 'absolute', top: '5px', right: '5px', background: '#ef4444', color: '#ffffff', fontSize: '0.62rem', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', letterSpacing: '0.5px' }}>
                              ● ACTIVE
                            </span>
                          )}
                          <span style={{ fontSize: '1.25rem' }}>🔴</span>
                          <strong style={{ fontSize: '0.95rem', letterSpacing: '0.5px' }}>OFFLINE / BRB</strong>
                          <span style={{ fontSize: '0.72rem', opacity: isOfflineActive ? 1 : 0.75, fontWeight: isOfflineActive ? 600 : 400 }}>{offlineScene}</span>
                        </button>
                      </div>

                      {/* Secondary Buttons Row */}
                      <div className="scene-buttons-secondary">
                        <button
                          className="btn btn-secondary"
                          onClick={() => switchScene(refreshScene, 'Refresh button')}
                          disabled={isSwitchingScene}
                          title={`Switch to "${refreshScene}" scene`}
                          style={{
                            background: isRefreshActive
                              ? 'linear-gradient(135deg, rgba(59, 130, 246, 0.35) 0%, rgba(37, 99, 235, 0.75) 100%)'
                              : 'rgba(255, 255, 255, 0.05)',
                            border: isRefreshActive ? '2px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.12)',
                            boxShadow: isRefreshActive ? '0 0 14px rgba(59, 130, 246, 0.55), inset 0 0 6px rgba(59, 130, 246, 0.25)' : 'none',
                            color: isRefreshActive ? '#ffffff' : 'rgba(255, 255, 255, 0.85)',
                            transform: isRefreshActive ? 'scale(1.02)' : 'scale(1)',
                            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                            padding: '10px 4px',
                            fontSize: '0.78rem',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '3px',
                            position: 'relative',
                            cursor: isSwitchingScene ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {isRefreshActive && (
                            <span style={{ position: 'absolute', top: '4px', right: '4px', background: '#3b82f6', color: '#ffffff', fontSize: '0.58rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', letterSpacing: '0.5px' }}>
                              ● ACTIVE
                            </span>
                          )}
                          <span style={{ fontSize: '1.1rem' }}>🔄</span>
                          <strong>REFRESH</strong>
                          <span style={{ fontSize: '0.7rem', opacity: isRefreshActive ? 1 : 0.65, fontWeight: isRefreshActive ? 600 : 400 }}>{refreshScene}</span>
                        </button>

                        <button
                          className="btn btn-secondary"
                          onClick={() => switchScene(startingScene, 'Starting button')}
                          disabled={isSwitchingScene}
                          style={{
                            background: isStartingActive
                              ? 'linear-gradient(135deg, rgba(168, 85, 247, 0.35) 0%, rgba(126, 34, 206, 0.75) 100%)'
                              : 'rgba(255, 255, 255, 0.05)',
                            border: isStartingActive ? '2px solid #a855f7' : '1px solid rgba(255, 255, 255, 0.12)',
                            boxShadow: isStartingActive ? '0 0 14px rgba(168, 85, 247, 0.55), inset 0 0 6px rgba(168, 85, 247, 0.25)' : 'none',
                            color: isStartingActive ? '#ffffff' : 'rgba(255, 255, 255, 0.85)',
                            transform: isStartingActive ? 'scale(1.02)' : 'scale(1)',
                            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                            padding: '10px 4px',
                            fontSize: '0.78rem',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '3px',
                            position: 'relative',
                            cursor: isSwitchingScene ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {isStartingActive && (
                            <span style={{ position: 'absolute', top: '4px', right: '4px', background: '#a855f7', color: '#ffffff', fontSize: '0.58rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', letterSpacing: '0.5px' }}>
                              ● ACTIVE
                            </span>
                          )}
                          <span style={{ fontSize: '1.1rem' }}>🎬</span>
                          <strong>STARTING</strong>
                          <span style={{ fontSize: '0.7rem', opacity: isStartingActive ? 1 : 0.65, fontWeight: isStartingActive ? 600 : 400 }}>{startingScene}</span>
                        </button>

                        <button
                          className="btn btn-secondary"
                          onClick={() => switchScene(endingScene, 'Ending button')}
                          disabled={isSwitchingScene}
                          style={{
                            background: isEndingActive
                              ? 'linear-gradient(135deg, rgba(236, 72, 153, 0.35) 0%, rgba(190, 24, 93, 0.75) 100%)'
                              : 'rgba(255, 255, 255, 0.05)',
                            border: isEndingActive ? '2px solid #ec4899' : '1px solid rgba(255, 255, 255, 0.12)',
                            boxShadow: isEndingActive ? '0 0 14px rgba(236, 72, 153, 0.55), inset 0 0 6px rgba(236, 72, 153, 0.25)' : 'none',
                            color: isEndingActive ? '#ffffff' : 'rgba(255, 255, 255, 0.85)',
                            transform: isEndingActive ? 'scale(1.02)' : 'scale(1)',
                            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                            padding: '10px 4px',
                            fontSize: '0.78rem',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '3px',
                            position: 'relative',
                            cursor: isSwitchingScene ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {isEndingActive && (
                            <span style={{ position: 'absolute', top: '4px', right: '4px', background: '#ec4899', color: '#ffffff', fontSize: '0.58rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', letterSpacing: '0.5px' }}>
                              ● ACTIVE
                            </span>
                          )}
                          <span style={{ fontSize: '1.1rem' }}>🏁</span>
                          <strong>ENDING</strong>
                          <span style={{ fontSize: '0.7rem', opacity: isEndingActive ? 1 : 0.65, fontWeight: isEndingActive ? 600 : 400 }}>{endingScene}</span>
                        </button>

                        <button
                          className="btn btn-secondary"
                          onClick={() => switchScene(privacyScene, 'Privacy button')}
                          disabled={isSwitchingScene}
                          style={{
                            background: isPrivacyActive
                              ? 'linear-gradient(135deg, rgba(234, 179, 8, 0.35) 0%, rgba(161, 98, 7, 0.75) 100%)'
                              : 'rgba(255, 255, 255, 0.05)',
                            border: isPrivacyActive ? '2px solid #eab308' : '1px solid rgba(255, 255, 255, 0.12)',
                            boxShadow: isPrivacyActive ? '0 0 14px rgba(234, 179, 8, 0.55), inset 0 0 6px rgba(234, 179, 8, 0.25)' : 'none',
                            color: isPrivacyActive ? '#ffffff' : 'rgba(255, 255, 255, 0.85)',
                            transform: isPrivacyActive ? 'scale(1.02)' : 'scale(1)',
                            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                            padding: '10px 4px',
                            fontSize: '0.78rem',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '3px',
                            position: 'relative',
                            cursor: isSwitchingScene ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {isPrivacyActive && (
                            <span style={{ position: 'absolute', top: '4px', right: '4px', background: '#eab308', color: '#422006', fontSize: '0.58rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', letterSpacing: '0.5px' }}>
                              ● ACTIVE
                            </span>
                          )}
                          <span style={{ fontSize: '1.1rem' }}>🔒</span>
                          <strong>PRIVACY</strong>
                          <span style={{ fontSize: '0.7rem', opacity: isPrivacyActive ? 1 : 0.65, fontWeight: isPrivacyActive ? 600 : 400 }}>{privacyScene}</span>
                        </button>
                      </div>
                    </>
                  );
                })()}

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

                {/* Active Scene Sources (Scene Items Hide/Show Toggle) */}
                <div style={{
                  marginTop: '16px',
                  background: 'rgba(0, 0, 0, 0.35)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '10px',
                  padding: '14px 16px',
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '8px',
                    marginBottom: '12px',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                    paddingBottom: '10px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '1.2rem' }}>🎛️</span>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          Scene Sources
                          {currentScene && (
                            <span style={{
                              fontSize: '0.7rem',
                              fontWeight: 600,
                              background: 'rgba(145, 70, 255, 0.18)',
                              color: '#c084fc',
                              border: '1px solid rgba(145, 70, 255, 0.35)',
                              padding: '2px 7px',
                              borderRadius: '4px'
                            }}>
                              {currentScene}
                            </span>
                          )}
                          <span style={{ fontSize: '0.75rem', opacity: 0.65 }}>
                            ({sceneSources.filter(s => s.enabled).length}/{sceneSources.length} visible)
                          </span>
                        </div>
                        <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                          Toggle source visibility in real-time on stream.
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {sceneSources.length > 0 && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleToggleAllSources(true)}
                            className="btn btn-secondary"
                            style={{
                              fontSize: '0.7rem',
                              padding: '4px 8px',
                              background: 'rgba(34, 197, 94, 0.12)',
                              border: '1px solid rgba(34, 197, 94, 0.3)',
                              color: '#4ade80'
                            }}
                            title="Show all sources in active scene"
                          >
                            👁️ Show All
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleAllSources(false)}
                            className="btn btn-secondary"
                            style={{
                              fontSize: '0.7rem',
                              padding: '4px 8px',
                              background: 'rgba(239, 68, 68, 0.12)',
                              border: '1px solid rgba(239, 68, 68, 0.3)',
                              color: '#f87171'
                            }}
                            title="Hide all sources in active scene"
                          >
                            🙈 Hide All
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => loadSceneSources(currentScene)}
                        disabled={isLoadingSources}
                        className="btn btn-secondary"
                        style={{
                          fontSize: '0.7rem',
                          padding: '4px 8px',
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.12)',
                          color: '#e2e8f0'
                        }}
                        title="Reload scene items from OBS"
                      >
                        {isLoadingSources ? '🔄 Refreshing...' : '🔄 Refresh'}
                      </button>
                    </div>
                  </div>

                  {/* Sources List */}
                  {isLoadingSources && sceneSources.length === 0 ? (
                    <div style={{ padding: '16px', textAlign: 'center', color: '#94a3b8', fontSize: '0.8rem' }}>
                      ⏳ Loading sources for &quot;{currentScene || 'active scene'}&quot;...
                    </div>
                  ) : sceneSources.length === 0 ? (
                    <div style={{ padding: '16px', textAlign: 'center', color: '#94a3b8', fontSize: '0.8rem', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                      <div>No sources loaded yet for {currentScene ? `"${currentScene}"` : 'the active scene'}.</div>
                      <button
                        type="button"
                        onClick={() => loadSceneSources(currentScene || telemetry?.currentScene)}
                        className="btn btn-secondary"
                        style={{ fontSize: '0.75rem', padding: '6px 12px', background: 'rgba(145, 70, 255, 0.2)', color: '#c084fc', border: '1px solid rgba(145, 70, 255, 0.4)' }}
                      >
                        🔄 Fetch Scene Sources
                      </button>
                    </div>
                  ) : (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      maxHeight: '340px',
                      overflowY: 'auto',
                      paddingRight: '4px'
                    }}>
                      {sceneSources.map((item) => {
                        const badge = getSourceKindBadge(item.kind, item.name);
                        const isToggling = togglingSourceId === item.id;
                        const isRemoving = removingSourceId === item.id;
                        return (
                          <div
                            key={item.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '8px 12px',
                              background: item.enabled ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.3)',
                              border: item.enabled ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid rgba(255, 255, 255, 0.03)',
                              borderRadius: '6px',
                              opacity: item.enabled ? 1 : 0.55,
                              transition: 'all 0.18s ease',
                              gap: '8px'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                              <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>
                                {getSourceIcon(item.kind, item.name)}
                              </span>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{
                                  fontSize: '0.85rem',
                                  fontWeight: 600,
                                  color: item.enabled ? '#ffffff' : '#94a3b8',
                                  textDecoration: item.enabled ? 'none' : 'line-through',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis'
                                }}>
                                  {item.name}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                                  <span style={{
                                    fontSize: '0.65rem',
                                    fontWeight: 600,
                                    padding: '1px 5px',
                                    borderRadius: '3px',
                                    color: badge.color,
                                    background: badge.bg
                                  }}>
                                    {badge.label}
                                  </span>
                                  {item.locked && (
                                    <span style={{ fontSize: '0.65rem', color: '#94a3b8' }} title="Locked in OBS">
                                      🔒 Locked
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                              <button
                                type="button"
                                onClick={() => handleToggleSource(item)}
                                disabled={isToggling || isRemoving}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                  fontSize: '0.75rem',
                                  fontWeight: 700,
                                  padding: '6px 12px',
                                  borderRadius: '6px',
                                  border: item.enabled ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid rgba(148, 163, 184, 0.25)',
                                  background: item.enabled
                                    ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.2) 0%, rgba(22, 163, 74, 0.3) 100%)'
                                    : 'rgba(255, 255, 255, 0.05)',
                                  color: item.enabled ? '#4ade80' : '#94a3b8',
                                  cursor: isToggling ? 'wait' : 'pointer',
                                  transition: 'all 0.15s ease',
                                  flexShrink: 0
                                }}
                              >
                                {isToggling ? (
                                  <>⏳ Saving...</>
                                ) : item.enabled ? (
                                  <>👁️ Visible</>
                                ) : (
                                  <>🙈 Hidden</>
                                )}
                              </button>

                              <button
                                type="button"
                                onClick={() => handleRemoveSource(item)}
                                disabled={isRemoving || isToggling}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  justifyContent: 'center',
                                  padding: '6px 10px',
                                  borderRadius: '6px',
                                  border: '1px solid rgba(239, 68, 68, 0.4)',
                                  background: 'rgba(239, 68, 68, 0.15)',
                                  color: '#f87171',
                                  cursor: isRemoving ? 'wait' : 'pointer',
                                  fontSize: '0.75rem',
                                  fontWeight: 600,
                                  transition: 'all 0.15s ease',
                                  flexShrink: 0
                                }}
                                title={`Remove "${item.name}" from ${currentScene || 'scene'}`}
                                aria-label={`Remove "${item.name}"`}
                              >
                                <span>{isRemoving ? '⏳' : '🗑️'}</span>
                                <span className="switcher-tab-text-desktop">{isRemoving ? 'Removing...' : 'Remove'}</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>

              {/* Desktop View: Realtime Bitrate History Sparkline Chart */}
              <div className="switcher-bitrate-desktop">
                {renderBitrateHistoryCard(desktopCanvasRef)}
              </div>

              {/* OBS Studio WebSocket Connection & Diagnostics Card */}
              {renderObsWebSocketCard()}

              {/* Quick Navigation Banner to Switcher Options */}
              <div style={{
                background: 'rgba(56, 189, 248, 0.05)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                borderRadius: '12px',
                padding: '16px 20px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '12px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontSize: '1.5rem' }}>⚙️</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>Configure Auto-Switch Triggers & Target Scenes</div>
                    <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>Bitrate thresholds, latency triggers, and target scene names are in Switcher Options.</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('switcher_options')}
                  className="btn btn-secondary"
                  style={{
                    fontSize: '0.82rem',
                    padding: '8px 16px',
                    background: 'rgba(56, 189, 248, 0.15)',
                    border: '1px solid rgba(56, 189, 248, 0.4)',
                    color: '#38bdf8',
                    fontWeight: 700,
                    cursor: 'pointer',
                    borderRadius: '8px',
                  }}
                >
                  Open Switcher Options →
                </button>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '14px 16px', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <div style={{ width: '38px', height: '38px', borderRadius: '8px', background: '#9146FF', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1.1rem' }}>
                    T
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>Twitch Bot</span>
                      {(settings.twitchUseCustomBot && settings.twitchBotUsername) ? (
                        <>
                          <span style={{ fontSize: '0.72rem', background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.3)', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                            ● BOT: @{settings.twitchBotUsername}
                          </span>
                          <span style={{ fontSize: '0.72rem', background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', border: '1px solid rgba(34, 197, 94, 0.3)', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                            IN @{settings.twitchUsername || 'YOUR CHAT'}
                          </span>
                        </>
                      ) : (settings.twitchToken || settings.twitchUsername) ? (
                        <span style={{ fontSize: '0.72rem', background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', border: '1px solid rgba(34, 197, 94, 0.3)', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● ACTIVE ON @{settings.twitchUsername || 'TWITCH'}
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.72rem', background: 'rgba(255, 255, 255, 0.1)', color: 'rgba(255, 255, 255, 0.5)', padding: '1px 6px', borderRadius: '4px' }}>
                          NOT CONNECTED
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.7, marginTop: '2px' }}>
                      {(settings.twitchUseCustomBot && settings.twitchBotUsername)
                        ? `Replies to chat commands as @${settings.twitchBotUsername} in @${settings.twitchUsername || 'your channel'}`
                        : (settings.twitchToken || settings.twitchUsername)
                          ? `Replies directly from @${settings.twitchUsername || 'your account'} in chat`
                          : 'Shared chat bot (Connect account in Settings)'}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {(settings.twitchUseCustomBot && settings.twitchBotUsername) ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                          saveSettingsUpdates({ twitchUseCustomBot: false });
                          showToast('Switched replies back to main streamer account', 'info');
                        }}
                        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '0.8rem', padding: '6px 12px' }}
                        title="Replies will come from your streamer account instead of the bot account"
                      >
                        Use main account
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={handleConnectCustomBot}
                        style={{ background: 'rgba(145, 70, 255, 0.18)', border: '1px solid rgba(145, 70, 255, 0.45)', color: '#c084fc', fontSize: '0.8rem', padding: '6px 12px', fontWeight: 600 }}
                      >
                        Change bot account
                      </button>
                    </>
                  ) : (
                    <>
                      {settings.twitchBotUsername && !settings.twitchUseCustomBot && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            saveSettingsUpdates({ twitchUseCustomBot: true });
                            showToast(`Switched replies to bot @${settings.twitchBotUsername}`, 'success');
                          }}
                          style={{ background: 'rgba(56, 189, 248, 0.15)', border: '1px solid rgba(56, 189, 248, 0.4)', color: '#38bdf8', fontSize: '0.8rem', padding: '6px 12px', fontWeight: 600 }}
                        >
                          Use @{settings.twitchBotUsername}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setShowManualBotInput(v => !v)}
                        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', fontSize: '0.8rem', padding: '6px 12px' }}
                        title="Enter bot username or token manually"
                      >
                        ✍️ Manual
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={handleConnectCustomBot}
                        style={{ background: 'rgba(145, 70, 255, 0.15)', border: '1px solid rgba(145, 70, 255, 0.35)', color: '#c084fc', fontSize: '0.82rem', padding: '6px 14px', fontWeight: 600 }}
                        title="Log in with your dedicated bot Twitch account"
                      >
                        Use your own bot
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Manual Bot Entry Form */}
              {showManualBotInput && (
                <div style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(145,70,255,0.3)', borderRadius: '8px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#c084fc' }}>
                    Connect Dedicated Bot Account Manually
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
                    <div>
                      <label style={{ fontSize: '0.78rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>
                        Bot Twitch Username:
                      </label>
                      <input
                        type="text"
                        value={manualBotUsername}
                        onChange={(e) => setManualBotUsername(e.target.value)}
                        placeholder="e.g. LazeskBot"
                        style={{ width: '100%', padding: '7px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', color: '#fff', fontSize: '0.85rem' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.78rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>
                        Bot OAuth Token:
                      </label>
                      <input
                        type="password"
                        value={manualBotToken}
                        onChange={(e) => setManualBotToken(e.target.value)}
                        placeholder="oauth:xxxx or access token"
                        style={{ width: '100%', padding: '7px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', color: '#fff', fontSize: '0.85rem' }}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setShowManualBotInput(false);
                        setManualBotUsername('');
                        setManualBotToken('');
                      }}
                      style={{ padding: '6px 12px', fontSize: '0.82rem' }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        const cleanName = manualBotUsername.trim().replace(/^@/, '');
                        if (!cleanName) {
                          showToast('Please enter the bot username', 'error');
                          return;
                        }
                        const cleanToken = manualBotToken.trim().replace(/^oauth:/i, '');
                        saveSettingsUpdates({
                          twitchBotUsername: cleanName,
                          ...(cleanToken ? { twitchBotToken: cleanToken } : {}),
                          twitchUseCustomBot: true
                        });
                        setShowManualBotInput(false);
                        showToast(`Bot account @${cleanName} saved and activated!`, 'success');
                      }}
                      style={{ padding: '6px 16px', fontSize: '0.82rem', fontWeight: 700 }}
                    >
                      Save Bot
                    </button>
                  </div>
                </div>
              )}

              {/* Kick Bot */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: '#53FC19', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                    K
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>Kick Bot</span>
                      {settings.kickChannelName && (
                        <span style={{ fontSize: '0.72rem', background: 'rgba(83, 252, 25, 0.15)', color: '#53FC19', border: '1px solid rgba(83, 252, 25, 0.3)', padding: '1px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● ACTIVE ON @{settings.kickChannelName}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.6 }}>Shared chat bot</div>
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

            <div style={{ fontSize: '0.78rem', color: 'rgba(255, 255, 255, 0.65)', display: 'flex', alignItems: 'flex-start', gap: '8px', background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)', lineHeight: 1.45 }}>
              <span style={{ color: '#38bdf8', fontSize: '1rem', marginTop: '-1px' }}>ⓘ</span>
              <div>
                <strong style={{ color: '#fff' }}>Using your own bot?</strong> Click <strong>"Use your own bot"</strong> and sign in as the <strong>bot account</strong> when asked (not yourself). Make sure your bot is a <strong>Moderator or VIP</strong> in your Twitch channel so it can reply in chat freely without slowmode or spam filtering.
              </div>
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
              <PurpleToggle
                checked={settings.obsCommandsPublicEnabled ?? true}
                onChange={(v) => saveSettingsUpdates({ obsCommandsPublicEnabled: v })}
              />
            </div>

            {/* Moderator Commands Toggle Row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.92rem', color: '#fff' }}>Moderator commands</div>
                <div style={{ fontSize: '0.8rem', opacity: 0.6, marginTop: '2px' }}>
                  Let your moderators run moderator commands.
                </div>
              </div>
              <PurpleToggle
                checked={settings.obsCommandsModEnabled ?? true}
                onChange={(v) => saveSettingsUpdates({ obsCommandsModEnabled: v })}
              />
            </div>
          </div>

          {/* CARD 4: COMMANDS (FILTER TABS, ALIAS EDITORS, ROLE SELECTORS, TOGGLES) */}
          <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '24px' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 6px', color: '#fff' }}>Commands</h3>
            <p style={{ margin: '0 0 16px', opacity: 0.7, fontSize: '0.84rem', lineHeight: 1.5 }}>
              Turn commands on or off, choose who may use them and add shorter names. Roles build on each other (Everyone → Subscribers → VIPs → Moderators → Admins): a command for Subscribers also works for VIPs, moderators and admins. Admins are the channel owner and designated workspace administrators.
            </p>

            {/* Filter Tabs & Search Bar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                {[
                  { key: 'All', label: `All ${countAll}` },
                  { key: 'Admins', label: 'Admins' },
                  { key: 'Moderators', label: 'Moderators' },
                  { key: 'Everyone', label: 'Everyone' },
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

                    <PurpleToggle
                      checked={cmd.enabled}
                      onChange={() => toggleCommandEnabled(cmd.id)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}

      {/* =====================================================================
          TAB 3: SWITCHER OPTIONS
          ===================================================================== */}
      {activeTab === 'switcher_options' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {/* Switching Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 4px', color: '#fff' }}>
                ⚙️ Switcher Options
              </h2>
              <p style={{ margin: 0, opacity: 0.7, fontSize: '0.88rem' }}>
                Configure auto-switching triggers, target scenes, and OBS automation rules for {settings.twitchUsername ? `@${settings.twitchUsername}` : 'your stream'}.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setActiveTab('switcher')}
                className="btn btn-secondary"
                style={{
                  fontSize: '0.82rem',
                  padding: '7px 14px',
                  background: 'rgba(34, 197, 94, 0.12)',
                  border: '1px solid rgba(34, 197, 94, 0.35)',
                  color: '#4ade80',
                  fontWeight: 700,
                  cursor: 'pointer',
                  borderRadius: '8px',
                }}
              >
                ← Back to Scene Studio
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.05)', padding: '8px 16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)' }}>
                <span style={{ fontSize: '0.88rem', fontWeight: 700, color: settings.obsAutoSwitchSceneToggle ? '#4ade80' : 'rgba(255,255,255,0.5)' }}>
                  Auto-Switch: {settings.obsAutoSwitchSceneToggle ? 'ACTIVE' : 'OFF'}
                </span>
                <PurpleToggle
                  checked={settings.obsAutoSwitchSceneToggle ?? false}
                  onChange={(v) => saveSettingsUpdates({ obsAutoSwitchSceneToggle: v })}
                />
              </div>
            </div>
          </div>

          {/* 2-Column Switching Grid */}
          <div className="switching-main-grid">
            
            {/* COLUMN 1: Triggers & Target Scenes */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              {/* CARD 1: Bitrate triggers */}
              <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '22px' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 6px', color: '#fff' }}>
                  Bitrate triggers
                </h3>
                <p style={{ margin: '0 0 16px', opacity: 0.7, fontSize: '0.82rem', lineHeight: 1.45 }}>
                  Measured on the highest-priority server that is receiving video. Set LOW where your picture starts to fall apart (the default 800 kbps suits most streams); with BRB off, the switcher goes to BRB only when the feed is gone.
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
                <div className="trigger-sliders-grid">
                  {/* LOW Bitrate Slider & Input */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(250, 204, 21, 0.2)', borderRadius: '10px', padding: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#facc15', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#facc15', display: 'inline-block' }} />
                        Switch to LOW at or below
                      </span>
                      <PurpleToggle
                        checked={settings.obsLowBitrateTriggerEnabled ?? true}
                        onChange={(v) => saveSettingsUpdates({ obsLowBitrateTriggerEnabled: v })}
                      />
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
                      <PurpleToggle
                        checked={settings.obsOfflineBitrateTriggerEnabled ?? true}
                        onChange={(v) => saveSettingsUpdates({ obsOfflineBitrateTriggerEnabled: v })}
                      />
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
                <div className="status-summary-3box">
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
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '0.8rem', color: (settings.rttTriggerEnabled ?? true) ? '#38bdf8' : 'rgba(255,255,255,0.4)', fontWeight: 600 }}>
                      {(settings.rttTriggerEnabled ?? true) ? 'Active' : 'Off'}
                    </span>
                    <PurpleToggle
                      checked={settings.rttTriggerEnabled ?? true}
                      onChange={(v) => saveSettingsUpdates({ rttTriggerEnabled: v })}
                    />
                  </div>
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
                <div className="trigger-sliders-grid">
                  {/* LOW RTT Slider & Input */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(250, 204, 21, 0.2)', borderRadius: '10px', padding: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#facc15', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#facc15', display: 'inline-block' }} />
                        Switch to LOW at or above
                      </span>
                      <PurpleToggle
                        checked={settings.obsRttLowTriggerEnabled ?? true}
                        onChange={(v) => saveSettingsUpdates({ obsRttLowTriggerEnabled: v })}
                      />
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
                      <PurpleToggle
                        checked={settings.obsRttOfflineTriggerEnabled ?? true}
                        onChange={(v) => saveSettingsUpdates({ obsRttOfflineTriggerEnabled: v })}
                      />
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
                <div className="status-summary-3box">
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
                const defaultPresets = DEFAULT_SCENE_PRESETS;

                const renderSceneSelect = (
                  label: string,
                  dotColor: string | null,
                  currentVal: string,
                  onChangeVal: (v: string) => void
                ) => {
                  const val = currentVal || '';
                  return (
                    <div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: 600, color: dotColor || '#e2e8f0', marginBottom: '6px' }}>
                        {dotColor && <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: dotColor, display: 'inline-block' }} />}
                        {label}
                      </label>
                      {customSceneMode ? (
                        <input
                          type="text"
                          value={val}
                          onChange={(e) => onChangeVal(e.target.value)}
                          placeholder={`e.g. ${val || 'scene name'}`}
                          style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                        />
                      ) : (
                        <select
                          value={val}
                          onChange={(e) => onChangeVal(e.target.value)}
                          style={{ width: '100%', padding: '9px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.88rem' }}
                        >
                          {availableScenes.length > 0 && (
                            <optgroup label="Detected in OBS Studio" style={{ background: '#0f172a', color: '#38bdf8' }}>
                              {availableScenes.map(sc => (
                                <option key={`obs-${sc}`} value={sc} style={{ background: '#1e293b', color: '#fff' }}>
                                  {sc}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label="Common Preset Scenes" style={{ background: '#0f172a', color: '#94a3b8' }}>
                            {defaultPresets.map(sc => (
                              <option key={`preset-${sc}`} value={sc} style={{ background: '#1e293b', color: '#fff' }}>
                                {sc}
                              </option>
                            ))}
                          </optgroup>
                          {Boolean(val && !availableScenes.includes(val) && !defaultPresets.includes(val)) && (
                            <optgroup label="Custom Scene" style={{ background: '#0f172a', color: '#c084fc' }}>
                              <option value={val} style={{ background: '#1e293b', color: '#fff' }}>
                                {val}
                              </option>
                            </optgroup>
                          )}
                        </select>
                      )}
                    </div>
                  );
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

                    <div className="target-scenes-grid">
                      {/* LIVE SCENE */}
                      {renderSceneSelect('Live Scene:', '#22c55e', settings.obsLiveSceneName || 'live', (val) => saveSettingsUpdates({ obsLiveSceneName: val }))}

                      {/* LOW SCENE */}
                      {renderSceneSelect('Low Scene:', '#eab308', settings.obsLowSceneName || 'low', (val) => saveSettingsUpdates({ obsLowSceneName: val }))}

                      {/* BRB / OFFLINE SCENE */}
                      {renderSceneSelect('BRB / Offline Scene:', '#ef4444', settings.obsOfflineSceneName || 'offline', (val) => saveSettingsUpdates({ obsOfflineSceneName: val }))}

                      {/* REFRESH SCENE */}
                      {renderSceneSelect('Refresh Scene:', '#38bdf8', settings.obsRefreshSceneName || 'refresh', (val) => saveSettingsUpdates({ obsRefreshSceneName: val }))}
                    </div>

                    {/* Switch Delay & Secondary scenes */}
                    <div className="target-scenes-secondary-grid">
                      <div>
                        <label style={{ fontSize: '0.8rem', opacity: 0.8, display: 'block', marginBottom: '6px' }}>
                          Switch Delay:
                        </label>
                        <select
                          value={settings.obsSwitchDelaySeconds ?? settings.obsChecksBeforeSwitching ?? 3}
                          onChange={(e) => {
                            const val = Number(e.target.value) || 3;
                            saveSettingsUpdates({ obsSwitchDelaySeconds: val, obsChecksBeforeSwitching: val });
                          }}
                          style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.85rem' }}
                        >
                          <option value={1} style={{ background: '#1e293b' }}>1 Second (Instant)</option>
                          <option value={2} style={{ background: '#1e293b' }}>2 Seconds</option>
                          <option value={3} style={{ background: '#1e293b' }}>3 Seconds (Recommended)</option>
                          <option value={5} style={{ background: '#1e293b' }}>5 Seconds</option>
                        </select>
                      </div>

                      {renderSceneSelect('Starting Scene:', '#c084fc', settings.obsStartingSceneName || 'starting', (val) => saveSettingsUpdates({ obsStartingSceneName: val }))}

                      {renderSceneSelect('Ending Scene:', '#f43f5e', settings.obsEndingSceneName || 'ending', (val) => saveSettingsUpdates({ obsEndingSceneName: val }))}

                      {renderSceneSelect('Privacy Scene:', '#eab308', settings.obsPrivacySceneName || 'privacy', (val) => saveSettingsUpdates({ obsPrivacySceneName: val }))}
                    </div>
                  </div>
                );
              })()}

            </div>

            {/* COLUMN 2: Switching Settings & Start/End/Raids */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              {/* CARD 1: Switching Options */}
              <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '22px' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 16px', color: '#fff' }}>
                  Switching Options
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
                  <PurpleToggle
                    checked={settings.obsAutoSwitchSceneToggle ?? false}
                    onChange={(v) => saveSettingsUpdates({ obsAutoSwitchSceneToggle: v })}
                  />
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
                  <PurpleToggle
                    checked={settings.obsSwitchOnlyWhileStreaming ?? true}
                    onChange={(v) => saveSettingsUpdates({ obsSwitchOnlyWhileStreaming: v })}
                  />
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
                  <PurpleToggle
                    checked={settings.obsInstantRecovery ?? true}
                    onChange={(v) => saveSettingsUpdates({ obsInstantRecovery: v })}
                  />
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
                  <PurpleToggle
                    checked={settings.obsChatAlertsEnabled ?? true}
                    onChange={(v) => saveSettingsUpdates({ obsChatAlertsEnabled: v })}
                  />
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
                    value={settings.obsChecksBeforeSwitching ?? settings.obsSwitchDelaySeconds ?? 3}
                    onChange={(e) => {
                      const val = Number(e.target.value) || 3;
                      saveSettingsUpdates({ obsChecksBeforeSwitching: val, obsSwitchDelaySeconds: val });
                    }}
                    style={{ width: '64px', padding: '6px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.95rem', fontWeight: 700, textAlign: 'center' }}
                  />
                </div>

                {/* 8. OBS Stream Commands (!start, !end & !refresh) */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      OBS Stream Commands (!start, !end & !refresh)
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Allow remote chat & cloud signals to trigger broadcast start, stop, or refresh scene cycles.
                    </div>
                  </div>
                  <PurpleToggle
                    checked={settings.obsStreamCommandsEnabled ?? true}
                    onChange={(v) => saveSettingsUpdates({ obsStreamCommandsEnabled: v })}
                  />
                </div>

                {/* 7. Auto-Switch Polling Interval */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Auto-Switch Polling Interval
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Interval for checking bitrate health to trigger automatic OBS scene switching.
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      min={3}
                      max={60}
                      step={1}
                      value={settings.autoSwitchPollInterval ?? 10}
                      onChange={(e) => saveSettingsUpdates({ autoSwitchPollInterval: Number(e.target.value) || 10 })}
                      style={{ width: '64px', padding: '6px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.95rem', fontWeight: 700, textAlign: 'center' }}
                    />
                    <span style={{ fontSize: '0.82rem', opacity: 0.6 }}>sec</span>
                  </div>
                </div>

                {/* 8. Belabox Bitrate Poll Interval */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Belabox Bitrate Poll Interval
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Polling interval for fetching SRT ingest bitrate stats from server.
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      min={2}
                      max={60}
                      step={2}
                      value={settings.bitrateUpdateInterval ?? 10}
                      onChange={(e) => saveSettingsUpdates({ bitrateUpdateInterval: Number(e.target.value) || 10 })}
                      style={{ width: '64px', padding: '6px 10px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', fontSize: '0.95rem', fontWeight: 700, textAlign: 'center' }}
                    />
                    <span style={{ fontSize: '0.82rem', opacity: 0.6 }}>sec</span>
                  </div>
                </div>
              </div>

              {/* CARD 2: Start, end & raids (Exact match to media_1793565680806_64deaffe.jpg) */}
              <div style={{ background: '#0e121b', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '12px', padding: '22px' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 16px', color: '#fff' }}>
                  Start, end & raids
                </h3>

                {/* 1. Starting scene on go-live */}
                <div style={{ padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ paddingRight: '16px' }}>
                      <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                        Starting scene on go-live
                      </div>
                      <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                        Show the selected scene when the stream starts on OBS.
                      </div>
                    </div>
                    <PurpleToggle
                      checked={settings.obsStartingSceneOnGoLive ?? false}
                      onChange={(v) => saveSettingsUpdates({ obsStartingSceneOnGoLive: v })}
                    />
                  </div>

                  {/* Pick scene on stream start dropdown & Belabox go-live check settings */}
                  <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#c084fc' }}>
                        🎬 Pick scene when stream starts:
                      </span>
                      <select
                        value={settings.obsStartingSceneName || 'starting'}
                        onChange={(e) => saveSettingsUpdates({ obsStartingSceneName: e.target.value })}
                        style={{
                          padding: '6px 12px',
                          background: '#131924',
                          border: '1px solid rgba(192, 132, 252, 0.4)',
                          borderRadius: '6px',
                          color: '#ffffff',
                          fontSize: '0.85rem',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        {availableScenes.length > 0 && (
                          <optgroup label="Detected in OBS Studio" style={{ background: '#0f172a', color: '#38bdf8' }}>
                            {availableScenes.map(sc => (
                              <option key={`start-obs-${sc}`} value={sc} style={{ background: '#1e293b', color: '#fff' }}>
                                {sc}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <optgroup label="Preset Scenes" style={{ background: '#0f172a', color: '#94a3b8' }}>
                          {DEFAULT_SCENE_PRESETS.map(sc => (
                            <option key={`start-preset-${sc}`} value={sc} style={{ background: '#1e293b', color: '#fff' }}>
                              {sc}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </div>

                    {/* Belabox Go-Live Check Timeout */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#38bdf8' }}>
                        ⏱️ Belabox go-live check timeout:
                      </span>
                      <select
                        value={settings.obsStartingSceneCheckSeconds ?? 60}
                        onChange={(e) => saveSettingsUpdates({ obsStartingSceneCheckSeconds: Number(e.target.value) || 60 })}
                        style={{
                          padding: '6px 12px',
                          background: '#131924',
                          border: '1px solid rgba(56, 189, 248, 0.4)',
                          borderRadius: '6px',
                          color: '#ffffff',
                          fontSize: '0.85rem',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        <option value={60} style={{ background: '#1e293b', color: '#fff' }}>1 minute (Default &amp; Minimum)</option>
                        <option value={120} style={{ background: '#1e293b', color: '#fff' }}>2 minutes</option>
                        <option value={180} style={{ background: '#1e293b', color: '#fff' }}>3 minutes</option>
                        <option value={300} style={{ background: '#1e293b', color: '#fff' }}>5 minutes</option>
                      </select>
                    </div>

                    {/* Minimum Starting Scene Delay */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'rgba(255, 255, 255, 0.75)' }}>
                        ⏳ Minimum delay on starting scene:
                      </span>
                      <select
                        value={settings.obsStartingSceneMinDelaySeconds ?? 0}
                        onChange={(e) => saveSettingsUpdates({ obsStartingSceneMinDelaySeconds: Number(e.target.value) || 0 })}
                        style={{
                          padding: '6px 12px',
                          background: '#131924',
                          border: '1px solid rgba(255, 255, 255, 0.2)',
                          borderRadius: '6px',
                          color: '#ffffff',
                          fontSize: '0.85rem',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        <option value={0} style={{ background: '#1e293b', color: '#fff' }}>0s (Switch to Live immediately when Belabox is live)</option>
                        <option value={60} style={{ background: '#1e293b', color: '#fff' }}>1 minute (Hold starting scene for at least 60s)</option>
                        <option value={120} style={{ background: '#1e293b', color: '#fff' }}>2 minutes</option>
                      </select>
                    </div>

                    <div style={{ fontSize: '0.74rem', opacity: 0.65, lineHeight: 1.4 }}>
                      When you start streaming on OBS, the switcher stays on your starting scene and checks for a minimum of 1 minute if Belabox goes live. If Belabox is detected, it automatically switches to your Live scene. If Belabox does not go live within the check timeout, it stops checking.
                    </div>

                    {/* Active check indicator banner if checking right now */}
                    {isCheckingStartingBelabox && (
                      <div style={{ marginTop: '4px', padding: '8px 12px', background: 'rgba(192, 132, 252, 0.12)', border: '1px solid rgba(192, 132, 252, 0.3)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem', color: '#c084fc', fontWeight: 600 }}>
                          <span>⏱️</span>
                          <span>Currently checking if Belabox goes live ({startingCheckRemainingSeconds}s remaining)...</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            startingCheckStartRef.current = 0;
                            setIsCheckingStartingBelabox(false);
                            setStartingCheckRemainingSeconds(0);
                            showToast('Belabox check stopped.', 'info');
                          }}
                          style={{
                            background: 'rgba(239, 68, 68, 0.2)',
                            border: '1px solid rgba(239, 68, 68, 0.4)',
                            color: '#fca5a5',
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            cursor: 'pointer'
                          }}
                        >
                          Stop Checking
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 2. Custom Chat Message on End Stream */}
                <div style={{ padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ paddingRight: '16px' }}>
                      <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>Post custom message on stream end</span>
                        <span style={{ fontSize: '0.72rem', color: '#c084fc', background: 'rgba(192, 132, 252, 0.15)', border: '1px solid rgba(192, 132, 252, 0.3)', padding: '1px 6px', borderRadius: '4px', fontWeight: 600 }}>
                          Chat
                        </span>
                      </div>
                      <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                        Write a custom message to automatically send to chat when your stream ends.
                      </div>
                    </div>
                    <PurpleToggle
                      checked={settings.obsEndingChatMessageEnabled ?? false}
                      onChange={(v) => saveSettingsUpdates({ obsEndingChatMessageEnabled: v })}
                    />
                  </div>

                  {/* Message Input Box & Test Button */}
                  <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        type="text"
                        value={settings.obsEndingChatMessage ?? ''}
                        onChange={(e) => saveSettingsUpdates({ obsEndingChatMessage: e.target.value }, { silent: true })}
                        placeholder="Thanks for watching everyone! Stream is now ending. See you next time! ❤️"
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.14)',
                          borderRadius: '8px',
                          color: '#ffffff',
                          fontSize: '0.88rem'
                        }}
                      />
                      <button
                        type="button"
                        onClick={handleTestEndStreamMessage}
                        disabled={isTestingEndChat}
                        title="Send a test message to Twitch chat right now"
                        style={{
                          padding: '8px 14px',
                          background: 'rgba(145, 70, 255, 0.2)',
                          border: '1px solid rgba(145, 70, 255, 0.45)',
                          borderRadius: '8px',
                          color: '#c084fc',
                          fontSize: '0.82rem',
                          fontWeight: 700,
                          cursor: isTestingEndChat ? 'not-allowed' : 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        <span>💬</span>
                        <span>{isTestingEndChat ? 'Sending...' : 'Test in Chat'}</span>
                      </button>
                    </div>
                    <span style={{ fontSize: '0.74rem', opacity: 0.55 }}>
                      Sent to connected chat when broadcast stops in OBS, via Switcher Studio, or via !end / !stop command.
                    </span>
                  </div>
                </div>

                {/* 4. Auto stop stream on raid */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', marginBottom: '3px' }}>
                      Auto stop stream on raid
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'rgba(255, 255, 255, 0.65)' }}>
                      Enable/disable stopping the stream on a raid.
                    </div>
                  </div>
                  <PurpleToggle
                    checked={settings.obsAutoStopStreamOnRaid ?? false}
                    onChange={(v) => saveSettingsUpdates({ obsAutoStopStreamOnRaid: v })}
                  />
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
                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: switcherDisplayState.color }}>
                      {switcherDisplayState.badgeText}
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

    </div>
  );
}

export default function LowBitratePage() {
  return (
    <Suspense fallback={<div style={{ padding: '40px', color: '#fff', textAlign: 'center' }}>Loading Switcher Engine...</div>}>
      <LowBitrateContent />
    </Suspense>
  );
}
