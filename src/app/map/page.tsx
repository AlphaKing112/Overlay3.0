"use client";

import { useEffect, useRef, useState, useCallback, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { API_KEYS, TIMERS, type RTIRLPayload } from '@/utils/overlay-constants';
import { OverlaySettings, DEFAULT_OVERLAY_SETTINGS, MapZoomLevel } from '@/types/settings';
import { fetchLocationFromLocationIQ, fetchWeatherAndTimezoneFromOpenWeatherMap, type SunriseSunsetData } from '@/utils/api-utils';
import { formatLocation, formatCountryName, distanceInMeters, type LocationData } from '@/utils/location-utils';
import { checkRateLimit } from '@/utils/rate-limiting';
import { kmhToMph, metersToFeet } from '@/utils/unit-conversions';
import { createLocationWithCountryFallback, createSunriseSunsetFallback, isNightTimeFallback } from '@/utils/fallback-utils';

declare global {
  interface Window {
    RealtimeIRL?: {
      forPullKey: (key: string) => {
        addListener: (cb: (p: unknown) => void) => void;
      };
    };
  }
}

// Preset zoom levels
const ZOOM_LEVELS: Record<string, number> = {
  neighbourhood: 15,
  city: 13,
  state: 8,
  country: 5,
  ocean: 3,
  continental: 1
};

// Map Style Specifications - 100% Vector, Free & Watermark-Free via OpenFreeMap
const MAP_STYLES: Record<string, maplibregl.StyleSpecification> = {
  // Dark Vector Style (clean midnight cyberpunk map, no API keys, no watermarks)
  dark: {
    version: 8 as const,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      'ofm': {
        type: 'vector' as const,
        url: 'https://tiles.openfreemap.org/planet'
      }
    },
    layers: [
      { id: 'bg', type: 'background' as const, paint: { 'background-color': '#0c1017' } },
      { id: 'lc-rock', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'rock', 'bare_rock', 'scree'] as any, paint: { 'fill-color': '#161b22' } },
      { id: 'lc-wood', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'wood', 'forest'] as any, paint: { 'fill-color': '#0d1a15' } },
      { id: 'lc-grass', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'grass', 'meadow', 'wetland', 'crop'] as any, paint: { 'fill-color': '#0e1d18' } },
      { id: 'lc-scrub', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'scrub', 'shrub'] as any, paint: { 'fill-color': '#0e1c17' } },
      { id: 'lc-sand', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'sand', 'beach'] as any, paint: { 'fill-color': '#1c1b16' } },
      { id: 'water', type: 'fill' as const, source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': '#060a12', 'fill-antialias': true } },
      { id: 'waterway', type: 'line' as const, source: 'ofm', 'source-layer': 'waterway', paint: { 'line-color': '#060a12', 'line-width': 1.5 } },
      { id: 'lu-farm', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse', filter: ['in', 'class', 'farmland', 'farmyard', 'agriculture'] as any, paint: { 'fill-color': '#0e1d17' } },
      { id: 'lu-military', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse', filter: ['==', 'class', 'military'] as any, paint: { 'fill-color': '#1b1922' } },
      { id: 'lu-cemetery', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse', filter: ['==', 'class', 'cemetery'] as any, paint: { 'fill-color': '#121a17' } },
      { id: 'lu-residential', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse', filter: ['in', 'class', 'residential', 'commercial', 'industrial', 'retail', 'hospital', 'school', 'university', 'neighbourhood', 'suburb'] as any, paint: { 'fill-color': '#0c1017' } },
      { id: 'park', type: 'fill' as const, source: 'ofm', 'source-layer': 'park', paint: { 'fill-color': '#0e1f18' } },
      { id: 'aeroway-fill', type: 'fill' as const, source: 'ofm', 'source-layer': 'aeroway', minzoom: 11, filter: ['in', 'class', 'runway', 'taxiway'] as any, paint: { 'fill-color': '#181e28' } },
      { id: 'aeroway-line', type: 'line' as const, source: 'ofm', 'source-layer': 'aeroway', minzoom: 11, paint: { 'line-color': '#202836', 'line-width': 2 } },
      { id: 'building', type: 'fill' as const, source: 'ofm', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': '#141a24', 'fill-outline-color': '#1f2737' } },
      { id: 'road-path', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 14, filter: ['in', 'class', 'path', 'track', 'footway', 'cycleway'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#1e2636', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 14, 1.2, 16, 2.5, 18, 4.5] as any } },
      { id: 'road-service', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 13, filter: ['==', 'class', 'service'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#232c3e', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 13, 1.5, 15, 3.8, 18, 7.0] as any } },
      { id: 'road-minor', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 12, filter: ['in', 'class', 'minor', 'street', 'street_limited', 'residential'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#283347', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 1.5, 14, 3.8, 16, 7.5, 18, 13.0] as any } },
      { id: 'road-secondary', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 10, filter: ['in', 'class', 'secondary', 'tertiary'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#33415c', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 1.5, 13, 3.8, 16, 9.5, 18, 16.0] as any } },
      { id: 'road-primary', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 8, filter: ['==', 'class', 'primary'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#3e5072', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 1.5, 11, 3.2, 14, 7.0, 16, 12.0, 18, 20.0] as any } },
      { id: 'road-trunk', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 6, filter: ['==', 'class', 'trunk'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#475d86', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 6, 1.2, 9, 2.8, 13, 6.5, 16, 14.0, 18, 24.0] as any } },
      { id: 'road-motorway', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 4, filter: ['==', 'class', 'motorway'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#5772a4', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 4, 1.0, 8, 2.5, 12, 6.0, 16, 16.0, 18, 28.0] as any } },
      {
        id: 'label-road-minor', type: 'symbol' as const, source: 'ofm', 'source-layer': 'transportation_name',
        filter: ['in', 'class', 'minor', 'service', 'street', 'street_limited'] as any,
        layout: {
          'symbol-placement': 'line' as const,
          'text-field': ['get', 'name'] as any,
          'text-font': ['Noto Sans Bold'] as any,
          'text-size': 10,
          'text-max-angle': 30,
          'text-letter-spacing': 0.05,
          'text-padding': 2,
          'text-rotation-alignment': 'map' as const,
          'text-pitch-alignment': 'viewport' as const,
        } as any,
        paint: {
          'text-color': '#8b9bb4',
          'text-halo-color': '#0c1017',
          'text-halo-width': 2,
        } as any,
      },
      {
        id: 'label-road-secondary', type: 'symbol' as const, source: 'ofm', 'source-layer': 'transportation_name',
        filter: ['in', 'class', 'secondary', 'tertiary'] as any,
        layout: {
          'symbol-placement': 'line' as const,
          'text-field': ['get', 'name'] as any,
          'text-font': ['Noto Sans Bold'] as any,
          'text-size': 11,
          'text-max-angle': 30,
          'text-letter-spacing': 0.05,
          'text-padding': 2,
          'text-rotation-alignment': 'map' as const,
          'text-pitch-alignment': 'viewport' as const,
        } as any,
        paint: {
          'text-color': '#b0c4de',
          'text-halo-color': '#0c1017',
          'text-halo-width': 2,
        } as any,
      },
      {
        id: 'label-road-primary', type: 'symbol' as const, source: 'ofm', 'source-layer': 'transportation_name',
        filter: ['in', 'class', 'primary', 'trunk', 'motorway'] as any,
        layout: {
          'symbol-placement': 'line' as const,
          'text-field': ['get', 'name'] as any,
          'text-font': ['Noto Sans Bold'] as any,
          'text-size': 13,
          'text-max-angle': 30,
          'text-letter-spacing': 0.1,
          'text-padding': 2,
          'text-rotation-alignment': 'map' as const,
          'text-pitch-alignment': 'viewport' as const,
        } as any,
        paint: {
          'text-color': '#e2e8f0',
          'text-halo-color': '#0c1017',
          'text-halo-width': 2.5,
        } as any,
      },
      {
        id: 'label-places', type: 'symbol' as const, source: 'ofm', 'source-layer': 'place',
        filter: ['in', 'class', 'city', 'town', 'village', 'suburb', 'neighbourhood'] as any,
        layout: {
          'text-field': ['get', 'name'] as any,
          'text-font': ['Noto Sans Bold'] as any,
          'text-size': 12,
          'text-letter-spacing': 0.05,
        } as any,
        paint: {
          'text-color': '#f1f5f9',
          'text-halo-color': '#0c1017',
          'text-halo-width': 2,
        } as any,
      }
    ]
  } as any,

  // GTA 5 Authentic Color Palette Style
  gta5: {
    version: 8 as const,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      'ofm': {
        type: 'vector' as const,
        url: 'https://tiles.openfreemap.org/planet'
      }
    },
    layers: [
      { id: 'bg', type: 'background' as const, paint: { 'background-color': '#d8d8d2' } },
      { id: 'lc-rock', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'rock', 'bare_rock', 'scree'] as any, paint: { 'fill-color': '#7a7a7a' } },
      { id: 'lc-wood', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'wood', 'forest'] as any, paint: { 'fill-color': '#3a6830' } },
      { id: 'lc-grass', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'grass', 'meadow', 'wetland', 'crop'] as any, paint: { 'fill-color': '#5c9248' } },
      { id: 'lc-scrub', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'scrub', 'shrub'] as any, paint: { 'fill-color': '#6a8e52' } },
      { id: 'lc-sand', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover', filter: ['in', 'class', 'sand', 'beach'] as any, paint: { 'fill-color': '#c8a84b' } },
      { id: 'water', type: 'fill' as const, source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': '#527a99', 'fill-antialias': true } },
      { id: 'waterway', type: 'line' as const, source: 'ofm', 'source-layer': 'waterway', paint: { 'line-color': '#527a99', 'line-width': 1.5 } },
      { id: 'lu-farm', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse', filter: ['in', 'class', 'farmland', 'farmyard', 'agriculture'] as any, paint: { 'fill-color': '#7a9e5e' } },
      { id: 'lu-military', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse', filter: ['==', 'class', 'military'] as any, paint: { 'fill-color': '#8a8870' } },
      { id: 'lu-cemetery', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse', filter: ['==', 'class', 'cemetery'] as any, paint: { 'fill-color': '#628050' } },
      { id: 'lu-residential', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse', filter: ['in', 'class', 'residential', 'commercial', 'industrial', 'retail', 'hospital', 'school', 'university', 'neighbourhood', 'suburb'] as any, paint: { 'fill-color': '#d8d8d2' } },
      { id: 'park', type: 'fill' as const, source: 'ofm', 'source-layer': 'park', paint: { 'fill-color': '#5c9248' } },
      { id: 'aeroway-fill', type: 'fill' as const, source: 'ofm', 'source-layer': 'aeroway', minzoom: 11, filter: ['in', 'class', 'runway', 'taxiway'] as any, paint: { 'fill-color': '#888888' } },
      { id: 'aeroway-line', type: 'line' as const, source: 'ofm', 'source-layer': 'aeroway', minzoom: 11, paint: { 'line-color': '#888888', 'line-width': 2 } },
      { id: 'road-path', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 14, filter: ['in', 'class', 'path', 'track', 'footway', 'cycleway'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 14, 1.2, 16, 2.5, 18, 4.5] as any } },
      { id: 'road-service', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 13, filter: ['==', 'class', 'service'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 13, 1.5, 15, 3.8, 18, 7.0] as any } },
      { id: 'road-minor', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 12, filter: ['in', 'class', 'minor', 'street', 'street_limited', 'residential'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 1.5, 14, 3.8, 16, 7.5, 18, 13.0] as any } },
      { id: 'road-secondary', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 10, filter: ['in', 'class', 'secondary', 'tertiary'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 1.5, 13, 3.8, 16, 9.5, 18, 16.0] as any } },
      { id: 'road-primary', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 8, filter: ['==', 'class', 'primary'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 1.5, 11, 3.2, 14, 7.0, 16, 12.0, 18, 20.0] as any } },
      { id: 'road-trunk', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 6, filter: ['==', 'class', 'trunk'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 6, 1.2, 9, 2.8, 13, 6.5, 16, 14.0, 18, 24.0] as any } },
      { id: 'road-motorway', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 4, filter: ['==', 'class', 'motorway'] as any, layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const }, paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 4, 1.0, 8, 2.5, 12, 6.0, 16, 16.0, 18, 28.0] as any } },
      { id: 'building', type: 'fill' as const, source: 'ofm', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': '#c0c0b8', 'fill-outline-color': '#a0a098' } },
      {
        id: 'label-road-minor', type: 'symbol' as const, source: 'ofm', 'source-layer': 'transportation_name',
        filter: ['in', 'class', 'minor', 'service', 'street', 'street_limited'] as any,
        layout: {
          'symbol-placement': 'line' as const,
          'text-field': ['get', 'name'] as any,
          'text-font': ['Noto Sans Bold'] as any,
          'text-size': 10,
          'text-max-angle': 30,
          'text-letter-spacing': 0.05,
          'text-padding': 2,
          'text-rotation-alignment': 'map' as const,
          'text-pitch-alignment': 'viewport' as const,
        } as any,
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 2.5,
        } as any,
      },
      {
        id: 'label-road-secondary', type: 'symbol' as const, source: 'ofm', 'source-layer': 'transportation_name',
        filter: ['in', 'class', 'secondary', 'tertiary'] as any,
        layout: {
          'symbol-placement': 'line' as const,
          'text-field': ['get', 'name'] as any,
          'text-font': ['Noto Sans Bold'] as any,
          'text-size': 11,
          'text-max-angle': 30,
          'text-letter-spacing': 0.05,
          'text-padding': 2,
          'text-rotation-alignment': 'map' as const,
          'text-pitch-alignment': 'viewport' as const,
        } as any,
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 2,
        } as any,
      },
      {
        id: 'label-road-primary', type: 'symbol' as const, source: 'ofm', 'source-layer': 'transportation_name',
        filter: ['in', 'class', 'primary', 'trunk', 'motorway'] as any,
        layout: {
          'symbol-placement': 'line' as const,
          'text-field': ['get', 'name'] as any,
          'text-font': ['Noto Sans Bold'] as any,
          'text-size': 13,
          'text-max-angle': 30,
          'text-letter-spacing': 0.1,
          'text-padding': 2,
          'text-rotation-alignment': 'map' as const,
          'text-pitch-alignment': 'viewport' as const,
        } as any,
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 2.5,
        } as any,
      },
    ]
  } as any
};

function FullMapContent() {
  const searchParams = useSearchParams();

  // Helper to parse boolean query parameter
  const parseBoolParam = (param: string | null): boolean | null => {
    if (param === null) return null;
    return param !== 'false' && param !== '0' && param !== 'no' && param !== 'off';
  };

  const queryStyle = searchParams.get('style') as 'auto' | 'dark' | 'gta5' | null;
  const queryZoom = searchParams.get('zoom') ? parseFloat(searchParams.get('zoom')!) : null;
  const queryPitch = searchParams.get('pitch') ? parseFloat(searchParams.get('pitch')!) : null;
  const queryScaleParam = searchParams.get('scale') || searchParams.get('uiscale') || searchParams.get('size');
  const queryScale = queryScaleParam ? parseFloat(queryScaleParam) : null;
  const queryRes = searchParams.get('res') || searchParams.get('aspect') || searchParams.get('ratio') || null;
  const queryInteractive = searchParams.get('interactive') === 'true' || searchParams.get('interactive') === '1';

  // Individual UI component query overrides
  const queryHud = parseBoolParam(searchParams.get('hud'));
  const querySpeed = parseBoolParam(searchParams.get('speed'));
  const queryTime = parseBoolParam(searchParams.get('time'));
  const queryAltitude = parseBoolParam(searchParams.get('altitude') ?? searchParams.get('height') ?? searchParams.get('alt'));
  const queryCoords = parseBoolParam(searchParams.get('coords') ?? searchParams.get('coordinates') ?? searchParams.get('latlon'));
  const queryLocation = parseBoolParam(searchParams.get('location') ?? searchParams.get('city') ?? searchParams.get('address'));
  const queryHeading = parseBoolParam(searchParams.get('heading') ?? searchParams.get('compass'));
  const queryStatus = parseBoolParam(searchParams.get('status') ?? searchParams.get('gps'));
  const queryTrail = parseBoolParam(searchParams.get('trail') ?? searchParams.get('path'));
  const queryControls = parseBoolParam(searchParams.get('controls') ?? searchParams.get('dock') ?? searchParams.get('toolbar'));

  // Live Settings State
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULT_OVERLAY_SETTINGS);

  // Map state
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const rawStyle = queryStyle || settings.mapStyle || 'gta5';
  const resolvedStyle: 'auto' | 'dark' | 'gta5' = (rawStyle === 'dark' || rawStyle === 'gta5' || rawStyle === 'auto') ? rawStyle : 'gta5';
  const [activeStyle, setActiveStyle] = useState<'auto' | 'dark' | 'gta5'>(resolvedStyle);
  const [prevStyle, setPrevStyle] = useState(resolvedStyle);
  if (resolvedStyle !== prevStyle) {
    setPrevStyle(resolvedStyle);
    setActiveStyle(resolvedStyle);
  }

  const resolvedPitch = queryPitch !== null ? queryPitch : (typeof settings.mapPitch === 'number' ? settings.mapPitch : 0);
  const [currentPitch, setCurrentPitch] = useState<number>(resolvedPitch);
  const [prevPitch, setPrevPitch] = useState(resolvedPitch);
  if (resolvedPitch !== prevPitch) {
    setPrevPitch(resolvedPitch);
    setCurrentPitch(resolvedPitch);
  }
  const [isFollowing, setIsFollowing] = useState<boolean>(true);
  const [copiedLink, setCopiedLink] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Auto-hide bottom controls: appear on mouse movement/hover, disappear when idle
  const [isDockHovered, setIsDockHovered] = useState<boolean>(false);
  const [mouseActive, setMouseActive] = useState<boolean>(false);

  useEffect(() => {
    let hideTimer: NodeJS.Timeout | null = null;

    const handleActivity = () => {
      setMouseActive(true);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        setMouseActive(false);
      }, 3000);
    };

    const handleMouseLeave = () => {
      if (hideTimer) clearTimeout(hideTimer);
      setMouseActive(false);
      setIsDockHovered(false);
    };

    window.addEventListener('mousemove', handleActivity, { passive: true });
    window.addEventListener('touchstart', handleActivity, { passive: true });
    window.addEventListener('pointermove', handleActivity, { passive: true });
    document.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('pointermove', handleActivity);
      document.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  const isDockOpen = mouseActive || isDockHovered;

  // Aspect ratio / Resolution mode: '1080p' | '720p' | '1080x1920' | '720x1280' | 'fill'
  const parseResolution = (res: string | null): '1080p' | '720p' | '1080x1920' | '720x1280' | 'fill' => {
    if (!res) return '1080p';
    if (res === '720p' || res === '1280x720') return '720p';
    if (res === '1080p' || res === '1920x1080' || res === 'horizontal' || res === '16:9' || res === 'landscape') return '1080p';
    if (res === '720x1280' || res === '720p-vertical' || res === '720x1280-vertical') return '720x1280';
    if (res === '1080x1920' || res === 'vertical' || res === '9:16' || res === 'portrait') return '1080x1920';
    if (res === 'fill') return 'fill';
    return '1080p';
  };

  const initialAspect = parseResolution(queryRes || settings.mapFormat || null);
  const [aspectRatio, setAspectRatio] = useState<'1080p' | '720p' | '1080x1920' | '720x1280' | 'fill'>(initialAspect);
  const [prevAspect, setPrevAspect] = useState(initialAspect);
  if (initialAspect !== prevAspect) {
    setPrevAspect(initialAspect);
    setAspectRatio(initialAspect);
  }

  // Streamer Telemetry State
  const [coords, setCoords] = useState<[number, number]>([0, 0]);
  const [hasValidGps, setHasValidGps] = useState<boolean>(false);
  const [currentSpeed, setCurrentSpeed] = useState<number>(0);
  const [currentAltitude, setCurrentAltitude] = useState<number | null>(null);
  const [heading, setHeading] = useState<number>(0);
  const [locationName, setLocationName] = useState<{ primary: string; secondary?: string; countryCode?: string } | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [timeStr, setTimeStr] = useState<string>('');
  const [isNight, setIsNight] = useState<boolean>(false);

  // Computed live UI element visibility (Query param override > live saved profile settings)
  const showHud = queryHud !== null ? queryHud : (settings.mapShowHud ?? true);
  const showSpeed = querySpeed !== null ? querySpeed : (settings.mapShowSpeed ?? true);
  const showTime = queryTime !== null ? queryTime : (settings.mapShowTime ?? true);
  const showAltitude = queryAltitude !== null ? queryAltitude : (settings.mapShowAltitude ?? true);
  const showCoords = queryCoords !== null ? queryCoords : (settings.mapShowCoords ?? true);
  const showLocation = queryLocation !== null ? queryLocation : (settings.mapShowLocation ?? true);
  const showHeading = queryHeading !== null ? queryHeading : (settings.mapShowHeading ?? true);
  const showStatus = queryStatus !== null ? queryStatus : (settings.mapShowStatus ?? true);
  const showTrail = queryTrail !== null ? queryTrail : (settings.mapShowTrail ?? true);
  const showControls = queryControls !== null ? queryControls : (settings.mapShowControls ?? true);

  // Tracking history for GPS trail
  const trailCoordinatesRef = useRef<[number, number][]>([]);
  const lastCoordsRef = useRef<[number, number] | null>(null);
  const lastCoordsTimestampRef = useRef<number>(0);
  const lastLocationFetchTime = useRef<number>(0);

  // Zoom state (Query override > settings > default 15)
  const resolvedTargetZoom = typeof queryZoom === 'number' && !isNaN(queryZoom) && queryZoom > 0
    ? queryZoom
    : (typeof settings.mapZoom === 'number' && !isNaN(settings.mapZoom) && settings.mapZoom > 0
      ? settings.mapZoom
      : (typeof settings.customMapZoom === 'number' && !isNaN(settings.customMapZoom) && settings.customMapZoom > 0
        ? settings.customMapZoom
        : (settings.mapZoomLevel && ZOOM_LEVELS[settings.mapZoomLevel] ? ZOOM_LEVELS[settings.mapZoomLevel] : 15)));

  const [currentZoom, setCurrentZoom] = useState<number>(resolvedTargetZoom);
  const [prevTargetZoom, setPrevTargetZoom] = useState<number>(resolvedTargetZoom);
  if (resolvedTargetZoom !== prevTargetZoom) {
    setPrevTargetZoom(resolvedTargetZoom);
    setCurrentZoom(resolvedTargetZoom);
  }

  // Compute active target zoom
  const targetZoom = resolvedTargetZoom;

  // Compute active Map UI Scale
  const uiScale = useMemo(() => {
    if (typeof queryScale === 'number' && !isNaN(queryScale) && queryScale > 0) return queryScale;
    if (typeof settings.mapUiScale === 'number' && !isNaN(settings.mapUiScale) && settings.mapUiScale > 0) return settings.mapUiScale;
    return 1.0;
  }, [queryScale, settings.mapUiScale]);

  // Initial settings load and SSE synchronization
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch(`/api/get-settings?_t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data) {
            setSettings(prev => ({ ...DEFAULT_OVERLAY_SETTINGS, ...prev, ...data }));
          }
        }
      } catch (err) {
        console.warn('Failed to load settings in map:', err);
      }
    };

    loadSettings();

    const eventSource = new EventSource('/api/settings-stream');
    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.type === 'settings_update') {
          const { type: _type, timestamp: _timestamp, ...settingsData } = data;
          setSettings(prev => ({ ...prev, ...settingsData }));
        }
      } catch {}
    };

    return () => {
      eventSource.close();
    };
  }, []);


  // Active ResizeObserver & resize triggers to keep WebGL projection matrix 100% distortion-free
  useEffect(() => {
    if (!mapContainer.current) return;
    const container = mapContainer.current;

    const handleResize = () => {
      if (mapRef.current) {
        mapRef.current.resize();
      }
    };

    const ro = new ResizeObserver(() => {
      handleResize();
    });
    ro.observe(container);

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    // Multiple staggered resizes on mount to handle OBS browser source delayed viewport resolution
    const t1 = setTimeout(handleResize, 50);
    const t2 = setTimeout(handleResize, 150);
    const t3 = setTimeout(handleResize, 400);
    const t4 = setTimeout(handleResize, 1000);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [mapLoaded, aspectRatio]);


  // Update Trail layer visibility on the live map
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    if (map.getLayer('gps-trail-layer')) {
      map.setLayoutProperty('gps-trail-layer', 'visibility', showTrail ? 'visible' : 'none');
    }
  }, [showTrail, mapLoaded]);

  // Local Clock updater based on timezone
  useEffect(() => {
    const updateClock = () => {
      try {
        const now = new Date();
        const options: Intl.DateTimeFormatOptions = {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
          timeZone: timezone || undefined
        };
        setTimeStr(new Intl.DateTimeFormat('en-US', options).format(now));
      } catch {
        setTimeStr(new Date().toLocaleTimeString());
      }
    };

    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, [timezone]);

  // Helper to determine map style specification
  const getStyleSpec = useCallback((styleName: string, nightTime: boolean): maplibregl.StyleSpecification => {
    if (styleName === 'dark') return MAP_STYLES.dark;
    if (styleName === 'gta5' || styleName === 'gta' || styleName === 'standard') return MAP_STYLES.gta5;
    return nightTime ? MAP_STYLES.dark : MAP_STYLES.gta5;
  }, []);

  // Initialize MapLibre Map
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const initialLat = coords[0] !== 0 ? coords[0] : (settings.startLat || 35.6812);
    const initialLon = coords[1] !== 0 ? coords[1] : (settings.startLon || 139.7671);

    const styleSpec = getStyleSpec(activeStyle, isNight);

    try {
      const map = new maplibregl.Map({
        container: mapContainer.current,
        style: styleSpec,
        center: [initialLon, initialLat],
        zoom: targetZoom,
        pitch: currentPitch,
        interactive: queryInteractive, // OBS mode is non-interactive by default
        attributionControl: false
      });

      map.on('error', (e) => {
        console.warn('Map error:', e);
      });

      map.on('load', () => {
        map.resize();
        setMapLoaded(true);

        // Add GPS Trail Source and Layer
        if (!map.getSource('gps-trail')) {
          map.addSource('gps-trail', {
            type: 'geojson',
            data: {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: trailCoordinatesRef.current
              }
            }
          });

          // Glow outline
          map.addLayer({
            id: 'gps-trail-glow',
            type: 'line',
            source: 'gps-trail',
            layout: {
              'line-join': 'round',
              'line-cap': 'round'
            },
            paint: {
              'line-color': '#00f2fe',
              'line-width': 10,
              'line-opacity': 0.35,
              'line-blur': 4
            }
          });

          // Inner solid line
          map.addLayer({
            id: 'gps-trail-line',
            type: 'line',
            source: 'gps-trail',
            layout: {
              'line-join': 'round',
              'line-cap': 'round'
            },
            paint: {
              'line-color': '#38bdf8',
              'line-width': 4,
              'line-opacity': 0.95
            }
          });
        }

        // Custom Animated Pulse Marker Element
        const el = document.createElement('div');
        el.className = 'streamer-radar-marker';
        el.innerHTML = `
          <div class="radar-pulse-ring"></div>
          <div class="radar-pulse-ring delay"></div>
          <div class="radar-center-core">
            <div class="radar-heading-arrow" id="marker-heading-arrow">▲</div>
            <div class="radar-beacon-dot"></div>
          </div>
        `;

        const marker = new maplibregl.Marker({
          element: el,
          anchor: 'center'
        })
          .setLngLat([initialLon, initialLat])
          .addTo(map);

        markerRef.current = marker;
      });

      mapRef.current = map;
    } catch (err) {
      console.error('Failed to initialize full map:', err);
    }

    return () => {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []); // Run once on mount

  // Switch Style dynamically when activeStyle changes
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const styleSpec = getStyleSpec(activeStyle, isNight);
    try {
      mapRef.current.setStyle(styleSpec);

      // Re-add trail layers on style reload
      mapRef.current.once('style.load', () => {
        if (!mapRef.current) return;
        if (!mapRef.current.getSource('gps-trail')) {
          mapRef.current.addSource('gps-trail', {
            type: 'geojson',
            data: {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: trailCoordinatesRef.current
              }
            }
          });

          mapRef.current.addLayer({
            id: 'gps-trail-glow',
            type: 'line',
            source: 'gps-trail',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#00f2fe', 'line-width': 10, 'line-opacity': 0.35, 'line-blur': 4 }
          });

          mapRef.current.addLayer({
            id: 'gps-trail-line',
            type: 'line',
            source: 'gps-trail',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#38bdf8', 'line-width': 4, 'line-opacity': 0.95 }
          });
        }
      });
    } catch (err) {
      console.warn('Style change error:', err);
    }
  }, [activeStyle, isNight, mapLoaded, getStyleSpec]);

  // Update camera when currentZoom or currentPitch changes
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    mapRef.current.easeTo({
      zoom: currentZoom,
      pitch: currentPitch,
      duration: 600
    });
  }, [currentZoom, currentPitch, mapLoaded]);

  // Update GPS Trail Layer Visibility
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    try {
      const visibility = showTrail ? 'visible' : 'none';
      if (mapRef.current.getLayer('gps-trail-line')) {
        mapRef.current.setLayoutProperty('gps-trail-line', 'visibility', visibility);
      }
      if (mapRef.current.getLayer('gps-trail-glow')) {
        mapRef.current.setLayoutProperty('gps-trail-glow', 'visibility', visibility);
      }
    } catch {}
  }, [showTrail, mapLoaded]);

  // Update Marker & Map Camera position on GPS update
  const updateMapPosition = useCallback((lat: number, lon: number, currentHeading?: number) => {
    if (!mapRef.current || !mapLoaded) return;

    // Update marker position
    if (markerRef.current) {
      markerRef.current.setLngLat([lon, lat]);
      const arrowEl = document.getElementById('marker-heading-arrow');
      if (arrowEl && typeof currentHeading === 'number') {
        arrowEl.style.transform = `rotate(${currentHeading}deg)`;
        arrowEl.style.opacity = currentSpeed > 3 ? '1' : '0';
      }
    }

    // Update Trail Coordinates GeoJSON
    if (trailCoordinatesRef.current.length === 0 || 
        distanceInMeters(lat, lon, trailCoordinatesRef.current[trailCoordinatesRef.current.length - 1][1], trailCoordinatesRef.current[trailCoordinatesRef.current.length - 1][0]) > 5) {
      const updatedTrail: [number, number][] = [...trailCoordinatesRef.current, [lon, lat]];
      trailCoordinatesRef.current = updatedTrail.slice(-300);
      const source = mapRef.current.getSource('gps-trail') as maplibregl.GeoJSONSource;
      if (source) {
        source.setData({
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: trailCoordinatesRef.current
          }
        });
      }
    }

    // Smoothly pan camera if following
    if (isFollowing) {
      mapRef.current.easeTo({
        center: [lon, lat],
        duration: 1200,
        easing: (t) => t * (2 - t)
      });
    }
  }, [mapLoaded, isFollowing, currentSpeed]);

  // Reverse geocode location & timezone on coordinate changes
  const fetchLocationData = useCallback(async (lat: number, lon: number) => {
    const now = Date.now();
    if (now - lastLocationFetchTime.current < 20000) return; // 20s rate limit
    lastLocationFetchTime.current = now;

    try {
      if (API_KEYS.LOCATIONIQ && checkRateLimit('locationiq')) {
        const result: any = await fetchLocationFromLocationIQ(lat, lon, API_KEYS.LOCATIONIQ);
        if (result && result.location) {
          const loc: LocationData = result.location;
          const formatted = formatLocation(loc, settings.locationDisplay || 'city');
          setLocationName({
            primary: formatted.primary || loc.city || loc.town || 'Current Location',
            secondary: formatted.secondary || loc.country,
            countryCode: loc.countryCode
          });
          if (loc.timezone) {
            setTimezone(loc.timezone);
          }
        }
      } else {
        const fallback = createLocationWithCountryFallback(lat, lon);
        if (fallback) {
          setLocationName({
            primary: fallback.primary || fallback.secondary || 'Current Location',
            secondary: fallback.secondary,
            countryCode: fallback.countryCode
          });
        }
      }

      // Check day/night status and timezone from OpenWeatherMap
      if (API_KEYS.OPENWEATHER) {
        const weatherRes = await fetchWeatherAndTimezoneFromOpenWeatherMap(lat, lon, API_KEYS.OPENWEATHER);
        if (weatherRes && weatherRes.timezone) {
          setTimezone(weatherRes.timezone);
          setIsNight(isNightTimeFallback(weatherRes.timezone));
        } else {
          setIsNight(isNightTimeFallback(timezone || undefined));
        }
      } else {
        setIsNight(isNightTimeFallback(timezone || undefined));
      }
    } catch (e) {
      console.warn('Full map location fetch error:', e);
    }
  }, [settings.locationDisplay, timezone]);

  // RealtimeIRL (RTIRL) Client Setup
  useEffect(() => {
    const setupListener = () => {
      if (typeof window !== 'undefined' && window.RealtimeIRL && API_KEYS.RTIRL) {
        try {
          window.RealtimeIRL.forPullKey(API_KEYS.RTIRL).addListener((payload: any) => {
            if (!payload || typeof payload !== 'object') return;

            let lat: number | null = null;
            let lon: number | null = null;

            if (payload.location) {
              lat = payload.location.lat ?? payload.location.latitude ?? null;
              lon = payload.location.lon ?? payload.location.longitude ?? null;
            }

            if (lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
              setCoords([lat, lon]);
              setHasValidGps(true);

              // Calculate Speed
              let spd = 0;
              if (typeof payload.speed === 'number' && payload.speed >= 0) {
                spd = Math.round(payload.speed * 3.6); // m/s to km/h
              } else if (lastCoordsRef.current && lastCoordsTimestampRef.current > 0) {
                const moved = distanceInMeters(lat, lon, lastCoordsRef.current[0], lastCoordsRef.current[1]);
                const timeDiff = (Date.now() - lastCoordsTimestampRef.current) / 1000;
                if (timeDiff > 0.5) spd = Math.round((moved / timeDiff) * 3.6);
              }
              setCurrentSpeed(spd);

              // Calculate Heading
              let hdg = 0;
              if (typeof payload.bearing === 'number' || typeof payload.heading === 'number') {
                hdg = payload.bearing ?? payload.heading;
              } else if (lastCoordsRef.current) {
                const dLon = (lon - lastCoordsRef.current[1]) * (Math.PI / 180);
                const lat1 = lastCoordsRef.current[0] * (Math.PI / 180);
                const lat2 = lat * (Math.PI / 180);
                const y = Math.sin(dLon) * Math.cos(lat2);
                const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
                hdg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
              }
              setHeading(Math.round(hdg));

              // Extract Altitude
              if (payload.altitude !== undefined) {
                if (typeof payload.altitude === 'number') {
                  setCurrentAltitude(Math.round(payload.altitude));
                } else if (payload.altitude && typeof payload.altitude.EGM96 === 'number') {
                  setCurrentAltitude(Math.round(payload.altitude.EGM96));
                }
              }

              lastCoordsRef.current = [lat, lon];
              lastCoordsTimestampRef.current = Date.now();

              // Update map and marker
              updateMapPosition(lat, lon, hdg);

              // Update Location Info
              fetchLocationData(lat, lon);
            }
          });
        } catch (err) {
          console.error('Failed to register RTIRL listener for map:', err);
        }
      }
    };

    if (typeof window !== 'undefined' && window.RealtimeIRL) {
      setupListener();
    } else {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@rtirl/api@latest/lib/index.min.js';
      script.async = true;
      script.onload = setupListener;
      document.body.appendChild(script);
    }
  }, [updateMapPosition, fetchLocationData]);

  // Copy Map Link Helper with Aspect Ratio, Style, and UI parameters
  const copyMapLink = () => {
    if (typeof window !== 'undefined') {
      let url = `${window.location.origin}/map`;
      const params = new URLSearchParams();
      if (aspectRatio === '720p') {
        params.set('res', '720p');
      } else if (aspectRatio === '1080p') {
        params.set('res', '1080p');
      } else if (aspectRatio === '720x1280') {
        params.set('res', '720x1280');
      } else if (aspectRatio === '1080x1920') {
        params.set('res', '1080x1920');
      }
      if (activeStyle !== 'gta5') {
        params.set('style', activeStyle);
      }
      if (!showHud) params.set('hud', 'false');
      if (!showSpeed) params.set('speed', 'false');
      if (!showTime) params.set('time', 'false');
      if (!showAltitude) params.set('altitude', 'false');
      if (!showCoords) params.set('coords', 'false');
      if (!showLocation) params.set('location', 'false');
      if (!showHeading) params.set('heading', 'false');
      if (!showStatus) params.set('status', 'false');
      if (!showTrail) params.set('trail', 'false');
      if (currentPitch > 0) {
        params.set('pitch', currentPitch.toString());
      }
      if (currentZoom && currentZoom !== 15) {
        params.set('zoom', currentZoom.toString());
      }
      if (uiScale && uiScale !== 1.0) {
        params.set('scale', uiScale.toString());
      }
      const qs = params.toString();
      if (qs) {
        url += `?${qs}`;
      }
      navigator.clipboard.writeText(url);
      const labels: Record<string, string> = {
        '1080p': '1080p Horizontal',
        '720p': '720p Horizontal',
        '1080x1920': '1080x1920 Vertical',
        '720x1280': '720x1280 Vertical',
        'fill': 'Full Viewport'
      };
      const label = labels[aspectRatio] || aspectRatio;
      setToastMessage(`📋 Full Map link (${label}) copied to clipboard!`);
      setTimeout(() => setToastMessage(null), 3000);
    }
  };

  // Convert Heading Angle to Cardinal Direction
  const getCardinalDirection = (deg: number) => {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(((deg % 360) / 45)) % 8;
    return directions[idx];
  };

  const isVertical = aspectRatio === '1080x1920' || aspectRatio === '720x1280';
  const isHorizontal = aspectRatio === '1080p' || aspectRatio === '720p';

  return (
    <div
      className={`full-map-wrapper ${isVertical ? 'wrapper-vertical' : isHorizontal ? 'wrapper-horizontal' : 'wrapper-fill'}`}
      style={{ '--map-ui-scale': uiScale } as React.CSSProperties}
    >
      <style>{`
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        html, body {
          width: 100vw;
          height: 100vh;
          overflow: hidden;
          background-color: #050811;
          font-family: var(--font-montserrat, 'Montserrat', sans-serif);
          color: #ffffff;
          user-select: none;
        }

        .full-map-wrapper {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          overflow: hidden;
          background-color: #050811;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* Viewport Canvas Container */
        .map-viewport-container {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background-color: #0b0f19;
        }

        /* 1080p Horizontal Mode (16:9) */
        .map-viewport-container.horizontal-mode {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }

        /* 1080x1920 Vertical Mode (9:16) */
        .map-viewport-container.vertical-mode {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }

        /* Desktop widescreen preview mode (when testing vertical link on a standard horizontal 16:9 monitor) */
        @media (min-aspect-ratio: 1/1) {
          .wrapper-vertical .map-viewport-container.vertical-mode {
            position: relative;
            inset: auto;
            width: calc(100vh * (9 / 16));
            height: 100vh;
            max-width: 100vw;
            border: 1px solid rgba(56, 189, 248, 0.3);
            box-shadow: 0 0 50px rgba(0, 0, 0, 0.9), 0 0 20px rgba(56, 189, 248, 0.2);
            border-radius: 18px;
          }
        }

        /* When in OBS (1080x1920) or mobile window */
        @media (max-aspect-ratio: 1/1) {
          .map-viewport-container.vertical-mode {
            position: absolute !important;
            inset: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            border: none !important;
            border-radius: 0 !important;
            box-shadow: none !important;
          }
        }

        #full-map-container {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          width: 100% !important;
          height: 100% !important;
          z-index: 1;
        }

        #full-map-container canvas,
        .maplibregl-canvas-container,
        .maplibregl-canvas {
          width: 100% !important;
          height: 100% !important;
          display: block !important;
        }

        /* Animated Pulsing Streamer Beacon Marker */
        .streamer-radar-marker {
          position: relative;
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
        }

        .radar-pulse-ring {
          position: absolute;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          border: 2px solid #00f2fe;
          background: rgba(0, 242, 254, 0.25);
          animation: radarWave 2.4s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
        }

        .radar-pulse-ring.delay {
          animation-delay: 1.2s;
        }

        .radar-center-core {
          position: relative;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 0 16px #00f2fe, 0 0 32px #00f2fe, 0 2px 8px rgba(0,0,0,0.8);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 3;
        }

        .radar-beacon-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #00d2ff;
        }

        .radar-heading-arrow {
          position: absolute;
          top: -14px;
          font-size: 13px;
          color: #00f2fe;
          font-weight: 900;
          text-shadow: 0 0 8px rgba(0, 242, 254, 0.9);
          transition: transform 0.3s ease, opacity 0.3s ease;
          pointer-events: none;
        }

        @keyframes radarWave {
          0% {
            transform: scale(0.3);
            opacity: 1;
          }
          100% {
            transform: scale(2.6);
            opacity: 0;
          }
        }

        /* Glassmorphic HUD Overlays */
        .hud-overlay {
          position: absolute;
          z-index: 10;
          pointer-events: auto;
          display: flex;
          gap: 12px;
          transition: opacity 0.4s ease, transform 0.4s ease;
        }

        .hud-card {
          background: rgba(11, 15, 25, 0.78);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.15);
          border-radius: 14px;
          padding: 12px 16px;
        }

        .hud-top-left {
          top: 24px;
          left: 24px;
          flex-direction: column;
          max-width: 380px;
          transform: scale(var(--map-ui-scale, 1));
          transform-origin: top left;
        }

        .hud-top-right {
          top: 24px;
          right: 24px;
          flex-direction: column;
          align-items: flex-end;
          transform: scale(var(--map-ui-scale, 1));
          transform-origin: top right;
        }

        /* Vertical mode HUD layout adaptations */
        .vertical-mode .hud-top-left {
          top: 16px;
          left: 16px;
          max-width: 260px;
          padding: 10px 12px;
        }

        .vertical-mode .hud-top-right {
          top: 16px;
          right: 16px;
        }

        .vertical-mode .location-title {
          font-size: 1.05rem;
        }

        .vertical-mode .speed-number {
          font-size: 1.8rem;
        }

        .status-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 4px 10px;
          border-radius: 20px;
          background: rgba(34, 197, 94, 0.15);
          border: 1px solid rgba(34, 197, 94, 0.35);
          color: #4ade80;
        }

        .status-badge.connecting {
          background: rgba(234, 179, 8, 0.15);
          border-color: rgba(234, 179, 8, 0.35);
          color: #facc15;
        }

        .status-pulse-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: currentColor;
          box-shadow: 0 0 8px currentColor;
        }

        .location-title {
          font-size: 1.25rem;
          font-weight: 800;
          color: #ffffff;
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 6px;
          line-height: 1.2;
        }

        .location-sub {
          font-size: 0.85rem;
          color: #94a3b8;
          margin-top: 2px;
        }

        .coords-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-family: 'Consolas', monospace;
          font-size: 0.75rem;
          color: #38bdf8;
          background: rgba(56, 189, 248, 0.1);
          border: 1px solid rgba(56, 189, 248, 0.25);
          padding: 3px 8px;
          border-radius: 6px;
          margin-top: 8px;
        }

        .speed-gauge-card {
          display: flex;
          align-items: baseline;
          gap: 8px;
          background: linear-gradient(135deg, rgba(14, 165, 233, 0.2), rgba(11, 15, 25, 0.85));
          border-color: rgba(56, 189, 248, 0.3);
        }

        .speed-number {
          font-size: 2.2rem;
          font-weight: 900;
          color: #ffffff;
          line-height: 1;
          letter-spacing: -0.02em;
        }

        .speed-unit {
          font-size: 0.85rem;
          font-weight: 700;
          color: #38bdf8;
          text-transform: uppercase;
        }

        .alt-time-row {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }

        .mini-stat-card {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.82rem;
          font-weight: 600;
          color: #e2e8f0;
          padding: 6px 12px;
          border-radius: 10px;
        }

        /* Bottom Floating Bar (Auto-hides on inactivity / mouse leave) */
        .bottom-dock {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%) translateY(28px) scale(0.95);
          opacity: 0;
          pointer-events: none;
          display: flex;
          align-items: center;
          gap: 8px;
          z-index: 100;
          padding: 6px 12px;
          border-radius: 40px;
          max-width: 95vw;
          flex-wrap: wrap;
          justify-content: center;
          transition: opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1), transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        }

        /* Visible when mouse is moving or hovering */
        .bottom-dock.dock-visible,
        .bottom-dock:hover,
        .bottom-dock:focus-within {
          opacity: 1;
          pointer-events: auto;
          transform: translateX(-50%) translateY(0) scale(1);
        }

        /* Bottom hover trigger zone */
        .bottom-dock-trigger-zone {
          position: fixed;
          bottom: 0;
          left: 0;
          width: 100vw;
          height: 100px;
          z-index: 99;
          pointer-events: auto;
        }

        /* Dropdown styling */
        .dock-select-group {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(56, 189, 248, 0.35);
          border-radius: 20px;
          padding: 4px 10px 4px 12px;
          transition: all 0.2s ease;
        }

        .dock-select-group:hover, .dock-select-group:focus-within {
          background: rgba(56, 189, 248, 0.18);
          border-color: #38bdf8;
          box-shadow: 0 0 12px rgba(56, 189, 248, 0.3);
        }

        .dock-select-label {
          font-size: 0.72rem;
          font-weight: 800;
          color: #38bdf8;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          white-space: nowrap;
        }

        .dock-select {
          background: transparent;
          border: none;
          color: #ffffff;
          font-family: inherit;
          font-size: 0.82rem;
          font-weight: 700;
          cursor: pointer;
          outline: none;
          padding: 2px 4px;
        }

        .dock-select option {
          background: #0f172a;
          color: #ffffff;
          padding: 8px;
        }

        .dock-btn {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: #ffffff;
          padding: 8px 14px;
          border-radius: 20px;
          font-size: 0.8rem;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: all 0.2s ease;
          white-space: nowrap;
        }

        /* Zoom Control Group */
        .dock-zoom-group {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 20px;
          padding: 2px 6px;
        }

        .dock-zoom-label {
          font-size: 0.76rem;
          font-weight: 800;
          color: #38bdf8;
          padding: 0 4px;
          min-width: 52px;
          text-align: center;
          user-select: none;
        }

        .dock-btn-icon {
          background: transparent;
          border: none;
          color: #ffffff;
          font-size: 0.8rem;
          font-weight: 800;
          cursor: pointer;
          padding: 4px 6px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s ease;
        }

        .dock-btn-icon:hover {
          background: rgba(56, 189, 248, 0.25);
          color: #38bdf8;
          transform: scale(1.15);
        }

        .dock-btn-icon:active {
          transform: scale(0.95);
        }

        .dock-btn:hover, .dock-btn.active {
          background: #38bdf8;
          color: #040711;
          border-color: #38bdf8;
          box-shadow: 0 0 16px rgba(56, 189, 248, 0.4);
        }

        .toast-popup {
          position: fixed;
          bottom: 90px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(16, 185, 129, 0.92);
          backdrop-filter: blur(10px);
          color: #ffffff;
          padding: 10px 20px;
          border-radius: 10px;
          font-weight: 700;
          font-size: 0.9rem;
          box-shadow: 0 10px 25px rgba(0,0,0,0.4);
          z-index: 9999;
          animation: toastSlide 0.3s ease-out;
        }

        @keyframes toastSlide {
          from { transform: translate(-50%, 15px); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }

        /* Clean mode for minimal OBS capture */
        .clean-mode .hud-overlay {
          display: none !important;
        }
      `}</style>

      {/* Main Viewport Container (Handles 1080p, 720p, Vertical 1080x1920, Vertical 720x1280, or Fill) */}
      <div className={`map-viewport-container ${isVertical ? 'vertical-mode' : isHorizontal ? 'horizontal-mode' : 'fill-mode'}`}>
        <div id="full-map-container" ref={mapContainer} />

        {/* Top Left Location & Signal HUD */}
        {showHud && (showStatus || (showHeading && heading > 0) || showLocation || showCoords) && (
          <div className="hud-overlay hud-top-left">
            <div className="hud-card">
              {(showStatus || (showHeading && heading > 0)) && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  {showStatus && (
                    <div className={`status-badge ${hasValidGps ? 'live' : 'connecting'}`}>
                      <span className="status-pulse-dot" />
                      <span>{hasValidGps ? '🟢 LIVE GPS' : '🟡 SEARCHING GPS'}</span>
                    </div>
                  )}
                  {showHeading && heading > 0 && (
                    <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#38bdf8', background: 'rgba(56,189,248,0.1)', padding: '3px 8px', borderRadius: '6px', border: '1px solid rgba(56,189,248,0.2)' }}>
                      🧭 {getCardinalDirection(heading)} ({heading}°)
                    </div>
                  )}
                </div>
              )}

              {showLocation && (
                <>
                  <div className="location-title">
                    {locationName?.countryCode && (
                      <img
                        src={`https://flagcdn.com/${locationName.countryCode.toLowerCase()}.svg`}
                        alt="Flag"
                        width={24}
                        height={16}
                        style={{ borderRadius: '2px', objectFit: 'cover' }}
                      />
                    )}
                    <span>{locationName?.primary || 'Streamer Location'}</span>
                  </div>

                  {locationName?.secondary && (
                    <div className="location-sub">
                      {locationName.secondary}
                    </div>
                  )}
                </>
              )}

              {showCoords && (
                <div className="coords-chip">
                  <span>📍</span>
                  <span>{coords[0] !== 0 ? `${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}` : 'Waiting for telemetry...'}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Top Right Speed & Telemetry HUD */}
        {showHud && (showSpeed || (showAltitude && currentAltitude !== null) || (showTime && Boolean(timeStr))) && (
          <div className="hud-overlay hud-top-right">
            {showSpeed && (
              <div className="hud-card speed-gauge-card">
                <div className="speed-number">{currentSpeed}</div>
                <div className="speed-unit">KM/H</div>
                <div style={{ fontSize: '1rem', opacity: 0.6, marginLeft: '4px' }}>
                  ({kmhToMph(currentSpeed)} MPH)
                </div>
              </div>
            )}

            {((showAltitude && currentAltitude !== null) || (showTime && Boolean(timeStr))) && (
              <div className="alt-time-row">
                {showAltitude && currentAltitude !== null && (
                  <div className="hud-card mini-stat-card">
                    <span>⛰️</span>
                    <span>{currentAltitude}m ({metersToFeet(currentAltitude)}ft)</span>
                  </div>
                )}
                {showTime && timeStr && (
                  <div className="hud-card mini-stat-card">
                    <span>🕐</span>
                    <span>{timeStr}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Toast Confirmation */}
      {toastMessage && (
        <div className="toast-popup">
          {toastMessage}
        </div>
      )}

      {/* Bottom Interactive Controls & Format Dropdown (Auto-hides on idle / no mouse) */}
      {showControls && (
        <>
          <div
            className="bottom-dock-trigger-zone"
            onMouseEnter={() => setIsDockHovered(true)}
            onMouseMove={() => setMouseActive(true)}
          />
          <div
            className={`hud-card bottom-dock ${isDockOpen ? 'dock-visible' : ''}`}
            onMouseEnter={() => setIsDockHovered(true)}
            onMouseLeave={() => setIsDockHovered(false)}
          >
            {/* Aspect Ratio / Resolution Selector Dropdown */}
            <div className="dock-select-group" title="Switch Map Format between 1080p, 720p, Vertical 1080x1920, Vertical 720x1280, or Auto Fill">
              <span className="dock-select-label">📺 Format:</span>
              <select
                className="dock-select"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as '1080p' | '720p' | '1080x1920' | '720x1280' | 'fill')}
              >
                <option value="1080p">🖥️ 1080p Horizontal (1920x1080)</option>
                <option value="720p">📺 720p Horizontal (1280x720)</option>
                <option value="1080x1920">📱 1080x1920 Vertical (9:16)</option>
                <option value="720x1280">📱 720x1280 Vertical (9:16)</option>
                <option value="fill">📐 Auto-Fill Window (100%)</option>
              </select>
            </div>

            <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.15)', margin: '0 2px' }} />

            {/* Style Switches */}
            <button
              className={`dock-btn ${activeStyle === 'gta5' ? 'active' : ''}`}
              onClick={() => setActiveStyle('gta5')}
              title="GTA V Authentic Vector Map"
            >
              🎮 GTA 5
            </button>
            <button
              className={`dock-btn ${activeStyle === 'dark' ? 'active' : ''}`}
              onClick={() => setActiveStyle('dark')}
              title="Dark Midnight Vector Map"
            >
              🌙 Dark
            </button>

            <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.15)', margin: '0 2px' }} />

            {/* 2D / 3D Pitch Toggle */}
            <button
              className={`dock-btn ${currentPitch > 0 ? 'active' : ''}`}
              onClick={() => setCurrentPitch(p => (p === 0 ? 45 : 0))}
              title="Toggle 2D / 3D Map Tilt"
            >
              {currentPitch > 0 ? '📐 3D' : '🗺️ 2D'}
            </button>

            <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.15)', margin: '0 2px' }} />

            {/* Zoom In / Zoom Out Controls */}
            <div className="dock-zoom-group" title="Adjust Map Zoom Level (1x to 20x)">
              <button
                className="dock-btn-icon"
                onClick={() => setCurrentZoom(z => Math.max(1, Math.round((z - 1) * 2) / 2))}
                title="Zoom Out (➖)"
              >
                ➖
              </button>
              <span className="dock-zoom-label" title={`Current Zoom: ${currentZoom.toFixed(1)}x`}>
                🔍 {currentZoom.toFixed(1)}x
              </span>
              <button
                className="dock-btn-icon"
                onClick={() => setCurrentZoom(z => Math.min(20, Math.round((z + 1) * 2) / 2))}
                title="Zoom In (➕)"
              >
                ➕
              </button>
            </div>

            <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.15)', margin: '0 2px' }} />

            {/* Copy OBS Link */}
            <button
              className="dock-btn"
              onClick={copyMapLink}
              style={{ background: 'rgba(16, 185, 129, 0.25)', borderColor: 'rgba(16, 185, 129, 0.5)', color: '#34d399' }}
              title={`Copy OBS Browser Source URL for ${aspectRatio === '1080x1920' ? '1080x1920 Vertical' : aspectRatio === '720x1280' ? '720x1280 Vertical' : aspectRatio === '720p' ? '720p Horizontal' : aspectRatio === '1080p' ? '1080p Horizontal' : 'Full Window'}`}
            >
              📋 Copy OBS Link
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function FullMapPage() {
  return (
    <Suspense fallback={<div style={{ width: '100vw', height: '100vh', background: '#0b0f19', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#38bdf8', fontFamily: 'sans-serif' }}>🗺️ Loading Full Map...</div>}>
      <FullMapContent />
    </Suspense>
  );
}
