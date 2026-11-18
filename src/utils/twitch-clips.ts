const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

export interface ParsedClipCommand {
  duration: number;
  title: string;
}

export interface ClipCommandDurationSettings {
  clipDefaultDuration?: number;
  clipMinDuration?: number;
  clipMaxDuration?: number;
  clipAllowCustomTitle?: boolean;
}

export type ClipDiscordDeliveryMode = 'video_auto' | 'video_boosted' | 'embed_only';

export interface ClipMp4Candidate {
  quality: string;
  url: string;
  sizeBytes?: number;
}

export interface ResolvedTwitchClipMedia {
  mp4Buffer: Buffer | null;
  mp4SizeBytes: number;
  quality?: string;
  thumbnailUrl?: string;
  clipTitle?: string;
}

/**
 * Parses `!clip [sec] [title]` / `!clip45 [title]` arguments consistently across chat IRC and HTTP commands.
 */
export function parseClipCommandInput(
  matchedCmd: string,
  rawArgs: string,
  settings: ClipCommandDurationSettings = {}
): ParsedClipCommand {
  const cleanCmd = matchedCmd.replace(/^!/, '').toLowerCase();
  const trimmedArgs = (rawArgs || '').trim();
  const defaultDuration = settings.clipDefaultDuration ?? 60;
  const minDuration = settings.clipMinDuration ?? 10;
  const maxDuration = settings.clipMaxDuration ?? 60;

  let requestedDuration = defaultDuration;
  let title = '';

  const numSuffixMatch = cleanCmd.match(/^clip(\d+)$/);
  if (numSuffixMatch) {
    requestedDuration = parseInt(numSuffixMatch[1], 10);
    title = trimmedArgs;
  } else if (trimmedArgs) {
    const argNumMatch = trimmedArgs.match(/^(\d+)(?:\s+([\s\S]*))?$/);
    if (argNumMatch) {
      const parsedNum = parseInt(argNumMatch[1], 10);
      if (parsedNum >= 5 && parsedNum <= 120) {
        requestedDuration = parsedNum;
        title = argNumMatch[2] ? argNumMatch[2].trim() : '';
      } else {
        title = trimmedArgs;
      }
    } else {
      title = trimmedArgs;
    }
  }

  const duration = Math.max(5, Math.min(60, Math.max(minDuration, Math.min(maxDuration, requestedDuration))));
  return { duration, title: settings.clipAllowCustomTitle === false ? '' : title };
}

/**
 * Verifies an MP4 buffer has ISO BMFF `ftyp` magic bytes and is non-trivial in size
 * so thumbnails/HTML error pages are never uploaded to Discord disguised as `.mp4`.
 */
export function isValidMp4Buffer(buf: Uint8Array | Buffer): boolean {
  if (!buf || buf.byteLength < 50000) return false;
  // Standard MP4/MOV header starts with 4-byte box size followed by ASCII 'ftyp'
  return buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
}

async function fetchClipFromGql(clipSlug: string): Promise<{
  thumbnailUrl?: string;
  clipTitle?: string;
  candidates: ClipMp4Candidate[];
}> {
  try {
    const query = `query($slug:ID!){clip(slug:$slug){title thumbnailURL videoQualities{quality sourceURL} playbackAccessToken(params:{platform:"web",playerType:"site"}){signature value}}}`;
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': TWITCH_GQL_CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { slug: clipSlug } }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { candidates: [] };

    const json = await res.json();
    const clip = json?.data?.clip;
    if (!clip) return { candidates: [] };

    const sig = clip?.playbackAccessToken?.signature;
    const tokenVal = clip?.playbackAccessToken?.value;
    const qualities = Array.isArray(clip?.videoQualities) ? clip.videoQualities : [];
    const candidates: ClipMp4Candidate[] = [];

    if (sig && tokenVal) {
      const encodedToken = encodeURIComponent(tokenVal);
      for (const vq of qualities) {
        if (vq?.sourceURL) {
          const sep = vq.sourceURL.includes('?') ? '&' : '?';
          candidates.push({
            quality: String(vq.quality || 'unknown'),
            url: `${vq.sourceURL}${sep}sig=${encodeURIComponent(sig)}&token=${encodedToken}`,
          });
        }
      }
    }

    return {
      thumbnailUrl: typeof clip.thumbnailURL === 'string' ? clip.thumbnailURL : undefined,
      clipTitle: typeof clip.title === 'string' ? clip.title : undefined,
      candidates,
    };
  } catch {
    return { candidates: [] };
  }
}

async function probeContentLength(url: string): Promise<number | undefined> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2500) });
    if (!res.ok) return undefined;
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) && len > 0 ? len : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Waits for a newly created Twitch clip to finish rendering and returns the highest-quality
 * playable MP4 that fits Discord's webhook size limit (prefers <= 9.5 MB for non-boosted servers),
 * plus the verified thumbnail URL for rich embed fallback.
 */
export async function resolveTwitchClipMedia(options: {
  clipSlug: string;
  broadcasterId?: string;
  token?: string;
  clientId?: string;
  deliveryMode?: ClipDiscordDeliveryMode;
  maxWaitMs?: number;
  standardMaxBytes?: number;
  boostedMaxBytes?: number;
}): Promise<ResolvedTwitchClipMedia> {
  const {
    clipSlug,
    broadcasterId,
    token,
    clientId,
    deliveryMode = 'video_auto',
    maxWaitMs = 13500,
    standardMaxBytes = 9.5 * 1024 * 1024,
    boostedMaxBytes = 24.5 * 1024 * 1024,
  } = options;

  const isEmbedOnly = deliveryMode === 'embed_only';
  const effectiveWaitMs = isEmbedOnly ? Math.min(maxWaitMs, 4500) : maxWaitMs;
  const deadline = Date.now() + effectiveWaitMs;
  let downloadsScopeSupported = Boolean(token && clientId && broadcasterId);
  let bestThumbUrl: string | undefined;
  let bestTitle: string | undefined;
  let readyCandidates: ClipMp4Candidate[] = [];
  let fallbackCandidates: ClipMp4Candidate[] = [];

  // Initial wait gives Twitch VAP encoder time before first poll
  await new Promise((r) => setTimeout(r, 1500));

  while (Date.now() < deadline) {
    const roundCandidates: ClipMp4Candidate[] = [];

    // 1. Official Helix Clips Download API (skip in embed_only mode)
    if (!isEmbedOnly && downloadsScopeSupported && token && clientId && broadcasterId) {
      try {
        const dlUrl = `https://api.twitch.tv/helix/clips/downloads?broadcaster_id=${encodeURIComponent(broadcasterId)}&editor_id=${encodeURIComponent(broadcasterId)}&clip_id=${encodeURIComponent(clipSlug)}`;
        const dlRes = await fetch(dlUrl, {
          headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        if (dlRes.status === 401 || dlRes.status === 403) {
          downloadsScopeSupported = false;
        } else if (dlRes.ok) {
          const dlJson = await dlRes.json();
          const landscapeUrl = dlJson?.data?.[0]?.landscape_download_url;
          if (typeof landscapeUrl === 'string' && landscapeUrl.startsWith('http')) {
            roundCandidates.push({ quality: 'source', url: landscapeUrl });
          }
        }
      } catch {}
    }

    // 2. Twitch GQL returns both 1080p thumbnailURL and signed MP4 videoQualities for modern VAP clips
    const gqlData = await fetchClipFromGql(clipSlug);
    if (gqlData.thumbnailUrl) bestThumbUrl = gqlData.thumbnailUrl;
    if (gqlData.clipTitle) bestTitle = gqlData.clipTitle;
    if (gqlData.candidates.length > 0) {
      roundCandidates.push(...gqlData.candidates);
    }

    // 3. Official Helix clip metadata fallback (provides thumbnail_url and legacy -preview MP4 URL)
    if (token && clientId) {
      try {
        const metaRes = await fetch(`https://api.twitch.tv/helix/clips?id=${encodeURIComponent(clipSlug)}`, {
          headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        if (metaRes.ok) {
          const metaJson = await metaRes.json();
          const fetched = metaJson?.data?.[0];
          if (fetched) {
            if (!bestThumbUrl && typeof fetched.thumbnail_url === 'string') {
              bestThumbUrl = fetched.thumbnail_url;
            }
            if (!bestTitle && typeof fetched.title === 'string') {
              bestTitle = fetched.title;
            }
            // Legacy clips-media-assets2 pattern only applies when `-preview` is explicitly present
            if (roundCandidates.length === 0 && typeof fetched.thumbnail_url === 'string' && /-preview(?:-\d+x\d+)?\.(jpg|png|jpeg)/i.test(fetched.thumbnail_url)) {
              const legacyMp4 = fetched.thumbnail_url
                .replace(/-preview-\d+x\d+\.(jpg|png|jpeg)/i, '.mp4')
                .replace(/-preview\.(jpg|png|jpeg)/i, '.mp4');
              if (legacyMp4.endsWith('.mp4')) {
                roundCandidates.push({ quality: 'legacy', url: legacyMp4 });
              }
            }
          }
        }
      } catch {}
    }

    if (isEmbedOnly && bestThumbUrl) {
      break;
    }

    if (!isEmbedOnly && roundCandidates.length > 0) {
      fallbackCandidates = roundCandidates;
      const probed = await Promise.all(
        roundCandidates.map(async (c) => ({
          ...c,
          sizeBytes: await probeContentLength(c.url),
        }))
      );
      const reachable = probed.filter((c) => typeof c.sizeBytes === 'number' && c.sizeBytes > 50000);
      if (reachable.length > 0) {
        readyCandidates = reachable;
        break;
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    await new Promise((r) => setTimeout(r, Math.min(1800, remaining - 200)));
  }

  if (isEmbedOnly) {
    return { mp4Buffer: null, mp4SizeBytes: 0, thumbnailUrl: bestThumbUrl, clipTitle: bestTitle };
  }

  const candidates = readyCandidates.length > 0 ? readyCandidates : fallbackCandidates;
  if (candidates.length === 0) {
    return { mp4Buffer: null, mp4SizeBytes: 0, thumbnailUrl: bestThumbUrl, clipTitle: bestTitle };
  }

  // Order qualities cleanly based on Discord server upload tier:
  // - video_auto: sharpest <= 9.5MB first (fits unboosted Discord servers), then smallest <= 24.5MB
  // - video_boosted: sharpest <= 24.5MB first (allows 60s 720p on Nitro-boosted servers)
  const numericQuality = (q: string) => (q === 'source' ? 1080 : parseInt(q, 10) || 0);
  const underStandard = candidates
    .filter((c) => typeof c.sizeBytes === 'number' && c.sizeBytes > 50000 && c.sizeBytes <= standardMaxBytes)
    .sort((a, b) => numericQuality(b.quality) - numericQuality(a.quality));
  const betweenStandardAndBoosted = candidates
    .filter((c) => typeof c.sizeBytes === 'number' && c.sizeBytes > standardMaxBytes && c.sizeBytes <= boostedMaxBytes);
  const unknownSize = candidates
    .filter((c) => typeof c.sizeBytes !== 'number')
    .sort((a, b) => numericQuality(a.quality) - numericQuality(b.quality));

  const ordered =
    deliveryMode === 'video_boosted'
      ? [
          ...[...betweenStandardAndBoosted, ...underStandard].sort((a, b) => numericQuality(b.quality) - numericQuality(a.quality)),
          ...unknownSize,
        ]
      : [
          ...underStandard,
          ...betweenStandardAndBoosted.sort((a, b) => (a.sizeBytes || Infinity) - (b.sizeBytes || Infinity)),
          ...unknownSize,
        ];

  for (const candidate of ordered.slice(0, 2)) {
    try {
      const vidRes = await fetch(candidate.url, { signal: AbortSignal.timeout(9000) });
      if (!vidRes.ok) continue;

      const contentType = (vidRes.headers.get('content-type') || '').toLowerCase();
      if (contentType.startsWith('image/') || contentType.includes('text/html')) continue;

      const buf = Buffer.from(await vidRes.arrayBuffer());
      if (buf.byteLength > boostedMaxBytes || !isValidMp4Buffer(buf)) continue;

      return {
        mp4Buffer: buf,
        mp4SizeBytes: buf.byteLength,
        quality: candidate.quality,
        thumbnailUrl: bestThumbUrl,
        clipTitle: bestTitle,
      };
    } catch {}
  }

  return { mp4Buffer: null, mp4SizeBytes: 0, thumbnailUrl: bestThumbUrl, clipTitle: bestTitle };
}
