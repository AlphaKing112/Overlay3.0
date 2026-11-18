import { NextRequest, NextResponse } from 'next/server';
import {
  safeObsSwitchScene,
  getCurrentObsScene,
  withTempObsConnection,
  isCloudUnreachableObsUrl
} from '@/lib/obs-helper';
import { kv } from '@vercel/kv';
import { broadcastSettings } from '@/lib/settings-broadcast';

export const dynamic = 'force-dynamic';

declare global {
  var __lastLoggedSwitchSceneStatus: string | undefined;
}

async function getObsConnectionInfo(overrideUrl?: string, overridePassword?: string) {
  let url = overrideUrl;
  let password = overridePassword;
  let port = 4455;

  try {
    const cached = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedOverlaySettings : null);
    if (cached) {
      if (!url && cached.obsWebsocketPort) {
        port = cached.obsWebsocketPort;
        url = `ws://127.0.0.1:${port}`;
      } else if (!url && cached.obsWebsocketUrl) {
        url = cached.obsWebsocketUrl;
      }
      if (password === undefined && cached.obsWebsocketPassword) {
        password = cached.obsWebsocketPassword;
      }
    } else {
      const kvSettings: any = await kv.get('overlay_settings');
      if (kvSettings) {
        if (!url && kvSettings.obsWebsocketPort) {
          port = kvSettings.obsWebsocketPort;
          url = `ws://127.0.0.1:${port}`;
        } else if (!url && kvSettings.obsWebsocketUrl) {
          url = kvSettings.obsWebsocketUrl;
        }
        if (password === undefined && kvSettings.obsWebsocketPassword) {
          password = kvSettings.obsWebsocketPassword;
        }
      }
    }
  } catch {}

  return {
    url: url || `ws://127.0.0.1:${port}`,
    password: password || '',
    port
  };
}

/**
 * GET /api/obs-switch-scene
 * Returns current scene and list of available scenes from OBS.
 * First checks telemetry reported by active OBS Browser Source on the streamer's PC.
 * Falls back to direct WebSocket if running locally.
 */
export async function GET(request: NextRequest) {
  try {
    const now = Date.now();
    // 0. Check latest scene switch signal (respect 1.5s cache TTL across serverless lambdas)
    const cachedSignalTime = typeof globalThis !== 'undefined' ? ((globalThis as any).__cachedObsSceneSignalTime || 0) : 0;
    let signal: any =
      typeof globalThis !== 'undefined' && now - cachedSignalTime < 1500
        ? (globalThis as any).__cachedObsSceneSignal
        : null;
    if (!signal) {
      try {
        const kvSettings: any = await kv.get('overlay_settings');
        if (kvSettings?.obsSceneSwitchSignal) {
          signal = kvSettings.obsSceneSwitchSignal;
          if (typeof globalThis !== 'undefined') {
            (globalThis as any).__cachedObsSceneSignal = signal;
            (globalThis as any).__cachedObsSceneSignalTime = now;
          }
        }
      } catch {}
    }

    // 1. Check if active OBS Browser Source on streamer's PC reported telemetry (respect 1.5s cache TTL)
    const cachedTelemetryTime = typeof globalThis !== 'undefined' ? ((globalThis as any).__cachedObsTelemetryTime || 0) : 0;
    let telemetry: any =
      typeof globalThis !== 'undefined' && now - cachedTelemetryTime < 1500
        ? (globalThis as any).__cachedObsTelemetry
        : null;
    if (!telemetry) {
      try {
        telemetry = await kv.get('obs_telemetry');
        if (telemetry && typeof telemetry === 'object' && typeof globalThis !== 'undefined') {
          (globalThis as any).__cachedObsTelemetry = telemetry;
          (globalThis as any).__cachedObsTelemetryTime = now;
        }
      } catch {}
    }

    const isTelemetryFresh = telemetry && (now - (telemetry.updatedAt || 0) < 180000);
    if (isTelemetryFresh && telemetry.online) {
      const current = telemetry.currentScene || '';
      const stateKey = `connected:${current}`;
      if (globalThis.__lastLoggedSwitchSceneStatus !== stateKey) {
        globalThis.__lastLoggedSwitchSceneStatus = stateKey;
        console.log(`📡 [OBS-SWITCH-SCENE] Connected via Browser Source. Current Scene: "${current}" (${telemetry.scenes?.length || 0} scenes)`);
      }
      return NextResponse.json({
        success: true,
        currentScene: telemetry.currentScene || '',
        scenes: telemetry.scenes || [],
        connected: true,
        signal: signal || null,
        via: 'browser_source'
      });
    } else {
      if (globalThis.__lastLoggedSwitchSceneStatus !== 'disconnected') {
        globalThis.__lastLoggedSwitchSceneStatus = 'disconnected';
        console.log(`📡 [OBS-SWITCH-SCENE] OBS is disconnected (no active Browser Source telemetry)`);
      }
    }

    // 2. Direct local WebSocket check (works when app runs on streamer's PC/local network)
    const { searchParams } = new URL(request.url);
    const reqUrl = searchParams.get('obsUrl') || undefined;
    const reqPass = searchParams.get('obsPassword') || undefined;
    const { url, password } = await getObsConnectionInfo(reqUrl, reqPass);

    if (isCloudUnreachableObsUrl(url)) {
      return NextResponse.json({
        success: false,
        connected: false,
        scenes: [],
        via: 'cloud_offline'
      });
    }

    try {
      const { default: OBSWebSocket } = await import('obs-websocket-js');
      const result = await withTempObsConnection(
        OBSWebSocket,
        { url, password, timeoutMs: 2000 },
        async (obs) => {
          let scenes: string[] = [];
          let currentScene: string = '';
          try {
            const sceneListData: any = await obs.call('GetSceneList');
            const rawScenes = sceneListData.scenes || [];
            scenes = rawScenes.map((s: any) => String(s.sceneName || s.name || '')).filter(Boolean);
            currentScene = String(sceneListData.currentProgramSceneName || sceneListData['current-scene'] || '');
          } catch {}

          if (!currentScene) {
            currentScene = (await getCurrentObsScene(obs)) || '';
          }
          return { scenes, currentScene };
        }
      );

      return NextResponse.json({
        success: true,
        currentScene: result.currentScene,
        scenes: result.scenes,
        connected: true,
        via: 'direct_ws'
      });
    } catch {
      // Return 200 with connected: false to allow graceful UI polling
      return NextResponse.json({
        success: false,
        error: 'OBS WebSocket not reachable. Add your overlay as a Browser Source in OBS Studio to connect.',
        connected: false,
        signal: signal || null,
        scenes: telemetry?.scenes || [],
        currentScene: telemetry?.currentScene || ''
      }, { status: 200 });
    }
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Server error' }, { status: 500 });
  }
}

/**
 * POST /api/obs-switch-scene
 * Dispatches scene switch signal to the OBS Browser Source running on the streamer's PC,
 * and also attempts direct local WebSocket if available.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sceneName, obsUrl, obsPassword } = body;

    if (!sceneName || typeof sceneName !== 'string') {
      return NextResponse.json({ success: false, error: 'sceneName is required' }, { status: 400 });
    }

    const now = Date.now();
    const signal = { sceneName, timestamp: now };
    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__cachedObsSceneSignal = signal;
      (globalThis as any).__cachedObsSceneSignalTime = now;
    }

    // 1. Dispatch signal via Settings Broadcast to the active OBS Browser Source
    try {
      let currentSettings: any = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedOverlaySettings : null) || {};
      try {
        const kvSettings = await kv.get('overlay_settings');
        if (kvSettings && typeof kvSettings === 'object') currentSettings = kvSettings;
      } catch {}

      const updated = { ...currentSettings, obsSceneSwitchSignal: signal };
      if (typeof globalThis !== 'undefined') {
        (globalThis as any).__cachedOverlaySettings = updated;
        (globalThis as any).__cachedOverlaySettingsTime = now;
      }
      try {
        await Promise.all([
          kv.set('overlay_settings', updated),
          kv.set('overlay_settings_modified', now)
        ]);
      } catch {}

      await broadcastSettings(updated);
    } catch (sigErr) {
      console.warn('⚠️ [API] Scene switch signal dispatch warning:', sigErr);
    }

    // 2. Also attempt direct local WS if reachable
    let switchedViaDirect = false;
    const { url, password } = await getObsConnectionInfo(obsUrl, obsPassword);
    if (!isCloudUnreachableObsUrl(url)) {
      try {
        const { default: OBSWebSocket } = await import('obs-websocket-js');
        switchedViaDirect = await withTempObsConnection(
          OBSWebSocket,
          { url, password, timeoutMs: 250 },
          (obs) => safeObsSwitchScene(obs, sceneName)
        );
      } catch {
        // Direct WS skipped or unavailable; the active OBS Browser Source handles it!
      }
    }

    console.log(`🎬 [API] Switched OBS scene to: "${sceneName}" (Direct: ${switchedViaDirect ? 'YES' : 'relayed to Browser Source'})`);
    return NextResponse.json({
      success: true,
      sceneName,
      via: switchedViaDirect ? 'direct' : 'browser_source_signal'
    });
  } catch (error: any) {
    console.error('📡 [API] obs-switch-scene error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Internal error' },
      { status: 500 }
    );
  }
}
