import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface CacheEntry {
    data: any;
    status: number;
    timestamp: number;
}

// Global in-memory cache (persists across warm serverless executions)
const g = global as any;
if (!g.__bitrateCache) g.__bitrateCache = new Map<string, CacheEntry>();
if (!g.__workingUrlCache) g.__workingUrlCache = new Map<string, string>();

const bitrateCache: Map<string, CacheEntry> = g.__bitrateCache;
const workingUrlCache: Map<string, string> = g.__workingUrlCache;
const CACHE_TTL_MS = 5000; // 5 seconds cache TTL

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const rawTargetUrl = searchParams.get('url');

        if (!rawTargetUrl) {
            return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        }

        // Clean cache busters from cache key so multiple requests match the cache
        const cacheKey = rawTargetUrl.replace(/([?&])t=\d+&?/, '$1').replace(/[?&]$/, '');

        // 1. Check in-memory cache
        const cached = bitrateCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
            return NextResponse.json(cached.data, {
                status: cached.status,
                headers: {
                    'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=2',
                    'X-Cache': 'HIT'
                }
            });
        }

        const targetUrl = rawTargetUrl;
        const urlObj = new URL(targetUrl.startsWith('http') ? targetUrl : `http://${targetUrl}`);
        const host = urlObj.host; // includes port if present
        const protocol = urlObj.protocol;
        const base = `${protocol}//${host}${urlObj.pathname.replace(/\/$/, '')}`;

        // Build list of variations
        const variations: string[] = [];

        // If we previously found a working URL for this host, try it FIRST
        const previousWorkingUrl = workingUrlCache.get(host);
        if (previousWorkingUrl) {
            variations.push(previousWorkingUrl);
        }

        if (!variations.includes(targetUrl)) variations.push(targetUrl);

        if (!targetUrl.endsWith('/stats') && !targetUrl.endsWith('/api/streams')) {
            const statsUrl = `${base}/stats`;
            const streamsUrl = `${base}/api/streams`;
            if (!variations.includes(statsUrl)) variations.push(statsUrl);
            if (!variations.includes(streamsUrl)) variations.push(streamsUrl);
        }

        // Attempt to try port 80 if 8181/8080 was specified and failed
        if (host.includes(':8181') || host.includes(':8080')) {
            const strippedHost = host.split(':')[0];
            const p80Stats = `${protocol}//${strippedHost}/stats`;
            const p80Streams = `${protocol}//${strippedHost}/api/streams`;
            if (!variations.includes(p80Stats)) variations.push(p80Stats);
            if (!variations.includes(p80Streams)) variations.push(p80Streams);
        }

        // Also try HTTPS if HTTP was tried
        if (protocol === 'http:') {
            const httpsBase = base.replace('http:', 'https:');
            if (!variations.includes(httpsBase)) variations.push(httpsBase);
        }

        let lastError = null;
        let lastStatus = 404;

        for (const url of variations) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout per attempt

                const response = await fetch(url, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Cache-Control': 'no-cache',
                    },
                    cache: 'no-store',
                    signal: controller.signal,
                });

                clearTimeout(timeout);

                if (response.ok) {
                    const contentType = response.headers.get('content-type');
                    if (contentType && (contentType.includes('application/json') || contentType.includes('text/plain'))) {
                        const data = await response.json().catch(async () => {
                            const text = await response.text();
                            return { rawText: text, isRaw: true };
                        });

                        // Cache working URL for this host
                        workingUrlCache.set(host, url);

                        // Save in memory cache
                        bitrateCache.set(cacheKey, {
                            data,
                            status: 200,
                            timestamp: Date.now()
                        });

                        return NextResponse.json(data, {
                            headers: {
                                'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=2',
                                'X-Cache': 'MISS'
                            }
                        });
                    } else {
                        const text = await response.text();
                        lastError = `Non-JSON response (starts with: ${text.substring(0, 30)})`;
                        lastStatus = 502;
                    }
                } else {
                    lastError = `HTTP ${response.status}: ${response.statusText}`;
                    lastStatus = response.status;
                }
            } catch (err: any) {
                lastError = err.name === 'AbortError' 
                    ? 'Connection timed out (stream offline or stats server unreachable)' 
                    : (err.message || 'Connection failed');
                lastStatus = err.name === 'AbortError' ? 504 : 502;
            }
        }

        // Cache failure for 2s so failure bursts don't hammer upstream
        const errorResponse = {
            error: lastError || 'Stats server unreachable',
            details: `Tried ${variations.length} variations`
        };
        bitrateCache.set(cacheKey, {
            data: errorResponse,
            status: lastStatus === 200 ? 502 : lastStatus,
            timestamp: Date.now()
        });

        return NextResponse.json(errorResponse, { status: lastStatus === 200 ? 502 : lastStatus });

    } catch (error: any) {
        return NextResponse.json({
            error: 'Proxy encountered a critical error',
            details: error.message
        }, { status: 500 });
    }
}

