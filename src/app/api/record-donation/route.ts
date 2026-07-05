import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { validateAndSanitizeSettings } from '@/lib/settings-validator';
import { broadcastSettings } from '@/lib/settings-broadcast';
import { OverlayLogger } from '@/lib/logger';
import { OverlaySettings } from '@/types/settings';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { amount, token, eventId } = body;

    if (typeof amount !== 'number' || amount <= 0 || typeof token !== 'string' || !token) {
      return NextResponse.json({ error: 'Invalid input parameters' }, { status: 400 });
    }

    // Server-side deduplication check using Vercel KV
    if (eventId && typeof eventId === 'string') {
      const kvKey = `processed_se_event:${eventId}`;
      // Set key with NX (only if not exists) and EX (expire in 5 seconds)
      const result = await kv.set(kvKey, '1', { nx: true, ex: 1 });
      if (result === null) {
        OverlayLogger.overlay(`Server-side duplicate event ignored: ${eventId}`);
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
      OverlayLogger.warn('record-donation rejected: StreamElements integration is disabled');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (currentSettings.streamElementsToken !== token) {
      OverlayLogger.warn(`record-donation rejected: token mismatch (sent ${token?.slice(0, 20)}... expected ${currentSettings.streamElementsToken?.slice(0, 20)}...)`);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Daily reset check
    const todayStr = new Date().toLocaleDateString('en-CA');
    let newDailyCurrent = (currentSettings.dailyTipCurrent ?? 0) + amount;
    let newDailyLastReset = currentSettings.dailyTipLastReset ?? '';
    
    if (newDailyLastReset !== todayStr) {
      newDailyCurrent = amount;
      newDailyLastReset = todayStr;
    }

    const updatedSettings = {
      ...currentSettings,
      totalTipCurrent: (currentSettings.totalTipCurrent ?? 0) + amount,
      dailyTipCurrent: newDailyCurrent,
      dailyTipLastReset: newDailyLastReset
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

    OverlayLogger.overlay(`Successfully recorded $${amount} donation from StreamElements`);

    return NextResponse.json({ success: true, totalTipCurrent: updatedSettings.totalTipCurrent, dailyTipCurrent: updatedSettings.dailyTipCurrent });
  } catch (error) {
    OverlayLogger.error(`Error recording donation (Status: 500):`, error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
