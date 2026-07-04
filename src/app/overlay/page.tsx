"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAnimatedValue } from '@/hooks/useAnimatedValue';
import dynamic from 'next/dynamic';
import { OverlaySettings, DEFAULT_OVERLAY_SETTINGS } from '@/types/settings';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useRenderPerformance } from '@/lib/performance';
import { OverlayLogger } from '@/lib/logger';
import { celsiusToFahrenheit, kmhToMph, metersToFeet } from '@/utils/unit-conversions';
import { API_KEYS, TIMERS, SPEED_ANIMATION, ELEVATION_ANIMATION, BITRATE_ANIMATION, type RTIRLPayload } from '@/utils/overlay-constants';

// Extract constants for cleaner code
const {
  GPS_FRESHNESS_TIMEOUT,
  GPS_STALE_TIMEOUT,
  WEATHER_DATA_VALIDITY_TIMEOUT,
  LOCATION_DATA_VALIDITY_TIMEOUT,
  MINIMAP_FADE_DURATION,
  WALKING_PACE_THRESHOLD,
  SETTINGS_POLLING_INTERVAL,
  MINIMAP_STALENESS_CHECK_INTERVAL,
  MINIMAP_SPEED_GRACE_PERIOD,
  MINIMAP_GPS_STALE_GRACE_PERIOD,
  BITRATE_UPDATE_INTERVAL,
} = TIMERS;
import { distanceInMeters } from '@/utils/location-utils';
import { fetchWeatherAndTimezoneFromOpenWeatherMap, fetchLocationFromLocationIQ, fetchBitrateStats, type SunriseSunsetData } from '@/utils/api-utils';
import { formatLocation, formatCountryName, type LocationData } from '@/utils/location-utils';
import { checkRateLimit } from '@/utils/rate-limiting';
import {
  createLocationWithCountryFallback,
  createWeatherFallback,
  createSunriseSunsetFallback,
  isNightTimeFallback
} from '@/utils/fallback-utils';

declare global {
  interface Window {
    RealtimeIRL?: {
      forPullKey: (key: string) => {
        addListener: (cb: (p: unknown) => void) => void;
      };
    };
  }
}

// MapLibreMinimap component - WebGL-based map rendering
const MapLibreMinimap = dynamic(() => import('@/components/MapLibreMinimap'), {
  ssr: false,
  loading: () => <div className="minimap-placeholder" />
});

const HeartRateMonitor = dynamic(() => import('@/components/HeartRateMonitor'), {
  ssr: false,
  loading: () => null
});

const CalorieTracker = dynamic(() => import('@/components/CalorieTracker').then(mod => mod.CalorieTracker), {
  ssr: false,
  loading: () => null
});

// Flag component - simple SVG only, hidden until loaded to prevent alt text flash
const LocationFlag = ({ countryCode }: { countryCode: string }) => {
  const [isLoaded, setIsLoaded] = useState(false);

  return (
    <span className="location-flag-inline">
      <img
        src={`https://flagcdn.com/${countryCode.toLowerCase()}.svg`}
        alt={`Country: ${countryCode}`}
        width={32}
        height={20}
        className="location-flag-small"
        style={{ opacity: isLoaded ? 1 : 0, transition: 'opacity 0.2s' }}
        onLoad={() => setIsLoaded(true)}
        onError={() => setIsLoaded(true)} // Show even on error to avoid alt text flash
      />
    </span>
  );
};

// Component for embedded URLs - Simplified for maximum compatibility
const EmbedUrl = ({ url }: { url: any }) => {
  return (
    <iframe
      src={url.url}
      style={{
        position: 'absolute',
        top: `${url.y || 0}px`,
        left: `${url.x || 0}px`,
        width: '1920px',
        height: '1080px',
        border: 'none',
        pointerEvents: 'none', // Allow click-through to underlying elements/game
        zIndex: 999,
        transform: `scale(${url.scale || 1})`,
        transformOrigin: 'top left',
        background: 'transparent'
      }}
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write; microphone; camera; display-capture; midi"
      // @ts-ignore
      allowtransparency="true"
      scrolling="no"
      sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
      loading="eager"
      referrerPolicy="origin"
    />
  );
};

function OverlayPage() {
  useRenderPerformance('OverlayPage');

  // Version parameter is added server-side via middleware to prevent OBS caching
  // No client-side code needed - middleware handles it before the page loads

  // State
  const [timeDisplay, setTimeDisplay] = useState({ time: '', date: '' });
  const [location, setLocation] = useState<{
    primary: string;
    secondary?: string;
    countryCode?: string;
  } | null>(null);
  const [weather, setWeather] = useState<{ temp: number; desc: string } | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [sunriseSunset, setSunriseSunset] = useState<SunriseSunsetData | null>(null);
  const [mapCoords, setMapCoords] = useState<[number, number] | null>(null);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [currentAltitude, setCurrentAltitude] = useState<number | null>(null);
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULT_OVERLAY_SETTINGS);
  const [minimapVisible, setMinimapVisible] = useState(false);
  const [minimapOpacity, setMinimapOpacity] = useState(0); // Initialize hidden, fade in when active
  const [hasIncompleteLocationData, setHasIncompleteLocationData] = useState(false); // Track if we have incomplete location data (country but no code)
  const [overlayVisible, setOverlayVisible] = useState(false); // Track if overlay should be visible (fade-in delay)
  const [currentBitrate, setCurrentBitrate] = useState<number | null>(null);
  const [currentRtt, setCurrentRtt] = useState<number | null>(null);
  const [totalDistanceTracked, setTotalDistanceTracked] = useState(0); // In meters
  const settingsLoadedRef = useRef(false); // Track if settings have been loaded from API (prevents logging initial default state change)

  // Persistent storage keys
  const STORAGE_KEY = 'overlay-completed-todos';
  const CACHED_STATE_KEY = 'overlay-cached-state';
  const DISTANCE_STORAGE_KEY = 'overlay-total-distance';
  const CALORIES_PER_KM = 62; // Average walking calories per km for 70kg person at 5km/h

  // Todo completion tracking with localStorage persistence
  const [completedTodoTimestamps, setCompletedTodoTimestamps] = useState<Map<string, number>>(new Map()); // Track when todos were completed
  const completedTodoTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map()); // Track timers for hiding completed todos

  // Social media rotation state and logic
  const [activeSocialIndex, setActiveSocialIndex] = useState(0);

  // Donation toast notification state
  const [donationToast, setDonationToast] = useState<{
    username: string;
    amount: string;
    label: string;
    icon: string;
    phase: 'entering' | 'exiting';
  } | null>(null);
  const donationToastTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Donation Goal auto-hide expiration timestamps and time tick for countdown
  const [goalExpiryTimestamps, setGoalExpiryTimestamps] = useState<Record<string, number>>({});
  const [timeTick, setTimeTick] = useState(Date.now());

  // Singleton socket ref — prevents duplicate connections when settings re-render
  const seSocketRef = useRef<any>(null);
  // Always-current settings ref so the socket handler reads fresh values without reconnecting
  const seSettingsRef = useRef(settings);
  useEffect(() => { seSettingsRef.current = settings; }, [settings]);

  // Set up second tick for countdown timers
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeTick(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Trigger visibility preview when donation settings change, so the user can see updates on the screen
  useEffect(() => {
    if (settings.showDonationGoals && settings.donationGoals && settings.donationGoals.length > 0) {
      const now = Date.now();
      const newExpiries: Record<string, number> = {};
      settings.donationGoals.forEach(g => {
        const duration = g.duration || 0;
        if (duration > 0) {
          // Set expiry to 20 seconds from now for settings change preview
          newExpiries[g.id] = now + 20000;
        }
      });
      setGoalExpiryTimestamps(prev => ({ ...prev, ...newExpiries }));
    }
  }, [
    settings.donationGoalsScale,
    settings.donationGoalsX,
    settings.donationGoalsY,
    settings.showDonationGoals,
    settings.donationGoals
  ]);


  const activeSocials = useMemo(() => {
    const list = [];
    if (settings.socialXEnabled && settings.socialXName) {
      list.push({ type: 'x', name: settings.socialXName });
    }
    if (settings.socialYoutubeEnabled && settings.socialYoutubeName) {
      list.push({ type: 'youtube', name: settings.socialYoutubeName });
    }
    if (settings.socialInstagramEnabled && settings.socialInstagramName) {
      list.push({ type: 'instagram', name: settings.socialInstagramName });
    }
    if (settings.socialTiktokEnabled && settings.socialTiktokName) {
      list.push({ type: 'tiktok', name: settings.socialTiktokName });
    }
    return list;
  }, [
    settings.socialXEnabled,
    settings.socialXName,
    settings.socialYoutubeEnabled,
    settings.socialYoutubeName,
    settings.socialInstagramEnabled,
    settings.socialInstagramName,
    settings.socialTiktokEnabled,
    settings.socialTiktokName
  ]);

  useEffect(() => {
    if (activeSocials.length <= 1) {
      setActiveSocialIndex(0);
      return;
    }

    const intervalSeconds = settings.socialRotateInterval || 5;
    const intervalId = setInterval(() => {
      setActiveSocialIndex((prevIndex) => (prevIndex + 1) % activeSocials.length);
    }, intervalSeconds * 1000);

    return () => clearInterval(intervalId);
  }, [activeSocials, settings.socialRotateInterval]);


  // Rate-gating refs for external API calls
  const lastWeatherTime = useRef(0);
  const lastLocationTime = useRef(0);
  const lastGpsUpdateTime = useRef(0); // Track when we last got GPS data (use ref for synchronous updates)
  const lastGpsTimestamp = useRef(0); // Track the actual GPS timestamp from payload (not reception time)
  const weatherFetchInProgress = useRef(false); // Track if weather fetch is already in progress
  const locationFetchInProgress = useRef(false); // Track if location fetch is already in progress
  const lastCoords = useRef<[number, number] | null>(null);
  const lastCoordsTime = useRef(0);
  const lastSettingsHash = useRef<string>('');
  const lastRawLocation = useRef<LocationData | null>(null);
  const lastSuccessfulWeatherFetch = useRef(0); // Track when weather was last successfully fetched
  const lastSuccessfulLocationFetch = useRef(0); // Track when location was last successfully fetched

  // API rate limiting tracking (per-second only)
  // GPS update tracking for minimap
  const minimapFadeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track last 3 speed readings for minimap visibility (need 3 consecutive readings > 5 km/h)
  const speedReadingsRef = useRef<number[]>([]); // Array of last 3 speed readings

  // Minimap speed-based visibility tracking
  const lowSpeedStartTimeRef = useRef<number | null>(null); // Track when speed dropped below 5 km/h
  const MINIMAP_HIDE_DELAY = 60000; // 1 minute - hide after low speed or no GPS updates

  // Speed and altitude staleness tracking
  // Track GPS timestamps (from payload), not reception times, so staleness works when stationary
  const lastSpeedGpsTimestamp = useRef(0); // Track GPS timestamp when speed was last updated
  const lastAltitudeGpsTimestamp = useRef(0); // Track GPS timestamp when altitude was last updated
  const [speedUpdateTimestamp, setSpeedUpdateTimestamp] = useState(0); // State to trigger re-renders
  const [altitudeUpdateTimestamp, setAltitudeUpdateTimestamp] = useState(0); // State to trigger re-renders
  const [bitrateUpdateTimestamp, setBitrateUpdateTimestamp] = useState(0); // State to trigger re-renders
  const consecutiveBitrateFailuresRef = useRef(0);

  // Helper: Check if GPS update is fresh (within 15 minutes)
  const isGpsUpdateFresh = (gpsUpdateTime: number, now: number): boolean => {
    return (now - gpsUpdateTime) <= GPS_FRESHNESS_TIMEOUT;
  };

  // Helper: Check if timezone is valid (not null/undefined/UTC placeholder)
  const isValidTimezone = (tz: string | null | undefined): boolean => {
    return tz !== null && tz !== undefined && tz !== 'UTC';
  };

  // Helper: Clear timeout safely
  const clearTimer = (timerRef: React.MutableRefObject<NodeJS.Timeout | null>) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };


  // Safe API call wrapper
  const safeApiCall = async (apiCall: () => Promise<unknown>, context: string): Promise<unknown> => {
    try {
      return await apiCall();
    } catch (error) {
      OverlayLogger.error(`${context} failed`, error);
      return null;
    }
  };

  // Ref to track current speed for minimap visibility (prevents infinite loops)
  const currentSpeedRef = useRef(0);

  // Update ref when speed changes
  useEffect(() => {
    currentSpeedRef.current = currentSpeed;
  }, [currentSpeed]);



  // Simplified minimap visibility logic:
  // - Show: Speed > 5 km/h for 3 consecutive RTIRL updates
  // - Hide: Speed < 5 km/h for more than 1 minute OR no GPS updates in 1 minute
  const updateMinimapVisibility = useCallback(() => {
    const now = Date.now();
    const timeSinceLastGps = lastGpsUpdateTime.current > 0 ? (now - lastGpsUpdateTime.current) : Infinity;
    const isGpsStale = timeSinceLastGps > MINIMAP_HIDE_DELAY; // 1 minute without GPS updates

    clearTimer(minimapFadeTimeoutRef);

    // Use ref to avoid dependency on currentSpeed state (prevents infinite loops)
    const speed = currentSpeedRef.current;

    if (settings.minimapSpeedBased) {
      // Check if GPS is stale (no updates in 1 minute) - hide after delay
      if (isGpsStale) {
        if (minimapVisible) {
          setMinimapVisible(false);
          setMinimapOpacity(0);
        } else {
          // Ensure opacity is 0 even if already hidden
          setMinimapOpacity(0);
        }
        // Clear speed readings and low speed timer when GPS is stale
        speedReadingsRef.current = [];
        lowSpeedStartTimeRef.current = null;
        return;
      }

      // GPS is fresh - check speed readings
      // Check if we have 3 consecutive readings > 5 km/h
      const hasThreeHighSpeedReadings = speedReadingsRef.current.length >= 3 &&
        speedReadingsRef.current.every(s => s > WALKING_PACE_THRESHOLD);

      if (speed > WALKING_PACE_THRESHOLD) {
        // Speed > 5 km/h - show minimap if we have 3 consecutive readings > 5 km/h
        if (hasThreeHighSpeedReadings) {
          // Reset low speed timer since we're moving
          lowSpeedStartTimeRef.current = null;

          if (!minimapVisible) {
            setMinimapVisible(true);
            setMinimapOpacity(1.0);
          } else {
            setMinimapOpacity(1.0);
          }
        }
      } else {
        // Speed < 5 km/h - start timer, hide after 1 minute
        if (minimapVisible) {
          // Start tracking when speed dropped below threshold
          if (lowSpeedStartTimeRef.current === null) {
            lowSpeedStartTimeRef.current = now;
          }

          // Check if 1 minute has passed since speed dropped
          const timeSinceLowSpeed = now - lowSpeedStartTimeRef.current;
          if (timeSinceLowSpeed >= MINIMAP_HIDE_DELAY) {
            setMinimapVisible(false);
            setMinimapOpacity(0);
            speedReadingsRef.current = [];
            lowSpeedStartTimeRef.current = null;
          }
        } else {
          // Already hidden - ensure opacity is 0 and clear readings
          setMinimapOpacity(0);
          speedReadingsRef.current = [];
          lowSpeedStartTimeRef.current = null;
        }
      }
    } else if (settings.showMinimap) {
      // Manual show mode
      lowSpeedStartTimeRef.current = null; // Clear low speed timer in manual mode
      if (!minimapVisible) {
        setMinimapVisible(true);
        setMinimapOpacity(0);
        requestAnimationFrame(() => setMinimapOpacity(1.0));
      } else {
        setMinimapOpacity(1.0);
      }
    } else {
      // Manual hide mode (showMinimap is false and minimapSpeedBased is false)
      // Hide immediately when manually turned off (no fade delay)
      speedReadingsRef.current = [];
      lowSpeedStartTimeRef.current = null;
      setMinimapVisible(false);
      setMinimapOpacity(0);
      // Clear any pending fade timeout
      clearTimer(minimapFadeTimeoutRef);
    }
  }, [settings.showMinimap, settings.minimapSpeedBased, minimapVisible]);

  // Track the last locationDisplay value to detect actual changes
  const lastLocationDisplayRef = useRef<string | undefined>(undefined);

  // Update settings hash and re-format location ONLY when locationDisplay changes
  useEffect(() => {
    const newHash = JSON.stringify(settings);
    const hashChanged = newHash !== lastSettingsHash.current;
    const locationDisplayChanged = settings.locationDisplay !== lastLocationDisplayRef.current;
    lastSettingsHash.current = newHash;
    lastLocationDisplayRef.current = settings.locationDisplay;

    // Only re-format location when locationDisplay actually changes
    // Other settings changes (showWeather, showMinimap, etc.) don't need location re-formatting
    if (!locationDisplayChanged) {
      return; // Skip re-formatting if locationDisplay hasn't changed
    }

    // Re-render location display instantly from cached raw data if available
    // This ensures location display updates immediately when settings change
    // IMPORTANT: Only re-format if we have complete location data (not just country)
    // This prevents trying to format incomplete fallback data
    const hasCompleteLocationData = lastRawLocation.current && (
      lastRawLocation.current.city ||
      lastRawLocation.current.town ||
      lastRawLocation.current.village ||
      lastRawLocation.current.municipality ||
      lastRawLocation.current.neighbourhood ||
      lastRawLocation.current.suburb ||
      lastRawLocation.current.district
    );

    // Re-format location when locationDisplay changes if we have complete location data
    if (hasCompleteLocationData && settings.locationDisplay !== 'hidden') {
      try {
        const formatted = formatLocation(lastRawLocation.current!, settings.locationDisplay);
        // Log only when locationDisplay actually changes (reduced verbosity)
        // Force update location state to trigger re-render with new format
        setLocation({
          primary: formatted.primary || '',
          secondary: formatted.secondary,
          countryCode: lastRawLocation.current!.countryCode || ''
        });
        setHasIncompleteLocationData(false); // Clear incomplete flag when re-formatting
      } catch (error) {
        OverlayLogger.warn('Location re-formatting failed on settings change', { error });
        // Ignore formatting errors; UI will update on next normal cycle
      }
    } else if (locationDisplayChanged && !hasCompleteLocationData && settingsLoadedRef.current) {
      // Only log if settings have been loaded (not initial default state)
      // Log when locationDisplay changes but we don't have complete location data yet
      if (lastRawLocation.current) {
        OverlayLogger.location('Location display mode changed but no complete location data available yet', {
          mode: settings.locationDisplay
        });
      } else {
        OverlayLogger.location('Location display mode changed but no raw location data cached yet', {
          mode: settings.locationDisplay
        });
      }
    }
  }, [settings.locationDisplay]); // Only depend on locationDisplay, not entire settings object

  // Combined minimap visibility updates - simpler than multiple separate effects
  useEffect(() => {
    try {
      // Clear speed readings and timers when switching modes or disabling minimap
      if (!settings.minimapSpeedBased) {
        speedReadingsRef.current = [];
        lowSpeedStartTimeRef.current = null;
      }
      updateMinimapVisibility();
    } catch (error) {
      OverlayLogger.error('Failed to update minimap visibility', error);
      // Don't throw - allow overlay to continue functioning
    }
  }, [settings.showMinimap, settings.minimapSpeedBased, currentSpeed, updateMinimapVisibility]);

  // Periodic check for GPS staleness (speed-based mode only)
  useEffect(() => {
    if (!settings.minimapSpeedBased) return;

    const interval = setInterval(() => {
      try {
        updateMinimapVisibility();
      } catch (error) {
        OverlayLogger.error('Failed to update minimap visibility in staleness check', error);
      }
    }, MINIMAP_STALENESS_CHECK_INTERVAL);

    return () => clearInterval(interval);
  }, [settings.minimapSpeedBased, updateMinimapVisibility]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      clearTimer(minimapFadeTimeoutRef);
      // Cleanup completed todo timers
      completedTodoTimersRef.current.forEach((timer) => clearTimeout(timer));
      completedTodoTimersRef.current.clear();
    };
  }, []);




  // Rate limiting is handled by checkRateLimit() from rate-limiting.ts
  // This ensures both per-second (1/sec) and daily (5,000/day) limits are enforced






  // Refs
  const timeUpdateTimer = useRef<NodeJS.Timeout | null>(null);

  // Global error handling - suppress harmless errors, log others
  useEffect(() => {
    const isHarmlessChromeError = (message: string | undefined, source?: string): boolean => {
      if (!message) return false;
      return message.includes('chrome is not defined') ||
        (message.includes('chrome') && (source?.includes('rtirl') ?? false));
    };

    const handleError = (event: ErrorEvent) => {
      if (isHarmlessChromeError(event.message, event.filename)) {
        event.preventDefault();
        return;
      }
      // Suppress noisy RTIRL library JSONP errors
      if (event.message && event.message.includes('pRTLPCB is not defined')) {
        event.preventDefault();
        return;
      }
      OverlayLogger.error('Unhandled error', {
        message: event.message,
        filename: event.filename
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason?.toString() || '';
      if (isHarmlessChromeError(reason)) {
        event.preventDefault();
        return;
      }
      OverlayLogger.error('Unhandled promise rejection', { reason: event.reason });
      event.preventDefault();
    };

    const originalOnError = window.onerror;
    window.onerror = (message, source, lineno, colno, error) => {
      if (typeof message === 'string' && isHarmlessChromeError(message, source || undefined)) {
        return true;
      }
      return originalOnError ? originalOnError(message, source, lineno, colno, error) : false;
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      window.onerror = originalOnError;
    };
  }, []);


  // Helper function to format time/date using timezone
  // Uses toLocaleString directly - simpler than storing formatters in refs
  const formatTime = useCallback((tz: string | null): { time: string; date: string } => {
    if (!isValidTimezone(tz)) {
      return { time: '', date: '' };
    }

    // TypeScript: tz is guaranteed to be string here due to isValidTimezone check
    const timezone = tz as string;

    try {
      const now = new Date();
      return {
        time: now.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: timezone,
        }),
        date: now.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: timezone,
        }),
      };
    } catch (error) {
      OverlayLogger.warn('Invalid timezone format, using UTC fallback', { timezone: tz, error });
      // Fallback to UTC
      const now = new Date();
      return {
        time: now.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'UTC',
        }),
        date: now.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        }),
      };
    }
  }, []);

  // Helper functions to update data - always update (no GPS staleness check)
  // Visibility is controlled by "Hidden" option in location display mode
  const updateLocation = useCallback((locationData: { primary: string; secondary?: string; countryCode?: string }) => {
    setLocation(locationData);
    lastSuccessfulLocationFetch.current = Date.now();
  }, []);

  const updateWeather = useCallback((weatherData: { temp: number; desc: string }) => {
    setWeather(weatherData);
    lastSuccessfulWeatherFetch.current = Date.now();
  }, []);

  // Single function to update timezone - used by all sources (LocationIQ, OpenWeatherMap, RTIRL)
  // Timezone updates even when GPS is stale - we need accurate timezone for time display
  const updateTimezone = useCallback((timezoneData: string) => {
    if (!isValidTimezone(timezoneData)) {
      return; // Don't set invalid timezones
    }
    setTimezone(timezoneData);
    // Don't call markGpsReceived() here - timezone updates even when GPS is stale
    // Location/weather visibility is controlled separately by hasReceivedFreshGps
  }, []);

  // Extract GPS coordinates from RTIRL payload
  const extractCoordinates = useCallback((payload: RTIRLPayload): [number, number] | null => {
    if (!payload.location) return null;

    let lat: number | null = null;
    let lon: number | null = null;

    if ('lat' in payload.location && 'lon' in payload.location) {
      lat = payload.location.lat;
      lon = payload.location.lon;
    } else if ('latitude' in payload.location && 'longitude' in payload.location) {
      lat = (payload.location as { latitude: number }).latitude;
      lon = (payload.location as { longitude: number }).longitude;
    }

    if (lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return [lat, lon];
    }

    return null;
  }, []);

  // Extract GPS timestamp from RTIRL payload
  const extractGpsTimestamp = useCallback((payload: RTIRLPayload): number => {
    const payloadWithTimestamp = payload as RTIRLPayload & {
      timestamp?: number;
      time?: number;
      reportedAt?: number;
      updatedAt?: number;
    };

    const payloadTimestamp = payloadWithTimestamp.reportedAt ||
      payloadWithTimestamp.updatedAt ||
      payloadWithTimestamp.timestamp ||
      payloadWithTimestamp.time;

    return payloadTimestamp && typeof payloadTimestamp === 'number'
      ? payloadTimestamp
      : Date.now();
  }, []);

  // Calculate speed from RTIRL payload and coordinates
  const calculateSpeed = useCallback((
    payload: RTIRLPayload,
    lat: number,
    lon: number,
    prevCoords: [number, number] | null,
    prevGpsTimestamp: number,
    gpsUpdateTime: number,
    wasGpsDataStale: boolean
  ): number => {
    if (wasGpsDataStale) return 0;

    // Try RTIRL speed first (preferred source)
    // RTIRL provides speed in m/s (meters per second), convert to km/h
    if (typeof payload === 'object' && payload !== null && 'speed' in payload) {
      const rawSpeedValue = (payload as RTIRLPayload).speed;
      if (typeof rawSpeedValue === 'number' && rawSpeedValue >= 0) {
        // Convert m/s to km/h: multiply by 3.6
        // Example: 25.5 m/s × 3.6 = 91.8 km/h (≈ 57 mph)
        return rawSpeedValue * 3.6;
      }
    }

    // Calculate from coordinates as fallback
    if (!prevCoords || prevGpsTimestamp <= 0) return 0;

    const movedMeters = distanceInMeters(lat, lon, prevCoords[0], prevCoords[1]);
    const timeDiffSeconds = (gpsUpdateTime - prevGpsTimestamp) / 1000;
    const timeDiffHours = timeDiffSeconds / 3600;
    const MIN_TIME_SECONDS = 0.5;

    if (timeDiffHours > 0 && timeDiffSeconds >= MIN_TIME_SECONDS && movedMeters > 0) {
      return (movedMeters / 1000) / timeDiffHours;
    } else if (movedMeters === 0 && timeDiffSeconds > 0) {
      return 0;
    }

    return 0;
  }, []);

  // Time and date updates - simplified single useEffect
  // Updates immediately when timezone changes, then every minute
  useEffect(() => {
    if (!isValidTimezone(timezone)) {
      setTimeDisplay({ time: '', date: '' });
      return;
    }

    let isActive = true;

    // Update function - formats time using current timezone
    const updateTime = () => {
      if (!isActive) return;
      const formatted = formatTime(timezone);
      if (isActive) {
        setTimeDisplay(formatted);
      }
    };

    // Immediate update when timezone changes
    updateTime();

    // Calculate delay until next minute boundary for clean updates
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    // Schedule first update at minute boundary, then every minute
    const timeoutId = setTimeout(() => {
      if (!isActive) return;
      updateTime();
      // Start interval for regular updates
      timeUpdateTimer.current = setInterval(updateTime, 60000);
    }, Math.max(0, msUntilNextMinute));

    return () => {
      isActive = false;
      clearTimeout(timeoutId);
      if (timeUpdateTimer.current) {
        clearInterval(timeUpdateTimer.current);
        timeUpdateTimer.current = null;
      }
    };
  }, [timezone, formatTime]);


  // Filter todos based on completion timestamps (hide if completed > 60 seconds ago)
  const visibleTodos = useMemo(() => {
    if (!settings.todos || settings.todos.length === 0) {
      return [];
    }

    const now = Date.now();
    const ONE_MINUTE = 60 * 1000; // 60 seconds in milliseconds

    return settings.todos.filter((todo) => {
      if (!todo.completed) {
        // Always show incomplete todos
        return true;
      }

      // For completed todos, check if they were completed less than 60 seconds ago
      const completionTime = completedTodoTimestamps.get(todo.id);
      if (!completionTime) {
        // No completion timestamp in state - check localStorage for persistence
        try {
          const stored = localStorage.getItem(STORAGE_KEY);
          if (stored) {
            const storedTimestamps = JSON.parse(stored) as Record<string, number>;
            const storedTimestamp = storedTimestamps[todo.id];

            if (storedTimestamp) {
              // Found in localStorage - check if it's still within 60 seconds
              const timeSinceCompletion = now - storedTimestamp;
              const shouldShow = timeSinceCompletion < ONE_MINUTE;
              if (!shouldShow) {
                OverlayLogger.overlay(`Hiding completed todo ${todo.id} - completed ${Math.round(timeSinceCompletion / 1000)}s ago`);
              }
              return shouldShow;
            }
          }
        } catch (error) {
          // If localStorage check fails, show the todo (graceful degradation)
          OverlayLogger.warn('Failed to check localStorage for todo visibility', { error });
          return true;
        }

        // No timestamp found in localStorage - this means it was completed more than 60 seconds ago
        // and was cleaned up, OR it was never tracked. Hide it to be safe.
        OverlayLogger.overlay(`Hiding completed todo ${todo.id} - no timestamp found`);
        return false;
      }

      const timeSinceCompletion = now - completionTime;
      const shouldShow = timeSinceCompletion < ONE_MINUTE;
      if (!shouldShow) {
        OverlayLogger.overlay(`Hiding completed todo ${todo.id} - completed ${Math.round(timeSinceCompletion / 1000)}s ago`);
      }
      return shouldShow;
    });
  }, [settings.todos, completedTodoTimestamps]);

  // Donation goals memoized JSX
  const donationGoalsJSX = useMemo(() => {
    if (!settings.showDonationGoals || !settings.donationGoals || settings.donationGoals.length === 0) {
      return null;
    }

    return (
      <div
        className={`overlay-box donation-goals-box ${!settings.showBackground ? 'no-background' : ''}`}
        style={{
          marginTop: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          minWidth: '220px',
          maxWidth: '320px',
          alignSelf: settings.todoListPosition === 'right' ? 'flex-end' : 'flex-start',
          transform: `translate(${settings.donationGoalsX || 0}px, ${settings.donationGoalsY || 0}px) scale(${settings.donationGoalsScale || 1})`,
          transformOrigin: settings.todoListPosition === 'right' ? 'top right' : 'top left',
          pointerEvents: 'none',
          padding: '12px 16px',
        }}
      >
        {(settings.donationGoals ?? []).map((g) => {
          const pct = g.goal > 0 ? Math.min(100, (g.current / g.goal) * 100) : 0;
          const done = pct >= 100;
          
          // Expiry and visibility check
          const duration = g.duration || 0;
          const expiry = goalExpiryTimestamps[g.id] || 0;
          const isVisible = duration > 0 ? expiry > timeTick : true;
          
          return (
            <div
              key={g.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                width: '100%',
                opacity: isVisible ? 1 : 0,
                maxHeight: isVisible ? '100px' : '0px',
                margin: isVisible ? '0 0' : '-4px 0',
                overflow: 'hidden',
                transition: 'opacity 0.5s ease-in-out, max-height 0.5s ease-in-out, margin 0.5s ease-in-out'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%' }}>
                <span style={{ color: '#fff', fontWeight: 800, fontSize: '0.9em', textShadow: 'var(--text-shadow)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                  DONO GOAL: {g.name}
                </span>
                <span style={{ color: done ? '#fbbf24' : 'rgba(255,255,255,0.75)', fontWeight: 800, fontSize: '0.85em', textShadow: 'var(--text-shadow)' }}>
                  ${Number(g.current).toLocaleString(undefined, { minimumFractionDigits: Number(g.current) % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 })} / ${Number(g.goal).toLocaleString(undefined, { minimumFractionDigits: Number(g.goal) % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.15)', overflow: 'hidden', width: '100%' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${pct}%`,
                    background: done
                      ? 'linear-gradient(90deg, #fbbf24, #f59e0b)'
                      : 'linear-gradient(90deg, #f59e0b, #ef4444)',
                    borderRadius: 4,
                    transition: 'width 0.6s cubic-bezier(0.34,1.56,0.64,1)',
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }, [settings.showDonationGoals, settings.donationGoals, settings.todoListPosition, settings.donationGoalsX, settings.donationGoalsY, settings.donationGoalsScale, settings.showBackground, goalExpiryTimestamps, timeTick]);


  // Load completed todo timestamps from localStorage on mount and set up timers
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      // Only log if there are timestamps to load (reduces noise)
      if (stored) {
        const timestamps = JSON.parse(stored) as Record<string, number>;
        const now = Date.now();
        const ONE_MINUTE = 60 * 1000;

        // Filter out timestamps older than 60 seconds (cleanup old data)
        const validTimestamps = new Map<string, number>();
        Object.entries(timestamps).forEach(([id, timestamp]) => {
          const timeSinceCompletion = now - timestamp;
          if (timeSinceCompletion < ONE_MINUTE) {
            validTimestamps.set(id, timestamp);

            // Set up timer to hide this todo when it reaches 60 seconds
            const remainingTime = ONE_MINUTE - timeSinceCompletion;
            const timer = setTimeout(() => {
              setCompletedTodoTimestamps((current) => {
                const updated = new Map(current);
                updated.delete(id);
                return updated;
              });
              completedTodoTimersRef.current.delete(id);
            }, remainingTime);

            completedTodoTimersRef.current.set(id, timer);
          }
        });

        setCompletedTodoTimestamps(validTimestamps);
        // Only log if we actually loaded timestamps (reduces noise on fresh loads)
        if (validTimestamps.size > 0) {
          OverlayLogger.overlay(`Loaded ${validTimestamps.size} completed todo timestamps from localStorage`);
        }
      }
    } catch (error) {
      // Ignore localStorage errors (e.g., in private browsing mode)
      OverlayLogger.warn('Failed to load completed todo timestamps from localStorage', { error });
    }

    // Load total distance from localStorage
    try {
      const storedDistance = localStorage.getItem(DISTANCE_STORAGE_KEY);
      if (storedDistance) {
        const parsedDistance = parseFloat(storedDistance);
        if (!isNaN(parsedDistance)) {
          setTotalDistanceTracked(parsedDistance);
          OverlayLogger.overlay(`Loaded total distance from localStorage: ${Math.round(parsedDistance)}m`);
        }
      }
    } catch (error) {
      OverlayLogger.warn('Failed to load distance from localStorage', { error });
    }
  }, []); // Run once on mount

  // Persist distance to localStorage
  useEffect(() => {
    try {
      if (totalDistanceTracked > 0) {
        localStorage.setItem(DISTANCE_STORAGE_KEY, totalDistanceTracked.toString());
      }
    } catch (error) {
      OverlayLogger.warn('Failed to save distance to localStorage', { error });
    }
  }, [totalDistanceTracked]);


  // StreamElements Realtime Donation Integration
  // Only reconnects when the token or enabled flag changes — twitchRevenueSplit is read
  // via seSettingsRef so we never need to tear down and rebuild the socket for that alone.
  useEffect(() => {
    // Disconnect any existing socket when disabled or token cleared
    if (!settings.streamElementsEnabled || !settings.streamElementsToken) {
      if (seSocketRef.current) {
        seSocketRef.current.disconnect();
        seSocketRef.current = null;
      }
      return;
    }

    // If a socket already exists (same token), don't create another one
    if (seSocketRef.current) return;

    const token = settings.streamElementsToken;

    import('socket.io-client').then(({ io }) => {
      // Double-check: another render might have beaten us to it
      if (seSocketRef.current) return;

      OverlayLogger.overlay('Connecting to StreamElements realtime server...');
      const socket = io('https://realtime.streamelements.com', {
        transports: ['websocket']
      });
      seSocketRef.current = socket;

      socket.on('connect', () => {
        OverlayLogger.overlay('Connected to StreamElements realtime server');
        socket.emit('authenticate', { method: 'jwt', token });
      });

      socket.on('authenticated', () => {
        OverlayLogger.overlay('Successfully authenticated with StreamElements');
      });

      socket.on('unauthorized', (err: any) => {
        OverlayLogger.error('StreamElements authentication failed:', err);
      });

      const showDonoToast = (username: string, amountStr: string, label: string, icon: string) => {
        if (donationToastTimerRef.current) clearTimeout(donationToastTimerRef.current);
        setDonationToast({ username, amount: amountStr, label, icon, phase: 'entering' });
        donationToastTimerRef.current = setTimeout(() => {
          setDonationToast(prev => prev ? { ...prev, phase: 'exiting' } : null);
          donationToastTimerRef.current = setTimeout(() => setDonationToast(null), 400);
        }, 4000);
      };

      // Global dedup set — one set shared across event + event:test listeners
      // Prevents double-counting when SE fires both for the same replay
      const recentEventIds = new Set<string>();

      const handleSEEvent = (rawEvent: any) => {
        if (!rawEvent) return;
        
        // Normalize: production events place details in rawEvent.data, test/replays place them in rawEvent.event
        const data = rawEvent.data || rawEvent.event;
        if (!data) return;

        const eventType = (rawEvent.type || '').toLowerCase() || (rawEvent.listener || '').toLowerCase();
        const username = data.username || data.name || 'Anonymous';
        const dedupKey = rawEvent._id || data._id || `${eventType}-${data.amount}-${username}`;
        
        if (recentEventIds.has(dedupKey)) {
          OverlayLogger.overlay(`SE duplicate ignored: ${dedupKey}`);
          return;
        }
        recentEventIds.add(dedupKey);
        setTimeout(() => recentEventIds.delete(dedupKey), 3000);

        let amount: number | null = null;
        // Read latest settings from ref — no stale closure risk
        const currentSettings = seSettingsRef.current;

        // ── Tip / Donation ─────────────────────────────────────────────
        if (eventType === 'tip' || eventType === 'donation' || eventType.includes('tip')) {
          if (typeof data.amount === 'number') {
            amount = data.amount;
          } else if (typeof data.amount === 'string') {
            const parsed = parseFloat(data.amount);
            if (!isNaN(parsed)) amount = parsed;
          }
          if (amount !== null) {
            OverlayLogger.overlay(`SE Tip: $${amount} from ${username}`);
            showDonoToast(username, `$${amount.toFixed(2)}`, 'DONATED', '💸');
          }
        }

        // ── Cheer / Bits ─────────────────────────────────────────────────
        // Streamers receive $0.01/bit — Twitch takes cut at viewer purchase
        else if (eventType === 'cheer' || eventType.includes('cheer')) {
          let bits: number | null = null;
          if (typeof data.amount === 'number') {
            bits = data.amount;
          } else if (typeof data.amount === 'string') {
            const parsed = parseInt(data.amount);
            if (!isNaN(parsed)) bits = parsed;
          }
          if (bits !== null) {
            amount = parseFloat((bits * 0.01).toFixed(2));
            OverlayLogger.overlay(`SE Cheer: ${bits} bits = $${amount} from ${username}`);
            showDonoToast(username, `${bits} BITS`, 'CHEERED', '⚡');
          }
        }

        // ── Subscriber ───────────────────────────────────────────────────
        // Twitch keeps 50% by default — configurable via twitchRevenueSplit
        else if (eventType === 'subscriber' || eventType.includes('sub')) {
          const tierPrices: Record<string, number> = {
            '1000': 4.99, 'prime': 4.99,
            '2000': 9.99,
            '3000': 24.99,
          };
          const tier = String(data.tier ?? '1000');
          const tierPrice = tierPrices[tier] ?? 4.99;
          const splitPercent = (currentSettings.twitchRevenueSplit ?? 50) / 100;
          amount = parseFloat((tierPrice * splitPercent).toFixed(2));
          const tierLabel = tier === 'prime' ? 'Prime' : `Tier ${parseInt(tier) / 1000}`;
          OverlayLogger.overlay(`SE Sub: ${tierLabel} = $${amount} (${currentSettings.twitchRevenueSplit ?? 50}% of $${tierPrice}) from ${username}`);
          showDonoToast(username, tierLabel, 'SUBSCRIBED', '⭐');
        }

        if (amount !== null && amount > 0) {
          // Trigger showing all active donation goals for their respective auto-hide durations
          const currentGoals = currentSettings.donationGoals ?? [];
          const now = Date.now();
          const newExpiries: Record<string, number> = {};
          currentGoals.forEach(g => {
            const duration = g.duration || 0;
            if (duration > 0) {
              newExpiries[g.id] = now + duration * 60 * 1000;
            }
          });
          setGoalExpiryTimestamps(prev => ({ ...prev, ...newExpiries }));

          // Always use fresh token from ref — closure token may be stale if settings were re-saved
          const freshToken = seSettingsRef.current.streamElementsToken || token;
          fetch('/api/record-donation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, token: freshToken, eventId: dedupKey })
          }).then(async res => {
            if (!res.ok) {
              const body = await res.text().catch(() => '(no body)');
              OverlayLogger.error(`record-donation failed HTTP ${res.status}:`, body);
            } else {
              OverlayLogger.overlay(`record-donation OK: $${amount} applied to goals`);
            }
          }).catch(err => {
            OverlayLogger.error('Failed to reach record-donation API:', err);
          });
        }
      };

      socket.on('event', handleSEEvent);
      socket.on('event:test', handleSEEvent);

      socket.on('disconnect', () => {
        OverlayLogger.overlay('Disconnected from StreamElements');
        seSocketRef.current = null; // Allow reconnect on next effect run
      });
    }).catch(err => {
      OverlayLogger.error('Failed to load socket.io-client:', err);
    });

    // Cleanup only on unmount or when token/enabled actually changes
    return () => {
      if (seSocketRef.current) {
        seSocketRef.current.disconnect();
        seSocketRef.current = null;
      }
    };
  }, [settings.streamElementsEnabled, settings.streamElementsToken]);
  // Note: twitchRevenueSplit intentionally excluded — read via seSettingsRef to avoid socket rebuild


  // Persist completed todo timestamps to localStorage whenever they change
  // Also clean up old timestamps (> 60 seconds) periodically
  useEffect(() => {
    try {
      const now = Date.now();
      const ONE_MINUTE = 60 * 1000;

      // Load existing timestamps to preserve ones not in current state
      const existing = localStorage.getItem(STORAGE_KEY);
      const allTimestamps: Record<string, number> = existing
        ? JSON.parse(existing) as Record<string, number>
        : {};

      // Update with current state timestamps
      completedTodoTimestamps.forEach((timestamp, id) => {
        allTimestamps[id] = timestamp;
      });

      // Clean up timestamps older than 60 seconds
      const cleaned: Record<string, number> = {};
      Object.entries(allTimestamps).forEach(([id, timestamp]) => {
        const timeSinceCompletion = now - timestamp;
        if (timeSinceCompletion < ONE_MINUTE) {
          cleaned[id] = timestamp;
        }
      });

      localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    } catch (error) {
      // Ignore localStorage errors (e.g., quota exceeded)
      OverlayLogger.warn('Failed to save completed todo timestamps to localStorage', { error });
    }
  }, [completedTodoTimestamps]);

  // Track when todos are marked complete and set timer to hide them after 60 seconds
  useEffect(() => {
    if (!settings.todos || settings.todos.length === 0) {
      // Clear timestamps and timers if todos are cleared
      setCompletedTodoTimestamps(new Map());
      completedTodoTimersRef.current.forEach((timer) => clearTimeout(timer));
      completedTodoTimersRef.current.clear();
      return;
    }

    const now = Date.now();
    const ONE_MINUTE = 60 * 1000; // 60 seconds in milliseconds

    // Use functional update to avoid dependency on completedTodoTimestamps
    setCompletedTodoTimestamps((prevTimestamps) => {
      const newTimestamps = new Map(prevTimestamps);

      if (!settings.todos) return newTimestamps;

      // Track newly completed todos
      settings.todos.forEach((todo) => {
        if (todo.completed) {
          // Check if this todo was just completed (not in timestamps yet)
          if (!prevTimestamps.has(todo.id)) {
            // Check localStorage to see if this was completed before (persistence check)
            try {
              const stored = localStorage.getItem(STORAGE_KEY);
              if (stored) {
                const storedTimestamps = JSON.parse(stored) as Record<string, number>;
                const storedTimestamp = storedTimestamps[todo.id];

                if (storedTimestamp) {
                  // Found in localStorage - check if it's still within 60 seconds
                  const timeSinceCompletion = now - storedTimestamp;
                  if (timeSinceCompletion < ONE_MINUTE) {
                    // Still within 60 seconds - use the stored timestamp
                    newTimestamps.set(todo.id, storedTimestamp);

                    // Set up timer for remaining time
                    const remainingTime = ONE_MINUTE - timeSinceCompletion;
                    const timer = setTimeout(() => {
                      setCompletedTodoTimestamps((current) => {
                        const updated = new Map(current);
                        updated.delete(todo.id);
                        return updated;
                      });
                      completedTodoTimersRef.current.delete(todo.id);
                    }, remainingTime);

                    completedTodoTimersRef.current.set(todo.id, timer);
                    return; // Skip adding new timestamp
                  }
                  // If stored timestamp is > 60 seconds old, don't add it (todo will be hidden)
                  // Todo was completed more than 60 seconds ago - don't add timestamp (no logging for routine operation)
                  return; // Don't add timestamp, todo will be filtered out
                }
              }
            } catch (error) {
              // If localStorage check fails, proceed with new timestamp
              OverlayLogger.warn('Failed to check localStorage for todo timestamp', { error });
            }

            // No stored timestamp or it's expired - record new timestamp
            newTimestamps.set(todo.id, now);

            // Set timer to hide this specific todo after 60 seconds
            const timer = setTimeout(() => {
              setCompletedTodoTimestamps((current) => {
                const updated = new Map(current);
                updated.delete(todo.id);
                return updated;
              });
              completedTodoTimersRef.current.delete(todo.id);
            }, ONE_MINUTE);

            completedTodoTimersRef.current.set(todo.id, timer);
          }
        } else {
          // Todo is incomplete - remove from timestamps if it was there
          if (prevTimestamps.has(todo.id)) {
            // Clear timer if it exists
            const timer = completedTodoTimersRef.current.get(todo.id);
            if (timer) {
              clearTimeout(timer);
              completedTodoTimersRef.current.delete(todo.id);
            }
            newTimestamps.delete(todo.id);
          }
        }
      });

      // Remove timestamps for todos that no longer exist
      prevTimestamps.forEach((timestamp, todoId) => {
        const todoExists = settings.todos?.some((t) => t.id === todoId);
        if (!todoExists) {
          const timer = completedTodoTimersRef.current.get(todoId);
          if (timer) {
            clearTimeout(timer);
            completedTodoTimersRef.current.delete(todoId);
          }
          newTimestamps.delete(todoId);
        }
      });

      return newTimestamps;
    });
  }, [settings.todos]); // Removed completedTodoTimestamps from dependencies to avoid infinite loop

  // Load settings and set up real-time updates
  useEffect(() => {
    // Helper function to create a stable hash from settings (sorts keys for consistency)
    const createSettingsHash = (settings: OverlaySettings): string => {
      const sorted = Object.keys(settings).sort().reduce((acc, key) => {
        acc[key] = settings[key as keyof OverlaySettings];
        return acc;
      }, {} as Record<string, unknown>);
      return JSON.stringify(sorted);
    };

    const loadSettings = async () => {
      try {
        // Add cache busting and force fresh data
        const timestamp = Date.now();
        const res = await fetch(`/api/get-settings?_t=${timestamp}`, {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
          }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (data) {
          // Merge with defaults to ensure new fields (altitudeDisplay, speedDisplay, weatherConditionDisplay) are initialized
          const mergedSettings = {
            ...DEFAULT_OVERLAY_SETTINGS,
            ...data,
            weatherConditionDisplay: data.weatherConditionDisplay || DEFAULT_OVERLAY_SETTINGS.weatherConditionDisplay,
            altitudeDisplay: data.altitudeDisplay || DEFAULT_OVERLAY_SETTINGS.altitudeDisplay,
            speedDisplay: data.speedDisplay || DEFAULT_OVERLAY_SETTINGS.speedDisplay,
          };
          setSettings(mergedSettings);
          // Set initial hash to prevent false positives on first poll
          lastSettingsHash.current = createSettingsHash(mergedSettings);
          settingsLoadedRef.current = true; // Mark settings as loaded
        }
        // If no data but request succeeded, keep existing settings (don't reset to defaults)
      } catch (error) {
        // Failed to load settings - keep existing settings instead of resetting
        // This ensures elements stay visible even when API fails
        OverlayLogger.warn('Settings load failed, keeping existing settings', { error });
        // Don't reset to defaults - keep what we have
      }
    };

    // Set up Server-Sent Events for real-time updates
    const setupSSE = () => {
      const eventSource = new EventSource('/api/settings-stream');

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'settings_update') {
            // Extract only settings properties, exclude SSE metadata (type, timestamp)
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { type: _type, timestamp: _timestamp, ...settingsData } = data;
            // Merge with defaults to ensure new fields (altitudeDisplay, speedDisplay, weatherConditionDisplay) are initialized
            const mergedSettings = {
              ...DEFAULT_OVERLAY_SETTINGS,
              ...settingsData,
              weatherConditionDisplay: settingsData.weatherConditionDisplay || DEFAULT_OVERLAY_SETTINGS.weatherConditionDisplay,
              altitudeDisplay: settingsData.altitudeDisplay || DEFAULT_OVERLAY_SETTINGS.altitudeDisplay,
              speedDisplay: settingsData.speedDisplay || DEFAULT_OVERLAY_SETTINGS.speedDisplay,
            } as OverlaySettings;
            OverlayLogger.settings('Settings updated via SSE', {
              locationDisplay: mergedSettings.locationDisplay,
              showWeather: mergedSettings.showWeather,
              showMinimap: mergedSettings.showMinimap
            });
            setSettings(mergedSettings);
            // Update hash to prevent polling from detecting this as a new change
            lastSettingsHash.current = createSettingsHash(mergedSettings);
            settingsLoadedRef.current = true; // Mark settings as loaded
          }
        } catch {
          // Ignore malformed SSE messages
        }
      };

      eventSource.onerror = () => {
        // Don't log SSE errors as they're common during development and not critical
        // Close the current connection before reconnecting
        try {
          eventSource.close();
        } catch {
          // Ignore close errors
        }
        // Reconnect after 1 second delay
        const reconnectDelay = 1000;
        setTimeout(() => {
          try {
            setupSSE();
          } catch {
            // Ignore reconnection errors
          }
        }, reconnectDelay);
      };

      return eventSource;
    };

    // Load initial settings
    loadSettings();

    // Set up real-time updates
    const eventSource = setupSSE();

    // Fallback polling mechanism - check for settings changes every 2 seconds for faster updates
    const pollingInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/get-settings?_t=${Date.now()}`, {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
          }
        });
        if (res.ok) {
          const data = await res.json();
          if (data) {
            // Merge with defaults to ensure all fields are present (including new ones)
            const mergedData = {
              ...DEFAULT_OVERLAY_SETTINGS,
              ...data,
              weatherConditionDisplay: data.weatherConditionDisplay || DEFAULT_OVERLAY_SETTINGS.weatherConditionDisplay,
              altitudeDisplay: data.altitudeDisplay || DEFAULT_OVERLAY_SETTINGS.altitudeDisplay,
              speedDisplay: data.speedDisplay || DEFAULT_OVERLAY_SETTINGS.speedDisplay,
            } as OverlaySettings;
            const newHash = createSettingsHash(mergedData);
            if (newHash !== lastSettingsHash.current) {
              lastSettingsHash.current = newHash;
              OverlayLogger.settings('Settings updated via polling', {
                locationDisplay: mergedData.locationDisplay,
                showWeather: mergedData.showWeather,
                showMinimap: mergedData.showMinimap,
                donationGoalsCurrent: mergedData.donationGoals?.map(g => g.current)
              });
              setSettings(mergedData);
            }
          }
        }
      } catch (error) {
        // Log polling errors for debugging
        OverlayLogger.warn('Settings polling failed', { error });
      }
    }, SETTINGS_POLLING_INTERVAL);

    // Cleanup on unmount
    return () => {
      if (eventSource) {
        eventSource.close();
      }
      clearInterval(pollingInterval);
    };
  }, []); // Empty dependency array - we want this to run once on mount

  // RTIRL connection - use refs to avoid re-running on timezone/settings changes
  const timezoneRef = useRef(timezone);
  const updateMinimapVisibilityRef = useRef(updateMinimapVisibility);
  const settingsRef = useRef(settings);
  const updateTimezoneRef = useRef(updateTimezone);

  // Update refs when values change (needed for RTIRL listener closure)
  useEffect(() => {
    timezoneRef.current = timezone;
    updateMinimapVisibilityRef.current = updateMinimapVisibility;
    settingsRef.current = settings;
    updateTimezoneRef.current = updateTimezone;
  }, [timezone, updateMinimapVisibility, settings, updateTimezone]);




  // RTIRL connection - use ref to track if listener is already set up
  const rtirlListenerSetupRef = useRef(false);

  useEffect(() => {
    // Prevent multiple listener setups if component remounts
    if (rtirlListenerSetupRef.current) {
      return;
    }

    const setupRTIRLListener = () => {
      if (typeof window !== 'undefined' && window.RealtimeIRL && API_KEYS.RTIRL) {
        // Mark as set up to prevent duplicates
        rtirlListenerSetupRef.current = true;

        try {
          window.RealtimeIRL.forPullKey(API_KEYS.RTIRL).addListener((p: unknown) => {
            try {
              if (!p || typeof p !== 'object') {
                return;
              }
              const payload = p as RTIRLPayload;

              // Extract GPS coordinates first (needed for logging and processing)
              const coords = extractCoordinates(payload);
              if (!coords) return;

              const [lat, lon] = coords;
              setMapCoords([lat, lon]);

              // Get GPS update timestamp from payload
              const payloadTimestamp = extractGpsTimestamp(payload);
              const now = Date.now();
              const timeSincePayload = now - payloadTimestamp;
              const isPayloadFresh = timeSincePayload <= GPS_FRESHNESS_TIMEOUT;

              // Log RTIRL payload for debugging (essential info only)
              OverlayLogger.overlay('RTIRL update received', {
                coordinates: { lat, lon },
                speed: payload.speed || 0,
                altitude: payload.altitude !== undefined ? payload.altitude : 'not provided',
                timestamp: payloadTimestamp,
                timestampAge: Math.round(timeSincePayload / 1000),
                timestampAgeMinutes: Math.round(timeSincePayload / 60000),
                isFresh: isPayloadFresh,
                reportedAt: (payload as { reportedAt?: number }).reportedAt,
                updatedAt: (payload as { updatedAt?: number }).updatedAt
              });

              // Handle timezone from RTIRL (lowest priority - will be overridden by LocationIQ/OpenWeatherMap)
              // Always update timezone from RTIRL when available, even when GPS is stale
              // This ensures time/date display works even when location/weather are hidden
              if (payload.location?.timezone) {
                // Update timezone even if we already have one - RTIRL provides current location timezone
                // This is important when GPS is stale but we still need accurate time display
                updateTimezoneRef.current(payload.location.timezone);
              }

              // Check if GPS data was stale BEFORE this update (for speed calculation)
              // Use GPS timestamp, not reception time, to handle network delays and RTIRL throttling
              const timeSinceLastGps = lastGpsUpdateTime.current > 0 ? (now - lastGpsUpdateTime.current) : Infinity;
              const wasGpsDataStale = timeSinceLastGps > GPS_STALE_TIMEOUT;

              // Update GPS timestamps AFTER checking for staleness
              const isFirstGpsUpdate = lastGpsUpdateTime.current === 0;
              lastGpsUpdateTime.current = now; // Track last GPS reception time for staleness detection
              lastGpsTimestamp.current = payloadTimestamp; // Track actual GPS timestamp from payload

              // Always use payload timestamp for freshness checks - GPS data age is what matters
              // Even if RTIRL is actively streaming, if the GPS reading itself is >15 minutes old, it's stale
              const isReceivingUpdates = !wasGpsDataStale || isFirstGpsUpdate; // Track if RTIRL is actively sending updates

              // Check if GPS update is fresh (for logging purposes only - no longer controls visibility)
              const isFresh = isGpsUpdateFresh(payloadTimestamp, now);

              // Get previous coordinates and GPS timestamp for speed calculation
              const prevCoords = lastCoords.current;
              const prevGpsTimestamp = lastGpsTimestamp.current;

              // Calculate speed from RTIRL payload and coordinates
              // Use payload timestamp for speed calculation (when GPS reading was taken)
              const speedKmh = calculateSpeed(
                payload,
                lat,
                lon,
                prevCoords,
                prevGpsTimestamp,
                payloadTimestamp, // Use payload timestamp for speed calculation
                wasGpsDataStale
              );
              const roundedSpeed = Math.round(speedKmh);

              setCurrentSpeed(roundedSpeed);
              lastSpeedGpsTimestamp.current = payloadTimestamp; // Track GPS timestamp, not reception time
              setSpeedUpdateTimestamp(now); // Trigger re-render

              // Extract altitude from RTIRL payload
              // RTIRL provides altitude as either a number or an object with EGM96/WGS84
              let altitudeValue: number | null = null;
              if (payload.altitude !== undefined) {
                if (typeof payload.altitude === 'number' && payload.altitude >= 0) {
                  altitudeValue = payload.altitude;
                } else if (typeof payload.altitude === 'object' && payload.altitude !== null) {
                  // Prefer EGM96 (more accurate for elevation above sea level), fallback to WGS84
                  const altitudeObj = payload.altitude as { EGM96?: number; WGS84?: number };
                  if (altitudeObj.EGM96 !== undefined && typeof altitudeObj.EGM96 === 'number' && altitudeObj.EGM96 >= 0) {
                    altitudeValue = altitudeObj.EGM96;
                  } else if (altitudeObj.WGS84 !== undefined && typeof altitudeObj.WGS84 === 'number' && altitudeObj.WGS84 >= 0) {
                    altitudeValue = altitudeObj.WGS84;
                  }
                }
              }

              if (altitudeValue !== null) {
                const roundedAltitude = Math.round(altitudeValue);
                setCurrentAltitude(roundedAltitude);
                lastAltitudeGpsTimestamp.current = payloadTimestamp; // Track GPS timestamp, not reception time
                setAltitudeUpdateTimestamp(now); // Trigger re-render
              }

              // Track speed readings for minimap visibility (need 3 consecutive readings > 5 km/h)
              if (settingsRef.current.minimapSpeedBased) {
                speedReadingsRef.current.push(roundedSpeed);
                // Keep only last 3 readings
                if (speedReadingsRef.current.length > 3) {
                  speedReadingsRef.current.shift(); // Remove oldest reading
                }
                // Reset low speed timer when we get a new GPS update (GPS is fresh)
                if (roundedSpeed > WALKING_PACE_THRESHOLD) {
                  lowSpeedStartTimeRef.current = null;
                }
              }

              // Store coordinates and timestamps for next speed calculation
              lastCoords.current = [lat, lon];
              // Update total distance if moving
              if (prevCoords && roundedSpeed > 1) { // Only track if moving > 1 km/h to avoid GPS noise
                const moved = distanceInMeters(lat, lon, prevCoords[0], prevCoords[1]);
                // Sanity check: don't add more than 500m in a single update (likely GPS jump)
                if (moved > 0 && moved < 500) {
                  setTotalDistanceTracked(prev => prev + moved);
                }
              }
              lastCoordsTime.current = now; // Reception time (for staleness detection)
              // Note: lastGpsTimestamp.current is already updated above

              // Trigger minimap visibility update after GPS data is processed
              // This will check for movement and update minimap visibility accordingly
              try {
                updateMinimapVisibilityRef.current();
              } catch (error) {
                OverlayLogger.error('Failed to update minimap visibility', error);
                // Don't throw - allow overlay to continue functioning
              }

              // Only fetch location/weather if GPS is fresh - don't fetch when stale
              // Timezone will still be updated from RTIRL even when GPS is stale
              // But we still need to allow timezone updates from RTIRL, so don't return early
              // Instead, check isFresh before fetching location/weather below

              // Kick off location + weather fetches on coordinate updates with gating
              (async () => {
                const movedMeters = prevCoords ? distanceInMeters(lat, lon, prevCoords[0], prevCoords[1]) : Infinity;

                // Adaptive location update threshold based on speed
                // Use the newly calculated speed (roundedSpeed) instead of currentSpeed state
                // This avoids race condition where currentSpeed hasn't updated yet
                const speedForThreshold = roundedSpeed;
                const adaptiveLocationThreshold = speedForThreshold > 200
                  ? 1000  // 1km threshold for flights (>200 km/h)
                  : speedForThreshold > 50
                    ? 100  // 100m threshold for driving (50-200 km/h)
                    : 10; // 10m threshold for walking (<50 km/h)

                // Determine what needs to be fetched
                const weatherElapsed = now - lastWeatherTime.current;
                const locationElapsed = now - lastLocationTime.current;
                const meetsDistance = movedMeters >= adaptiveLocationThreshold;

                // Weather updates every 5 minutes regardless of movement
                // Also fetch if we don't have weather data yet or weather is getting stale
                const hasWeatherData = lastSuccessfulWeatherFetch.current > 0;
                const weatherDataAge = hasWeatherData
                  ? now - lastSuccessfulWeatherFetch.current
                  : Infinity;
                const shouldFetchWeather = lastWeatherTime.current === 0 ||
                  weatherElapsed >= TIMERS.WEATHER_UPDATE_INTERVAL ||
                  !hasWeatherData || // Fetch if no weather data
                  weatherDataAge >= WEATHER_DATA_VALIDITY_TIMEOUT; // Fetch if weather is stale

                // Location updates: respect API limits (1/sec + 5,000/day)
                // 
                // Rate limiting strategy uses TWO layers of protection:
                // 1. Time gate: Minimum 18 seconds between calls (ensures ~4,800 calls/day max, safely under 5,000/day limit)
                //    - Calculation: 5,000/day = ~208/hour = ~3.5/min = 1 call every ~17.3 seconds
                //    - Using 18 seconds provides safety margin
                // 2. Rate limiter: checkRateLimit('locationiq') enforces 1 call/second + daily counter
                //    - Prevents burst traffic if multiple GPS updates arrive quickly
                //    - Tracks daily usage and blocks if daily limit (4,500/day) is reached
                //
                // Why both? The time gate prevents excessive calls during normal operation, while the rate limiter
                // handles edge cases (rapid GPS updates, app restarts, etc.) and provides daily limit protection.
                // Also requires distance threshold to avoid unnecessary calls when stationary.
                // We need country name/flag even in custom location mode
                const LOCATION_MIN_INTERVAL = 18000; // 18 seconds minimum (safely under 5,000/day limit)
                const shouldFetchLocation = lastLocationTime.current === 0 ||
                  (locationElapsed >= LOCATION_MIN_INTERVAL && meetsDistance);

                // If settings just updated (hash changed), allow UI update but do not force API refetch here
                // API fetching remains purely based on the time/distance gates above

                // Fetch weather and location in parallel for faster loading
                // Only fetch if GPS is fresh - don't fetch location/weather when GPS is stale
                // Timezone will still be updated from RTIRL even when GPS is stale
                const promises: Promise<void>[] = [];

                // Fetch weather when needed (no GPS staleness check - always fetch when conditions are met)
                // Weather updates periodically (every 5 min) or when data is stale
                // Check rate limits: 50 per minute (well under 60/min free tier limit)
                const needsTimezone = !isValidTimezone(timezoneRef.current);
                const shouldFetchWeatherNow = shouldFetchWeather && API_KEYS.OPENWEATHER &&
                  !weatherFetchInProgress.current && // Prevent concurrent weather fetches
                  checkRateLimit('openweathermap') && // Check rate limits before fetching
                  (shouldFetchWeather || needsTimezone); // Fetch if conditions met OR if we need timezone

                // Log weather fetch decision for debugging (only when actually fetching)
                if (shouldFetchWeather && API_KEYS.OPENWEATHER && shouldFetchWeatherNow) {
                  OverlayLogger.weather('Weather fetch check', {
                    willFetch: true,
                    reason: !checkRateLimit('openweathermap') ? 'rate limited' :
                      weatherFetchInProgress.current ? 'fetch in progress' :
                        needsTimezone ? 'timezone needed' :
                          shouldFetchWeather ? 'conditions met' : 'not needed',
                    needsTimezone,
                    weatherElapsed: Math.round(weatherElapsed / 1000),
                    weatherDataAge: hasWeatherData ? Math.round(weatherDataAge / 60000) : 'none'
                  });
                }

                if (shouldFetchWeatherNow) {
                  weatherFetchInProgress.current = true; // Mark as in progress
                  promises.push(
                    (async () => {
                      try {
                        const weatherResult = await safeApiCall(
                          () => fetchWeatherAndTimezoneFromOpenWeatherMap(lat!, lon!, API_KEYS.OPENWEATHER!),
                          'Weather fetch'
                        );

                        lastWeatherTime.current = Date.now();
                        if (weatherResult && typeof weatherResult === 'object' && 'weather' in weatherResult) {
                          const result = weatherResult as {
                            weather?: { temp: number; desc: string };
                            timezone?: string;
                            sunriseSunset?: SunriseSunsetData;
                          };

                          // Always update weather state when available (no GPS staleness check)
                          if (result.weather) {
                            updateWeather(result.weather);
                          } else {
                            OverlayLogger.warn('Weather result missing weather data');
                          }

                          // OpenWeatherMap timezone: Always update timezone even if GPS is stale
                          // LocationIQ will override with more accurate timezone if available
                          // This ensures timezone updates when moving to new locations and time/date display works
                          if (result.timezone) {
                            updateTimezone(result.timezone);
                          }

                          if (result.sunriseSunset) {
                            setSunriseSunset(result.sunriseSunset);
                            // Sunrise/sunset data is already logged by API logger, no need to duplicate
                          }
                        } else {
                          // OpenWeatherMap failed - don't clear existing weather, keep showing last known weather
                          // Only use fallback if we have no weather data at all
                          if (!weather) {
                            OverlayLogger.warn('OpenWeatherMap failed and no cached weather, using fallbacks');
                            const fallbackWeather = createWeatherFallback();
                            if (fallbackWeather) {
                              updateWeather(fallbackWeather);
                            }
                          } else {
                            OverlayLogger.warn('OpenWeatherMap failed, keeping existing weather data');
                          }

                          // Use fallback sunrise/sunset
                          const fallbackSunriseSunset = createSunriseSunsetFallback(timezone || undefined);
                          if (fallbackSunriseSunset) {
                            setSunriseSunset(fallbackSunriseSunset);
                          }
                        }
                      } catch (error) {
                        OverlayLogger.error('OpenWeatherMap API exception', error);
                      } finally {
                        weatherFetchInProgress.current = false; // Always clear flag, even on error
                      }
                    })()
                  );
                }

                // Only fetch location if GPS is fresh - don't fetch when stale
                const shouldFetchLocationNow = shouldFetchLocation && !locationFetchInProgress.current; // Prevent concurrent location fetches

                if (shouldFetchLocationNow) {
                  locationFetchInProgress.current = true; // Mark as in progress
                  promises.push(
                    (async () => {
                      try {
                        // Capture request timestamp to prevent race conditions
                        // If multiple requests are in flight, only use the most recent result
                        const requestTimestamp = Date.now();

                        let loc: LocationData | null = null;

                        // Fetch location from LocationIQ
                        let locationIQWas404 = false;
                        let locationIQRateLimited = false;

                        if (API_KEYS.LOCATIONIQ) {
                          // Check rate limits: 1 per second + 5,000 per day
                          if (checkRateLimit('locationiq')) {
                            const locationResult = await safeApiCall(
                              () => fetchLocationFromLocationIQ(lat!, lon!, API_KEYS.LOCATIONIQ!),
                              'LocationIQ fetch'
                            );
                            if (locationResult && typeof locationResult === 'object' && 'location' in locationResult) {
                              const result = locationResult as { location: LocationData | null; was404: boolean };
                              loc = result.location;
                              locationIQWas404 = result.was404;
                            }
                          } else {
                            // Rate limited - don't use fallback yet, wait for next update
                            locationIQRateLimited = true;
                            OverlayLogger.location('LocationIQ rate limited, skipping fetch - will retry on next GPS update');
                          }
                        }

                        // Only update if this is still the most recent request
                        // Prevents race conditions where older requests complete after newer ones
                        if (requestTimestamp >= lastLocationTime.current) {
                          lastLocationTime.current = requestTimestamp;

                          // Check if LocationIQ returned useful data (more than just country)
                          const hasUsefulData = loc && (
                            loc.city || loc.town || loc.village || loc.municipality ||
                            loc.neighbourhood || loc.suburb || loc.district
                          );

                          const hasCountryData = loc && loc.country;

                          if (loc && hasUsefulData) {
                            // Full location data available - use it
                            // Use settingsRef to get the current settings value (not stale closure value)
                            const currentDisplayMode = settingsRef.current.locationDisplay;
                            const formatted = formatLocation(loc, currentDisplayMode);
                            lastRawLocation.current = loc;

                            // Only update if we have something meaningful to display
                            // Check for non-empty strings (not just truthy, since empty string is falsy)
                            if (formatted.primary.trim() || formatted.secondary) {
                              // Log location updates (only when actually updating)
                              OverlayLogger.location('Location updated from fresh RTIRL data', {
                                mode: currentDisplayMode,
                                primary: formatted.primary.trim() || 'none',
                                secondary: formatted.secondary || 'none'
                              });
                              updateLocation({
                                primary: formatted.primary.trim() || '',
                                secondary: formatted.secondary,
                                countryCode: loc.countryCode || ''
                              });
                              setHasIncompleteLocationData(false);
                            }

                            // PRIORITY: LocationIQ timezone is ALWAYS preferred (accurate IANA timezone)
                            // Always update timezone from LocationIQ when available, even if we already have one
                            // This ensures timezone updates correctly when moving between locations
                            if (loc.timezone) {
                              OverlayLogger.location('Updating timezone from LocationIQ', {
                                timezone: loc.timezone,
                                previousTimezone: timezoneRef.current
                              });
                              updateTimezone(loc.timezone);
                            }
                            // Note: If LocationIQ doesn't provide timezone, OpenWeatherMap will set it as fallback
                          } else if (hasCountryData) {
                            // Only country data available
                            // If LocationIQ returned a country, we're on land (not in water)
                            // LocationIQ doesn't return country data for open water coordinates
                            const rawCountryName = loc!.country?.trim() || '';
                            const countryCode = loc!.countryCode || '';

                            // If we only have country name but no country code, hide the entire top-right section
                            // This avoids showing incomplete data - better to hide than show without flag
                            if (!countryCode) {
                              OverlayLogger.warn('LocationIQ returned only country data without country code - hiding top-right section', {
                                country: rawCountryName
                              });
                              // Clear location and mark as incomplete to hide the entire section
                              setLocation(null);
                              setHasIncompleteLocationData(true);
                              // Don't update lastSuccessfulLocationFetch - we're hiding, not caching
                            } else if (rawCountryName) {
                              // We have both country name and code - safe to display
                              setHasIncompleteLocationData(false);
                              // We have both country name and code - safe to display
                              OverlayLogger.warn('LocationIQ returned only country data, using country name');
                              // Format country name (e.g., "United States of America" -> "USA")
                              const formattedCountryName = formatCountryName(rawCountryName, countryCode);
                              updateLocation({
                                primary: formattedCountryName,
                                secondary: undefined,
                                countryCode: countryCode
                              });
                            }

                            // Use timezone if available
                            if (loc!.timezone) {
                              updateTimezone(loc!.timezone);
                            }
                          } else if (!locationIQRateLimited) {
                            // LocationIQ failed completely (not rate-limited), use country-only fallback
                            // Never show coordinates - only show country if estimable, or ocean names if on water
                            OverlayLogger.warn('LocationIQ failed, using country-only fallback');

                            const fallbackLocation = createLocationWithCountryFallback(lat!, lon!, locationIQWas404);
                            if (fallbackLocation.secondary || (fallbackLocation.primary && fallbackLocation.primary.trim())) {
                              updateLocation({
                                primary: fallbackLocation.primary.trim() || '',
                                secondary: fallbackLocation.secondary,
                                countryCode: fallbackLocation.countryCode || ''
                              });
                              setHasIncompleteLocationData(false);
                              // IMPORTANT: Don't update lastRawLocation.current with fallback data
                              // This ensures settings changes don't try to format incomplete country-only data
                              // Only update lastRawLocation when we have full location data from LocationIQ
                            }
                            // If no country can be estimated and not on water, don't update location (keep existing or blank)
                          }
                          // If rate-limited, don't update location - keep existing location or wait for next update
                          // If fetch failed, don't clear location - keep showing last known location
                          // IMPORTANT: lastRawLocation.current is only updated when we have full location data (line 1391)
                          // This ensures settings changes can properly re-format location data
                        } // End of race condition check
                      } catch (error) {
                        OverlayLogger.error('Location fetch error', { error });
                      } finally {
                        locationFetchInProgress.current = false; // Always clear flag, even on error
                      }
                    })()
                  );
                }

                // Wait for all parallel requests to complete
                if (promises.length > 0) {
                  await Promise.all(promises);
                }
              })();
            } catch (error) {
              OverlayLogger.error('RTIRL listener error', error);
            }
          });
        } catch (error) {
          OverlayLogger.error('Failed to register RTIRL listener', error);
        }
      }
    };

    // Check if RTIRL is already loaded
    if (typeof window !== 'undefined' && window.RealtimeIRL) {
      setupRTIRLListener();
    } else {
      // Load RTIRL script if not already loaded
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@rtirl/api@latest/lib/index.min.js';
      script.async = true;
      script.onerror = () => {
        OverlayLogger.error('Failed to load RTIRL script');
      };
      script.onload = () => {
        setupRTIRLListener();
      };
      document.body.appendChild(script);
    }

    // RTIRL script cleanup handled automatically
    // Note: Functions (checkRateLimit, safeApiCall) are not in deps because:
    // 1. They're used inside the listener callback, not during setup
    // 2. The listener is set up once and doesn't need to be recreated when functions change
    // 3. If functions need to access latest values, they should use refs (which they already do)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      // Reset flag on unmount so listener can be set up again if component remounts
      rtirlListenerSetupRef.current = false;
    };
  }, []); // Empty deps - RTIRL listener should only be set up once on mount

  // Fade-in delay: Start overlay hidden, then fade in after 2 seconds to allow everything to load
  useEffect(() => {
    const fadeInTimer = setTimeout(() => {
      setOverlayVisible(true);
    }, 2000); // 2 second delay before fade-in to allow flags, images, and data to load

    return () => {
      clearTimeout(fadeInTimer);
    };
  }, []); // Run once on mount

  // Load cached state (location, weather, timezone) on mount to prevent empty overlay on refresh
  useEffect(() => {
    try {
      const cached = localStorage.getItem(CACHED_STATE_KEY);
      if (cached) {
        const data = JSON.parse(cached);
        // Only restore if valid
        if (data.location) {
          // Only restore location if we have at least a country
          if (data.location.primary || (data.location.secondary && data.location.secondary.trim())) {
            setLocation(data.location);
            OverlayLogger.overlay('Restored location from cache', data.location);
          }
        }
        if (data.weather) {
          setWeather(data.weather);
          OverlayLogger.overlay('Restored weather from cache', data.weather);
        }
        if (data.timezone) {
          // Restore timezone immediately so time displays correctly
          setTimezone(data.timezone);
          OverlayLogger.overlay('Restored timezone from cache', { timezone: data.timezone });
        }
      }
    } catch (e) {
      OverlayLogger.warn('Failed to load cached state', e);
    }
  }, []);

  // Persist critical state (location, weather, timezone) to localStorage
  useEffect(() => {
    try {
      // Only save if we have at least some data
      if (!location && !weather && !timezone) return;

      const cacheData = {
        location,
        weather,
        timezone,
        timestamp: Date.now()
      };
      localStorage.setItem(CACHED_STATE_KEY, JSON.stringify(cacheData));
    } catch (e) {
      // silent fail for quota exceeded etc
    }
  }, [location, weather, timezone]);

  // Memoized display values
  // IMPORTANT: This memo re-formats location from raw data when settings change
  // This ensures location display updates immediately when settings change, even if location state hasn't updated yet
  const locationDisplay = useMemo(() => {
    if (settings.locationDisplay === 'hidden') {
      return null;
    }

    if (settings.locationDisplay === 'custom') {
      return {
        primary: settings.customLocation?.trim() || '',
        secondary: location?.secondary, // Secondary line (city/state/country) - in custom mode this shows the actual country name
        countryCode: location?.countryCode?.toUpperCase()
      };
    }

    // If we have raw location data, re-format it with current settings to ensure display mode changes are reflected immediately
    // This handles the case where settings change but location state hasn't updated yet
    const hasCompleteLocationData = lastRawLocation.current && (
      lastRawLocation.current.city ||
      lastRawLocation.current.town ||
      lastRawLocation.current.village ||
      lastRawLocation.current.municipality ||
      lastRawLocation.current.neighbourhood ||
      lastRawLocation.current.suburb ||
      lastRawLocation.current.district
    );

    if (hasCompleteLocationData) {
      try {
        const formatted = formatLocation(lastRawLocation.current, settings.locationDisplay);
        // Return formatted location with current settings
        return {
          primary: formatted.primary || '',
          secondary: formatted.secondary,
          countryCode: formatted.countryCode?.toUpperCase()
        };
      } catch (error) {
        // If formatting fails, fall back to location state
        OverlayLogger.warn('Location formatting failed in memo, using location state', { error });
      }
    }

    // Fallback to location state if no raw data or formatting failed
    // Show location data if available
    // For 'country' mode, primary will be empty but secondary field will have the country name
    if (location && (location.primary || location.secondary)) {
      return {
        ...location,
        countryCode: location.countryCode?.toUpperCase()
      };
    }

    // No location data yet - return null so UI stays blank
    return null;
  }, [location, settings.locationDisplay, settings.customLocation]);


  // Accurate day/night check using OpenWeatherMap sunrise/sunset data
  // Memoized to avoid recalculating on every render
  const isNightTime = useMemo((): boolean => {
    if (!sunriseSunset) {
      // Fallback to simple time-based check if no API data
      OverlayLogger.warn('No sunrise/sunset data available, using fallback detection');
      return isNightTimeFallback(timezone || undefined);
    }

    try {
      const now = new Date();
      const sunriseUTC = new Date(sunriseSunset.sunrise);
      const sunsetUTC = new Date(sunriseSunset.sunset);

      // Get current time components in the location's timezone
      const tz = timezone || 'UTC';
      const currentHour = parseInt(now.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hour12: false }));
      const currentMinute = parseInt(now.toLocaleString('en-US', { timeZone: tz, minute: '2-digit' }));
      const sunriseHour = parseInt(sunriseUTC.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hour12: false }));
      const sunriseMin = parseInt(sunriseUTC.toLocaleString('en-US', { timeZone: tz, minute: '2-digit' }));
      const sunsetHour = parseInt(sunsetUTC.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hour12: false }));
      const sunsetMin = parseInt(sunsetUTC.toLocaleString('en-US', { timeZone: tz, minute: '2-digit' }));

      // Convert to minutes since midnight for comparison
      const currentMinutes = currentHour * 60 + currentMinute;
      const sunriseMinutes = sunriseHour * 60 + sunriseMin;
      const sunsetMinutes = sunsetHour * 60 + sunsetMin;

      return currentMinutes < sunriseMinutes || currentMinutes > sunsetMinutes;
    } catch (error) {
      OverlayLogger.error('Day/night calculation error', error);
      return false;
    }
  }, [sunriseSunset, timezone]);

  // Get weather icon based on description and time of day
  // Returns emoji string
  const getWeatherIcon = useCallback((desc: string, showForAllConditions: boolean = false, isNight: boolean = false): string | null => {
    const d = desc.toLowerCase();

    // Hide icon for clear/partly cloudy conditions unless showing all conditions
    if (!showForAllConditions && (d.includes('clear') || d.includes('sunny') || d.includes('partly') || d.includes('few clouds'))) {
      return null;
    }

    // Map conditions to emojis with day/night variants
    if (d.includes('clear') || d.includes('sunny')) {
      return isNight ? '🌙' : '☀️';
    }
    if (d.includes('rain') || d.includes('drizzle')) {
      return '🌧️';
    }
    if (d.includes('storm') || d.includes('thunder')) {
      return '⛈️';
    }
    if (d.includes('snow')) {
      return '❄️';
    }
    if (d.includes('fog') || d.includes('mist') || d.includes('haze')) {
      return '🌫️';
    }
    if (d.includes('wind')) {
      return '💨';
    }
    if (d.includes('cloud') || d.includes('partly') || d.includes('few clouds')) {
      // Partly cloudy: sun behind cloud during day, just cloud at night (no single moon+cloud emoji)
      if (d.includes('partly') || d.includes('few clouds')) {
        return isNight ? '☁️' : '⛅';
      }
      return '☁️'; // Full clouds
    }

    // Default fallback
    return isNight ? '🌙' : '☀️';
  }, []);

  // Check if weather condition is notable (affects IRL streaming)
  const isNotableWeatherCondition = useCallback((desc: string): boolean => {
    const d = desc.toLowerCase();

    // Notable conditions that affect IRL streaming
    return (
      d.includes('rain') ||
      d.includes('drizzle') ||
      d.includes('storm') ||
      d.includes('thunder') ||
      d.includes('snow') ||
      d.includes('sleet') ||
      d.includes('hail') ||
      d.includes('fog') ||
      d.includes('mist') ||
      d.includes('haze') ||
      d.includes('wind') ||
      d.includes('gale') ||
      d.includes('hurricane') ||
      d.includes('typhoon') ||
      d.includes('tornado') ||
      d.includes('blizzard') ||
      d.includes('freezing') ||
      d.includes('extreme')
    );
  }, []);


  const weatherDisplay = useMemo(() => {
    if (!weather) {
      // No weather data - return null (no logging to reduce console spam)
      return null;
    }

    // Determine if icon and description should be shown based on display mode
    let showIcon = false;
    let showDescription = false;

    if (settings.weatherConditionDisplay === 'always') {
      // Always show icon and description
      showIcon = true;
      showDescription = true;
    } else if (settings.weatherConditionDisplay === 'auto') {
      // Only show for notable conditions
      const isNotable = isNotableWeatherCondition(weather.desc);
      showIcon = isNotable;
      showDescription = isNotable;
    }
    // 'hidden' mode: showIcon and showDescription remain false

    const icon = showIcon ? getWeatherIcon(weather.desc, settings.weatherConditionDisplay === 'always', isNightTime) : null;
    const description = showDescription ? weather.desc : null;

    const tempF = celsiusToFahrenheit(weather.temp);
    // Color: red if hot (≥80°F), blue if cold (≤45°F), white in between
    const tempColor: string =
      tempF >= 80 ? `hsl(${Math.max(0, 10 - (tempF - 80) * 0.3)}, 100%, 60%)` :
      tempF <= 45 ? `hsl(${Math.min(220, 195 + (45 - tempF) * 0.6)}, 100%, 65%)` :
      '#ffffff';

    const temperatureStr = (settings.temperatureUnit ?? 'both') === 'F'
      ? `${tempF}°F`
      : `${weather.temp}°C (${tempF}°F)`;

    const display = {
      temperature: temperatureStr,
      icon: icon,
      description: description,
      tempColor
    };
    return display;
  }, [weather, settings.weatherConditionDisplay, settings.temperatureUnit, getWeatherIcon, isNotableWeatherCondition, isNightTime]);

  // Animated speed value - counts through each integer (50, 51, 52...) - faster for responsiveness
  const displayedSpeed = useAnimatedValue(currentSpeed, {
    ...SPEED_ANIMATION,
    allowNull: false,
  }) ?? 0;

  // Animated altitude value - counts through each integer (100, 101, 102...) - slower, more contemplative
  const displayedAltitude = useAnimatedValue(currentAltitude, {
    ...ELEVATION_ANIMATION,
    allowNull: true,
  });

  // Animated bitrate value - counts through each integer
  const displayedBitrate = useAnimatedValue(currentBitrate, {
    ...BITRATE_ANIMATION,
    allowNull: true,
  });

  // Altitude display logic - hybrid change + rate detection for notable elevation
  const altitudeDisplay = useMemo(() => {
    // Hide if no altitude data
    if (currentAltitude === null || displayedAltitude === null) {
      return null;
    }

    // Check display mode first
    if (settings.altitudeDisplay === 'hidden') {
      return null;
    }

    // "Always" mode: show regardless of staleness or notable changes
    if (settings.altitudeDisplay === 'always') {
      const altitudeM = displayedAltitude;
      const altitudeFt = metersToFeet(altitudeM);
      return { value: altitudeM, formatted: `${altitudeM.toLocaleString()} m (${altitudeFt.toLocaleString()} ft)` };
    }

    // "Auto" mode: show only when above notable elevation threshold (e.g., mountains/hills)
    if (settings.altitudeDisplay === 'auto') {
      const now = Date.now();

      // Check GPS staleness - hide if GPS data is older than 1 minute
      const timeSinceAltitudeUpdate = lastAltitudeGpsTimestamp.current > 0 ? (now - lastAltitudeGpsTimestamp.current) : Infinity;
      const ALTITUDE_STALE_TIMEOUT = 60 * 1000; // 1 minute
      const isAltitudeStale = timeSinceAltitudeUpdate > ALTITUDE_STALE_TIMEOUT;

      // Hide if stale
      if (isAltitudeStale) {
        return null;
      }

      // Show only if elevation is above threshold (notable elevation like mountains/hills)
      // 500m threshold filters out almost all major cities, only shows notable mountains/hills
      const ELEVATION_THRESHOLD = 500; // meters
      if (currentAltitude < ELEVATION_THRESHOLD) {
        return null;
      }
    }

    // Show altitude (auto mode with notable change detected)
    const altitudeM = displayedAltitude;
    const altitudeFt = metersToFeet(altitudeM);
    return { value: altitudeM, formatted: `${altitudeM.toLocaleString()} m (${altitudeFt.toLocaleString()} ft)` };
  }, [currentAltitude, displayedAltitude, settings.altitudeDisplay, altitudeUpdateTimestamp]);

  // Speed display logic
  const speedDisplay = useMemo(() => {
    // Check display mode first
    if (settings.speedDisplay === 'hidden') {
      return null;
    }

    // Check staleness only for "auto" mode - "always" mode shows even if stale
    if (settings.speedDisplay === 'auto') {
      const now = Date.now();
      // Use GPS timestamp for staleness check (not reception time) - works correctly when stationary
      const timeSinceSpeedUpdate = lastSpeedGpsTimestamp.current > 0 ? (now - lastSpeedGpsTimestamp.current) : Infinity;
      const isSpeedStale = timeSinceSpeedUpdate > GPS_STALE_TIMEOUT; // 10 seconds

      // Hide if stale (regardless of speed value)
      if (isSpeedStale) {
        return null;
      }

      // Auto mode: show if >= 10 km/h (above walking pace)
      if (currentSpeed < 10) {
        return null;
      }
    }

    // Show speed (either always mode, or auto mode with speed >= 10 km/h)
    // In always mode, show even if speed is 0
    const speedKmh = displayedSpeed;
    const speedMph = kmhToMph(speedKmh);
    return { value: speedKmh, formatted: `${Math.round(speedKmh)} km/h (${Math.round(speedMph)} mph)` };
  }, [currentSpeed, displayedSpeed, settings.speedDisplay, speedUpdateTimestamp]);

  // Bitrate display logic
  const bitrateDisplay = useMemo(() => {
    // Hide ONLY if hidden in settings
    if (settings.bitrateDisplay === 'hidden') {
      return null;
    }

    // Auto mode: hide if no data, 0 bitrate, or data is stale
    const isStale = bitrateUpdateTimestamp > 0 && (Date.now() - bitrateUpdateTimestamp) > 10000;
    if (settings.bitrateDisplay === 'auto' && (currentBitrate === null || currentBitrate <= 0 || isStale)) {
      return null;
    }

    // Mode is 'always' OR mode is 'auto' with valid data
    // If animated value is null but raw value isn't, use raw value
    // This handles the very first frame before animation starts
    const bitrate = displayedBitrate !== null ? displayedBitrate : (currentBitrate || 0);
    const rtt = currentRtt;

    let formatted = `${bitrate.toLocaleString()} Kbps`;
    if (rtt !== null && rtt !== undefined) {
      formatted += ` / ${rtt}ms`;
    }

    return {
      value: bitrate,
      formatted,
      warningLevel: (!settings.showBitrateWarnings || bitrate <= 0) ? 'none' : (bitrate < 900 ? 'red' : (bitrate < 1300 ? 'yellow' : 'none'))
    };
  }, [currentBitrate, displayedBitrate, currentRtt, settings.bitrateDisplay, bitrateUpdateTimestamp]);

  // Periodic bitrate stats fetcher
  useEffect(() => {
    if (!API_KEYS.BITRATE_URL) {
      console.warn('📡 Bitrate display is active but NEXT_PUBLIC_NOALBS_STATS_URL is not set in .env.local');
      return;
    }

    console.log('📡 Bitrate debugger: Periodic fetching started from', API_KEYS.BITRATE_URL);
    if (API_KEYS.SRT_PUBLISHER_KEY) {
      console.log('📡 Bitrate debugger: Filtering for publisher key:', API_KEYS.SRT_PUBLISHER_KEY);
    } else {
      console.log('📡 Bitrate debugger: No publisher key set, will use the first stream found.');
    }

    let isActive = true;
    let timer: NodeJS.Timeout;

    const fetchStats = async () => {
      if (!isActive) return;

      const stats = await fetchBitrateStats(API_KEYS.BITRATE_URL!, API_KEYS.SRT_PUBLISHER_KEY);

      if (isActive) {
        if (stats) {
          // Success case - no need to spam console
          setCurrentBitrate(stats.bitrateKbps);
          setCurrentRtt(stats.rttMs ?? null);
          setBitrateUpdateTimestamp(Date.now());
          consecutiveBitrateFailuresRef.current = 0;
        } else {
          // Failure or No Data - increment failures
          consecutiveBitrateFailuresRef.current++;

          // If we have 3 consecutive failures (approx 6-10 seconds), clear the display
          // This ensures "auto" mode disappears when you end your stream
          if (consecutiveBitrateFailuresRef.current >= 3) {
            setCurrentBitrate(0);
            setCurrentRtt(null);
          }

          console.warn('📡 Bitrate debugger: Fetch attempted but returned no data. Check if your stream is LIVE and the stats URL is reachable.');
        }

        timer = setTimeout(fetchStats, BITRATE_UPDATE_INTERVAL);
      }
    };

    fetchStats();

    return () => {
      isActive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Shared Bitrate JSX to avoid duplication
  const bitrateJSX = bitrateDisplay && (bitrateDisplay.value > 0 || settings.bitrateDisplay === 'always') && (
    <div
      className="bitrate-container movement-data-line"
      style={{
        opacity: bitrateDisplay.value > 0 ? 1 : 0,
        height: bitrateDisplay.value > 0 ? 'auto' : 0,
        overflow: 'hidden',
        transition: 'all 0.5s ease-in-out'
      }}
    >
      <div className={`weather-temperature bitrate-text ${bitrateDisplay.warningLevel === 'red' ? 'bitrate-warning-red' :
        bitrateDisplay.warningLevel === 'yellow' ? 'bitrate-warning-yellow' : ''
        }`}>
        {bitrateDisplay.formatted}
      </div>
    </div>
  );

  return (
    <ErrorBoundary autoReload={false}>
      <div
        className="overlay-container obs-render"
        style={{
          // Always show overlay - top-left (time/date/heart rate) doesn't depend on GPS or location data
          // Top-right section has its own visibility conditions
          // This ensures elements stay visible even if location/weather data is cleared due to errors
          // Start hidden and fade in after delay to prevent flashing on initial load
          opacity: overlayVisible ? 1 : 0,
          transition: overlayVisible ? 'opacity 0.8s ease-in-out' : 'none'
        }}
      >
        <div className="top-left">
          {settings.swapLocationTimePositions ? (
            /* Swapped: Show Location/Weather on Left */
            settings.locationDisplay !== 'hidden' && (locationDisplay || weatherDisplay || altitudeDisplay || speedDisplay || (settings.bitrateAnchor !== 'time' && bitrateDisplay && (bitrateDisplay.value > 0 || settings.bitrateDisplay === 'always'))) ? (
              <div
                className={`overlay-box align-left ${!settings.showBackground ? 'no-background' : ''}`}
                style={{
                  alignItems: 'flex-start',
                  transform: `scale(${settings.timeWeatherLocationScale ?? 1.0})`,
                  transformOrigin: 'top left'
                }}
              >
                {/* Location section */}
                {locationDisplay && (
                  <>
                    {locationDisplay.primary && (
                      <div className="location location-line">
                        <div className="location-main">{locationDisplay.primary}</div>
                      </div>
                    )}
                    {locationDisplay.secondary && (settings.locationDisplay !== 'custom' || settings.showCountryName) && (
                      <div className={`location location-line location-sub-line ${!locationDisplay.primary ? 'country-only' : ''}`}>
                        <div className="location-sub">
                          {locationDisplay.secondary}
                          {locationDisplay.countryCode && <LocationFlag countryCode={locationDisplay.countryCode} />}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Weather section */}
                {weatherDisplay && settings.showWeather && (
                  <div className="weather weather-line">
                    <div className="weather-text-group">
                      <div className="weather-temperature" style={{ color: weatherDisplay.tempColor }}>{weatherDisplay.temperature}</div>
                      {(weatherDisplay.icon || weatherDisplay.description) && (
                        <div className="weather-condition-group">
                          {weatherDisplay.description && <span className="weather-description-text">{weatherDisplay.description}</span>}
                          {weatherDisplay.icon && <span className="weather-icon-inline">{weatherDisplay.icon}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Movement Data section */}
                {(altitudeDisplay || speedDisplay || (settings.bitrateAnchor !== 'time' && bitrateDisplay && (bitrateDisplay.value > 0 || settings.bitrateDisplay === 'always'))) && (
                  <div className="movement-data-group">
                    {altitudeDisplay && (
                      <div className="weather weather-line movement-data-line">
                        <div className="weather-temperature">{altitudeDisplay.formatted}</div>
                      </div>
                    )}
                    {speedDisplay && (
                      <div className="weather weather-line movement-data-line">
                        <div className="weather-temperature">{speedDisplay.formatted}</div>
                      </div>
                    )}
                    {settings.bitrateAnchor !== 'time' && bitrateJSX}
                  </div>
                )}
              </div>
            ) : null
          ) : (
            /* Normal: Show Time/Date on Left */
            (isValidTimezone(timezone) && (timeDisplay.time || timeDisplay.date) || API_KEYS.PULSOID || (settings.bitrateAnchor === 'time' && bitrateJSX)) ? (
              <div
                className={`overlay-box ${!settings.showBackground ? 'no-background' : ''}`}
                style={{
                  transform: `scale(${settings.timeWeatherLocationScale ?? 1.0})`,
                  transformOrigin: 'top left'
                }}
              >
                {isValidTimezone(timezone) && timeDisplay.time && (
                  <div className="time time-left time-line">
                    <div className="time-display">
                      <span className="time-value">{timeDisplay.time.split(' ')[0]}</span>
                      <span className="time-period">{timeDisplay.time.split(' ')[1]}</span>
                    </div>
                  </div>
                )}
                {isValidTimezone(timezone) && timeDisplay.date && (settings.showDate ?? true) && (
                  <div className="date date-left date-line">{timeDisplay.date}</div>
                )}
                {API_KEYS.PULSOID && (
                  <ErrorBoundary fallback={<div className="heart-rate-line">Heart rate unavailable</div>}>
                    <HeartRateMonitor pulsoidToken={API_KEYS.PULSOID} />
                  </ErrorBoundary>
                )}
                {settings.bitrateAnchor === 'time' && bitrateJSX}
              </div>
            ) : null
          )}

          {/* To-Do List - Top Left (below time) */}
          {settings.showTodoList && visibleTodos.length > 0 && settings.todoListPosition === 'left' && (
            <div className={`overlay-box todo-list-box ${!settings.showBackground ? 'no-background' : ''}`} style={{ marginTop: '12px', alignSelf: 'flex-start' }}>
              {visibleTodos
                .sort((a, b) => (a.completed === b.completed ? 0 : a.completed ? 1 : -1))
                .map((todo) => (
                  <div key={todo.id} className={`todo-item ${todo.completed ? 'completed' : ''}`}>
                    <span className="todo-checkbox-icon">{todo.completed ? '✓' : '☐'}</span>
                    <span className="todo-text">
                      {todo.text}
                      {todo.goal !== undefined && todo.goal > 0 && (
                        <span className="todo-goal-progress" style={{ opacity: 0.8, fontSize: '0.85em', fontWeight: 'bold', marginLeft: '6px' }}>
                          ({todo.current ?? 0}/{todo.goal})
                        </span>
                      )}
                    </span>
                  </div>
                ))}
            </div>
          )}
          {settings.todoListPosition === 'left' && donationGoalsJSX}
          {settings.todoListPosition === 'left' && settings.showDonationGoals && donationToast && (
            <div
              className={`dono-toast ${donationToast.phase}`}
              style={{
                marginTop: '8px',
                transform: `scale(${settings.donationGoalsScale || 1})`,
                transformOrigin: 'top left',
                alignSelf: 'flex-start',
              }}
            >
              <span className="dono-toast-icon">{donationToast.icon}</span>
              <div className="dono-toast-body">
                <span className="dono-toast-name">{donationToast.username} {donationToast.label}</span>
                <span className="dono-toast-amount">{donationToast.amount}</span>
              </div>
            </div>
          )}
        </div>

        <div className="top-right">
          {settings.swapLocationTimePositions ? (
            /* Swapped: Show Time/Date on Right */
            (isValidTimezone(timezone) && (timeDisplay.time || timeDisplay.date) || API_KEYS.PULSOID || (settings.bitrateAnchor === 'time' && bitrateJSX)) ? (
              <div
                className={`overlay-box ${!settings.showBackground ? 'no-background' : ''}`}
                style={{
                  alignItems: 'flex-end',
                  transform: `scale(${settings.timeWeatherLocationScale ?? 1.0})`,
                  transformOrigin: 'top right'
                }}
              >
                {isValidTimezone(timezone) && timeDisplay.time && (
                  <div className="time time-left time-line" style={{ textAlign: 'right' }}>
                    <div className="time-display" style={{ justifyContent: 'flex-end' }}>
                      <span className="time-value">{timeDisplay.time.split(' ')[0]}</span>
                      <span className="time-period">{timeDisplay.time.split(' ')[1]}</span>
                    </div>
                  </div>
                )}
                {isValidTimezone(timezone) && timeDisplay.date && (settings.showDate ?? true) && (
                  <div className="date date-left date-line" style={{ textAlign: 'right' }}>{timeDisplay.date}</div>
                )}
                {API_KEYS.PULSOID && (
                  <ErrorBoundary fallback={<div className="heart-rate-line">Heart rate unavailable</div>}>
                    <HeartRateMonitor pulsoidToken={API_KEYS.PULSOID} />
                  </ErrorBoundary>
                )}
                {settings.bitrateAnchor === 'time' && bitrateJSX}
              </div>
            ) : null
          ) : (
            /* Normal: Show Location/Weather on Right */
            settings.locationDisplay !== 'hidden' && (locationDisplay || weatherDisplay || altitudeDisplay || speedDisplay || (settings.bitrateAnchor !== 'time' && bitrateDisplay && (bitrateDisplay.value > 0 || settings.bitrateDisplay === 'always'))) ? (
              <div
                className={`overlay-box ${!settings.showBackground ? 'no-background' : ''}`}
                style={{
                  alignSelf: 'flex-end',
                  transform: `scale(${settings.timeWeatherLocationScale ?? 1.0})`,
                  transformOrigin: 'top right'
                }}
              >
                {/* Location section */}
                {locationDisplay && (
                  <>
                    {locationDisplay.primary && (
                      <div className="location location-line">
                        <div className="location-main">{locationDisplay.primary}</div>
                      </div>
                    )}
                    {locationDisplay.secondary && (settings.locationDisplay !== 'custom' || settings.showCountryName) && (
                      <div className={`location location-line location-sub-line ${!locationDisplay.primary ? 'country-only' : ''}`}>
                        <div className="location-sub">
                          {locationDisplay.secondary}
                          {locationDisplay.countryCode && <LocationFlag countryCode={locationDisplay.countryCode} />}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Weather section */}
                {weatherDisplay && settings.showWeather && (
                  <div className="weather weather-line">
                    <div className="weather-text-group">
                      <div className="weather-temperature" style={{ color: weatherDisplay.tempColor }}>{weatherDisplay.temperature}</div>
                      {(weatherDisplay.icon || weatherDisplay.description) && (
                        <div className="weather-condition-group">
                          {weatherDisplay.description && <span className="weather-description-text">{weatherDisplay.description}</span>}
                          {weatherDisplay.icon && <span className="weather-icon-inline">{weatherDisplay.icon}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Movement Data section */}
                {(altitudeDisplay || speedDisplay || (settings.bitrateAnchor !== 'time' && bitrateDisplay && (bitrateDisplay.value > 0 || settings.bitrateDisplay === 'always'))) && (
                  <div className="movement-data-group">
                    {altitudeDisplay && (
                      <div className="weather weather-line movement-data-line">
                        <div className="weather-temperature">{altitudeDisplay.formatted}</div>
                      </div>
                    )}
                    {speedDisplay && (
                      <div className="weather weather-line movement-data-line">
                        <div className="weather-temperature">{speedDisplay.formatted}</div>
                      </div>
                    )}
                    {settings.bitrateAnchor !== 'time' && bitrateJSX}
                  </div>
                )}
              </div>
            ) : null
          )}

          {/* To-Do List - Top Right (below location) */}
          {/* Show todo list when enabled and there are visible todos */}
          {settings.showTodoList && visibleTodos.length > 0 && settings.todoListPosition === 'right' && (
            <div className={`overlay-box todo-list-box ${!settings.showBackground ? 'no-background' : ''}`} style={{ marginTop: '12px', alignSelf: 'flex-end' }}>
              {visibleTodos
                .sort((a, b) => {
                  // Incomplete tasks first, then completed tasks
                  if (a.completed === b.completed) return 0;
                  return a.completed ? 1 : -1;
                })
                .map((todo) => (
                  <div key={todo.id} className={`todo-item ${todo.completed ? 'completed' : ''}`}>
                    <span className="todo-checkbox-icon">{todo.completed ? '✓' : '☐'}</span>
                    <span className="todo-text">
                      {todo.text}
                      {todo.goal !== undefined && todo.goal > 0 && (
                        <span className="todo-goal-progress" style={{ opacity: 0.8, fontSize: '0.85em', fontWeight: 'bold', marginLeft: '6px' }}>
                          ({todo.current ?? 0}/{todo.goal})
                        </span>
                      )}
                    </span>
                  </div>
                ))}
            </div>
          )}
          {settings.todoListPosition === 'right' && donationGoalsJSX}
          {settings.todoListPosition === 'right' && settings.showDonationGoals && donationToast && (
            <div
              className={`dono-toast ${donationToast.phase}`}
              style={{
                marginTop: '8px',
                transform: `scale(${settings.donationGoalsScale || 1})`,
                transformOrigin: 'top right',
                alignSelf: 'flex-end',
              }}
            >
              <span className="dono-toast-icon">{donationToast.icon}</span>
              <div className="dono-toast-body">
                <span className="dono-toast-name">{donationToast.username} {donationToast.label}</span>
                <span className="dono-toast-amount">{donationToast.amount}</span>
              </div>
            </div>
          )}
        </div>

        {/* Top Middle Panel (Social Media Rotation) */}
        {settings.showSocials !== false && settings.socialPosition !== 'bottom-left' && activeSocials.length > 0 && (
          <div className="top-middle">
            <div className={`overlay-box social-box ${!(settings.socialShowBackground ?? true) ? 'no-background' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 16px', minWidth: '150px' }}>
              {(() => {
                const social = activeSocials[activeSocialIndex] || activeSocials[0];
                if (!social) return null;
                const theme = settings.socialTextTheme || 'default';

                return (
                  <div key={social.type} className="social-item" data-theme={theme} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: 'var(--font-size-sm)', animation: 'fadeIn 0.5s ease' }}>
                    {social.type === 'x' && (
                      <>
                        <span className="social-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px' }}>
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                        </span>
                        <span className="social-name" style={{ fontWeight: '800', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-compact)' }}>{social.name}</span>
                      </>
                    )}
                    {social.type === 'youtube' && (
                      <>
                        <span className="social-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', color: '#FF0000' }}>
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.518 3.545 12 3.545 12 3.545s-7.518 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.87.508 9.388.508 9.388.508s7.518 0 9.388-.508a3.003 3.003 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                        </span>
                        <span className="social-name" style={{ fontWeight: '800', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-compact)' }}>{social.name}</span>
                      </>
                    )}
                    {social.type === 'instagram' && (
                      <>
                        <span className="social-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', color: '#E1306C' }}>
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line></svg>
                        </span>
                        <span className="social-name" style={{ fontWeight: '800', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-compact)' }}>{social.name}</span>
                      </>
                    )}
                    {social.type === 'tiktok' && (
                      <>
                        <span className="social-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', color: '#00f2fe' }}>
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.17-2.86-.74-3.94-1.74-.22-.2-.42-.43-.61-.67-.02 3.76-.01 7.52-.02 11.28-.19 3.28-2.6 6.08-5.88 6.55-3.71.53-7.26-1.97-7.9-5.62-.64-3.69 1.64-7.46 5.29-8.26.8-.17 1.62-.2 2.43-.07v4.18c-.68-.14-1.39-.14-2.07.03-1.63.39-2.73 2.02-2.52 3.69.21 1.68 1.69 2.92 3.38 2.77 1.73-.15 2.97-1.7 2.82-3.43V.02z"/></svg>
                        </span>
                        <span className="social-name" style={{ fontWeight: '800', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-compact)' }}>{social.name}</span>
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Bottom Left Panel (Social Media & URLs) */}
        {((settings.showSocials !== false && settings.socialPosition === 'bottom-left' && activeSocials.length > 0) ||
          (settings.showUrls && settings.urls && settings.urls.filter(u => u.active && (!u.type || u.type === 'text')).length > 0)) && (
          <div className="bottom-left">
            {/* Social Media Panel */}
            {settings.showSocials !== false && settings.socialPosition === 'bottom-left' && activeSocials.length > 0 && (
              <div className={`overlay-box social-box ${!(settings.socialShowBackground ?? true) ? 'no-background' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 16px', minWidth: '150px' }}>
                {(() => {
                  const social = activeSocials[activeSocialIndex] || activeSocials[0];
                  if (!social) return null;
                  const theme = settings.socialTextTheme || 'default';

                  return (
                    <div key={social.type} className="social-item" data-theme={theme} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: 'var(--font-size-sm)', animation: 'fadeIn 0.5s ease' }}>
                      {social.type === 'x' && (
                        <>
                          <span className="social-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px' }}>
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                          </span>
                          <span className="social-name" style={{ fontWeight: '800', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-compact)' }}>{social.name}</span>
                        </>
                      )}
                      {social.type === 'youtube' && (
                        <>
                          <span className="social-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', color: '#FF0000' }}>
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.518 3.545 12 3.545 12 3.545s-7.518 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.87.508 9.388.508 9.388.508s7.518 0 9.388-.508a3.003 3.003 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                          </span>
                          <span className="social-name" style={{ fontWeight: '800', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-compact)' }}>{social.name}</span>
                        </>
                      )}
                      {social.type === 'instagram' && (
                        <>
                          <span className="social-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', color: '#E1306C' }}>
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line></svg>
                          </span>
                          <span className="social-name" style={{ fontWeight: '800', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-compact)' }}>{social.name}</span>
                        </>
                      )}
                      {social.type === 'tiktok' && (
                        <>
                          <span className="social-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', color: '#00f2fe' }}>
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.17-2.86-.74-3.94-1.74-.22-.2-.42-.43-.61-.67-.02 3.76-.01 7.52-.02 11.28-.19 3.28-2.6 6.08-5.88 6.55-3.71.53-7.26-1.97-7.9-5.62-.64-3.69 1.64-7.46 5.29-8.26.8-.17 1.62-.2 2.43-.07v4.18c-.68-.14-1.39-.14-2.07.03-1.63.39-2.73 2.02-2.52 3.69.21 1.68 1.69 2.92 3.38 2.77 1.73-.15 2.97-1.7 2.82-3.43V.02z"/></svg>
                          </span>
                          <span className="social-name" style={{ fontWeight: '800', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-compact)' }}>{social.name}</span>
                        </>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* URLs Panel */}
            {settings.showUrls && settings.urls && settings.urls.filter(u => u.active && (!u.type || u.type === 'text')).length > 0 && (
              <div className={`overlay-box ${!settings.showBackground ? 'no-background' : ''}`}>
                {settings.urls.filter(u => u.active && (!u.type || u.type === 'text')).map(url => (
                  <div key={url.id} className="url-item">
                    <div className="url-label">{url.label}</div>
                    <div className="url-address">{url.url}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Embedded Browser Sources (Full Screen / Absolute) */}
        {
          settings.urls && settings.urls.filter(u => u.active && u.type === 'embed').map(url => (
            <EmbedUrl key={url.id} url={url} />
          ))
        }


        {/* Low Bitrate Alert Text (Slide up) */}
        {
          settings.showBitrateWarnings && settings.showLowBitrateAlert && (
            <div
              className={`low-bitrate-alert-container ${bitrateDisplay && bitrateDisplay.warningLevel !== 'none' ? `active alert-${bitrateDisplay.warningLevel}` : ''}`}
              style={{
                transform: `translateX(calc(-50% + ${settings.lowBitrateAlertX || 0}px)) scale(${settings.lowBitrateAlertScale || 1})`,
                left: '50%',
                bottom: bitrateDisplay && bitrateDisplay.warningLevel !== 'none' ? `${40 + (settings.lowBitrateAlertY || 0)}px` : `${-300 + (settings.lowBitrateAlertY || 0)}px`
              }}
            >
              <div className={`low-bitrate-alert-text-box font-theme-${settings.lowBitrateAlertFont || 'default'}`}>
                <span className="low-bitrate-warning-icon">⚠️</span>
                <span className="low-bitrate-warning-text">LOW BITRATE - PLEASE WAIT!</span>
              </div>
            </div>
          )
        }
        {/* Calorie Tracker */}
        <CalorieTracker
          calories={(totalDistanceTracked / 1000) * CALORIES_PER_KM}
          goal={settings.calorieGoal || 500}
          visible={settings.showCalorieTracker || false}
          scale={settings.calorieTrackerScale || 1}
          x={settings.calorieTrackerX || 0}
          y={settings.calorieTrackerY || 0}
        />


        {/* Standalone Minimap Container */}
        {
          mapCoords && (
            <div
              className={`minimap standalone-minimap ${settings.minimapPosition === 'right' ? 'anchor-right' : 'anchor-left'} ${minimapVisible ? 'map-active' : 'map-inactive'}`}
              style={{
                opacity: minimapOpacity,
                position: 'absolute',
                top: '20px',
                [settings.minimapPosition === 'right' ? 'right' : 'left']: '20px',
                width: `${200 * ((settings.minimapScale || 100) / 100)}px`,
                height: `${200 * ((settings.minimapScale || 100) / 100)}px`,
                transform: `translate(${settings.minimapX || 0}px, ${-(settings.minimapY || 0)}px) 
                            ${!minimapVisible ? 'scale(0.7) translateY(-40px) rotate(8deg)' : 'scale(1) translateY(0) rotate(0deg)'}`,
                transition: 'all 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)',
                zIndex: 100,
                pointerEvents: 'none',
                filter: minimapVisible ? `blur(0px) ${settings.showBackground ? 'drop-shadow(0 10px 15px rgba(0,0,0,0.3))' : ''}` : 'blur(8px)',
                borderRadius: '50%',
                overflow: 'hidden',
                boxShadow: (minimapVisible && settings.showBackground) ? '0 10px 30px rgba(0, 0, 0, 0.4)' : 'none'
              }}
            >
              {sunriseSunset ? (
                <ErrorBoundary fallback={<div className="minimap-placeholder" style={{ width: '100%', height: '100%' }}>Map unavailable</div>}>
                  <MapLibreMinimap
                    lat={mapCoords[0]}
                    lon={mapCoords[1]}
                    isVisible={minimapVisible}
                    zoomLevel={settings.mapZoomLevel}
                    timezone={timezone || undefined}
                    isNight={isNightTime}
                    mapStyle={settings.mapStyle}
                  />
                </ErrorBoundary>
              ) : (
                <div className="minimap-placeholder" style={{ width: '100%', height: '100%' }}>Loading map...</div>
              )}
            </div>
          )
        }
      </div >
    </ErrorBoundary >
  );
}

// Export wrapped version that doesn't auto-reload on errors
function OverlayPageWrapper() {
  return (
    <ErrorBoundary
      autoReload={false} // Disable auto-reload - keep elements visible indefinitely
    >
      <OverlayPage />
    </ErrorBoundary>
  );
}

export default OverlayPageWrapper;
