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
    const { amount, token, eventId, clientDate } = body;

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

    // Fetch the current settings from KV or memory fallback
    let currentSettings: OverlaySettings | null = typeof globalThis !== 'undefined' ? (globalThis.__cachedOverlaySettings as OverlaySettings) : null;
    try {
      const kvSettings = (await kv.get('overlay_settings')) as OverlaySettings | null;
      if (kvSettings) currentSettings = kvSettings;
    } catch (err) {
      OverlayLogger.warn('KV read failed in record-donation (using in-memory fallback):', err);
    }

    if (!currentSettings) {
      return NextResponse.json({ error: 'Settings not initialized' }, { status: 404 });
    }

    // Security check: Verify token matches the configured StreamElements token
    if (!currentSettings.streamElementsToken || currentSettings.streamElementsToken !== token) {
      OverlayLogger.warn(`record-donation rejected: token mismatch or StreamElements not configured (sent ${token?.slice(0, 20)}... expected ${currentSettings.streamElementsToken?.slice(0, 20)}...)`);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Increment current amount for all active donation goals
    const updatedGoals = (currentSettings.donationGoals ?? []).map(g => ({
      ...g,
      current: g.current + amount,
      lastTriggered: Date.now()
    }));

    // Reset daily tip count if it's a new day
    let newDailyTipCurrent = currentSettings.dailyTipCurrent || 0;
    let newDailyTipLastReset = currentSettings.dailyTipLastReset || '';
    
    if (clientDate && typeof clientDate === 'string') {
       if (newDailyTipLastReset !== clientDate) {
          // New day detected! Reset daily tips.
          newDailyTipCurrent = 0;
          newDailyTipLastReset = clientDate;
          OverlayLogger.overlay(`Daily tip goal reset for new day: ${clientDate}`);
       }
    }

    const updatedSettings = {
      ...currentSettings,
      donationGoals: updatedGoals,
      totalTipCurrent: (currentSettings.totalTipCurrent || 0) + amount,
      dailyTipCurrent: newDailyTipCurrent + amount,
      dailyTipLastReset: newDailyTipLastReset
    };

    // Update in-memory cache immediately
    if (typeof globalThis !== 'undefined') {
      globalThis.__cachedOverlaySettings = updatedSettings;
      globalThis.__cachedOverlaySettingsTime = Date.now();
      globalThis.__cachedOverlayModifiedTime = Date.now();
      globalThis.sseCacheInvalidated = Date.now();
    }

    // Try saving to KV
    try {
      await Promise.all([
        kv.set('overlay_settings', updatedSettings),
        kv.set('overlay_settings_modified', Date.now())
      ]);
    } catch (err) {
      OverlayLogger.warn('KV save failed in record-donation (using memory cache):', err);
    }

    await broadcastSettings(updatedSettings);

    OverlayLogger.overlay(`Successfully recorded $${amount} donation from StreamElements`);

    return NextResponse.json({ success: true, donationGoals: updatedGoals });
  } catch (error) {
    OverlayLogger.error(`Error recording donation (Status: 500):`, error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
