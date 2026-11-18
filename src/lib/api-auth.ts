// === 🔐 API AUTHENTICATION UTILITIES ===

import { cookies } from 'next/headers';

// Centralized admin secret configuration
export const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD;

/**
 * Verify authentication using HTTP-only cookie
 * Centralized authentication for all API routes
 */
export async function verifyAuth(): Promise<boolean> {
  const cookieStore = await cookies();
  const authToken = cookieStore.get('auth-token');
  
  if (!authToken) {
    return false;
  }
  
  // Check if the token is 'authenticated' (set by login route)
  return authToken.value === 'authenticated';
}

// === 📊 KV USAGE TRACKING ===

// Simple KV usage tracking
let kvReadCount = 0;
let kvWriteCount = 0;
let kvUsageStartTime = Date.now();

// Reset counters daily
declare global {
  var kvUsageReset: number | undefined;
}

if (typeof global !== 'undefined' && !global.kvUsageReset) {
  global.kvUsageReset = Date.now();
  kvReadCount = 0;
  kvWriteCount = 0;
  kvUsageStartTime = Date.now();
}

/**
 * Log KV usage every 100 operations
 * Centralized tracking for all API routes
 */
export function logKVUsage(operation: 'read' | 'write') {
  if (operation === 'read') kvReadCount++;
  if (operation === 'write') kvWriteCount++;
  
  const total = kvReadCount + kvWriteCount;
  const hoursSinceStart = Math.max((Date.now() - kvUsageStartTime) / (1000 * 60 * 60), 1 / 3600);
  const readsPerHour = kvReadCount / hoursSinceStart;
  const writesPerHour = kvWriteCount / hoursSinceStart;
  
  if (total % 50 === 0) {
    console.log(`📊 KV Usage: ${kvReadCount} reads, ${kvWriteCount} writes (${total} total) | Rate: ${readsPerHour.toFixed(1)} reads/hr, ${writesPerHour.toFixed(1)} writes/hr`);
    
    // Warn if usage is high
    if (readsPerHour > 1000 || writesPerHour > 1000) {
      console.warn(`⚠️  HIGH KV USAGE: ${readsPerHour.toFixed(1)} reads/hour, ${writesPerHour.toFixed(1)} writes/hour`);
    }
  }
  
  // Monthly projection warning
  if (total % 1000 === 0) {
    const projectedReads = (kvReadCount / hoursSinceStart) * 24 * 30;
    const projectedWrites = (kvWriteCount / hoursSinceStart) * 24 * 30;
    
    if (projectedReads > 80000 || projectedWrites > 80000) {
      console.warn(`🚨 MONTHLY KV PROJECTION: ${projectedReads.toFixed(0)} reads, ${projectedWrites.toFixed(0)} writes (limit: 100,000 each)`);
    }
  }
}

// === 🔄 GENERIC API UTILITIES ===

/**
 * Generic API wrapper with authentication and error handling
 */
export function withApiAuth<T extends unknown[]>(
  handler: (...args: T) => Promise<Response>
) {
  return async (...args: T): Promise<Response> => {
    const startTime = Date.now();
    
    try {
      const isAuthenticated = await verifyAuth();
      if (!isAuthenticated) {
        return new Response('Unauthorized', { status: 401 });
      }
      
      const result = await handler(...args);
      const executionTime = Date.now() - startTime;
      
      // Warn if function is taking too long (approaching 10s limit)
      if (executionTime > 8000) {
        console.warn(`⚠️  SLOW FUNCTION: ${handler.name || 'Unknown'} took ${executionTime}ms (limit: 10s)`);
      }
      
      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`❌ API Error in ${handler.name || 'Unknown'}:`, error);
      console.error(`⏱️  Execution time: ${executionTime}ms`);
      
      return new Response('Internal Server Error', { status: 500 });
    }
  };
} 