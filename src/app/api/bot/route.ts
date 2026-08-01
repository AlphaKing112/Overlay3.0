import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { fetchBitrateStats } from '@/utils/api-utils';
import { DEFAULT_OVERLAY_SETTINGS } from '@/types/settings';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const query = (searchParams.get('q') || searchParams.get('type') || searchParams.get('cmd') || 'help').toLowerCase();

    // Fetch settings from KV (or fallback to defaults)
    let settings: any = null;
    try {
      settings = await kv.get('overlay_settings');
    } catch {}

    const s = { ...DEFAULT_OVERLAY_SETTINGS, ...(settings || {}) };

    let reply = '';

    switch (query) {
      case 'location':
      case 'loc':
      case 'where':
        if (s.locationDisplay === 'custom' && s.customLocation) {
          reply = `📍 Location: ${s.customLocation}`;
        } else if (s.locationDisplay === 'hidden') {
          reply = `📍 Location is currently hidden.`;
        } else {
          reply = `📍 Location mode: ${s.locationDisplay} | Custom: ${s.customLocation || 'Auto GPS'}`;
        }
        break;

      case 'bitrate':
      case 'belabox':
      case 'stream':
        const statsUrl = s.belaboxUrl || (s.belaboxPublisherKey ? `https://stats.srt.belabox.net/${s.belaboxPublisherKey}` : '');
        if (!statsUrl) {
          reply = `📡 Bitrate: No Belabox URL/Key configured in settings.`;
        } else {
          try {
            const stats = await fetchBitrateStats(statsUrl, s.belaboxPublisherKey || '');
            if (stats && stats.bitrateKbps > 0) {
              reply = `📡 Bitrate: ${stats.bitrateKbps} kbps | RTT: ${stats.rttMs ? `${stats.rttMs}ms` : 'N/A'}`;
            } else {
              reply = `📡 Bitrate: 0 kbps (Stream Offline / Reconnecting)`;
            }
          } catch {
            reply = `📡 Bitrate: Unable to reach stats server.`;
          }
        }
        break;

      case 'subgoal':
      case 'subs':
      case 'sub':
        const currentSubs = s.totalSubCurrent || 0;
        const goalSubs = s.totalSubGoal || 100;
        reply = `🎯 Sub Goal: ${currentSubs} / ${goalSubs} subscribers (${Math.min(100, Math.round((currentSubs / Math.max(1, goalSubs)) * 100))}%)`;
        break;

      case 'tipgoal':
      case 'dono':
      case 'donogoal':
      case 'tips':
        const currentTips = s.totalTipCurrent || 0;
        const goalTips = s.totalTipGoal || 100;
        reply = `💰 Tip Goal: $${currentTips} / $${goalTips} (${Math.min(100, Math.round((currentTips / Math.max(1, goalTips)) * 100))}%)`;
        break;

      case 'todo':
      case 'tasks':
        if (s.todos && Array.isArray(s.todos) && s.todos.length > 0) {
          const pending = s.todos.filter((t: any) => !t.completed).map((t: any) => t.text);
          if (pending.length > 0) {
            reply = `📋 To-Do List: ${pending.join(' | ')}`;
          } else {
            reply = `📋 To-Do List: All tasks completed! 🎉`;
          }
        } else {
          reply = `📋 To-Do List is empty.`;
        }
        break;

      default:
        reply = `🎮 Stream Commands: $(customapi ${req.nextUrl.origin}/api/bot?q=location) | bitrate | subgoal | tipgoal | todo`;
        break;
    }

    return new Response(reply, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (err: any) {
    return new Response(`⚠️ Error: ${err.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
