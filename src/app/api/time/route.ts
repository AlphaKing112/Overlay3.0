import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const pullKey = process.env.NEXT_PUBLIC_RTIRL_PULL_KEY;
    const weatherApiKey = process.env.NEXT_PUBLIC_OPENWEATHERMAP_KEY;

    if (!pullKey) {
      const now = new Date();
      const defaultTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      return new Response(`The current stream time is ${defaultTime}`, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // 1. Fetch live RTIRL GPS coordinates
    const rtirlRes = await fetch(`https://rtirl.com/api/pull?key=${pullKey}`, { cache: 'no-store' });
    if (!rtirlRes.ok) {
      throw new Error('Failed to fetch RTIRL GPS payload');
    }
    const data = await rtirlRes.json();
    const lat = data?.location?.lat;
    const lon = data?.location?.lon;
    const payloadTimezone = data?.location?.timezone;

    let targetTimezone = payloadTimezone || null;

    // 2. If lat/lon present but no timezone, look up timezone via OpenWeatherMap API
    if (!targetTimezone && typeof lat === 'number' && typeof lon === 'number' && weatherApiKey) {
      try {
        const weatherRes = await fetch(
          `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${weatherApiKey}`,
          { cache: 'no-store' }
        );
        if (weatherRes.ok) {
          const wData = await weatherRes.json();
          if (typeof wData.timezone === 'number') {
            const nowUtc = Date.now();
            const localTimeMs = nowUtc + (wData.timezone * 1000);
            const d = new Date(localTimeMs);
            const hours = d.getUTCHours();
            const minutes = d.getUTCMinutes();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours % 12 || 12;
            const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;
            const timeString = `${displayHours}:${formattedMinutes} ${ampm}`;

            return new Response(`The streamer's local time is ${timeString}`, {
              headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
          }
        }
      } catch {}
    }

    // 3. Format using IANA timezone string if available
    const now = new Date();
    let timeString = '';
    if (targetTimezone) {
      try {
        timeString = now.toLocaleTimeString('en-US', {
          timeZone: targetTimezone,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
      } catch {
        timeString = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      }
    } else {
      timeString = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    }

    return new Response(`The streamer's local time is ${timeString}`, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });

  } catch (error: any) {
    const now = new Date();
    const fallbackTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return new Response(`The current stream time is ${fallbackTime}`, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}
