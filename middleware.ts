import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  
  // Add version parameter to overlay & map URLs server-side to prevent OBS caching
  // This ensures the version parameter is present BEFORE OBS caches the page
  if (pathname === '/overlay' || pathname === '/map' || pathname === '/low-bitrate') {
    const hasVersion = searchParams.has('v');
    
    if (!hasVersion) {
      // Generate a build-time version (use timestamp at build time, or current timestamp as fallback)
      const buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || Date.now().toString();
      
      // Rewrite URL to include version parameter (internal rewrite, not redirect)
      const url = request.nextUrl.clone();
      url.searchParams.set('v', buildVersion);
      return NextResponse.rewrite(url);
    }
  }
  
  // Skip authentication for public overlay pages after ?v= rewrite
  const publicRoutes = ['/overlay', '/map', '/low-bitrate'];

  if (publicRoutes.includes(pathname)) {
    return NextResponse.next();
  }

  // Check if user is trying to access protected dashboard routes
  if (pathname === '/' || pathname === '/settings') {
    const authToken = request.cookies.get('auth-token');

    if (!authToken || authToken.value !== 'authenticated') {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  return NextResponse.next();
}

// Keep API routes out of Edge Middleware so public polling (/api/get-settings, etc.)
// hits Vercel Edge CDN directly without doubling invocations or burning middleware CPU.
export const config = {
  matcher: ['/', '/settings', '/low-bitrate', '/overlay', '/map']
};