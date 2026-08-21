import { NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { logKVUsage } from '@/lib/api-auth';
import { validateEnvironment } from '@/lib/env-validator';
import { OverlayLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 3;

async function handleGET() {
  let settings: any = null;
  const now = Date.now();
  
  // First check in-memory cache for ultra-fast & fresh reads (within 3s)
  const isCacheFresh = typeof globalThis !== 'undefined' && 
    globalThis.__cachedOverlaySettings && 
    (now - (globalThis.__cachedOverlaySettingsTime || 0) < 3000);

  if (isCacheFresh) {
    settings = globalThis.__cachedOverlaySettings;
  } else {
    try {
      logKVUsage('read');
      const kvSettings = await kv.get('overlay_settings');
      if (kvSettings && typeof kvSettings === 'object') {
        settings = kvSettings;
        if (typeof globalThis !== 'undefined') {
          globalThis.__cachedOverlaySettings = settings;
          globalThis.__cachedOverlaySettingsTime = now;
        }
      }
    } catch (err: any) {
      OverlayLogger.warn('KV read failed in get-settings:', err);
      // Fallback to memory cache if KV fails
      if (typeof globalThis !== 'undefined' && globalThis.__cachedOverlaySettings) {
        settings = globalThis.__cachedOverlaySettings;
      }
    }
  }

  // Import default settings to ensure all fields exist
  const { DEFAULT_OVERLAY_SETTINGS } = await import('@/types/settings');
  
  const combinedSettings = {
    ...DEFAULT_OVERLAY_SETTINGS,
    ...(settings || {})
  };

  return NextResponse.json(combinedSettings, {
    headers: {
      'Cache-Control': 'public, s-maxage=3, stale-while-revalidate=5',
      'CDN-Cache-Control': 'public, s-maxage=3, stale-while-revalidate=5',
      'Vercel-CDN-Cache-Control': 'public, s-maxage=3, stale-while-revalidate=5',
    }
  });
}

export async function GET(): Promise<NextResponse> {
  // Validate environment (only KV storage is required)
  const envValidation = validateEnvironment();
  if (!envValidation.isValid) {
    OverlayLogger.error('Environment validation failed', envValidation.missing);
    return new NextResponse('Server configuration error', { status: 500 });
  }
  
  // Allow unauthenticated access for overlay (public access)
  // Authentication is only required for admin panel access
  return handleGET();
} 