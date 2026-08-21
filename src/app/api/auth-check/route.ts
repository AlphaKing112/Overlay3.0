import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';

export async function GET(): Promise<NextResponse> {
  try {
    const isAuthenticated = await verifyAuth();
    if (!isAuthenticated) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }
    return NextResponse.json({ success: true, message: 'Authenticated' });
  } catch (error) {
    console.error('Auth check error:', error);
    return NextResponse.json({ success: false, error: 'Failed to verify auth' }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  return GET();
}
