import { NextRequest } from 'next/server';
import { kv } from '@vercel/kv';
import { addConnection, removeConnection, getConnectionInfo, connections } from '@/lib/settings-broadcast';

// === 📡 SERVER-SENT EVENTS STREAM ===
export async function GET(request: NextRequest): Promise<Response> {
  // Check if this is a status check request
  const url = new URL(request.url);
  if (url.searchParams.get('status') === 'check') {
    const connectionInfo = getConnectionInfo();
    return Response.json({
      connections: connectionInfo.count,
      ids: connectionInfo.ids,
      timestamp: Date.now()
    });
  }
  
  // Allow public read-only access to settings stream (overlay needs this)
  // Authentication is not required - this endpoint is read-only and safe for public access

  const encoder = new TextEncoder();
  
  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      let lastModified = 0;
      const connectionId = `sse_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      
      if (process.env.NODE_ENV === 'development') {
        console.log(`[SSE] New connection established: ${connectionId}`);
      }
      
      // Register this connection with the broadcast system
      addConnection(controller, connectionId);
      
      if (process.env.NODE_ENV === 'development') {
        console.log(`[SSE] Connection ${connectionId} registered with broadcast system`);
      }
      
      // Log connection status after a short delay to verify registration (only for first few connections)
      if (process.env.NODE_ENV === 'development') {
        setTimeout(() => {
          const connectionInfo = getConnectionInfo();
          if (connectionInfo.count <= 3) {
            console.log(`[SSE] Connection ${connectionId} status check - registered: ${connectionInfo.ids.includes(connectionId)}, total: ${connectionInfo.count}`);
          }
        }, 200);
      }
      
      // Function to send SSE data
      const sendSSE = (data: string) => {
        try {
          // Check if connection is still valid before sending
          if (connections.has(connectionId)) {
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } else {
            if (process.env.NODE_ENV === 'development') {
              console.log(`[SSE] Connection ${connectionId} no longer exists, skipping send`);
            }
          }
        } catch (error) {
          if (process.env.NODE_ENV === 'development') {
            console.error(`[SSE] Failed to send data to ${connectionId}:`, error);
          }
          // Remove dead connection
          removeConnection(connectionId);
        }
      };
      
      // Function to check for settings updates
      // Allow unauthenticated read access for overlay (public read-only access)
      const checkForUpdates = async () => {
        try {
          const now = Date.now();
          let settings = typeof globalThis !== 'undefined' ? globalThis.__cachedOverlaySettings : null;
          let modifiedTimestamp = typeof globalThis !== 'undefined' ? globalThis.__cachedOverlayModifiedTime : null;
          const cacheTime = typeof globalThis !== 'undefined' ? (globalThis.__cachedOverlaySettingsTime || 0) : 0;

          // Only query KV if cache is missing or older than 5000ms
          if (!settings || (now - cacheTime > 5000)) {
            try {
              const [kvSettings, kvModified] = await Promise.all([
                kv.get('overlay_settings'),
                kv.get('overlay_settings_modified')
              ]);
              if (kvSettings && typeof kvSettings === 'object') {
                settings = kvSettings;
                modifiedTimestamp = (kvModified as number) || now;
                if (typeof globalThis !== 'undefined') {
                  globalThis.__cachedOverlaySettings = settings;
                  globalThis.__cachedOverlaySettingsTime = now;
                  globalThis.__cachedOverlayModifiedTime = modifiedTimestamp;
                }
              }
            } catch (kvErr: any) {
              const isQuotaError = kvErr?.message?.includes('max requests limit exceeded');
              if (!settings && typeof globalThis !== 'undefined') {
                settings = globalThis.__cachedOverlaySettings;
              }
              if (!settings) {
                const { DEFAULT_OVERLAY_SETTINGS } = await import('@/types/settings');
                settings = DEFAULT_OVERLAY_SETTINGS;
                if (typeof globalThis !== 'undefined') {
                  globalThis.__cachedOverlaySettings = settings;
                  // Backoff KV checks for 60 seconds if rate limited
                  globalThis.__cachedOverlaySettingsTime = now + (isQuotaError ? 60000 : 5000);
                }
              }
            }
          }
          
          if (settings && typeof settings === 'object') {
            const currentModified = (modifiedTimestamp as number) || cacheTime || now;
            
            if (currentModified > lastModified) {
              lastModified = currentModified;
              
              const settingsUpdate = {
                ...settings,
                type: 'settings_update',
                timestamp: currentModified
              };
              
              sendSSE(JSON.stringify(settingsUpdate));
            }
          }
        } catch (error) {
          // Silent error handling
        }
      };
      
      // Send initial connection message and current settings
      sendSSE(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
      
      // Send current settings immediately (allow unauthenticated read access)
        // Small delay to ensure connection is fully established
        setTimeout(() => {
          checkForUpdates();
        }, 100);
      
      // Send periodic heartbeat to keep SSE connection alive without reconnecting
      const heartbeatInterval = setInterval(() => {
        try {
          if (connections.has(connectionId)) {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          }
        } catch {}
      }, 15000);

      // Gracefully close the connection after 45 seconds to stay comfortably within Vercel execution limits
      const graceTimeout = setTimeout(() => {
        clearInterval(interval);
        clearInterval(heartbeatInterval);
        removeConnection(connectionId);
        try {
          controller.close();
        } catch {}
      }, 45000);
      
      // Check for updates every 5 seconds for fallback sync (instant updates sent via SSE broadcast)
      const interval = setInterval(checkForUpdates, 5000);
      
      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        if (process.env.NODE_ENV === 'development') {
          console.log(`[SSE] Connection closed: ${connectionId}`);
        }
        clearInterval(interval);
        clearInterval(heartbeatInterval);
        clearTimeout(graceTimeout);
        removeConnection(connectionId);
        try {
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // If credentials are needed, specify exact origin; otherwise omit credentials header.
      'Access-Control-Allow-Origin': '*'
    },
  });
} 