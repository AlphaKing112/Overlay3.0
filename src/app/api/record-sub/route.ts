import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { broadcastSettings } from '@/lib/settings-broadcast';
import { OverlayLogger } from '@/lib/logger';
import { OverlaySettings } from '@/types/settings';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { count, token, eventId, clientDate } = body;

    if (typeof count !== 'number' || count <= 0 || typeof token !== 'string' || !token) {
      return NextResponse.json({ error: 'Invalid input parameters' }, { status: 400 });
    }

    // Server-side deduplication check using Vercel KV
    if (eventId && typeof eventId === 'string') {
      const kvKey = `processed_sub_event:${eventId}`;
      // Set key with NX (only if not exists) and EX (expire in 5 seconds)
      const result = await kv.set(kvKey, '1', { nx: true, ex: 5 });
      if (result === null) {
        OverlayLogger.overlay(`Server-side duplicate sub event ignored: ${eventId}`);
        return NextResponse.json({ success: true, message: 'Duplicate event already processed' });
      }
    }

    // Fetch the current settings
    const currentSettings = (await kv.get('overlay_settings')) as OverlaySettings | null;
    if (!currentSettings) {
      return NextResponse.json({ error: 'Settings not initialized' }, { status: 404 });
    }

    // Security check: Verify token matches the configured StreamElements token
    if (!currentSettings.streamElementsEnabled) {
      OverlayLogger.warn('record-sub rejected: StreamElements integration is disabled');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (currentSettings.streamElementsToken !== token) {
      OverlayLogger.warn(`record-sub rejected: token mismatch`);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Reset daily sub count if it's a new day
    let newDailySubCurrent = currentSettings.dailySubCurrent || 0;
    let newDailyLastReset = currentSettings.dailySubLastReset || '';
    
    // clientDate is the streamer's local date string (e.g., '2026-07-05')
    if (clientDate && typeof clientDate === 'string') {
       if (newDailyLastReset !== clientDate) {
          // New day detected! Reset daily subs.
          newDailySubCurrent = 0;
          newDailyLastReset = clientDate;
          OverlayLogger.overlay(`Daily sub goal reset for new day: ${clientDate}`);
       }
    }

    // Increment sub goals
    const updatedSettings = {
      ...currentSettings,
      totalSubCurrent: (currentSettings.totalSubCurrent || 0) + count,
      dailySubCurrent: newDailySubCurrent + count,
      dailySubLastReset: newDailyLastReset
    };

    // Save and broadcast
    await Promise.all([
      kv.set('overlay_settings', updatedSettings),
      kv.set('overlay_settings_modified', Date.now())
    ]);

    if (typeof global !== 'undefined') {
      global.sseCacheInvalidated = Date.now();
    }

    await broadcastSettings(updatedSettings);

    OverlayLogger.overlay(`Successfully recorded ${count} sub(s). Total: ${updatedSettings.totalSubCurrent}, Daily: ${updatedSettings.dailySubCurrent}`);

    return NextResponse.json({ success: true, totalSubCurrent: updatedSettings.totalSubCurrent, dailySubCurrent: updatedSettings.dailySubCurrent });
  } catch (error) {
    OverlayLogger.error(`Error recording sub (Status: 500):`, error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
