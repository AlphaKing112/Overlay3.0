import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { broadcasterId, message, token, clientId, color } = await request.json();

    if (!broadcasterId || !message || !token || !clientId) {
      return NextResponse.json({ success: false, reason: 'Twitch integration token or broadcasterId not connected' });
    }

    // 1. Attempt Twitch Chat Announcement API first
    const announcementRes = await fetch(`https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: message.slice(0, 500),
        color: color || 'primary'
      })
    });

    if (announcementRes.ok) {
      return NextResponse.json({ success: true, method: 'announcement' });
    }

    const annErr = await announcementRes.text().catch(() => '');
    console.warn('Twitch announcement API failed, trying standard chat message:', announcementRes.status, annErr);

    // 2. Fallback to Twitch Chat Message API
    const chatRes = await fetch(`https://api.twitch.tv/helix/chat/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: broadcasterId,
        message: message.slice(0, 500)
      })
    });

    if (chatRes.ok) {
      return NextResponse.json({ success: true, method: 'chat_message' });
    }

    const chatErr = await chatRes.text().catch(() => '');
    console.warn('Twitch chat message API response:', chatRes.status, chatErr);
    return NextResponse.json({
      success: false,
      status: chatRes.status,
      error: `Announcement API (${announcementRes.status}): ${annErr} | Chat API (${chatRes.status}): ${chatErr}`
    });
  } catch (error) {
    console.error('Failed to post Twitch announcement/chat message:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
