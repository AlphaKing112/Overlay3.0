// Centralized settings types and constants

export type LocationDisplayMode = 'neighbourhood' | 'city' | 'state' | 'country' | 'custom' | 'hidden';
export type MapZoomLevel = 'neighbourhood' | 'city' | 'state' | 'country' | 'ocean' | 'continental';
export type DisplayMode = 'always' | 'auto' | 'hidden';

export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface UrlItem {
  id: string;
  url: string;
  label: string;
  active: boolean;
  type: 'text' | 'embed';
  scale?: number;
  x?: number;
  y?: number;
}

export interface OverlaySettings {
  locationDisplay: LocationDisplayMode;
  customLocation?: string;
  showCountryName: boolean;
  showWeather: boolean;
  weatherConditionDisplay: DisplayMode;
  showMinimap: boolean;
  minimapSpeedBased: boolean;
  mapZoomLevel: MapZoomLevel;
  altitudeDisplay: DisplayMode;
  speedDisplay: DisplayMode;
  todos?: TodoItem[];
  showTodoList?: boolean;
  urls?: UrlItem[];
  showUrls?: boolean;
  swapLocationTimePositions?: boolean;
  minimapScale?: number;
  showBackground?: boolean;
  mapStyle?: 'auto' | 'standard' | 'dark' | 'gta';
}

// Default settings (single source of truth)
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  locationDisplay: 'neighbourhood',
  customLocation: '',
  showCountryName: true,
  showWeather: true,
  weatherConditionDisplay: 'auto',
  showMinimap: false,
  minimapSpeedBased: false,
  mapZoomLevel: 'city',
  altitudeDisplay: 'auto',
  speedDisplay: 'auto',
  todos: [],
  showTodoList: false,
  urls: [],
  showUrls: false,
  swapLocationTimePositions: false,
  minimapScale: 100,
  showBackground: true,
  mapStyle: 'auto',
};

// Valid settings schema for validation
// Note: 'todos' and 'urls' are handled separately in the validator as they are arrays
export const SETTINGS_CONFIG: Record<Exclude<keyof OverlaySettings, 'todos' | 'urls'>, 'boolean' | 'string' | 'number'> = {
  locationDisplay: 'string',
  customLocation: 'string',
  showCountryName: 'boolean',
  showWeather: 'boolean',
  weatherConditionDisplay: 'string',
  showMinimap: 'boolean',
  minimapSpeedBased: 'boolean',
  mapZoomLevel: 'string',
  altitudeDisplay: 'string',
  speedDisplay: 'string',
  showTodoList: 'boolean',
  showUrls: 'boolean',
  swapLocationTimePositions: 'boolean',
  minimapScale: 'number',
  showBackground: 'boolean',
  mapStyle: 'string'
};

// SSE message types
export interface SettingsUpdateMessage {
  type: 'settings_update';
  timestamp: number;
  // All OverlaySettings properties will be spread here
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  timestamp: number;
}

export type SSEMessage = SettingsUpdateMessage | HeartbeatMessage; 