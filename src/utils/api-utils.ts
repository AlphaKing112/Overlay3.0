import {
  checkRateLimit
} from './rate-limiting';
import { type LocationData } from './location-utils';
import { ApiLogger } from '@/lib/logger';
import {
  isValidApiKey
} from './fallback-utils';
import {
  recordApiSuccess,
  recordApiFailure,
  canUseApi
} from './api-health';





// === ⏱️ API CONFIGURATION ===
const API_CONFIG = {
  TIMEOUT: 15000, // Increased to 15 seconds default
  RETRY_ATTEMPTS: 1, // Reduced retries for bitrate to prevent stack up
  RETRY_DELAY: 1000, // 1 second base delay
  MAX_RETRY_DELAY: 10000, // 10 seconds max delay
} as const;

// === 🧠 CACHING REMOVED ===
// Caching system removed to prevent stale data issues

// === 🔄 RETRY UTILITY ===
async function fetchWithRetry(
  url: string,
  options: RequestInit & { timeout?: number } = {},
  retries: number = API_CONFIG.RETRY_ATTEMPTS
): Promise<Response> {
  const timeoutLimit = options.timeout || API_CONFIG.TIMEOUT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.debug(`[fetchWithRetry] Aborting request to ${url} after ${timeoutLimit}ms`);
    controller.abort();
  }, timeoutLimit);

  try {
    console.debug(`[fetchWithRetry] Fetching: ${url} (Timeout: ${timeoutLimit}ms)`);
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    console.debug(`[fetchWithRetry] Success: ${url} (${response.status})`);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      console.warn(`[fetchWithRetry] Request timed out: ${url}`);
    } else {
      console.error(`[fetchWithRetry] Network error: ${url}`, error);
    }

    if (retries > 0 && isAbort) {
      const attempt = API_CONFIG.RETRY_ATTEMPTS - retries + 1;
      const backoffDelay = Math.min(
        API_CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1),
        API_CONFIG.MAX_RETRY_DELAY
      );

      ApiLogger.warn('fetch', `Request timeout, retrying in ${backoffDelay}ms... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
      return fetchWithRetry(url, options, retries - 1);
    }

    throw error;
  }
}

// === 🌤️ WEATHER TYPES ===
export interface WeatherData {
  temp: number; // actual temperature
  desc: string;
  id?: number; // OpenWeatherMap condition code for warnings
}

export interface WeatherTimezoneResponse {
  weather: WeatherData | null;
  timezone: string | null;
  sunriseSunset?: SunriseSunsetData | null;
}

export interface SunriseSunsetData {
  sunrise: string; // HH:MM:SS format
  sunset: string;  // HH:MM:SS format
  dayLength: string; // HH:MM:SS format
}

// === 📍 LOCATION API (LocationIQ) ===

/**
 * Fetches location name from coordinates using LocationIQ API
 * Optimized for English street names globally (including Japan)
 * Includes caching to reduce API calls and respect daily limits
 */
export interface LocationIQResult {
  location: LocationData | null;
  was404: boolean; // True if LocationIQ returned 404 (no address found - likely on water)
}

export async function fetchLocationFromLocationIQ(
  lat: number,
  lon: number,
  apiKey: string
): Promise<LocationIQResult> {
  // Check API health before attempting call
  if (!canUseApi('locationiq')) {
    ApiLogger.warn('locationiq', 'API is currently unavailable, using fallback');
    return { location: null, was404: false }; // Will trigger fallback in calling code
  }

  if (!isValidApiKey(apiKey)) {
    const error = 'Invalid or missing API key';
    ApiLogger.warn('locationiq', error);
    recordApiFailure('locationiq', error);
    return { location: null, was404: false };
  }

  // Rate limiting is checked in overlay/page.tsx before calling this function
  // Don't check again here to avoid double-checking and race conditions

  try {
    ApiLogger.info('locationiq', 'Fetching location data', {
      lat,
      lon
    });

    // Add cache busting timestamp to prevent browser caching
    const timestamp = Date.now();
    const response = await fetchWithRetry(
      `https://us1.locationiq.com/v1/reverse.php?key=${apiKey}&lat=${lat}&lon=${lon}&format=json&accept-language=en&_t=${timestamp}`
    );

    if (!response.ok) {
      let error: string;
      let isRateLimited = false;

      if (response.status === 429) {
        error = 'Rate limit exceeded';
        isRateLimited = true;
        ApiLogger.info('locationiq', 'Rate limit exceeded - fallback will be used', {
          status: response.status,
          message: 'Rate limit exceeded - fallback will be used'
        });
      } else if (response.status === 402) {
        error = 'Daily API limit reached';
        ApiLogger.warn('locationiq', 'Daily API limit reached', {
          message: 'LocationIQ daily limit exceeded. Consider upgrading plan or wait until tomorrow.'
        });
      } else if (response.status === 401) {
        error = 'Invalid API key';
        ApiLogger.warn('locationiq', 'Invalid API key');
      } else if (response.status === 404) {
        error = 'Location not found (likely at sea or remote area)';
        ApiLogger.info('locationiq', 'No reverse geocode available - using coordinate fallback', {
          status: 404,
          lat,
          lon
        });
        recordApiFailure('locationiq', error, isRateLimited);
        return { location: null, was404: true }; // 404 means likely on water
      } else {
        error = `HTTP ${response.status}: ${response.statusText}`;
        ApiLogger.error('locationiq', error);
      }

      recordApiFailure('locationiq', error, isRateLimited);
      return { location: null, was404: false }; // Other errors are not 404
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`LocationIQ Error: ${data.error}`);
    }

    if (data.address) {
      // Parse address components with better city prioritization
      // Try to get the most recognizable city name, not just the smallest administrative unit
      // NOTE: Do NOT use suburb as fallback - it's a neighborhood field, not a city field
      // This ensures City mode shows actual city names (e.g., "Austin") not neighborhoods (e.g., "Downtown")
      const city = data.address.city ||
        data.address.municipality ||  // Municipality is often the actual city
        data.address.town;            // Town is usually a proper city
      // Suburb is NOT used here - it's stored separately and handled by precision logic

      // State/province/region level - do NOT include county here as it's a separate administrative level
      // County is stored separately and handled by precision logic
      const state = data.address.province ||  // Japanese prefectures are in 'province' field
        data.address.state ||
        data.address.region;

      // Normalize location names to English
      // LocationIQ API uses accept-language=en, but we normalize as a fallback
      const normalizeToEnglish = (name: string | undefined): string | undefined => {
        if (!name) return name;
        // Common non-English to English mappings for known cases
        const englishMappings: Record<string, string> = {
          // Japanese prefectures (common romanizations)
          'tokyo-to': 'Tokyo',
          'osaka-fu': 'Osaka',
          'kyoto-fu': 'Kyoto',
          // Add more mappings as needed
        };
        const lowerName = name.toLowerCase().trim();
        return englishMappings[lowerName] || name;
      };

      const result: LocationData = {
        city: normalizeToEnglish(city) || city,
        state: normalizeToEnglish(state) || state,
        country: normalizeToEnglish(data.address.country) || data.address.country,
        countryCode: data.address.country_code ? data.address.country_code.toLowerCase() : '',
        timezone: data.address.timezone,
        // Store the raw address components for better city detection (normalized)
        town: normalizeToEnglish(data.address.town) || data.address.town,
        municipality: normalizeToEnglish(data.address.municipality) || data.address.municipality,
        suburb: normalizeToEnglish(data.address.suburb) || data.address.suburb,
        neighbourhood: normalizeToEnglish(data.address.neighbourhood) || data.address.neighbourhood, // British spelling from LocationIQ
        quarter: normalizeToEnglish(data.address.quarter) || data.address.quarter,
        province: normalizeToEnglish(data.address.province) || data.address.province,
        region: normalizeToEnglish(data.address.region) || data.address.region,
        county: normalizeToEnglish(data.address.county) || data.address.county,
        house_number: data.address.house_number,
        road: data.address.road,
        postcode: data.address.postcode,
      };

      ApiLogger.info('locationiq', 'Location data received', result);

      // Record successful API call
      recordApiSuccess('locationiq');

      // Validate the result before returning
      if (!result.city && !result.state && !result.country) {
        ApiLogger.warn('locationiq', 'LocationIQ returned incomplete result - missing city, state, and country', {
          availableFields: {
            neighbourhood: result.neighbourhood,
            suburb: result.suburb,
            town: result.town,
            municipality: result.municipality
          }
        });
        return { location: null, was404: false };
      }

      // Debug: Log the raw API response to see what fields are actually available
      ApiLogger.info('locationiq', 'Raw API response address fields', {
        house_number: data.address.house_number,
        road: data.address.road,
        neighbourhood: data.address.neighbourhood,
        suburb: data.address.suburb,
        town: data.address.town,
        municipality: data.address.municipality,
        city: data.address.city,
        county: data.address.county,
        state: data.address.state,
        province: data.address.province,
        region: data.address.region,
        postcode: data.address.postcode,
        country: data.address.country,
        timezone: data.address.timezone,
        fullAddress: data.address
      });

      return { location: result, was404: false };
    }

    throw new Error('No address data in response');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    ApiLogger.error('locationiq', 'Failed to fetch location', error);
    recordApiFailure('locationiq', errorMessage);
    return { location: null, was404: false };
  }
}


// === 🌤️ WEATHER API (OpenWeatherMap) ===

/**
 * Fetches weather, timezone, and sunrise/sunset data from OpenWeatherMap API
 * Includes sunrise/sunset times for accurate day/night detection
 */
export async function fetchWeatherAndTimezoneFromOpenWeatherMap(
  lat: number,
  lon: number,
  apiKey: string
): Promise<WeatherTimezoneResponse | null> {
  // Check API health before attempting call
  if (!canUseApi('openweathermap')) {
    ApiLogger.warn('openweathermap', 'API is currently unavailable, using fallback');
    return null; // Will trigger fallback in calling code
  }

  if (!isValidApiKey(apiKey)) {
    const error = 'Invalid or missing API key';
    ApiLogger.warn('openweathermap', error);
    recordApiFailure('openweathermap', error);
    return null;
  }

  // Rate limiting is checked in overlay/page.tsx before calling this function
  // Don't check again here to avoid double-checking and race conditions

  try {
    ApiLogger.info('openweathermap', 'Fetching weather, timezone, and sunrise/sunset data', { lat, lon });

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;

    const response = await fetchWithRetry(url);

    if (!response.ok) {
      let error: string;
      let isRateLimited = false;

      if (response.status === 429) {
        error = 'Rate limit exceeded';
        isRateLimited = true;
      } else if (response.status === 401) {
        error = 'Invalid API key';
      } else if (response.status === 404) {
        error = 'Location not found';
      } else {
        error = `HTTP ${response.status}: ${response.statusText}`;
      }

      recordApiFailure('openweathermap', error, isRateLimited);
      throw new Error(error);
    }

    const data = await response.json();

    if (data.cod !== 200) {
      const error = `OpenWeatherMap Error: ${data.message || 'Unknown error'}`;
      recordApiFailure('openweathermap', error);
      throw new Error(error);
    }

    let weather: WeatherData | null = null;
    let timezone: string | null = null;
    let sunriseSunset: SunriseSunsetData | null = null;

    // Extract weather data
    // Use actual temperature as primary, fallback to feels_like if missing
    if (data.main && typeof data.main.temp === 'number' && data.weather && data.weather[0]) {
      weather = {
        temp: Math.round(data.main.temp), // Use actual temperature
        desc: data.weather[0].description || 'unknown',
        id: data.weather[0].id,
      };

      ApiLogger.info('openweathermap', 'Weather data received', weather);
    } else if (data.main && typeof data.main.feels_like === 'number' && data.weather && data.weather[0]) {
      // Fallback to feels_like if regular temp is not available
      weather = {
        temp: Math.round(data.main.feels_like),
        desc: data.weather[0].description || 'unknown',
        id: data.weather[0].id,
      };

      ApiLogger.info('openweathermap', 'Weather data received (using feels_like as regular temp unavailable)', weather);
    }

    // Extract timezone data
    // NOTE: OpenWeatherMap only provides a numeric offset (seconds), not an IANA timezone name
    // LocationIQ provides the actual IANA timezone name and is preferred
    // This is a simplified fallback mapping - LocationIQ should handle most cases accurately
    if (data.timezone && typeof data.timezone === 'number') {
      // Convert timezone offset to hours
      const offsetHours = Math.round(data.timezone / 3600);

      // Simple offset-to-timezone mapping (fallback only)
      // This is approximate - same offset can map to different timezones (e.g., -4 could be Eastern or Central with DST)
      // LocationIQ provides accurate IANA timezone names and should be used when available
      const timezoneMap: Record<number, string> = {
        9: 'Asia/Tokyo',
        8: 'Asia/Shanghai',
        7: 'Asia/Bangkok',
        6: 'Asia/Dhaka',
        5: 'Asia/Karachi',
        4: 'Asia/Dubai',
        3: 'Europe/Moscow',
        2: 'Europe/Athens',
        1: 'Europe/Paris',
        0: 'UTC',
        [-1]: 'Atlantic/Azores',
        [-2]: 'Atlantic/South_Georgia',
        [-3]: 'America/Sao_Paulo',
        [-4]: 'America/New_York', // Eastern Time (EDT) - approximate, LocationIQ preferred
        [-5]: 'America/Chicago', // Default fallback - will be refined by coordinates for US
        [-6]: 'America/Chicago', // Central Time (CST) - approximate, LocationIQ preferred
        [-7]: 'America/Denver', // Mountain Time - approximate, LocationIQ preferred
        [-8]: 'America/Los_Angeles', // Pacific Time - approximate, LocationIQ preferred
        [-9]: 'Pacific/Gambier',
        [-10]: 'Pacific/Honolulu',
        [-11]: 'Pacific/Midway',
        [-12]: 'Pacific/Baker'
      };

      // Use simple offset mapping as base
      timezone = timezoneMap[offsetHours] || timezoneMap[Math.floor(offsetHours)] || 'UTC';

      // For US locations, refine timezone based on coordinates (when LocationIQ doesn't provide timezone)
      // This handles cases where same offset maps to different US timezones
      if (lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66) {
        // US region - use coordinates to determine correct timezone
        if (offsetHours === -5) {
          // -5 offset can be Eastern Time (EST) or Central Time (CDT)
          // Eastern Time: roughly east of -87° longitude (includes Florida, Georgia, Carolinas, etc.)
          if (lon >= -87) {
            timezone = 'America/New_York'; // Eastern Time (EST)
          } else {
            timezone = 'America/Chicago'; // Central Time (CDT)
          }
        } else if (offsetHours === -4) {
          // -4 offset is Eastern Time (EDT) - covers entire Eastern US
          if (lon >= -87) {
            timezone = 'America/New_York'; // Eastern Time (EDT)
          }
        } else if (offsetHours === -6) {
          // -6 offset is Central Time (CST) - covers central US
          if (lon >= -106 && lon <= -85) {
            timezone = 'America/Chicago'; // Central Time (CST)
          }
        } else if (offsetHours === -7) {
          // -7 offset is Mountain Time (MDT) - covers mountain states
          if (lon >= -124 && lon <= -102) {
            timezone = 'America/Denver'; // Mountain Time
          }
        } else if (offsetHours === -8) {
          // -8 offset is Pacific Time (PST) - covers west coast
          if (lon >= -124 && lon <= -102) {
            timezone = 'America/Los_Angeles'; // Pacific Time
          }
        }
      }

      ApiLogger.info('openweathermap', 'Timezone data received (fallback - LocationIQ preferred)', {
        timezone,
        offsetHours,
        rawOffsetSeconds: data.timezone,
        coordinates: { lat, lon },
        note: 'OpenWeatherMap provides offset only - LocationIQ provides accurate IANA timezone name'
      });
    }

    // Extract sunrise/sunset data
    if (data.sys && data.sys.sunrise && data.sys.sunset) {
      const sunrise = new Date(data.sys.sunrise * 1000);
      const sunset = new Date(data.sys.sunset * 1000);

      sunriseSunset = {
        sunrise: sunrise.toISOString(),
        sunset: sunset.toISOString(),
        dayLength: formatDuration(sunset.getTime() - sunrise.getTime())
      };

      ApiLogger.info('openweathermap', 'Sunrise/sunset data received', sunriseSunset);
    }

    // Record successful API call
    recordApiSuccess('openweathermap');

    const result = { weather, timezone, sunriseSunset };
    return result;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    ApiLogger.error('openweathermap', 'Failed to fetch weather/timezone/sunrise-sunset', error);
    recordApiFailure('openweathermap', errorMessage);
    return null;
  }
}

// Helper function to format duration in HH:MM:SS format
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}


/**
 * Fetches bitrate stats from NOALBS or Belabox SRT Live Server (SLS)
 */
export async function fetchBitrateStats(
  url: string,
  publisherKey?: string
): Promise<{ bitrateKbps: number; rttMs?: number } | null> {
  if (!url) return null;

  try {
    // Check health status before fetching
    if (!canUseApi('bitrate')) {
      return null;
    }

    const isBrowser = typeof window !== 'undefined';
    const isHttps = url.startsWith('https://');

    // RESOURCE OPTIMIZATION:
    // If we're on HTTPS and the target is HTTPS, try direct fetch first
    // This saves Vercel / Serverless execution credits.
    let response;
    let usedProxy = false;

    // OBS Browser Source is very aggressive with caching fetch requests.
    // Adding a timestamp cache buster to the URL ensures we always get fresh data.
    const cacheBuster = `t=${Date.now()}`;
    const directUrl = url.includes('?') ? `${url}&${cacheBuster}` : `${url}?${cacheBuster}`;
    
    if (isBrowser && isHttps) {
      try {
        // Try direct fetch first
        response = await fetchWithRetry(directUrl, {
          timeout: 5000,
          headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
          cache: 'no-store'
        });
        if (!response.ok) throw new Error('Direct fetch failed');
      } catch (e) {
        // Fallback to proxy if direct fetch fails (likely CORS)
        const proxyUrl = `/api/bitrate?url=${encodeURIComponent(url)}&${cacheBuster}`;
        response = await fetchWithRetry(proxyUrl, { 
          timeout: 15000,
          headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
          cache: 'no-store'
        });
        usedProxy = true;
      }
    } else {
      // Use proxy for HTTP to avoid Mixed Content errors, or if not in browser
      const fetchUrl = isBrowser
        ? `/api/bitrate?url=${encodeURIComponent(url)}&${cacheBuster}`
        : directUrl;
      response = await fetchWithRetry(fetchUrl, { 
        timeout: 20000,
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
        cache: 'no-store'
      });
      usedProxy = true;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // If the proxy returned an error object inside the 200 response
    if (data && data.error) {
      throw new Error(`Proxy error: ${data.error}`);
    }

    // Record success
    recordApiSuccess('bitrate');

    // --- PARSING LOGIC STRENGTHENED ---

    // 1. Format: Belabox/SLS "sessions" (Standard SLS)
    if (data.sessions && Array.isArray(data.sessions)) {
      const session = publisherKey
        ? data.sessions.find((s: any) => s.pub_id === publisherKey)
        : data.sessions[0];

      if (session) {
        return {
          bitrateKbps: Math.round((session.bitrate || session.bps || 0) / 1000),
          rttMs: session.rtt
        };
      }
    }

    // 2. Format: NOALBS /api/streams (Array of objects)
    if (Array.isArray(data)) {
      const stream = publisherKey
        ? data.find((s: any) => s.name === publisherKey || s.key === publisherKey)
        : data[0];

      if (stream) {
        let rate = 0;
        // Handle string bitrates like "5.2Mbps" or "5200Kbps"
        const bitrateVal = stream.bitrate || stream.bps || stream.bitrate_kbit || 0;
        const rateStr = String(bitrateVal);

        if (rateStr.toLowerCase().includes('mbps')) {
          rate = parseFloat(rateStr) * 1000;
        } else if (rateStr.toLowerCase().includes('kbps')) {
          rate = parseFloat(rateStr);
        } else {
          rate = parseFloat(rateStr) || 0;
        }

        return {
          bitrateKbps: Math.round(rate),
          rttMs: stream.rtt || stream.ping
        };
      }
    }

    // 3. Format: NOALBS "publishers" object (As seen in some older versions)
    if (data.publishers && typeof data.publishers === 'object') {
      const pubKeys = Object.keys(data.publishers);
      const pubKey = publisherKey && data.publishers[publisherKey]
        ? publisherKey
        : pubKeys[0];

      const pub = data.publishers[pubKey];
      if (pub && pub.connected) {
        return {
          bitrateKbps: Math.round((pub.bitrate || pub.bps || 0) / (pub.bps ? 1000 : 1)),
          rttMs: pub.rtt || 0
        };
      }
    }

    // 4. Format: Direct stream objects (e.g. { "bps": 5000000, "rtt": 20 })
    if (data.bps || data.bitrate || data.bw_video) {
      const rate = data.bitrate || data.bps || data.bw_video || data.bitrate_kbit;
      // Nginx bw_video is often in bytes/sec
      const divisor = (data.bps || data.bw_video) ? 1000 : 1;
      return {
        bitrateKbps: Math.round(Number(rate) / divisor),
        rttMs: data.rtt || data.ping || 0
      };
    }

    // 5. Format: Nginx RTMP Stats (Deeply nested)
    try {
      if (data.rtmp && data.rtmp.server) {
        const apps = Array.isArray(data.rtmp.server)
          ? data.rtmp.server[0].application
          : data.rtmp.server.application;

        const appList = Array.isArray(apps) ? apps : [apps];
        for (const app of appList) {
          const streams = app.live ? (Array.isArray(app.live.stream) ? app.live.stream : [app.live.stream]) : [];
          const stream = publisherKey
            ? streams.find((s: any) => s.name === publisherKey)
            : streams[0];

          if (stream && (stream.bw_video || stream.bw_in)) {
            return {
              bitrateKbps: Math.round((Number(stream.bw_video || stream.bw_in) || 0) / 1024),
              rttMs: 0 // Nginx standard doesn't provide RTT
            };
          }
        }
      }
    } catch (e) {
      // Ignore nested parsing errors
    }

    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // EXTREMELY VISIBLE LOG FOR F12 DEBUGGING
    console.error(
      '%c📡 BITRATE ERROR %c\n' +
      'Status: Failed to fetch stream stats\n' +
      'Reason: ' + errorMessage + '\n\n' +
      'Troubleshooting Checklist:\n' +
      '1. 🔴 IS YOUR STREAM LIVE? Stats are usually only available while you are streaming.\n' +
      '2. 🌐 Reachability: Check if your stats URL is accessible from your network.\n' +
      '3. 🔑 Publisher Key: Ensure NEXT_PUBLIC_SRT_PUBLISHER_KEY matches your "Stream ID".\n' +
      '4. 🏗️ Nginx Setup: If using Nginx NOALBS, ensure "rtmp_stat_format json" is enabled.\n' +
      '5. 🔄 Ports: Try ports 80, 8080, or 8181 in your .env.local.',
      'background: #D0021B; color: white; font-weight: bold; padding: 4px 8px; border-radius: 4px;',
      'color: #D0021B; font-weight: 500;'
    );

    ApiLogger.error('bitrate', 'Failed to fetch bitrate stats', error);
    recordApiFailure('bitrate', errorMessage);
    return null;
  }
}

// === 🛠️ API HELPER FUNCTIONS ===

/**
 * Creates a consistent error response
 */
export function createErrorResponse(message: string, status: number = 400) {
  return Response.json({ success: false, error: message }, { status });
}

/**
 * Creates a consistent success response
 */
export function createSuccessResponse(data?: Record<string, unknown>) {
  return Response.json({ success: true, ...data });
} 