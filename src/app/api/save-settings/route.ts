import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { validateAndSanitizeSettings, detectMaliciousKeys } from '@/lib/settings-validator';
import { verifyAuth, logKVUsage } from '@/lib/api-auth';
import { broadcastSettings } from '@/lib/settings-broadcast';
import { OverlayLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Invalidate SSE cache when settings are updated
declare global {
  var sseCacheInvalidated: number | undefined;
  var __cachedOverlaySettings: any | undefined;
  var __cachedOverlaySettingsTime: number | undefined;
  var __cachedOverlayModifiedTime: number | undefined;
}

function invalidateSSECache() {
  if (typeof globalThis !== 'undefined') {
    globalThis.sseCacheInvalidated = Date.now();
  }
}

async function handlePOST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Support both flat settings and nested { settings: ... } formats
    let updates = body;
    if (body && typeof body === 'object' && 'settings' in body) {
      updates = body.settings;
    }

    // Retrieve existing settings from KV or memory cache
    let existingSettings: any = globalThis.__cachedOverlaySettings || null;
    try {
      const kvExisting = await kv.get('overlay_settings');
      if (kvExisting && typeof kvExisting === 'object') {
        existingSettings = kvExisting;
      }
    } catch (err) {
      OverlayLogger.warn('Failed to get existing settings from KV (using memory cache if available):', err);
    }

    const mergedRawSettings = existingSettings ? { ...existingSettings, ...updates } : updates;

    // Detect and log any malicious keys
    const maliciousKeys = detectMaliciousKeys(mergedRawSettings);
    if (maliciousKeys.length > 0) {
      OverlayLogger.warn('SECURITY ALERT: Malicious settings keys detected', maliciousKeys);
    }
    
    // Validate and sanitize the merged settings
    const settings = validateAndSanitizeSettings(mergedRawSettings);
    
    // Merge/preserve real-time updates from StreamElements (prevent resetting raised amount)
    if (existingSettings) {
      if (existingSettings.donationGoals && settings.donationGoals) {
        settings.donationGoals = settings.donationGoals.map((newGoal: any) => {
          const existingGoal = existingSettings.donationGoals.find((eg: any) => eg.id === newGoal.id);
          if (existingGoal) {
            return {
              ...newGoal,
              current: newGoal.current !== undefined ? newGoal.current : existingGoal.current || 0
            };
          }
          return newGoal;
        });
      } else if (existingSettings.donationGoals && !settings.donationGoals) {
        settings.donationGoals = existingSettings.donationGoals;
      }
    }
    
    const startTime = Date.now();
    const nowTime = Date.now();

    // Always update global in-memory cache immediately
    if (typeof globalThis !== 'undefined') {
      globalThis.__cachedOverlaySettings = settings;
      globalThis.__cachedOverlaySettingsTime = nowTime;
      globalThis.__cachedOverlayModifiedTime = nowTime;
      invalidateSSECache();
    }
    
    // Batch KV operations to reduce calls, wrap in try/catch to avoid crash if KV rate limited
    let kvSuccess = false;
    try {
      await Promise.all([
        kv.set('overlay_settings', settings),
        kv.set('overlay_settings_modified', nowTime)
      ]);
      logKVUsage('write');
      kvSuccess = true;
    } catch (error) {
      OverlayLogger.warn('KV save operation failed or limit reached (using memory cache):', error);
    }
    
    // SSE broadcast handles real-time updates to all connected clients
    const broadcastResult = await Promise.allSettled([
      broadcastSettings(settings)
    ]);
    
    const broadcastSuccess = broadcastResult[0].status === 'fulfilled' && 
                            broadcastResult[0].value?.success;
    
    const saveTime = Date.now() - startTime;
    
    return NextResponse.json({ 
      success: true, 
      kvSuccess, 
      broadcastSuccess,
      processingTime: saveTime 
    });
    
  } catch (error) {
    OverlayLogger.error('Settings save error', error);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const isAuthenticated = await verifyAuth();
  
  if (!isAuthenticated) {
    // Check if body only contains safe overlay updates (startLat, startLon, distanceCurrent, donationGoals)
    try {
      const cloned = request.clone();
      const body = await cloned.json();
      const updates = body?.settings || body || {};
      const allowedKeys = ['startLat', 'startLon', 'distanceCurrent', 'donationGoals'];
      const updateKeys = Object.keys(updates);
      const isOverlayAllowedUpdate = updateKeys.length > 0 && updateKeys.every(k => allowedKeys.includes(k));
      
      if (!isOverlayAllowedUpdate) {
        OverlayLogger.warn('Unauthenticated access attempt to save non-overlay settings', updateKeys);
        return new NextResponse('Unauthorized', { status: 401 });
      }
    } catch {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }
  
  return handlePOST(request);
} 