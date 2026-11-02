import { NextResponse } from 'next/server';
import { kv } from '@vercel/kv';

async function getSettings(): Promise<any> {
  let settings: any = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedOverlaySettings : null) || null;
  if (!settings) {
    try {
      const kvData = await kv.get('overlay_settings');
      if (kvData && typeof kvData === 'object') {
        settings = kvData;
      }
    } catch {}
  }
  return settings || {};
}

/**
 * POST /api/twitch-announcement
 * Body: { broadcasterId, message, token, clientId, color, asAnnouncement?: boolean }
 *
 * Sends a normal Twitch Chat message reply by default (or Twitch Announcement if requested).
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    let { broadcasterId, message, token, clientId, color, asAnnouncement, replyParentMessageId } = body;

    if (!message || typeof message !== 'string') {
      return NextResponse.json({ success: false, reason: 'Message string is required' });
    }

    // Auto-resolve credentials from KV if not supplied by caller
    if (!token || !broadcasterId) {
      const settings = await getSettings();
      token = token || settings.twitchToken || '';
      broadcasterId = broadcasterId || settings.twitchBroadcasterId || '';
      clientId = clientId || settings.twitchClientId || 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw';
    }

    // Auto-resolve broadcasterId from token if missing
    if (token && !broadcasterId) {
      try {
        const uRes = await fetch('https://api.twitch.tv/helix/users', {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Client-Id': clientId || 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw'
          }
        });
        if (uRes.ok) {
          const uData = await uRes.json();
          broadcasterId = uData?.data?.[0]?.id;
        }
      } catch {}
    }

    if (!broadcasterId || !token || !clientId) {
      return NextResponse.json({ success: false, reason: 'Twitch integration token or broadcasterId not connected' });
    }

    const cleanMessage = message.slice(0, 500);

    // If explicitly requested as Announcement banner
    if (asAnnouncement) {
      try {
        const announcementRes = await fetch(`https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Client-Id': clientId,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: cleanMessage,
            color: color || 'primary'
          })
        });

        if (announcementRes.ok) {
          return NextResponse.json({ success: true, method: 'announcement' });
        }
      } catch (annErr) {
        console.warn('Twitch announcement API failed, falling back to chat message:', annErr);
      }
    }

    // Standard Twitch Chat Message API (replying directly to user command if replyParentMessageId provided)
    const chatPayload: Record<string, any> = {
      broadcaster_id: broadcasterId,
      sender_id: broadcasterId,
      message: cleanMessage
    };
    if (replyParentMessageId) {
      chatPayload.reply_parent_message_id = replyParentMessageId;
    }

    const chatRes = await fetch(`https://api.twitch.tv/helix/chat/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(chatPayload)
    });

    if (chatRes.ok) {
      return NextResponse.json({ success: true, method: 'chat_message' });
    }

    const chatErr = await chatRes.text().catch(() => '');
    console.warn('Twitch chat message API failed:', chatRes.status, chatErr);

    // Fallback to Announcement API if scope for chat message fails
    const fallbackAnnRes = await fetch(`https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: cleanMessage,
        color: color || 'primary'
      })
    });

    if (fallbackAnnRes.ok) {
      return NextResponse.json({ success: true, method: 'announcement_fallback' });
    }

    const annErr = await fallbackAnnRes.text().catch(() => '');
    return NextResponse.json({
      success: false,
      status: chatRes.status,
      error: `Chat API (${chatRes.status}): ${chatErr} | Announcement API (${fallbackAnnRes.status}): ${annErr}`
    });
  } catch (error) {
    console.error('Failed to post Twitch chat message:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
