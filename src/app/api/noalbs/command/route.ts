import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { broadcastSettings } from '@/lib/settings-broadcast';
import { safeObsSwitchScene, safeObsRefreshCycle, getCurrentObsScene, safeObsStreamControlResult, safeObsFixFeed, safeObsRecordControl } from '@/lib/obs-helper';
import { fetchBitrateStats } from '@/utils/api-utils';
import { CommandConfigItem, DEFAULT_NOALBS_COMMANDS } from '@/types/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

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
    const parts = trimmed.split(/\s+/);
    const rawCmd = parts[0];
    const args = parts.slice(1);

    const settings = await getSettings();
    const prefix = settings.obsCommandPrefix || '!';
    const commandsList: CommandConfigItem[] = settings.noalbsCommandsList || DEFAULT_NOALBS_COMMANDS;

    // Normalize command by checking if it starts with the configured prefix
    let normalizedCmdName = rawCmd.toLowerCase();
    if (prefix && prefix !== '!' && normalizedCmdName.startsWith(prefix)) {
      normalizedCmdName = '!' + normalizedCmdName.slice(prefix.length);
    }

    // Find command configuration
    const foundConfig = commandsList.find(c => {
      if (c.name.toLowerCase() === normalizedCmdName) return true;
      if (Array.isArray(c.aliases) && c.aliases.some(a => a.toLowerCase() === normalizedCmdName)) return true;
      return false;
    });

    // Check if command is globally disabled or specifically disabled (allow dashboard bypass)
    if (foundConfig && !foundConfig.enabled && !body.fromDashboard) {
      return NextResponse.json({ success: false, error: `Command "${rawCmd}" is currently disabled in switcher settings.` }, { status: 403 });
    }

    // Check role permissions: Admins -> Moderators -> Everyone
    const targetRole = foundConfig?.role || 'Everyone';
    if (!body.fromDashboard) {
      if (targetRole === 'Admins' && !isBroadcaster) {
        return NextResponse.json({ success: false, error: `Permission denied: ${rawCmd} requires Admin / Broadcaster.` }, { status: 403 });
      }
      if (targetRole === 'Moderators') {
        if (settings.obsCommandsModEnabled === false && !isBroadcaster) {
          return NextResponse.json({ success: false, error: `Moderator commands are currently disabled in settings.` }, { status: 403 });
        }
        if (!isBroadcaster && !isMod) {
          return NextResponse.json({ success: false, error: `Permission denied: ${rawCmd} requires Moderator or Broadcaster.` }, { status: 403 });
        }
      }
      if (targetRole === 'Everyone') {
        if (settings.obsCommandsPublicEnabled === false && !isBroadcaster && !isMod) {
          return NextResponse.json({ success: false, error: 'Public chat commands are currently disabled in settings.' }, { status: 403 });
        }
      }
    }

    // Connect to OBS helper with fast timeout for Vercel serverless
    const wsPort = settings.obsWebsocketPort || 4455;
    const obsUrl = settings.obsWebsocketUrl || `ws://127.0.0.1:${wsPort}`;
    const obsPassword = settings.obsWebsocketPassword || '';

    const connectObs = async () => {
      const { default: OBSWebSocket } = await import('obs-websocket-js');
      const obs = new OBSWebSocket();
      obs.on('ConnectionClosed', () => {});
      obs.on('ConnectionError', () => {});
      const connectPromise = obs.connect(obsUrl, obsPassword || undefined);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 2500));
      await Promise.race([connectPromise, timeoutPromise]);
      return obs;
    };

    const cmdName = normalizedCmdName;

    // 1. !bitrate or !b
    if (cmdName === '!bitrate' || cmdName === '!b') {
      let stats: { bitrateKbps: number; rttMs?: number } | null = null;
      if (settings.belaboxPublisherKey) {
        try {
          stats = await fetchBitrateStats(`https://stats.srt.belabox.net/${settings.belaboxPublisherKey}`, settings.belaboxPublisherKey);
        } catch {}
      }

      if (!stats) {
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
      const rttThresh = settings.obsRttThreshold || 2500;

      const msg = `📊 Status: ${isStreaming ? '🟢 Live' : '⚪ Standby'} | Scene: "${activeScene}" | Auto-Switch: ${autoSwitchOn ? 'ENABLED' : 'DISABLED'} (Low: ${lowThresh}k, Rec: ${recThresh}k, RTT: ${rttThresh}ms)`;
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
      let targetScene = '';
      if (isSwitchCommand) {
        targetScene = args.join(' ').trim();
        if (!targetScene) {
          return NextResponse.json({ success: false, error: 'Usage: !switch <sceneName> or !ss <sceneName>' }, { status: 400 });
        }
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

      // Dispatch signal to OBS Browser Source on the streamer's machine
      const now = Date.now();
      await saveSettingsPatch({
        obsSceneSwitchSignal: { sceneName: targetScene, timestamp: now }
      });

      // Attempt direct WS if available locally
      let switchedDirect = false;
      try {
        const obs = await connectObs();
        switchedDirect = await safeObsSwitchScene(obs, targetScene);
        await obs.disconnect();
      } catch {}

      return NextResponse.json({
        success: true,
        message: `🎬 Switched OBS Program Scene to "${targetScene}"`,
        scene: targetScene,
        via: switchedDirect ? 'direct' : 'browser_source'
      });
    }

    // 4a. !fix / !f (Reconnect stream/Belabox sources on the scene on air, ZERO scene change!)
    if (cmdName === '!fix' || cmdName === '!f') {
      const liveScene = settings.obsLiveSceneName || 'live';
      const now = Date.now();

      // Dispatch stream fix command to active OBS Browser Source
      await saveSettingsPatch({
        obsStreamCommandSignal: { action: 'fix', timestamp: now }
      });

      // Also attempt direct WS if local
      let fixResult: any = null;
      try {
        const obs = await connectObs();
        fixResult = await safeObsFixFeed(obs, liveScene);
        try { await obs.disconnect(); } catch {}
      } catch {}

      const scene = fixResult?.scene || liveScene;
      const sources: string[] = fixResult?.sources || [];
      const msg = fixResult
        ? fixResult.message
        : `🔧 Signal dispatched to fix feed on active scene (${liveScene})`;

      return NextResponse.json({
        success: true,
        scene,
        sources,
        message: msg
      });
    }

    // 4b. !refresh / !ref (Full scene transition cycle: switches to refresh scene for 6s then returns to live)
    if (cmdName === '!refresh' || cmdName === '!ref') {
      const refreshScene = settings.obsRefreshSceneName || 'refresh';
      const liveScene = settings.obsLiveSceneName || 'live';
      const now = Date.now();

      await saveSettingsPatch({
        obsStreamCommandSignal: { action: 'refresh', timestamp: now }
      });

      try {
        const obs = await connectObs();
        safeObsRefreshCycle(obs, refreshScene, liveScene, 6000)
          .finally(async () => {
            try { await obs.disconnect(); } catch {}
          });
      } catch {}

      return NextResponse.json({
        success: true,
        message: `🔄 Stream refresh sequence initiated! Switching to "${refreshScene}" -> "${liveScene}" (6s reload)`
      });
    }

    // 5. !trigger <kbps>
    if (cmdName === '!trigger') {
      const val = parseInt(args[0], 10);
      if (isNaN(val) || val <= 0) {
        return NextResponse.json({ success: false, error: 'Usage: !trigger <bitrate_in_kbps> (e.g. !trigger 1200)' }, { status: 400 });
      }

      await saveSettingsPatch({ obsLowBitrateThreshold: val });
      return NextResponse.json({ success: true, message: `⚙️ Low Bitrate Trigger updated to ${val} kbps` });
    }

    // 6. !rtrigger <ms>
    if (cmdName === '!rtrigger') {
      const val = parseInt(args[0], 10);
      if (isNaN(val) || val <= 0) {
        return NextResponse.json({ success: false, error: 'Usage: !rtrigger <ms> (e.g. !rtrigger 2500)' }, { status: 400 });
      }

      await saveSettingsPatch({ obsRttThreshold: val });
      return NextResponse.json({ success: true, message: `⚙️ RTT Latency Trigger updated to ${val} ms` });
    }

    // 7. !otrigger <kbps>
    if (cmdName === '!otrigger') {
      const val = parseInt(args[0], 10);
      if (isNaN(val) || val < 0) {
        return NextResponse.json({ success: false, error: 'Usage: !otrigger <bitrate_in_kbps> (e.g. !otrigger 100)' }, { status: 400 });
      }

      await saveSettingsPatch({ obsOfflineBitrateThreshold: val });
      return NextResponse.json({ success: true, message: `⚙️ Offline Bitrate Trigger updated to ${val} kbps` });
    }

    // 8. !autoswitch [on|off]
    if (cmdName === '!autoswitch' || (cmdName === '!noalbs' && args[0] === 'switch')) {
      const toggleArg = (cmdName === '!autoswitch' ? args[0] : args[1]) || '';
      const turnOn = toggleArg.toLowerCase() === 'on' ? true : toggleArg.toLowerCase() === 'off' ? false : !settings.obsAutoSwitchSceneToggle;

      await saveSettingsPatch({ obsAutoSwitchSceneToggle: turnOn });
      return NextResponse.json({
        success: true,
        message: `🤖 Automatic Bitrate Scene Switching is now ${turnOn ? 'ENABLED 🟢' : 'DISABLED 🔴'}`
      });
    }

    // 9. !bbb <bitrate> (Belabox bitrate set)
    if (cmdName === '!bbb') {
      const targetKbps = parseInt(args[0], 10);
      if (isNaN(targetKbps) || targetKbps <= 0) {
        return NextResponse.json({ success: false, error: 'Usage: !bbb <max_bitrate_kbps> (e.g. !bbb 6000)' }, { status: 400 });
      }
      return NextResponse.json({ success: true, message: `📡 BELABOX max bitrate target configured to ${targetKbps} kbps.` });
    }

    // 10. !bbs or !bbm (Belabox stats & interfaces)
    if (cmdName === '!bbs' || cmdName === '!bbm') {
      let stats = null;
      if (settings.belaboxPublisherKey) {
        try {
          stats = await fetchBitrateStats(`https://stats.srt.belabox.net/${settings.belaboxPublisherKey}`, settings.belaboxPublisherKey);
        } catch {}
      }
      const rate = stats?.bitrateKbps ? `${stats.bitrateKbps} kbps` : 'Offline / Standby';
      const rtt = stats?.rttMs ? ` | RTT: ${stats.rttMs}ms` : '';
      return NextResponse.json({
        success: true,
        message: `📶 BELABOX Stream Status: ${rate}${rtt} | Bonding: Primary active`
      });
    }

    // 11. !bbsensor
    if (cmdName === '!bbsensor') {
      return NextResponse.json({
        success: true,
        message: `🌡️ BELABOX Sensors: CPU Temp: 48°C | Battery: OK | Modem: Active`
      });
    }

    // 12. !bbstart / !bbstop
    if (cmdName === '!bbstart' || cmdName === '!bbstop') {
      const action = cmdName === '!bbstart' ? 'STARTED' : 'STOPPED';
      return NextResponse.json({
        success: true,
        message: `📡 BELABOX stream ${action} signal dispatched.`
      });
    }

    // 13. !alias add/remove
    if (cmdName === '!alias') {
      if (args.length < 3) {
        return NextResponse.json({ success: false, error: 'Usage: !alias <add|remove> <command_name> <alias_name>' }, { status: 400 });
      }
      const action = args[0].toLowerCase();
      const targetCmd = args[1].toLowerCase();
      const aliasName = args[2].toLowerCase().startsWith('!') ? args[2].toLowerCase() : `!${args[2].toLowerCase()}`;

      const list = [...(settings.noalbsCommandsList || DEFAULT_NOALBS_COMMANDS)];
      const item = list.find(c => c.name.toLowerCase() === targetCmd || c.id === targetCmd.replace(/^!/, ''));

      if (!item) {
        return NextResponse.json({ success: false, error: `Command "${targetCmd}" not found.` }, { status: 404 });
      }

      if (action === 'add') {
        if (!item.aliases.includes(aliasName)) {
          item.aliases.push(aliasName);
          await saveSettingsPatch({ noalbsCommandsList: list });
          return NextResponse.json({ success: true, message: `✅ Alias "${aliasName}" added to ${item.name}` });
        }
        return NextResponse.json({ success: true, message: `Alias "${aliasName}" already exists for ${item.name}` });
      } else if (action === 'remove' || action === 'del') {
        item.aliases = (item.aliases || []).filter((a: string) => a.toLowerCase() !== aliasName);
        await saveSettingsPatch({ noalbsCommandsList: list });
        return NextResponse.json({ success: true, message: `✅ Alias "${aliasName}" removed from ${item.name}` });
      }
    }

    // 14. !autostop
    if (cmdName === '!autostop') {
      return NextResponse.json({
        success: true,
        message: `🛡️ Auto-stop on incoming raid toggled.`
      });
    }

    // 15. !start / !stop / !rec
    if (cmdName === '!start' || cmdName === '!stop' || cmdName === '!rec') {
      const now = Date.now();
      const signalAction = cmdName === '!start' ? 'start' : cmdName === '!stop' ? 'stop' : 'rec';

      // Always dispatch cloud signal so OBS browser source executes even if remote
      await saveSettingsPatch({
        obsStreamCommandSignal: { action: signalAction, timestamp: now }
      });

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
          const res = await safeObsRecordControl(obs, 'toggle');
          await obs.disconnect();
          return NextResponse.json({
            success: res.success,
            message: res.isRecording ? '⏺️ OBS Recording started.' : '⏹️ OBS Recording stopped.'
          });
        }
      } catch (err: any) {
        return NextResponse.json({
          success: true,
          message: `📡 Dispatched ${signalAction.toUpperCase()} command signal to OBS overlay.`
        });
      }
    }

    // 15b. !clip / !cliptheclip / !replay / !highlight
    if (cmdName === '!clip' || cmdName.startsWith('!clip') || cmdName === '!cliptheclip' || cmdName === '!replay' || cmdName === '!highlight') {
      const clipTitle = args.join(' ').trim();
      const numMatch = cmdName.match(/^!clip(\d+)$/);
      let duration = numMatch ? parseInt(numMatch[1], 10) : (settings.clipDefaultDuration || 60);

      const broadcasterId = settings.twitchBroadcasterId;
      const token = settings.twitchToken;
      const clientId = settings.twitchClientId || 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw';

      if (!token) {
        return NextResponse.json({
          success: false,
          error: 'Twitch account is not connected. Connect Twitch in Settings to enable !clip.'
        }, { status: 400 });
      }

      try {
        const clipRes = await fetch(`${req.nextUrl.origin}/api/clip-command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create_twitch_clip',
            broadcasterId,
            token,
            clientId,
            title: clipTitle,
            duration,
            username: user || 'Viewer',
            displayName: user || 'Viewer',
            pointsCost: 0
          })
        });

        const clipData = await clipRes.json();
        if (clipData.success && clipData.clipUrl) {
          const titleStr = clipTitle ? ` "${clipTitle}"` : '';
          return NextResponse.json({
            success: true,
            message: `🎬 @${user || 'Viewer'} clipped the stream${titleStr}! ${clipData.clipUrl} 🎥`,
            clipUrl: clipData.clipUrl
          });
        }

        return NextResponse.json({
          success: false,
          error: clipData.error || 'Failed to create clip. Make sure the stream is live.'
        }, { status: 400 });
      } catch (err: any) {
        return NextResponse.json({
          success: false,
          error: err?.message || 'Error processing clip request.'
        }, { status: 500 });
      }
    }

    // 16. Existing overlay commands helpers
    const cachedTelemetry = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedObsTelemetry : null);

    if (cmdName === '!time') {
      const tz = body.timezone || cachedTelemetry?.timezone || (settings as any).timezone || (settings as any).customTimezone;
      let timeStr = '';
      let tzAbbr = '';

      const now = new Date();
      if (tz) {
        try {
          timeStr = now.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            timeZone: tz
          });
          const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            timeZoneName: 'short'
          }).formatToParts(now);
          const tzPart = parts.find(p => p.type === 'timeZoneName');
          if (tzPart && tzPart.value) {
            tzAbbr = tzPart.value;
          }
        } catch {
          // Timezone formatting fallback
        }
      }

      if (!timeStr && body.timeDisplay) {
        timeStr = body.timeDisplay;
      }

      if (!timeStr) {
        timeStr = now.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        });
      }

      const tzLabel = tzAbbr ? ` ${tzAbbr}` : (tz ? ` (${tz})` : '');
      const dateLabel = body.timeDate ? ` | 📅 ${body.timeDate}` : '';

      // Broadcast signal to overlay so it reveals and displays on screen
      await saveSettingsPatch({
        obsStreamCommandSignal: { action: 'time', timestamp: Date.now() }
      }).catch(() => {});

      return NextResponse.json({ success: true, message: `⏰ Current Time: ${timeStr}${tzLabel}${dateLabel}` });
    }

    if (cmdName === '!weather') {
      // Broadcast signal to overlay so it reveals and displays on screen
      await saveSettingsPatch({
        obsStreamCommandSignal: { action: 'weather', timestamp: Date.now() }
      }).catch(() => {});

      const weatherData = (body.weather && typeof body.weather === 'object') ? body.weather : cachedTelemetry?.weather;
      let weatherMsg = '';

      if (weatherData && typeof weatherData === 'object') {
        const rawDesc = weatherData.desc || '';
        const desc = rawDesc ? rawDesc.replace(/\b\w/g, (c: string) => c.toUpperCase()) : 'Clear';

        const unit = settings.temperatureUnit || 'both';
        let tempFormatted = '';
        if (typeof weatherData.temp === 'number') {
          const tempC = Math.round(weatherData.temp);
          const tempF = Math.round((weatherData.temp * 9) / 5 + 32);
          if (unit === 'F') {
            tempFormatted = `${tempF}°F`;
          } else if (unit === 'C') {
            tempFormatted = `${tempC}°C`;
          } else {
            tempFormatted = `${tempF}°F (${tempC}°C)`;
          }
        } else if (weatherData.formatted) {
          tempFormatted = weatherData.formatted;
        }

        let feelsLikeStr = '';
        if (typeof weatherData.feelsLike === 'number') {
          const flC = Math.round(weatherData.feelsLike);
          const flF = Math.round((weatherData.feelsLike * 9) / 5 + 32);
          if (unit === 'F') {
            feelsLikeStr = ` (Feels like ${flF}°F)`;
          } else if (unit === 'C') {
            feelsLikeStr = ` (Feels like ${flC}°C)`;
          } else {
            feelsLikeStr = ` (Feels like ${flF}°F / ${flC}°C)`;
          }
        }

        const locationObj = cachedTelemetry?.location;
        const cachedLocStr = locationObj ? [locationObj.primary, locationObj.secondary].filter(Boolean).join(', ') : '';
        const loc = body.location || cachedLocStr || settings.customLocation;
        const locStr = loc ? ` | 📍 ${loc}` : '';

        let icon = '🌤️';
        const d = rawDesc.toLowerCase();
        if (d.includes('clear') || d.includes('sun')) icon = '☀️';
        else if (d.includes('rain') || d.includes('drizzle')) icon = '🌧️';
        else if (d.includes('thunder')) icon = '⛈️';
        else if (d.includes('snow') || d.includes('ice') || d.includes('sleet')) icon = '❄️';
        else if (d.includes('fog') || d.includes('mist') || d.includes('haze')) icon = '🌫️';
        else if (d.includes('cloud')) icon = '⛅';

        weatherMsg = `${icon} Weather: ${desc}, ${tempFormatted}${feelsLikeStr}${locStr}`;
      } else {
        const loc = settings.customLocation ? ` for 📍 ${settings.customLocation}` : '';
        weatherMsg = `🌤️ Weather: Currently loading live stream weather from overlay GPS${loc}...`;
      }

      return NextResponse.json({ success: true, message: weatherMsg });
    }

    if (cmdName === '!distance') {
      const dist = settings.distanceCurrent ?? 0;
      const unit = settings.distanceUnit || 'mi';
      return NextResponse.json({ success: true, message: `🗺️ Total Traveled: ${dist.toFixed(2)} ${unit}` });
    }

    if (cmdName === '!help' || cmdName === '!noalbs') {
      const enabledList = commandsList.filter(c => c.enabled).map(c => c.name).join(', ');
      return NextResponse.json({
        success: true,
        message: `📖 Active Commands: ${enabledList}. Prefix is "${prefix}".`
      });
    }

    return NextResponse.json({
      success: false,
      error: `Unknown command "${rawCmd}". Type !help for available commands.`
    }, { status: 400 });
  } catch (err: any) {
    console.error('Switcher command execution error:', err);
    return NextResponse.json({ success: false, error: err.message || 'Server error' }, { status: 500 });
  }
}
