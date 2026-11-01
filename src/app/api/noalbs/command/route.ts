import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { broadcastSettings } from '@/lib/settings-broadcast';
import { safeObsSwitchScene, safeObsRefreshCycle, getCurrentObsScene, safeObsStreamControlResult } from '@/lib/obs-helper';
import { fetchBitrateStats } from '@/utils/api-utils';

export const dynamic = 'force-dynamic';

async function getSettings(): Promise<any> {
  let settings: any = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedOverlaySettings : null) || null;
  try {
    const kvData = await kv.get('overlay_settings');
    if (kvData && typeof kvData === 'object') {
      settings = kvData;
    }
  } catch {}
  return settings || {};
}

async function saveSettingsPatch(patch: Record<string, any>) {
  const current = await getSettings();
  const updated = { ...current, ...patch };
  const now = Date.now();

  if (typeof globalThis !== 'undefined') {
    (globalThis as any).__cachedOverlaySettings = updated;
    (globalThis as any).__cachedOverlaySettingsTime = now;
  }

  try {
    await Promise.all([
      kv.set('overlay_settings', updated),
      kv.set('overlay_settings_modified', now)
    ]);
  } catch (err) {
    console.warn('KV save warning in noalbs command:', err);
  }

  await broadcastSettings(updated);
  return updated;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { command, user = 'admin', isMod = true, isBroadcaster = true } = body;

    if (!command || typeof command !== 'string') {
      return NextResponse.json({ success: false, error: 'Command string is required' }, { status: 400 });
    }

    const trimmed = command.trim();
    const lower = trimmed.toLowerCase();
    const parts = trimmed.split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1);

    const settings = await getSettings();

    // Check permissions
    const publicAllowed = settings.obsCommandsPublicEnabled !== false;
    const modAllowed = settings.obsCommandsModEnabled !== false;

    // Connect to OBS helper
    const obsUrl = settings.obsWebsocketUrl || 'ws://127.0.0.1:4455';
    const obsPassword = settings.obsWebsocketPassword || '';

    const connectObs = async () => {
      const { default: OBSWebSocket } = await import('obs-websocket-js');
      const obs = new OBSWebSocket();
      obs.on('ConnectionClosed', () => {});
      obs.on('ConnectionError', () => {});
      await obs.connect(obsUrl, obsPassword || undefined);
      return obs;
    };

    // 1. !bitrate or !b
    if (cmdName === '!bitrate' || cmdName === '!b') {
      let stats: { bitrateKbps: number; rttMs?: number } | null = null;
      if (settings.belaboxPublisherKey) {
        try {
          stats = await fetchBitrateStats(`https://stats.srt.belabox.net/${settings.belaboxPublisherKey}`, settings.belaboxPublisherKey);
        } catch {}
      }

      if (!stats) {
        // Fallback to telemetry cache
        const telemetry = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedObsTelemetry : null);
        if (telemetry && telemetry.outputBitrateKbps) {
          stats = { bitrateKbps: telemetry.outputBitrateKbps };
        }
      }

      if (stats) {
        const health = stats.bitrateKbps >= (settings.obsRecoveryBitrateThreshold || 2000)
          ? '🟢 Healthy'
          : stats.bitrateKbps >= (settings.obsLowBitrateThreshold || 1300)
          ? '🟡 Low'
          : stats.bitrateKbps > 0
          ? '🟠 Degraded'
          : '🔴 Offline';

        const rttStr = stats.rttMs !== undefined ? ` | RTT: ${stats.rttMs}ms` : '';
        const msg = `📡 Current Bitrate: ${stats.bitrateKbps.toLocaleString()} kbps${rttStr} | Stream Health: ${health}`;
        return NextResponse.json({ success: true, message: msg, stats });
      } else {
        return NextResponse.json({ success: true, message: '📡 Bitrate: No active stream telemetry received or stream is offline.' });
      }
    }

    // 2. !status
    if (cmdName === '!status') {
      let activeScene = 'unknown';
      let isStreaming = false;

      try {
        const obs = await connectObs();
        activeScene = (await getCurrentObsScene(obs)) || 'unknown';
        const streamStatus: any = await obs.call('GetStreamStatus');
        isStreaming = Boolean(streamStatus?.outputActive);
        await obs.disconnect();
      } catch {
        activeScene = settings.obsLiveSceneName || 'live';
      }

      const autoSwitchOn = Boolean(settings.obsAutoSwitchSceneToggle);
      const lowThresh = settings.obsLowBitrateThreshold || 1300;
      const recThresh = settings.obsRecoveryBitrateThreshold || 2000;

      const msg = `📊 Status: ${isStreaming ? '🟢 Live' : '⚪ Standby'} | Scene: "${activeScene}" | Auto-Switch: ${autoSwitchOn ? 'ENABLED' : 'DISABLED'} (Low: ${lowThresh}k, Rec: ${recThresh}k)`;
      return NextResponse.json({ success: true, message: msg, activeScene, isStreaming, autoSwitchOn });
    }

    // 3. !switch or !ss or quick scene shortcuts
    const isSwitchCommand = cmdName === '!switch' || cmdName === '!ss';
    const isLiveShortcut = cmdName === '!live';
    const isLowShortcut = cmdName === '!low';
    const isOfflineShortcut = cmdName === '!offline' || cmdName === '!brb';
    const isStartingShortcut = cmdName === '!starting';
    const isEndingShortcut = cmdName === '!ending';
    const isPrivacyShortcut = cmdName === '!privacy' || cmdName === '!pause';

    if (isSwitchCommand || isLiveShortcut || isLowShortcut || isOfflineShortcut || isStartingShortcut || isEndingShortcut || isPrivacyShortcut) {
      if (!isBroadcaster && !isMod) {
        return NextResponse.json({ success: false, error: 'Permission denied: Scene switching requires Mod or Broadcaster' }, { status: 403 });
      }

      let targetScene = '';
      if (isSwitchCommand) {
        targetScene = args.join(' ').trim();
        if (!targetScene) {
          return NextResponse.json({ success: false, error: 'Usage: !switch <sceneName> or !ss <sceneName>' }, { status: 400 });
        }
        // Aliases
        const lowerTarget = targetScene.toLowerCase();
        if (lowerTarget === 'live') targetScene = settings.obsLiveSceneName || 'live';
        else if (lowerTarget === 'low') targetScene = settings.obsLowSceneName || 'low';
        else if (lowerTarget === 'offline' || lowerTarget === 'brb') targetScene = settings.obsOfflineSceneName || 'offline';
        else if (lowerTarget === 'starting') targetScene = settings.obsStartingSceneName || 'starting';
        else if (lowerTarget === 'ending') targetScene = settings.obsEndingSceneName || 'ending';
        else if (lowerTarget === 'privacy' || lowerTarget === 'pause') targetScene = settings.obsPrivacySceneName || 'privacy';
      } else if (isLiveShortcut) {
        targetScene = settings.obsLiveSceneName || 'live';
      } else if (isLowShortcut) {
        targetScene = settings.obsLowSceneName || 'low';
      } else if (isOfflineShortcut) {
        targetScene = settings.obsOfflineSceneName || 'offline';
      } else if (isStartingShortcut) {
        targetScene = settings.obsStartingSceneName || 'starting';
      } else if (isEndingShortcut) {
        targetScene = settings.obsEndingSceneName || 'ending';
      } else if (isPrivacyShortcut) {
        targetScene = settings.obsPrivacySceneName || 'privacy';
      }

      try {
        const obs = await connectObs();
        const success = await safeObsSwitchScene(obs, targetScene);
        await obs.disconnect();

        if (success) {
          return NextResponse.json({
            success: true,
            message: `🎬 Switched OBS Program Scene to "${targetScene}"`,
            scene: targetScene
          });
        } else {
          return NextResponse.json({
            success: false,
            error: `Failed to switch to scene "${targetScene}". Please ensure scene exists in OBS.`
          }, { status: 404 });
        }
      } catch (err: any) {
        return NextResponse.json({
          success: false,
          error: `OBS connection error: ${err.message}`
        }, { status: 503 });
      }
    }

    // 4. !fix / !refresh / !f
    if (cmdName === '!fix' || cmdName === '!refresh' || cmdName === '!f') {
      if (!isBroadcaster && !isMod) {
        return NextResponse.json({ success: false, error: 'Permission denied: !refresh requires Mod or Broadcaster' }, { status: 403 });
      }

      const refreshScene = settings.obsRefreshSceneName || 'refresh';
      const liveScene = settings.obsLiveSceneName || 'live';

      try {
        const obs = await connectObs();
        // Fire refresh in background or await
        safeObsRefreshCycle(obs, refreshScene, liveScene, 6000)
          .then(async () => {
            try { await obs.disconnect(); } catch {}
          })
          .catch(async () => {
            try { await obs.disconnect(); } catch {}
          });

        return NextResponse.json({
          success: true,
          message: `🔄 Stream refresh sequence initiated! Switching to "${refreshScene}" -> "${liveScene}" (6s reload)`
        });
      } catch (err: any) {
        return NextResponse.json({ success: false, error: `OBS connection error: ${err.message}` }, { status: 503 });
      }
    }

    // 5. !trigger <kbps> (adjust low threshold)
    if (cmdName === '!trigger') {
      if (!isBroadcaster && !isMod) {
        return NextResponse.json({ success: false, error: 'Permission denied: !trigger requires Mod or Broadcaster' }, { status: 403 });
      }
      const val = parseInt(args[0], 10);
      if (isNaN(val) || val <= 0) {
        return NextResponse.json({ success: false, error: 'Usage: !trigger <bitrate_in_kbps> (e.g. !trigger 1200)' }, { status: 400 });
      }

      await saveSettingsPatch({ obsLowBitrateThreshold: val });
      return NextResponse.json({ success: true, message: `⚙️ Low Bitrate Trigger updated to ${val} kbps` });
    }

    // 6. !otrigger <kbps> (adjust offline threshold)
    if (cmdName === '!otrigger') {
      if (!isBroadcaster && !isMod) {
        return NextResponse.json({ success: false, error: 'Permission denied: !otrigger requires Mod or Broadcaster' }, { status: 403 });
      }
      const val = parseInt(args[0], 10);
      if (isNaN(val) || val < 0) {
        return NextResponse.json({ success: false, error: 'Usage: !otrigger <bitrate_in_kbps> (e.g. !otrigger 100)' }, { status: 400 });
      }

      await saveSettingsPatch({ obsOfflineBitrateThreshold: val });
      return NextResponse.json({ success: true, message: `⚙️ Offline Bitrate Trigger updated to ${val} kbps` });
    }

    // 7. !rtrigger <ms> (adjust RTT trigger threshold)
    if (cmdName === '!rtrigger') {
      if (!isBroadcaster && !isMod) {
        return NextResponse.json({ success: false, error: 'Permission denied: !rtrigger requires Mod or Broadcaster' }, { status: 403 });
      }
      const val = parseInt(args[0], 10);
      if (isNaN(val) || val <= 0) {
        return NextResponse.json({ success: false, error: 'Usage: !rtrigger <ms> (e.g. !rtrigger 2500)' }, { status: 400 });
      }

      await saveSettingsPatch({ obsRttThreshold: val });
      return NextResponse.json({ success: true, message: `⚙️ RTT Latency Trigger updated to ${val} ms` });
    }

    // 8. !autoswitch [on|off] or !noalbs switch [on|off]
    if (cmdName === '!autoswitch' || (cmdName === '!noalbs' && args[0] === 'switch')) {
      if (!isBroadcaster && !isMod) {
        return NextResponse.json({ success: false, error: 'Permission denied: !autoswitch requires Mod or Broadcaster' }, { status: 403 });
      }
      const toggleArg = (cmdName === '!autoswitch' ? args[0] : args[1]) || '';
      const turnOn = toggleArg.toLowerCase() === 'on' ? true : toggleArg.toLowerCase() === 'off' ? false : !settings.obsAutoSwitchSceneToggle;

      await saveSettingsPatch({ obsAutoSwitchSceneToggle: turnOn });
      return NextResponse.json({
        success: true,
        message: `🤖 Automatic Bitrate Scene Switching is now ${turnOn ? 'ENABLED 🟢' : 'DISABLED 🔴'}`
      });
    }

    // 9. !start / !stop / !rec
    if (cmdName === '!start' || cmdName === '!stop' || cmdName === '!rec') {
      if (!isBroadcaster) {
        return NextResponse.json({ success: false, error: 'Permission denied: Stream controls require Broadcaster' }, { status: 403 });
      }

      try {
        const obs = await connectObs();
        if (cmdName === '!start' || cmdName === '!stop') {
          const action = cmdName === '!start' ? 'start' : 'stop';
          const res = await safeObsStreamControlResult(obs, action);
          await obs.disconnect();
          return NextResponse.json({
            success: res.success,
            message: res.success ? `🎬 OBS Stream ${action.toUpperCase()} command sent.` : `Failed: ${res.error}`
          });
        } else if (cmdName === '!rec') {
          await obs.call('ToggleRecord');
          await obs.disconnect();
          return NextResponse.json({ success: true, message: '⏺️ OBS Recording toggled.' });
        }
      } catch (err: any) {
        return NextResponse.json({ success: false, error: `OBS control failed: ${err.message}` }, { status: 503 });
      }
    }

    // 10. !server
    if (cmdName === '!server') {
      const serverType = settings.noalbsServerType || 'Belabox Cloud (SRT)';
      const publisherKey = settings.belaboxPublisherKey ? 'Configured ✅' : 'Not Set ⚠️';
      return NextResponse.json({
        success: true,
        message: `🖥️ Ingest Server: ${serverType} | Key: ${publisherKey}`
      });
    }

    // 11. !source
    if (cmdName === '!source') {
      return NextResponse.json({
        success: true,
        message: `📹 Ingest Source: Belabox / SRT / RTMP | Target: OBS WebSocket (${settings.obsWebsocketUrl || 'ws://127.0.0.1:4455'})`
      });
    }

    // 12. !help or !noalbs help
    if (cmdName === '!help' || cmdName === '!noalbs') {
      const helpMsg = `📖 NOALBS Commands:
• !bitrate (!b) - Live stream bitrate & RTT health
• !status - Stream health, active scene & auto-switch state
• !switch <scene> (!ss <scene>) - Switch OBS program scene
• !live / !low / !offline / !starting / !ending / !privacy - Quick scene switch
• !fix (!refresh / !f) - Reset video feed & SRT buffer (6s reload)
• !autoswitch [on|off] - Toggle automatic low bitrate switching
• !trigger <kbps> - Change low bitrate threshold
• !rtrigger <ms> - Change RTT latency threshold
• !start / !stop / !rec - OBS stream/recording control`;

      return NextResponse.json({ success: true, message: helpMsg });
    }

    return NextResponse.json({
      success: false,
      error: `Unknown command "${cmdName}". Type !help for available commands.`
    }, { status: 400 });
  } catch (err: any) {
    console.error('NOALBS command execution error:', err);
    return NextResponse.json({ success: false, error: err.message || 'Server error' }, { status: 500 });
  }
}

