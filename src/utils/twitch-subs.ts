export interface TwitchSubPointsResult {
  total: number;
  points: number;
  subCount: number;
}

/**
 * Fetch subscriber points directly from Twitch Helix over CORS so periodic sync
 * does not invoke a serverless proxy function. Falls back to /api/twitch-subs
 * only if browser networking/CORS blocks the direct request.
 */
export async function fetchTwitchSubPoints(
  broadcasterId: string,
  token: string,
  clientId: string
): Promise<TwitchSubPointsResult> {
  try {
    const response = await fetch(
      `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-Id': clientId,
        },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Twitch API error: ${response.status}${errorText ? ` ${errorText}` : ''}`);
    }

    const data = await response.json();
    const points = typeof data.points === 'number' ? data.points : (data.total ?? 0);
    const total = typeof data.total === 'number' ? data.total : points;
    return { total: points, points, subCount: total };
  } catch (err) {
    // Only fall back to the Next.js proxy on transport/CORS errors, not Twitch HTTP errors.
    if (!(err instanceof TypeError)) {
      throw err;
    }

    const proxyRes = await fetch(
      `/api/twitch-subs?broadcasterId=${encodeURIComponent(broadcasterId)}&token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`
    );
    if (!proxyRes.ok) {
      let errorMsg = `HTTP ${proxyRes.status}`;
      try {
        const errorData = await proxyRes.json();
        errorMsg = errorData.error || errorMsg;
      } catch {}
      throw new Error(errorMsg);
    }

    const proxyData = await proxyRes.json();
    const points = typeof proxyData.points === 'number' ? proxyData.points : (proxyData.total ?? 0);
    const total = typeof proxyData.total === 'number' ? proxyData.total : points;
    return { total: points, points, subCount: total };
  }
}
