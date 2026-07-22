"use client";

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapZoomLevel } from '@/types/settings';

interface MapLibreMinimapProps {
  lat: number;
  lon: number;
  isVisible: boolean;
  zoomLevel: MapZoomLevel;
  customZoom?: number;
  timezone?: string;
  isNight?: boolean; // Pass day/night state from parent
  mapStyle?: 'auto' | 'standard' | 'dark' | 'gta' | 'gta5';
  shape?: 'circle' | 'square';
}


const MINIMAP_CONFIG = {
  ZOOM_LEVELS: {
    neighbourhood: 15,  // Neighbourhood - streets & buildings (Clear street names)
    city: 13,          // City - whole city view (Major avenues/streets)
    state: 8,          // State - state/province view
    country: 5,       // Country - country view
    ocean: 3,          // Ocean - coastal view from sea
    continental: 1     // Continental - trans-oceanic, see entire ocean
  },
  MARKER_SIZE: 12,
  MARKER_COLOR: "#22c55e",
  MARKER_GLOW: "#22c55e80",
} as const;


// Available map styles - easily switch between them
const MAP_STYLES: Record<string, maplibregl.StyleSpecification> = {
  // CartoDB Voyager (clean, colorful, perfect for daytime)
  voyager: {
    version: 8 as const,
    sources: {
      'carto-voyager-base': {
        type: 'raster' as const,
        tiles: [
          'https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png'
        ] as string[],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors, © CartoDB'
      },
      'carto-voyager-labels': {
        type: 'raster' as const,
        tiles: [
          'https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png'
        ] as string[],
        tileSize: 256
      }
    },
    layers: [
      {
        id: 'carto-voyager-base',
        type: 'raster' as const,
        source: 'carto-voyager-base',
        minzoom: 0,
        maxzoom: 19
      },
      {
        id: 'carto-voyager-labels',
        type: 'raster' as const,
        source: 'carto-voyager-labels',
        minzoom: 0,
        maxzoom: 19
      }
    ]
  },
  // CartoDB Dark Matter (clean, dark, perfect for nighttime)
  dark: {
    version: 8 as const,
    sources: {
      'carto-dark-base': {
        type: 'raster' as const,
        tiles: [
          'https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png'
        ] as string[],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors, © CartoDB'
      },
      'carto-dark-labels': {
        type: 'raster' as const,
        tiles: [
          'https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png'
        ] as string[],
        tileSize: 256
      }
    },
    layers: [
      {
        id: 'carto-dark-base',
        type: 'raster' as const,
        source: 'carto-dark-base',
        minzoom: 0,
        maxzoom: 19
      },
      {
        id: 'carto-dark-labels',
        type: 'raster' as const,
        source: 'carto-dark-labels',
        minzoom: 0,
        maxzoom: 19
      }
    ]
  },
  // GTA V Style (Inverted Voyager Base for defined streets + Light Labels)
  gta: {
    version: 8 as const,
    sources: {
      'carto-voyager-base': {
        type: 'raster' as const,
        tiles: [
          'https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png'
        ] as string[],
        tileSize: 256,
        attribution: '© CartoDB'
      },
      'carto-light-labels': {
        type: 'raster' as const,
        tiles: [
          'https://a.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png'
        ] as string[],
        tileSize: 256
      }
    },
    layers: [
      {
        id: 'carto-voyager-base',
        type: 'raster' as const,
        source: 'carto-voyager-base',
        minzoom: 0,
        maxzoom: 19
      },
      {
        id: 'carto-light-labels',
        type: 'raster' as const,
        source: 'carto-light-labels',
        minzoom: 0,
        maxzoom: 19
      }
    ]
  },

  // GTA 5 Style - Authentic GTA V color palette using free vector tiles
  // Colors based on the GTA V minimap: white city blocks, black roads, olive green terrain,
  // gray mountains, brown dirt, blue-gray water
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
      // Background defaults to URBAN color (white city blocks)
      // This prevents the green bleeding through un-mapped city blocks
      { id: 'bg', type: 'background' as const,
        paint: { 'background-color': '#d8d8d2' } },

      // Terrain base - paint green over the whole landmass (non-water areas)
      // Use landcover to identify explicitly natural/rural areas
      // Rock / bare mountain - medium gray (GTA V mountain color)
      { id: 'lc-rock', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover',
        filter: ['in', 'class', 'rock', 'bare_rock', 'scree'] as any,
        paint: { 'fill-color': '#7a7a7a' } },

      // Forest / woodland - dark forest green
      { id: 'lc-wood', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover',
        filter: ['in', 'class', 'wood', 'forest'] as any,
        paint: { 'fill-color': '#3a6830' } },

      // Grass / meadow / wetland - bright grass green
      { id: 'lc-grass', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover',
        filter: ['in', 'class', 'grass', 'meadow', 'wetland', 'crop'] as any,
        paint: { 'fill-color': '#5c9248' } },

      // Scrub / brushland - muted olive green
      { id: 'lc-scrub', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover',
        filter: ['in', 'class', 'scrub', 'shrub'] as any,
        paint: { 'fill-color': '#6a8e52' } },

      // Sandy beach / coastal sand - golden yellow
      { id: 'lc-sand', type: 'fill' as const, source: 'ofm', 'source-layer': 'landcover',
        filter: ['in', 'class', 'sand', 'beach'] as any,
        paint: { 'fill-color': '#c8a84b' } },

      // Water bodies - steel blue (like GTA V water)
      { id: 'water', type: 'fill' as const, source: 'ofm', 'source-layer': 'water',
        paint: { 'fill-color': '#527a99', 'fill-antialias': true } },

      // Waterways (rivers, streams)
      { id: 'waterway', type: 'line' as const, source: 'ofm', 'source-layer': 'waterway',
        paint: { 'line-color': '#527a99', 'line-width': 1.5 } },

      // Farmland - slightly lighter field green
      { id: 'lu-farm', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse',
        filter: ['in', 'class', 'farmland', 'farmyard', 'agriculture'] as any,
        paint: { 'fill-color': '#7a9e5e' } },

      // Military zones - khaki/tan
      { id: 'lu-military', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse',
        filter: ['==', 'class', 'military'] as any,
        paint: { 'fill-color': '#8a8870' } },

      // Cemetery - dark muted green
      { id: 'lu-cemetery', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse',
        filter: ['==', 'class', 'cemetery'] as any,
        paint: { 'fill-color': '#628050' } },

      // Residential/Commercial city blocks - matches background (redundant but explicit)
      { id: 'lu-residential', type: 'fill' as const, source: 'ofm', 'source-layer': 'landuse',
        filter: ['in', 'class', 'residential', 'commercial', 'industrial', 'retail', 'hospital', 'school', 'university', 'neighbourhood', 'suburb'] as any,
        paint: { 'fill-color': '#d8d8d2' } },

      // Parks within urban areas - medium green
      { id: 'park', type: 'fill' as const, source: 'ofm', 'source-layer': 'park',
        paint: { 'fill-color': '#5c9248' } },

      // Airport runways/taxiways - gray
      { id: 'aeroway-fill', type: 'fill' as const, source: 'ofm', 'source-layer': 'aeroway', minzoom: 11,
        filter: ['in', 'class', 'runway', 'taxiway'] as any,
        paint: { 'fill-color': '#888888' } },
      { id: 'aeroway-line', type: 'line' as const, source: 'ofm', 'source-layer': 'aeroway', minzoom: 11,
        paint: { 'line-color': '#888888', 'line-width': 2 } },

      // Roads - paths/tracks (Only visible when zoomed in very close)
      { id: 'road-path', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 14,
        filter: ['in', 'class', 'path', 'track', 'footway', 'cycleway'] as any,
        layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const },
        paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 14, 0.4, 16, 1.2, 18, 2.5] as any } },

      // Roads - service/private drives (Only visible when zoomed in close)
      { id: 'road-service', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 13,
        filter: ['==', 'class', 'service'] as any,
        layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const },
        paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 13, 0.5, 15, 1.8, 18, 3.5] as any } },

      // Roads - minor streets / local residential (Only visible at neighborhood zoom 12+)
      { id: 'road-minor', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 12,
        filter: ['in', 'class', 'minor', 'street', 'street_limited', 'residential'] as any,
        layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const },
        paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.5, 15, 2.5, 18, 5] as any } },

      // Roads - secondary / tertiary (Visible at city zoom 10+)
      { id: 'road-secondary', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 10,
        filter: ['in', 'class', 'secondary', 'tertiary'] as any,
        layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const },
        paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 0.5, 13, 1.8, 16, 4, 18, 7.5] as any } },

      // Roads - primary arteries (Visible at metro zoom 8+)
      { id: 'road-primary', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 8,
        filter: ['==', 'class', 'primary'] as any,
        layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const },
        paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 0.5, 11, 1.5, 15, 4.5, 18, 9] as any } },

      // Roads - trunk roads (Visible at regional zoom 6+)
      { id: 'road-trunk', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 6,
        filter: ['==', 'class', 'trunk'] as any,
        layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const },
        paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 6, 0.4, 9, 1.2, 13, 3, 18, 11] as any } },

      // Roads - motorways / highways (Visible at country zoom 4+)
      { id: 'road-motorway', type: 'line' as const, source: 'ofm', 'source-layer': 'transportation', minzoom: 4,
        filter: ['==', 'class', 'motorway'] as any,
        layout: { 'line-join': 'round' as const, 'line-cap': 'round' as const },
        paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 4, 0.3, 8, 1.0, 12, 2.5, 16, 7, 18, 14] as any } },

      // Buildings - light gray fill (Only visible when zoomed in close 13+)
      { id: 'building', type: 'fill' as const, source: 'ofm', 'source-layer': 'building', minzoom: 13,
        paint: { 'fill-color': '#c0c0b8', 'fill-outline-color': '#a0a098' } },

      // ── LABELS ──────────────────────────────────────────────────────────────

      // Minor road names (streets, service roads) — White text with black stroke
      { id: 'label-road-minor', type: 'symbol' as const, source: 'ofm', 'source-layer': 'transportation_name',
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
          'text-halo-width': 2,
        } as any,
      },

      // Secondary / tertiary road names — White text with black stroke
      { id: 'label-road-secondary', type: 'symbol' as const, source: 'ofm', 'source-layer': 'transportation_name',
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

      // Primary / trunk / motorway road names — White text with black stroke
      { id: 'label-road-primary', type: 'symbol' as const, source: 'ofm', 'source-layer': 'transportation_name',
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


export default function MapLibreMinimap({
  lat,
  lon,
  isVisible,
  zoomLevel,
  customZoom,
  timezone,
  isNight,
  mapStyle = 'auto',
  shape = 'circle'
}: MapLibreMinimapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const [mapError, setMapError] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Compute effective zoom level (prefer custom numeric zoom if set)
  const targetZoom = typeof customZoom === 'number' && !isNaN(customZoom) && customZoom > 0
    ? customZoom
    : (MINIMAP_CONFIG.ZOOM_LEVELS[zoomLevel] || MINIMAP_CONFIG.ZOOM_LEVELS.city);

  // Initialize map (only once when first visible)
  useEffect(() => {
    if (!mapContainer.current || map.current || !isVisible) return;

    // Reset position tracking when map is initialized
    prevPosition.current = null;
    lastUpdateTime.current = 0;

    // Check WebGL support
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      console.warn('WebGL not supported, falling back to error state');
      setMapError(true);
      return;
    }

    // Determine which style to use
    let styleToUse: any = MAP_STYLES.voyager; // Default

    if (mapStyle === 'gta') {
      styleToUse = MAP_STYLES.gta;
    } else if (mapStyle === 'gta5') {
      styleToUse = MAP_STYLES.gta5;
    } else if (mapStyle === 'dark') {
      styleToUse = MAP_STYLES.dark;
    } else if (mapStyle === 'standard') {
      styleToUse = MAP_STYLES.voyager;
    } else {
      // Auto mode (default behavior)
      styleToUse = isNight ? MAP_STYLES.dark : MAP_STYLES.voyager;
    }

    // Initialize map
    try {
      map.current = new maplibregl.Map({
        container: mapContainer.current,
        style: styleToUse,
        center: [lon, lat],
        zoom: targetZoom,
        interactive: false, // Disable user interaction for overlay
        attributionControl: false,
        logoPosition: 'bottom-right'
      });

      // Add error handling
      map.current.on('error', (e) => {
        console.error('MapLibre error:', e);
        setMapError(true);
      });

      // Add load event
      map.current.on('load', () => {
        setMapLoaded(true);

        // Add marker
        const markerElement = document.createElement('div');
        markerElement.style.width = `${MINIMAP_CONFIG.MARKER_SIZE}px`;
        markerElement.style.height = `${MINIMAP_CONFIG.MARKER_SIZE}px`;
        markerElement.style.borderRadius = '50%';
        markerElement.style.backgroundColor = MINIMAP_CONFIG.MARKER_COLOR;
        markerElement.style.boxShadow = `0 0 8px ${MINIMAP_CONFIG.MARKER_GLOW}, 0 2px 4px rgba(0,0,0,0.3)`;
        markerElement.style.border = '2px solid white';
        markerElement.style.zIndex = '2';

        marker.current = new maplibregl.Marker({
          element: markerElement,
          anchor: 'center'
        })
          .setLngLat([lon, lat])
          .addTo(map.current!);
      });

    } catch (error) {
      console.error('Failed to initialize MapLibre:', error);
      setMapError(true);
    }

    // Cleanup
    return () => {
      if (marker.current) {
        marker.current.remove();
        marker.current = null;
      }
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]); // Only depend on isVisible - lat/lon/zoom intentionally omitted to prevent re-initialization

  // Track previous position to calculate movement distance
  const prevPosition = useRef<[number, number] | null>(null);
  const lastUpdateTime = useRef(0);
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Update map center and marker position efficiently
  useEffect(() => {
    if (!map.current || !marker.current || !mapLoaded) return;

    // Throttle updates to prevent excessive map operations (max once per 500ms)
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTime.current;
    const THROTTLE_MS = 500; // Minimum time between map updates

    // Clear any pending update
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
      updateTimeoutRef.current = null;
    }

    // Calculate movement distance if we have a previous position
    // Calculate movement distance if previous position exists
    // Note: Movement distance calculation is available for future pan threshold logic
    if (prevPosition.current) {
      const [prevLon, prevLat] = prevPosition.current;
      // Simple distance calculation (Haversine approximation)
      const R = 6371000; // Earth radius in meters
      const dLat = (lat - prevLat) * Math.PI / 180;
      const dLon = (lon - prevLon) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(prevLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      // Movement distance calculated but not currently used
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _movementDistance = R * c;
    }

    const MIN_PAN_DISTANCE = 100; // Only pan map if movement > 100m
    const shouldUpdateNow = timeSinceLastUpdate >= THROTTLE_MS;

    const updateMap = () => {
      try {
        // Recalculate movement distance at update time (in case position changed)
        let currentMovementDistance = Infinity;
        if (prevPosition.current) {
          const [prevLon, prevLat] = prevPosition.current;
          const R = 6371000; // Earth radius in meters
          const dLat = (lat - prevLat) * Math.PI / 180;
          const dLon = (lon - prevLon) * Math.PI / 180;
          const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(prevLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          currentMovementDistance = R * c;
        }

        // Always pan map to keep marker centered at [lon, lat]
        // Marker stays fixed in center, only map moves
        // For small movements, use shorter/faster animation to reduce visual impact
        const animationDuration = currentMovementDistance > MIN_PAN_DISTANCE ? 800 : 300;

        map.current!.easeTo({
          center: [lon, lat], // Pan map to keep marker centered
          duration: animationDuration,
          easing: (t) => t * (2 - t) // ease-out function
        });

        // Marker position matches map center, so it stays centered
        // We still update it to ensure it's at the exact coordinates
        marker.current!.setLngLat([lon, lat]);

        // Update previous position and timestamp
        prevPosition.current = [lon, lat];
        lastUpdateTime.current = Date.now();
      } catch (error) {
        console.error('Failed to update map position:', error);
      }
    };

    if (shouldUpdateNow) {
      // Update immediately if enough time has passed
      updateMap();
    } else {
      // Schedule update after throttle period
      updateTimeoutRef.current = setTimeout(updateMap, THROTTLE_MS - timeSinceLastUpdate);
    }

    // Cleanup timeout on unmount
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
        updateTimeoutRef.current = null;
      }
    };
  }, [lat, lon, mapLoaded]);

  // Update zoom level when zoom level setting or customZoom slider changes (with smooth animation)
  useEffect(() => {
    if (!map.current || !mapLoaded) return;

    try {
      map.current.easeTo({
        zoom: targetZoom,
        duration: 400, // smooth zoom transition
        easing: (t) => t * (2 - t)
      });
    } catch (error) {
      console.error('Failed to update map zoom:', error);
    }
  }, [targetZoom, zoomLevel, customZoom, mapLoaded]);

  // Handle style changes (night/day or manual selection)
  useEffect(() => {
    if (!map.current) return;

    let styleToUse: any = MAP_STYLES.voyager;

    if (mapStyle === 'gta') {
      styleToUse = MAP_STYLES.gta;
    } else if (mapStyle === 'gta5') {
      styleToUse = MAP_STYLES.gta5;
    } else if (mapStyle === 'dark') {
      styleToUse = MAP_STYLES.dark;
    } else if (mapStyle === 'standard') {
      styleToUse = MAP_STYLES.voyager;
    } else {
      // Auto mode
      styleToUse = isNight ? MAP_STYLES.dark : MAP_STYLES.voyager;
    }

    try {
      map.current.setStyle(styleToUse);
      console.log(`🗺️ Map style updated to ${mapStyle === 'auto' ? (isNight ? 'dark' : 'light') : mapStyle} mode`);
    } catch (error) {
      console.error('Failed to update map style:', error);
    }
  }, [isNight, mapStyle]);

  if (!isVisible) return null;

  if (mapError) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: shape === 'square' ? "14px" : "50%",
          overflow: "hidden",
          position: "relative",
          background: "#f8fafc",
          border: "2px solid rgba(255, 255, 255, 0.9)",
          boxShadow: "0 2px 4px rgba(0, 0, 0, 0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ textAlign: 'center', color: '#64748b' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🗺️</div>
          <div style={{ fontSize: '0.875rem' }}>Map unavailable</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={mapContainer}
      style={{
        width: "100%",
        height: "100%", // Fill parent container which is controlled by overlay/page.tsx
        // Fixed size is now handled by parent container scale
        borderRadius: shape === 'square' ? "14px" : "50%",
        overflow: "hidden",
        position: "relative",
        background: "#f8fafc",
        border: "2px solid rgba(255, 255, 255, 0.9)",
        boxShadow: "0 2px 4px rgba(0, 0, 0, 0.2)",
        transform: "translateZ(0)",
        outline: "none",
        WebkitFontSmoothing: "antialiased",
        MozOsxFontSmoothing: "grayscale",
        // CSS filter transformations per map style
        // GTA (original): invert+grayscale for blueprint look
        // GTA5: uses a custom vector style - no CSS filter needed
        filter: mapStyle === 'gta'
          ? 'invert(1) grayscale(1) brightness(3) contrast(1.3)'
          : 'none'
      }}
    />
  );
}
