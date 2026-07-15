import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/obs-switch-scene
 * Body: { sceneName: string }
 *
 * This route connects to OBS WebSocket server-side (from localhost) and switches
 * the current scene. This avoids the problem where OBS only allows 1 WebSocket
 * connection and the Admin Panel already holds it.
 *
 * This ONLY works when running locally (npm run dev), because OBS is on the
 * same machine as the Next.js server at ws://127.0.0.1:4455.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sceneName, obsUrl, obsPassword } = body;

    if (!sceneName || typeof sceneName !== 'string') {
      return NextResponse.json({ success: false, error: 'sceneName is required' }, { status: 400 });
    }

    const resolvedUrl = obsUrl || 'ws://127.0.0.1:4455';
    const resolvedPassword = obsPassword || '';

    // Dynamically import obs-websocket-js to avoid SSR issues
    const { default: OBSWebSocket } = await import('obs-websocket-js');

    const obs = new OBSWebSocket();

    // Suppress the unhandled `onclose` call-stack error that obs-websocket-js
    // emits when the socket closes (including intentional disconnect after reconnect).
    obs.on('ConnectionClosed', () => { /* no-op: expected on disconnect */ });
    // Also swallow any socket-level errors so they don't bubble as unhandled rejections
    obs.on('ConnectionError', () => { /* no-op: handled in catch below */ });

    try {
      // Connect, switch scene, then disconnect cleanly
      await obs.connect(resolvedUrl, resolvedPassword || undefined);

      try {
        // Try OBS WebSocket v5 first
        await obs.call('SetCurrentProgramScene', { sceneName });
      } catch {
        // Fallback to v4 syntax
        const v4Method = 'SetCurrentScene' as any;
        await obs.call(v4Method, { 'scene-name': sceneName });
      }

      await obs.disconnect();
      console.log(`📡 [API] Switched OBS scene to: ${sceneName}`);

      return NextResponse.json({ success: true, sceneName });
    } catch (obsError: any) {
      try { await obs.disconnect(); } catch { /* ignore */ }
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
