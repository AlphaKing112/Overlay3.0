import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const targetUrl = searchParams.get('url');

        if (!targetUrl) {
            return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        }

        console.log(`[PROXY] Initial URL: ${targetUrl}`);

        // Try multiple variations if the URL doesn't look right
        const variations: string[] = [targetUrl];

        // Add common variations if not already specified
        const urlObj = new URL(targetUrl.startsWith('http') ? targetUrl : `http://${targetUrl}`);
        const host = urlObj.host; // includes port if present
        const protocol = urlObj.protocol;
        const base = `${protocol}//${host}${urlObj.pathname.replace(/\/$/, '')}`;

        if (!targetUrl.endsWith('/stats') && !targetUrl.endsWith('/api/streams')) {
            variations.push(`${base}/stats`);
            variations.push(`${base}/api/streams`);
        }

        // Attempt to try port 80 if 8181/8080 was specified and failed
        if (host.includes(':8181') || host.includes(':8080')) {
            const strippedHost = host.split(':')[0];
            variations.push(`${protocol}//${strippedHost}/stats`);
            variations.push(`${protocol}//${strippedHost}/api/streams`);
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
                console.log(`[PROXY] Trying: ${url}`);
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000); // 8 second timeout per attempt

                const response = await fetch(url, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Cache-Control': 'no-cache',
                    },
                    signal: controller.signal,
                });

                clearTimeout(timeout);

                if (response.ok) {
                    const contentType = response.headers.get('content-type');
                    if (contentType && (contentType.includes('application/json') || contentType.includes('text/plain'))) {
                        const data = await response.json().catch(async () => {
                            const text = await response.text();
                            // Try to see if it's Nginx XML or something else we can handle later
                            return { rawText: text, isRaw: true };
                        });
                        console.log(`[PROXY] Success from ${url}`);
                        return NextResponse.json(data);
                    } else {
                        const text = await response.text();
                        console.warn(`[PROXY] Non-JSON response from ${url}`);
                        lastError = `Non-JSON response (starts with: ${text.substring(0, 30)})`;
                        lastStatus = 502; // Bad Gateway from upstream
                    }
                } else {
                    console.warn(`[PROXY] ${url} -> ${response.status} ${response.statusText}`);
                    lastError = `HTTP ${response.status}: ${response.statusText}`;
                    lastStatus = response.status;
                }
            } catch (err: any) {
                console.error(`[PROXY] Error ${url}:`, err.message);
                lastError = err.message || 'Connection failed';
                lastStatus = err.name === 'AbortError' ? 504 : 502;
            }
        }

        // If we're here, all variations failed
        return NextResponse.json({
            error: lastError || 'Stats server unreachable',
            details: `Tried ${variations.length} variations: ${variations.join(', ')}`
        }, { status: lastStatus === 200 ? 502 : lastStatus });

    } catch (error: any) {
        console.error('[PROXY] Critical error:', error);
        return NextResponse.json({
            error: 'Proxy encountered a critical error',
            details: error.message
        }, { status: 500 });
    }
}
