import { NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { logKVUsage } from '@/lib/api-auth';
import { validateEnvironment } from '@/lib/env-validator';
import { OverlayLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function handleGET() {
  let settings: any = null;
  
  try {
    logKVUsage('read');
    settings = await kv.get('overlay_settings');
  } catch (err: any) {
    OverlayLogger.warn('KV read failed in get-settings:', err);
  }

  // Import default settings to ensure all fields exist
  const { DEFAULT_OVERLAY_SETTINGS } = await import('@/types/settings');
  
  const combinedSettings = {
    ...DEFAULT_OVERLAY_SETTINGS,
    ...(settings || {})
  };

  return NextResponse.json(combinedSettings, {
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
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