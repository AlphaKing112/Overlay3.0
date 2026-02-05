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
  bitrateDisplay?: DisplayMode;
  bitrateAnchor?: 'time' | 'location';
  showLowBitrateAlert?: boolean;
  showBitrateWarnings?: boolean;
  lowBitrateAlertScale?: number;
  lowBitrateAlertX?: number;
  lowBitrateAlertY?: number;
  todoListPosition?: 'left' | 'right';
  showCalorieTracker?: boolean;
  calorieGoal?: number;
  calorieTrackerScale?: number;
  calorieTrackerX?: number;
  calorieTrackerY?: number;
  minimapX?: number;
  minimapY?: number;
  minimapPosition?: 'left' | 'right';
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
  bitrateDisplay: 'auto',
  bitrateAnchor: 'location',
  showLowBitrateAlert: true,
  showBitrateWarnings: true,
  lowBitrateAlertScale: 0.6,
  lowBitrateAlertX: 0,
  lowBitrateAlertY: 0,
  todoListPosition: 'left',
  showCalorieTracker: false,
  calorieGoal: 500,
  calorieTrackerScale: 1,
  calorieTrackerX: 0,
  calorieTrackerY: 0,
  minimapX: 0,
  minimapY: 0,
  minimapPosition: 'left',
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
  mapStyle: 'string',
  bitrateDisplay: 'string',
  bitrateAnchor: 'string',
  showLowBitrateAlert: 'boolean',
  showBitrateWarnings: 'boolean',
  lowBitrateAlertScale: 'number',
  lowBitrateAlertX: 'number',
  lowBitrateAlertY: 'number',
  todoListPosition: 'string',
  showCalorieTracker: 'boolean',
  calorieGoal: 'number',
  calorieTrackerScale: 'number',
  calorieTrackerX: 'number',
  calorieTrackerY: 'number',
  minimapX: 'number',
  minimapY: 'number',
  minimapPosition: 'string',
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