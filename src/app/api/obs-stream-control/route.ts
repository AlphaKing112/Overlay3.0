import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { broadcastSettings } from '@/lib/settings-broadcast';
import { safeObsStreamControlResult } from '@/lib/obs-helper';

export const dynamic = 'force-dynamic';

/**
 * POST /api/obs-stream-control
 * Body: { action: 'start' | 'stop' | 'refresh' | 'toggle', obsUrl?: string, obsPassword?: string }
 *
 * Route that connects to OBS WebSocket server-side and controls stream status (start/stop)
 * or executes a feed refresh cycle (switching to refresh scene and back to live).
 * On Cloud deployments (Vercel) where 127.0.0.1 is unreachable, it broadcasts an
 * obsStreamCommandSignal via KV & SSE so the local OBS Overlay (/overlay) running on the streamer's
 * PC executes the command in real-time!
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, obsUrl, obsPassword } = body;

    if (!action || !['start', 'stop', 'refresh', 'toggle'].includes(action)) {
      return NextResponse.json({ success: false, error: 'action must be "start", "stop", "refresh", or "toggle"' }, { status: 400 });
    }

    let existingSettings: any = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedOverlaySettings : null) || null;
    try {
      const kvData = await kv.get('overlay_settings');
      if (kvData && typeof kvData === 'object') {
        existingSettings = kvData;
      }
    } catch (kvErr) {
      console.warn('KV read warning in obs-stream-control guard:', kvErr);
    }

    if (existingSettings && existingSettings.obsStreamCommandsEnabled !== true) {
      return NextResponse.json({
        success: false,
        error: 'Stream commands (!start, !end, !refresh) are disabled in settings'
      }, { status: 403 });
    }

    const resolvedUrl = obsUrl || existingSettings?.obsWebsocketUrl || 'ws://127.0.0.1:4455';
    const resolvedPassword = obsPassword || existingSettings?.obsWebsocketPassword || '';
    const targetState: 'start' | 'stop' | 'refresh' = action === 'toggle' ? 'start' : action;
    const refreshScene = existingSettings?.obsRefreshSceneName || 'refresh';
    const liveScene = existingSettings?.obsLiveSceneName || 'live';

    // Helper to broadcast command signal via KV & SSE directly
    const broadcastSignal = async (cmdAction: 'start' | 'stop' | 'refresh') => {
      try {
        const now = Date.now();
        const updatedSettings = {
          ...(existingSettings || {}),
          obsStreamCommandSignal: { action: cmdAction, timestamp: now }
        };

        try {
          await Promise.all([
            kv.set('overlay_settings', updatedSettings),
            kv.set('overlay_settings_modified', now)
          ]);
        } catch (setErr) {
          console.warn('KV set warning in obs-stream-control:', setErr);
        }

        await broadcastSettings(updatedSettings);
        console.log(`📡 [API] Successfully broadcasted obsStreamCommandSignal: ${cmdAction}`);
      } catch (err) {
        console.warn('Failed to broadcast obsStreamCommandSignal:', err);
      }
    };

    // Dynamically import obs-websocket-js to avoid SSR issues
    const { default: OBSWebSocket } = await import('obs-websocket-js');
    const obs = new OBSWebSocket();

    // Swallow unhandled listener events on disconnect
    obs.on('ConnectionClosed', () => { /* no-op */ });
    obs.on('ConnectionError', () => { /* no-op */ });

    try {
      const connectPromise = obs.connect(resolvedUrl, resolvedPassword || undefined);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 2500));
      await Promise.race([connectPromise, timeoutPromise]);

      const ctrlRes = await safeObsStreamControlResult(obs, targetState, {
        refreshScene,
        liveScene,
        delayMs: 6000
      });

      try { await obs.disconnect(); } catch {}

      if (ctrlRes.success) {
        console.log(`📡 [API] Direct OBS action '${targetState}' completed successfully.`);
        await broadcastSignal(targetState);

        return NextResponse.json({
          success: true,
          action: targetState,
          message: targetState === 'refresh'
            ? `Refreshed feed via "${refreshScene}" -> "${liveScene}"`
            : (targetState === 'start' ? 'Stream started' : 'Stream stopped')
        });
      } else {
        throw new Error(ctrlRes.error || `Failed to execute ${targetState}`);
      }
    } catch (obsError: any) {
      try { await obs.disconnect(); } catch { /* ignore */ }
      console.warn('📡 [API] Direct OBS connection failed (expected on Cloud deployment). Broadcasting signal to local OBS Overlay:', obsError?.message);

      // Broadcast signal so the local OBS Overlay running on streamer's PC executes the action!
      await broadcastSignal(targetState);

      return NextResponse.json({
        success: true,
        action: targetState,
        signalSent: true,
        message: `Command signal !${targetState} sent to OBS Overlay`
      });
    }
  } catch (error: any) {
    console.error('📡 [API] obs-stream-control error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
