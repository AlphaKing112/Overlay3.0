/**
 * StreamElements Loyalty Points & Channel Helper
 * Handles querying and mutating viewer points via StreamElements Kappa v2 REST API.
 */

// In-memory cache for channel ID to avoid repeat lookups
let cachedChannelId: string | null = null;
let cachedToken: string | null = null;

/**
 * Normalizes JWT token by removing surrounding quotes, 'Bearer ' prefix, and whitespace
 */
export function normalizeJwt(token: string): string {
  if (!token) return '';
  let t = token.trim();
  if (t.toLowerCase().startsWith('bearer ')) {
    t = t.slice(7).trim();
  }
  t = t.replace(/^["']|["']$/g, '').trim();
  return t;
}

/**
 * Checks if a token is in valid JWT structure (3 parts, starting with eyJ)
 */
export function isValidJwtFormat(token: string): boolean {
  const clean = normalizeJwt(token);
  return clean.startsWith('eyJ') && clean.split('.').length === 3;
}

/**
 * Extracts 24-hex channel ID directly from JWT payload if present
 */
export function extractChannelIdFromJwt(token: string): string | null {
  try {
    const cleanToken = normalizeJwt(token);
    const parts = cleanToken.split('.');
    if (parts.length >= 2) {
      const payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = Buffer.from(payloadBase64, 'base64').toString('utf8');
      const payload = JSON.parse(jsonStr);
      const candidates = [payload.userId, payload.channelId, payload._id, payload.channel];
      for (const c of candidates) {
        if (typeof c === 'string' && /^[a-f0-9]{24}$/i.test(c)) {
          return c;
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Resolves the streamer's StreamElements Channel ID from their JWT token
 */
export async function getStreamElementsChannelId(token: string): Promise<string | null> {
  const cleanToken = normalizeJwt(token);
  if (!cleanToken) return null;

  if (cachedChannelId && cachedToken === cleanToken) {
    return cachedChannelId;
  }

  // 1. Fetch from /channels/me first (authoritative)
  try {
    const res = await fetch('https://api.streamelements.com/kappa/v2/channels/me', {
      headers: {
        'Authorization': `Bearer ${cleanToken}`,
        'Accept': 'application/json'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const channelId = data?._id || data?.id || null;
      if (channelId && /^[a-f0-9]{24}$/i.test(channelId)) {
        cachedChannelId = channelId;
        cachedToken = cleanToken;
        return channelId;
      }
    }
  } catch (err: any) {
    console.error('[StreamElements] Channel resolution error:', err?.message || err);
  }

  // 2. Fallback to 24-hex ObjectId from JWT payload
  const jwtChannelId = extractChannelIdFromJwt(cleanToken);
  if (jwtChannelId) {
    cachedChannelId = jwtChannelId;
    cachedToken = cleanToken;
    return jwtChannelId;
  }

  return null;
}

/**
 * Queries current loyalty points for a specific Twitch viewer
 */
export async function getStreamElementsUserPoints(
  token: string,
  channelId: string,
  username: string
): Promise<{ success: boolean; points: number; rank?: number; error?: string }> {
  const cleanToken = normalizeJwt(token);
  if (!cleanToken || !channelId || !username) {
    return { success: false, points: 0, error: 'Missing token, channelId, or username' };
  }

  if (!isValidJwtFormat(cleanToken)) {
    return {
      success: false,
      points: 0,
      error: 'Token is not a valid JWT format (must start with eyJ...). Please copy the JWT Token from StreamElements Account Settings > Show Secrets.'
    };
  }

  const cleanUser = username.replace(/^@/, '').toLowerCase().trim();

  // Try query with resolved channelId
  try {
    const res = await fetch(`https://api.streamelements.com/kappa/v2/points/${channelId}/${encodeURIComponent(cleanUser)}`, {
      headers: {
        'Authorization': `Bearer ${cleanToken}`,
        'Accept': 'application/json'
      }
    });

    if (res.status === 404) {
      // User has 0 points or doesn't exist in loyalty database
      return { success: true, points: 0 };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        success: false,
        points: 0,
        error: 'StreamElements returned 401 Unauthorized. Please verify your JWT Token in Settings.'
      };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { success: false, points: 0, error: `StreamElements points API returned ${res.status}: ${errText}` };
    }

    const data = await res.json();
    const points = typeof data?.points === 'number' ? data.points : 0;
    return { success: true, points, rank: data?.rank };
  } catch (err: any) {
    return { success: false, points: 0, error: err?.message || String(err) };
  }
}

/**
 * Deducts or adds loyalty points for a viewer.
 * Pass negative amount to deduct (e.g. -200), positive to add/refund.
 */
export async function modifyStreamElementsPoints(
  token: string,
  channelId: string,
  username: string,
  amount: number
): Promise<{ success: boolean; newPoints?: number; error?: string }> {
  const cleanToken = normalizeJwt(token);
  if (!cleanToken || !channelId || !username || amount === 0) {
    return { success: false, error: 'Missing parameters or amount is 0' };
  }

  if (!isValidJwtFormat(cleanToken)) {
    return {
      success: false,
      error: 'Token is not a valid JWT format (must start with eyJ...). Please copy the JWT Token from StreamElements Account Settings > Show Secrets.'
    };
  }

  const cleanUser = username.replace(/^@/, '').toLowerCase().trim();

  try {
    const res = await fetch(`https://api.streamelements.com/kappa/v2/points/${channelId}/${encodeURIComponent(cleanUser)}/${amount}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${cleanToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (res.status === 401 || res.status === 403) {
      return {
        success: false,
        error: 'StreamElements returned 401 Unauthorized when deducting points.'
      };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { success: false, error: `Points update failed (HTTP ${res.status}): ${errText}` };
    }

    const data = await res.json();
    return { success: true, newPoints: data?.points };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
