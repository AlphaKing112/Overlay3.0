import { NextRequest } from 'next/server';
import { kv } from '@vercel/kv';
import { addConnection, removeConnection, getConnectionInfo, connections } from '@/lib/settings-broadcast';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

// === 📡 SERVER-SENT EVENTS STREAM ===
export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('status') === 'check') {
    const connectionInfo = getConnectionInfo();
    return Response.json({
      connections: connectionInfo.count,
      ids: connectionInfo.ids,
      timestamp: Date.now()
    });
  }

  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    start(controller) {
      let lastModified = 0;
      const connectionId = `sse_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      
      // Register connection with broadcast system
      addConnection(controller, connectionId);
      
      const sendSSE = (data: string) => {
        try {
          if (connections.has(connectionId)) {
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
        } catch {
          removeConnection(connectionId);
        }
      };
      
      const checkForUpdates = async () => {
        try {
          const now = Date.now();
          const kvModified = await kv.get('overlay_settings_modified');
          const currentModified = (kvModified as number) || 0;

          if (currentModified > lastModified || !lastModified) {
            const kvSettings = await kv.get('overlay_settings');
            if (kvSettings && typeof kvSettings === 'object') {
              const settings = kvSettings;
              lastModified = currentModified || now;
              if (typeof globalThis !== 'undefined') {
                globalThis.__cachedOverlaySettings = settings;
                globalThis.__cachedOverlaySettingsTime = now;
                globalThis.__cachedOverlayModifiedTime = lastModified;
              }
              const settingsUpdate = {
                ...settings,
                type: 'settings_update',
                timestamp: lastModified
              };
              sendSSE(JSON.stringify(settingsUpdate));
            }
          }
        } catch {}
      };
      
      // Send initial connect handshake and immediate settings
      sendSSE(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
      setTimeout(checkForUpdates, 100);
      
      // Heartbeat to keep connection alive
      const heartbeatInterval = setInterval(() => {
        try {
          if (connections.has(connectionId)) {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          }
        } catch {}
      }, 15000);

      // Gracefully close before Vercel 90s limit so client reconnects smoothly
      const graceTimeout = setTimeout(() => {
        clearInterval(interval);
        clearInterval(heartbeatInterval);
        removeConnection(connectionId);
        try { controller.close(); } catch {}
      }, 75000);
      
      // Periodic check for updates every 10s (saves ~70% Active CPU while maintaining fast responsiveness)
      const interval = setInterval(checkForUpdates, 10000);
      
      // Cleanup on abort
      request.signal.addEventListener('abort', () => {
        clearInterval(interval);
        clearInterval(heartbeatInterval);
        clearTimeout(graceTimeout);
        removeConnection(connectionId);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    },
  });
} 