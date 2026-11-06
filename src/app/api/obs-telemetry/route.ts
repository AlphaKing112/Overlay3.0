import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { OverlayLogger } from '@/lib/logger';
import type { ObsTelemetryStats } from '@/types/obs-telemetry';

export const dynamic = 'force-dynamic';

declare global {
  var __cachedObsTelemetry: ObsTelemetryStats | undefined;
  var __cachedObsTelemetryTime: number | undefined;
  var __lastKvTelemetryWriteTime: number | undefined;
  var __lastObsTelemetryStaleLogged: boolean | undefined;
  var __lastObsTelemetryStaleLogTime: number | undefined;
}

export async function GET(): Promise<NextResponse> {
  const now = Date.now();
  let telemetry: ObsTelemetryStats | null = null;

  // 1. Check in-memory cache (fresh within 1 second for instant state updates)
  if (globalThis.__cachedObsTelemetry && (now - (globalThis.__cachedObsTelemetryTime || 0) < 1000)) {
    telemetry = globalThis.__cachedObsTelemetry;
  } else {
    // 2. Fetch from Upstash KV
    try {
      const kvData = await kv.get<ObsTelemetryStats>('obs_telemetry');
      if (kvData && typeof kvData === 'object') {
        telemetry = kvData;
        globalThis.__cachedObsTelemetry = telemetry;
        globalThis.__cachedObsTelemetryTime = now;
      }
    } catch (err) {
      OverlayLogger.warn('KV read failed in obs-telemetry GET:', err);
      if (globalThis.__cachedObsTelemetry) {
        telemetry = globalThis.__cachedObsTelemetry;
      }
    }
  }

  // Check if telemetry is stale (>180 seconds old means OBS or Overlay is offline)
  // 180s threshold accommodates all intervals (15s, 30s, 45s, 60s) without false offline flipping
  const ageMs = telemetry ? (now - (telemetry.updatedAt || 0)) : -1;
  const isStale = !telemetry || ageMs > 180000;

  if (isStale) {
    const lastLogTime = globalThis.__lastObsTelemetryStaleLogTime || 0;
    if (telemetry && !globalThis.__lastObsTelemetryStaleLogged && (now - lastLogTime > 60000)) {
      globalThis.__lastObsTelemetryStaleLogged = true;
      globalThis.__lastObsTelemetryStaleLogTime = now;
      console.warn(`[OBS-TELEMETRY] ⚠️ Telemetry is stale (${Math.round(ageMs / 1000)}s old > 180s limit). Reporting OBS as disconnected.`);
    }
  } else {
    globalThis.__lastObsTelemetryStaleLogged = false;
  }

  const responseData: ObsTelemetryStats = telemetry && !isStale ? {
    ...telemetry,
    online: Boolean(telemetry.online !== false),
    scenes: telemetry.scenes || [],
  } : {
    online: false,
    streaming: false,
    recording: false,
    scenes: telemetry?.scenes || [],
    error: telemetry?.error,
    updatedAt: telemetry?.updatedAt || 0,
  };

  return NextResponse.json(responseData, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const now = Date.now();

    // Merge incoming logs with cached logs to preserve log history (keep 25 most recent)
    let previousTelemetry = globalThis.__cachedObsTelemetry;
    if (!previousTelemetry) {
      try {
        const kvExisting = await kv.get<ObsTelemetryStats>('obs_telemetry');
        if (kvExisting && typeof kvExisting === 'object') {
          previousTelemetry = kvExisting;
        }
      } catch {}
    }

    let mergedLogs = previousTelemetry?.logs || [];
    if (Array.isArray(body.logs) && body.logs.length > 0) {
      const existingTimestamps = new Set(mergedLogs.map(l => `${l.timestamp}_${l.message}`));
      const newLogs = body.logs.filter((l: any) => l && typeof l.message === 'string' && !existingTimestamps.has(`${l.timestamp}_${l.message}`));
      mergedLogs = [...mergedLogs, ...newLogs].sort((a, b) => a.timestamp - b.timestamp).slice(-25);
    }

    const isOnline = Boolean(body.online !== false);
    const telemetry: ObsTelemetryStats = {
      online: isOnline,
      streaming: typeof body.streaming === 'boolean' ? body.streaming : (isOnline ? Boolean(previousTelemetry?.streaming) : false),
      recording: typeof body.recording === 'boolean' ? body.recording : (isOnline ? Boolean(previousTelemetry?.recording) : false),
      uptimeTimecode: body.uptimeTimecode || previousTelemetry?.uptimeTimecode || '00:00:00',
      uptimeDurationMs: typeof body.uptimeDurationMs === 'number' ? body.uptimeDurationMs : previousTelemetry?.uptimeDurationMs,
      outputBytes: typeof body.outputBytes === 'number' ? body.outputBytes : previousTelemetry?.outputBytes,
      outputBitrateKbps: typeof body.outputBitrateKbps === 'number' ? body.outputBitrateKbps : previousTelemetry?.outputBitrateKbps,
      droppedFrames: typeof body.droppedFrames === 'number' ? body.droppedFrames : (previousTelemetry?.droppedFrames ?? 0),
      totalFrames: typeof body.totalFrames === 'number' ? body.totalFrames : (previousTelemetry?.totalFrames ?? 0),
      droppedFramesPercent: typeof body.droppedFramesPercent === 'number' ? body.droppedFramesPercent : (previousTelemetry?.droppedFramesPercent ?? 0),
      cpuUsagePercent: typeof body.cpuUsagePercent === 'number' ? body.cpuUsagePercent : (previousTelemetry?.cpuUsagePercent ?? 0),
      memoryUsageMb: typeof body.memoryUsageMb === 'number' ? body.memoryUsageMb : previousTelemetry?.memoryUsageMb,
      fps: typeof body.fps === 'number' ? body.fps : (previousTelemetry?.fps ?? 60),
      renderSkippedFrames: typeof body.renderSkippedFrames === 'number' ? body.renderSkippedFrames : previousTelemetry?.renderSkippedFrames,
      renderTotalFrames: typeof body.renderTotalFrames === 'number' ? body.renderTotalFrames : previousTelemetry?.renderTotalFrames,
      currentScene: body.currentScene || previousTelemetry?.currentScene || undefined,
      scenes: Array.isArray(body.scenes) && body.scenes.length > 0 ? body.scenes : previousTelemetry?.scenes || undefined,
      mediaFeedLive: typeof body.mediaFeedLive === 'boolean' ? body.mediaFeedLive : previousTelemetry?.mediaFeedLive,
      mediaFeedState: body.mediaFeedState || previousTelemetry?.mediaFeedState || undefined,
      mediaFeedSource: body.mediaFeedSource || previousTelemetry?.mediaFeedSource || undefined,
      obsVersion: body.obsVersion || previousTelemetry?.obsVersion || undefined,
      obsWebSocketVersion: body.obsWebSocketVersion || previousTelemetry?.obsWebSocketVersion || undefined,
      platform: body.platform || previousTelemetry?.platform || undefined,
      logs: mergedLogs.length > 0 ? mergedLogs : undefined,
      weather: (body.weather && typeof body.weather === 'object') ? body.weather : previousTelemetry?.weather,
      location: (body.location && typeof body.location === 'object') ? body.location : previousTelemetry?.location,
      timezone: typeof body.timezone === 'string' ? body.timezone : previousTelemetry?.timezone,
      error: body.error || undefined,
      updatedAt: now,
    };

    // Rate-limit KV writes: write immediately on streaming/online/scene status change, otherwise at most once every 15s
    const statusChanged = !previousTelemetry ||
      previousTelemetry.streaming !== telemetry.streaming ||
      previousTelemetry.online !== telemetry.online ||
      previousTelemetry.currentScene !== telemetry.currentScene;
    const lastWrite = globalThis.__lastKvTelemetryWriteTime || previousTelemetry?.updatedAt || 0;

    // Update in-memory cache immediately
    globalThis.__cachedObsTelemetry = telemetry;
    globalThis.__cachedObsTelemetryTime = now;

    if (statusChanged || now - lastWrite > 15000) {
      globalThis.__lastKvTelemetryWriteTime = now;
      try {
        await kv.set('obs_telemetry', telemetry, { ex: 300 });
        if (statusChanged) {
          console.log(`📡 [OBS-TELEMETRY] State update: scene="${telemetry.currentScene || 'unknown'}", streaming=${telemetry.streaming}, fps=${telemetry.fps}`);
        }
      } catch (kvErr) {
        OverlayLogger.warn('KV write failed in obs-telemetry POST:', kvErr);
      }
    }

    return NextResponse.json({ success: true, timestamp: now });
  } catch (err: any) {
    OverlayLogger.error('Failed to parse obs-telemetry POST:', err);
    return NextResponse.json({ success: false, error: err?.message || 'Invalid payload' }, { status: 400 });
  }
}
