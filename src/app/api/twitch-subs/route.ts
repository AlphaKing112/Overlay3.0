import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const broadcasterId = searchParams.get('broadcasterId');
    const token = searchParams.get('token');
    const clientId = searchParams.get('clientId');

    if (!broadcasterId || !token || !clientId) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const response = await fetch(`https://api.twitch.tv/helix/subscriptions?broadcaster_id=${broadcasterId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': clientId
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Twitch API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    // Twitch Sub Goal displays sub points (e.g. 10/20 Sub Points)
    const points = typeof data.points === 'number' ? data.points : (data.total ?? 0);
    const total = typeof data.total === 'number' ? data.total : points;

    return NextResponse.json({ 
      total: points, 
      points, 
      subCount: total,
      rawTotal: data.total 
    });
  } catch (error) {
    console.error('Twitch API Proxy Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch Twitch subscriptions' }, 
      { status: 500 }
    );
  }
}
