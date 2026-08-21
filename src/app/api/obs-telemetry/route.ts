import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { OverlayLogger } from '@/lib/logger';
import type { ObsTelemetryStats } from '@/types/obs-telemetry';

export const dynamic = 'force-dynamic';

declare global {
  // eslint-disable-next-line no-var
  var __cachedObsTelemetry: ObsTelemetryStats | undefined;
  // eslint-disable-next-line no-var
  var __cachedObsTelemetryTime: number | undefined;
  // eslint-disable-next-line no-var
  var __lastKvTelemetryWriteTime: number | undefined;
}

export async function GET(): Promise<NextResponse> {
  const now = Date.now();
  let telemetry: ObsTelemetryStats | null = null;

  // 1. Check in-memory cache (fresh within 10 seconds)
  if (globalThis.__cachedObsTelemetry && (now - (globalThis.__cachedObsTelemetryTime || 0) < 10000)) {
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
  const isStale = !telemetry || (now - (telemetry.updatedAt || 0) > 180000);

  const responseData: ObsTelemetryStats = telemetry && !isStale ? {
    ...telemetry,
    online: Boolean(telemetry.online !== false),
  } : {
    online: false,
    streaming: false,
    recording: false,
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
    const previousTelemetry = globalThis.__cachedObsTelemetry;
    let mergedLogs = previousTelemetry?.logs || [];
    if (Array.isArray(body.logs) && body.logs.length > 0) {
      const existingTimestamps = new Set(mergedLogs.map(l => `${l.timestamp}_${l.message}`));
      const newLogs = body.logs.filter((l: any) => l && typeof l.message === 'string' && !existingTimestamps.has(`${l.timestamp}_${l.message}`));
      mergedLogs = [...mergedLogs, ...newLogs].sort((a, b) => a.timestamp - b.timestamp).slice(-25);
    }

    const telemetry: ObsTelemetryStats = {
      online: Boolean(body.online !== false),
      streaming: Boolean(body.streaming),
      recording: Boolean(body.recording),
      uptimeTimecode: body.uptimeTimecode || '00:00:00',
      uptimeDurationMs: typeof body.uptimeDurationMs === 'number' ? body.uptimeDurationMs : undefined,
      outputBytes: typeof body.outputBytes === 'number' ? body.outputBytes : undefined,
      outputBitrateKbps: typeof body.outputBitrateKbps === 'number' ? body.outputBitrateKbps : undefined,
      droppedFrames: typeof body.droppedFrames === 'number' ? body.droppedFrames : 0,
      totalFrames: typeof body.totalFrames === 'number' ? body.totalFrames : 0,
      droppedFramesPercent: typeof body.droppedFramesPercent === 'number' ? body.droppedFramesPercent : 0,
      cpuUsagePercent: typeof body.cpuUsagePercent === 'number' ? body.cpuUsagePercent : 0,
      memoryUsageMb: typeof body.memoryUsageMb === 'number' ? body.memoryUsageMb : undefined,
      fps: typeof body.fps === 'number' ? body.fps : 60,
      renderSkippedFrames: typeof body.renderSkippedFrames === 'number' ? body.renderSkippedFrames : undefined,
      renderTotalFrames: typeof body.renderTotalFrames === 'number' ? body.renderTotalFrames : undefined,
      currentScene: body.currentScene || undefined,
      obsVersion: body.obsVersion || previousTelemetry?.obsVersion || undefined,
      obsWebSocketVersion: body.obsWebSocketVersion || previousTelemetry?.obsWebSocketVersion || undefined,
      platform: body.platform || previousTelemetry?.platform || undefined,
      logs: mergedLogs.length > 0 ? mergedLogs : undefined,
      error: body.error || undefined,
      updatedAt: now,
    };

    // Update in-memory cache immediately
    globalThis.__cachedObsTelemetry = telemetry;
    globalThis.__cachedObsTelemetryTime = now;

    // Rate-limit KV writes: write immediately on streaming/online status change, otherwise at most once every 20s
    const statusChanged = !previousTelemetry || previousTelemetry.streaming !== telemetry.streaming || previousTelemetry.online !== telemetry.online;
    const lastWrite = globalThis.__lastKvTelemetryWriteTime || 0;
    if (statusChanged || now - lastWrite > 20000) {
      globalThis.__lastKvTelemetryWriteTime = now;
      try {
        await kv.set('obs_telemetry', telemetry, { ex: 300 });
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
