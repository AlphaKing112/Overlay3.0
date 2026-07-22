import { NextResponse } from 'next/server';
import OBSWebSocket from 'obs-websocket-js';
import { fetchBitrateStats } from '@/utils/api-utils';

export const dynamic = 'force-dynamic';

// Attach to global to survive hot reloads in dev mode
const g = global as any;

if (g.autoSwitchData && g.autoSwitchData.intervalId) {
  // Clear the old interval during Next.js Hot Module Replacement
  clearInterval(g.autoSwitchData.intervalId);
}

if (!g.autoSwitchData) {
  g.autoSwitchData = {
    intervalId: null,
    obsRef: null,
    statusLog: 'Idle',
    obsStatus: 'disconnected',
    lastState: null as 'live' | 'offline' | null,
    failures: 0,
    settings: null as any,
    isActive: false
  };
}

const state = g.autoSwitchData;

export async function POST(request: Request) {
  try {
    const { action, settings } = await request.json();

    if (action === 'start') {
      state.settings = settings;
      if (!state.isActive) {
        state.isActive = true;
        state.statusLog = 'Starting background service...';
        state.failures = 0;
        state.lastState = null;
        startBackgroundService();
      }
      return NextResponse.json({ success: true, message: 'Started', status: state.statusLog });
    }

    if (action === 'stop') {
      state.isActive = false;
      stopBackgroundService();
      state.statusLog = 'Stopped background service';
      return NextResponse.json({ success: true, message: 'Stopped', status: state.statusLog });
    }

    if (action === 'update_settings') {
      state.settings = settings;
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    isActive: state.isActive,
    obsStatus: state.obsStatus,
    statusLog: state.statusLog,
    lastState: state.lastState
  });
}

function stopBackgroundService() {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  if (state.obsRef) {
    try { state.obsRef.removeAllListeners(); } catch { }
    try { state.obsRef.disconnect(); } catch { }
    state.obsRef = null;
  }
  state.obsStatus = 'disconnected';
}

function startBackgroundService() {
  // Clear any existing
  if (state.intervalId) clearInterval(state.intervalId);
  
  const reconnectOBS = async () => {
    if (!state.settings?.obsWebsocketUrl) return;
    if (state.obsStatus !== 'disconnected' && state.obsRef) return;

    if (state.obsRef) {
      try { state.obsRef.removeAllListeners(); } catch { }
      try { state.obsRef.disconnect(); } catch { }
      state.obsRef = null;
    }

    let url = state.settings.obsWebsocketUrl;
    if (url && url.includes('localhost')) {
      url = url.replace('localhost', '127.0.0.1');
    }

    const tryConnect = async (targetUrl: string) => {
      const tempObs = new OBSWebSocket();
      tempObs.on('ConnectionClosed', () => { state.obsStatus = 'disconnected'; });
      tempObs.on('ConnectionError', () => { state.obsStatus = 'disconnected'; });
      
      const connectPromise = tempObs.connect(targetUrl, state.settings.obsWebsocketPassword || undefined);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timed out.")), 5000));
      await Promise.race([connectPromise, timeoutPromise]);
      
      state.obsRef = tempObs;
      state.obsStatus = 'connected';
    };

    try {
      await tryConnect(url);
      console.log('📡 [BACKEND AUTO-SWITCH] OBS connected successfully');
    } catch (err: any) {
      console.warn(`📡 [BACKEND AUTO-SWITCH] OBS connection failed to ${url}:`, err.message);
      
      const fallbackUrl = 'ws://127.0.0.1:4455';
      if (url !== fallbackUrl) {
        console.log(`📡 [BACKEND AUTO-SWITCH] Trying local fallback to ${fallbackUrl} (to bypass NAT Hairpinning)...`);
        try {
          await tryConnect(fallbackUrl);
          console.log(`📡 [BACKEND AUTO-SWITCH] OBS connected successfully via fallback`);
        } catch (fallbackErr: any) {
          state.obsStatus = 'disconnected';
          console.warn('📡 [BACKEND AUTO-SWITCH] OBS fallback connection failed:', fallbackErr.message);
        }
      } else {
        state.obsStatus = 'disconnected';
      }
    }
  };

  const switchScene = async (sceneName: string): Promise<boolean> => {
    if (!state.obsRef || state.obsStatus !== 'connected') {
      state.statusLog = '❌ OBS not connected';
      return false;
    }
    try {
      await state.obsRef.call('SetCurrentProgramScene', { sceneName });
      state.statusLog = `✅ Switched to: ${sceneName} at ${new Date().toLocaleTimeString()}`;
      console.log(`[BACKEND AUTO-SWITCH] ✅ Switched to: ${sceneName}`);
      return true;
    } catch {
      try {
        const v4Method = 'SetCurrentScene' as any;
        await state.obsRef.call(v4Method, { 'scene-name': sceneName });
        state.statusLog = `✅ Switched to: ${sceneName} (v4) at ${new Date().toLocaleTimeString()}`;
        console.log(`[BACKEND AUTO-SWITCH] ✅ Switched to: ${sceneName}`);
        return true;
      } catch (err: any) {
        state.statusLog = `❌ Switch failed: ${err.message}`;
        console.warn(`[BACKEND AUTO-SWITCH] ❌ Switch failed:`, err.message);
        return false;
      }
    }
  };

  const poll = async () => {
    if (!state.isActive) {
      stopBackgroundService();
      return;
    }

    // Keep OBS connected
    if (state.obsStatus === 'disconnected') {
      await reconnectOBS();
    }

    if (!state.settings?.belaboxPublisherKey) {
      state.statusLog = 'No publisher key provided';
      return;
    }

    const url = `https://stats.srt.belabox.net/${state.settings.belaboxPublisherKey}`;
    try {
      const stats = await fetchBitrateStats(url, '');
      const bitrateKbps = stats ? stats.bitrateKbps : 0;
      const isLive = bitrateKbps > 0;
      
      state.failures = isLive ? 0 : state.failures + 1;
      state.statusLog = `Polling: ${bitrateKbps} kbps, state=${state.lastState || 'null'}`;

      if (isLive && state.lastState !== 'live') {
        if (state.settings.obsLiveSceneName) {
          const success = await switchScene(state.settings.obsLiveSceneName);
          if (success) state.lastState = 'live';
        }
      } else if (!isLive && state.lastState !== 'offline') {
        if (state.settings.obsOfflineSceneName) {
          const success = await switchScene(state.settings.obsOfflineSceneName);
          if (success) state.lastState = 'offline';
        }
      }
    } catch (err: any) {
      state.failures++;
      if (state.failures >= 3 && state.lastState !== 'offline') {
        if (state.settings?.obsOfflineSceneName) {
          const success = await switchScene(state.settings.obsOfflineSceneName);
          if (success) state.lastState = 'offline';
        }
      }
      state.statusLog = `⚠️ Error (${state.failures}): ${err.message}`;
    }
  };

  // Run immediately then loop
  poll();
  state.intervalId = setInterval(poll, 3000);
}
