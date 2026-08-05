import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const username = (searchParams.get('username') || searchParams.get('login') || '').trim().replace(/^@/, '');
    const token = searchParams.get('token');
    const clientId = searchParams.get('clientId');

    if (!username) {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }

    // Default structure with unavatar fallback
    let userData = {
      username: username.toLowerCase(),
      displayName: username,
      avatarUrl: `https://unavatar.io/twitch/${username.toLowerCase()}`,
      gameName: '',
      title: ''
    };

    // Attempt 1: Twitch Helix API (Official)
    if (token && clientId) {
      try {
        const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Client-Id': clientId
          },
          next: { revalidate: 300 }
        });

        if (userRes.ok) {
          const userJson = await userRes.json();
          if (userJson.data && userJson.data.length > 0) {
            const user = userJson.data[0];
            userData.displayName = user.display_name || username;
            if (user.profile_image_url) {
              userData.avatarUrl = user.profile_image_url;
            }

            const channelRes = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${user.id}`, {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Client-Id': clientId
              },
              next: { revalidate: 120 }
            });

            if (channelRes.ok) {
              const channelJson = await channelRes.json();
              if (channelJson.data && channelJson.data.length > 0) {
                const channel = channelJson.data[0];
                userData.gameName = channel.game_name || '';
                userData.title = channel.title || '';
              }
            }
          }
        }
      } catch (e) {
        console.warn('Twitch Helix API fetch failed, trying secondary fallback:', e);
      }
    }

    // Attempt 2: IVR API fallback for direct Twitch CDN profile picture
    if (!userData.avatarUrl || userData.avatarUrl.includes('unavatar.io')) {
      try {
        const ivrRes = await fetch(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(username.toLowerCase())}`, {
          headers: { 'User-Agent': 'OverlayApp/3.0' },
          next: { revalidate: 300 }
        });
        if (ivrRes.ok) {
          const ivrData = await ivrRes.json();
          if (Array.isArray(ivrData) && ivrData.length > 0) {
            if (ivrData[0].logo) userData.avatarUrl = ivrData[0].logo;
            if (ivrData[0].displayName) userData.displayName = ivrData[0].displayName;
          }
        }
      } catch {}
    }

    return NextResponse.json(userData, {
      headers: {
        'Cache-Control': 's-maxage=60, stale-while-revalidate=30'
      }
    });
  } catch (error) {
    console.error('Twitch user lookup error:', error);
    return NextResponse.json({
      username: 'unknown',
      displayName: 'Streamer',
      avatarUrl: 'https://unavatar.io/twitch/twitch',
      gameName: '',
      title: ''
    });
  }
}
