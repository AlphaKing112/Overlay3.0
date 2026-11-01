import { NextRequest, NextResponse } from 'next/server';
import { safeObsSwitchScene, getCurrentObsScene } from '@/lib/obs-helper';
import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

async function getObsConnectionInfo(overrideUrl?: string, overridePassword?: string) {
  let url = overrideUrl;
  let password = overridePassword;

  if (!url) {
    try {
      const cached = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedOverlaySettings : null);
      if (cached?.obsWebsocketUrl) {
        url = cached.obsWebsocketUrl;
        password = cached.obsWebsocketPassword || '';
      } else {
        const kvSettings: any = await kv.get('overlay_settings');
        if (kvSettings?.obsWebsocketUrl) {
          url = kvSettings.obsWebsocketUrl;
          password = kvSettings.obsWebsocketPassword || '';
        }
      }
    } catch {
      // Fallback
    }
  }

  return {
    url: url || 'ws://127.0.0.1:4455',
    password: password || ''
  };
}

/**
 * GET /api/obs-switch-scene
 * Returns current scene and list of available scenes from OBS
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const reqUrl = searchParams.get('obsUrl') || undefined;
    const reqPass = searchParams.get('obsPassword') || undefined;

    const { url, password } = await getObsConnectionInfo(reqUrl, reqPass);

    const { default: OBSWebSocket } = await import('obs-websocket-js');
    const obs = new OBSWebSocket();

    obs.on('ConnectionClosed', () => {});
    obs.on('ConnectionError', () => {});

    try {
      const connectPromise = obs.connect(url, password || undefined);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out')), 3000));
      await Promise.race([connectPromise, timeoutPromise]);

      let scenes: string[] = [];
      let currentScene: string = '';

      // Query scene list
      try {
        const sceneListData: any = await obs.call('GetSceneList');
        const rawScenes = sceneListData.scenes || [];
        scenes = rawScenes.map((s: any) => String(s.sceneName || s.name || '')).filter(Boolean);
        currentScene = String(sceneListData.currentProgramSceneName || sceneListData['current-scene'] || '');
      } catch (err: any) {
        console.warn('⚠️ [API] GetSceneList failed:', err.message);
      }

      if (!currentScene) {
        currentScene = (await getCurrentObsScene(obs)) || '';
      }

      await obs.disconnect();

      return NextResponse.json({
        success: true,
        currentScene,
        scenes,
        connected: true
      });
    } catch (obsErr: any) {
      try { await obs.disconnect(); } catch {}
      return NextResponse.json({
        success: false,
        error: obsErr?.message || 'OBS connection failed',
        connected: false,
        scenes: [],
        currentScene: ''
      }, { status: 200 }); // Return 200 with connected: false to gracefully handle UI polling
    }
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Server error' }, { status: 500 });
  }
}

/**
 * POST /api/obs-switch-scene
 * Body: { sceneName: string, obsUrl?: string, obsPassword?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sceneName, obsUrl, obsPassword } = body;

    if (!sceneName || typeof sceneName !== 'string') {
      return NextResponse.json({ success: false, error: 'sceneName is required' }, { status: 400 });
    }

    const { url, password } = await getObsConnectionInfo(obsUrl, obsPassword);

    const { default: OBSWebSocket } = await import('obs-websocket-js');
    const obs = new OBSWebSocket();

    obs.on('ConnectionClosed', () => {});
    obs.on('ConnectionError', () => {});

    try {
      const connectPromise = obs.connect(url, password || undefined);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out')), 4000));
      await Promise.race([connectPromise, timeoutPromise]);

      const switched = await safeObsSwitchScene(obs, sceneName);
      const activeScene = (await getCurrentObsScene(obs)) || sceneName;

      await obs.disconnect();

      if (switched) {
        console.log(`📡 [API] Switched OBS scene to: ${sceneName}`);
        return NextResponse.json({ success: true, sceneName: activeScene });
      } else {
        return NextResponse.json({ success: false, error: `Could not switch to scene: ${sceneName}` }, { status: 404 });
      }
    } catch (obsError: any) {
      try { await obs.disconnect(); } catch {}
      console.error('📡 [API] OBS scene switch failed:', obsError?.message);
      return NextResponse.json(
        { success: false, error: obsError?.message || 'OBS connection failed' },
        { status: 503 }
      );
    }
  } catch (error: any) {
    console.error('📡 [API] obs-switch-scene error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Internal error' },
      { status: 500 }
    );
  }
}
