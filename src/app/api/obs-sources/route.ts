import { NextRequest, NextResponse } from 'next/server';
import { getObsSceneItems, toggleObsSceneItem, removeObsSceneItem } from '@/lib/obs-helper';
import { kv } from '@vercel/kv';
import { broadcastSettings } from '@/lib/settings-broadcast';

export const dynamic = 'force-dynamic';

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

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sceneName = searchParams.get('sceneName') || '';

    // 1. Try local direct WebSocket if available
    let sources: any[] = [];
    const { url, password, port } = await getObsConnectionInfo();
    const urlsToTry = [
      url,
      `ws://127.0.0.1:${port}`,
      `ws://localhost:${port}`,
      'ws://127.0.0.1:4455',
      'ws://localhost:4455'
    ].filter((v, i, a) => a.indexOf(v) === i);

    try {
      const { default: OBSWebSocket } = await import('obs-websocket-js');
      const obs = new OBSWebSocket();
      obs.on('ConnectionClosed', () => {});
      obs.on('ConnectionError', () => {});

      let connected = false;
      for (const targetUrl of urlsToTry) {
        try {
          const connectPromise = obs.connect(targetUrl, password || undefined);
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500));
          await Promise.race([connectPromise, timeoutPromise]);
          connected = true;
          break;
        } catch {}
      }

      if (connected) {
        const targetScene = sceneName || (await obs.call('GetCurrentProgramScene' as any).then((r: any) => r.currentProgramSceneName || r.sceneName).catch(() => ''));
        if (targetScene) {
          sources = await getObsSceneItems(obs, targetScene);
        }
        await obs.disconnect();
      }
    } catch {}

    // 2. Fallback to Upstash KV telemetry cache (crucial for mobile devices connecting via cloud!)
    if (sources.length === 0) {
      try {
        let telemetry = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedObsTelemetry : null);
        if (!telemetry || !telemetry.currentSceneSources || telemetry.currentSceneSources.length === 0) {
          const kvData = await kv.get<any>('obs_telemetry');
          if (kvData && typeof kvData === 'object') {
            telemetry = kvData;
          }
        }
        if (telemetry?.currentSceneSources && Array.isArray(telemetry.currentSceneSources)) {
          sources = telemetry.currentSceneSources;
        }
      } catch (kvErr) {
        console.warn('⚠️ [API] Failed to fetch sources from KV:', kvErr);
      }
    }

    return NextResponse.json({
      success: true,
      sceneName,
      sources
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || 'Server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, sceneName, sceneItemId, sourceName, enabled, obsUrl, obsPassword } = body;
    const isRemove = action === 'remove';

    if (!sceneName || sceneItemId === undefined || (!isRemove && enabled === undefined)) {
      return NextResponse.json({ success: false, error: 'sceneName and sceneItemId are required' }, { status: 400 });
    }

    const now = Date.now();
    const toggleSignal = { sceneName, sceneItemId: Number(sceneItemId), sourceName: sourceName || '', enabled: Boolean(enabled), timestamp: now };
    const removeSignal = { sceneName, sceneItemId: Number(sceneItemId), sourceName: sourceName || '', timestamp: now };

    // 1. Dispatch signal via Settings Broadcast to the active OBS Browser Source
    try {
      let currentSettings: any = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedOverlaySettings : null) || {};
      try {
        const kvSettings = await kv.get('overlay_settings');
        if (kvSettings && typeof kvSettings === 'object') currentSettings = kvSettings;
      } catch {}

      const updated = isRemove
        ? { ...currentSettings, obsSourceRemoveSignal: removeSignal }
        : { ...currentSettings, obsSourceToggleSignal: toggleSignal };

      if (typeof globalThis !== 'undefined') {
        (globalThis as any).__cachedOverlaySettings = updated;
        (globalThis as any).__cachedOverlaySettingsTime = now;
      }
      try {
        await Promise.all([
          kv.set('overlay_settings', updated),
          kv.set('overlay_settings_modified', now)
        ]);

        // Optimistically update obs_telemetry KV so mobile GET immediately sees the change
        const kvTelemetry = await kv.get<any>('obs_telemetry');
        if (kvTelemetry && Array.isArray(kvTelemetry.currentSceneSources)) {
          const updatedSources = isRemove
            ? kvTelemetry.currentSceneSources.filter((s: any) => s.id !== Number(sceneItemId))
            : kvTelemetry.currentSceneSources.map((s: any) =>
                s.id === Number(sceneItemId) ? { ...s, enabled: Boolean(enabled) } : s
              );
          const nextTel = { ...kvTelemetry, currentSceneSources: updatedSources };
          if (typeof globalThis !== 'undefined') {
            (globalThis as any).__cachedObsTelemetry = nextTel;
          }
          await kv.set('obs_telemetry', nextTel, { ex: 300 });
        }
      } catch {}

      await broadcastSettings(updated);
    } catch (sigErr) {
      console.warn('⚠️ [API] Source action signal dispatch warning:', sigErr);
    }

    // 2. Also attempt direct local WS if available
    let actionViaDirect = false;
    const { url, password, port } = await getObsConnectionInfo(obsUrl, obsPassword);
    const urlsToTry = [
      url,
      `ws://127.0.0.1:${port}`,
      `ws://localhost:${port}`,
      'ws://127.0.0.1:4455',
      'ws://localhost:4455'
    ].filter((v, i, a) => a.indexOf(v) === i);

    try {
      const { default: OBSWebSocket } = await import('obs-websocket-js');
      const obs = new OBSWebSocket();
      obs.on('ConnectionClosed', () => {});
      obs.on('ConnectionError', () => {});

      let connected = false;
      for (const targetUrl of urlsToTry) {
        try {
          const connectPromise = obs.connect(targetUrl, password || undefined);
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500));
          await Promise.race([connectPromise, timeoutPromise]);
          connected = true;
          break;
        } catch {}
      }

      if (connected) {
        if (isRemove) {
          actionViaDirect = await removeObsSceneItem(obs, sceneName, Number(sceneItemId), sourceName);
        } else {
          actionViaDirect = await toggleObsSceneItem(obs, sceneName, Number(sceneItemId), Boolean(enabled), sourceName);
        }
        await obs.disconnect();
      }
    } catch {}

    return NextResponse.json({
      success: true,
      action: isRemove ? 'remove' : 'toggle',
      sceneName,
      sceneItemId,
      sourceName,
      enabled: isRemove ? undefined : enabled,
      via: actionViaDirect ? 'direct' : 'signal'
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || 'Server error' }, { status: 500 });
  }
}

