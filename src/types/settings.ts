// Centralized settings types and constants

export type LocationDisplayMode = 'neighbourhood' | 'city' | 'state' | 'country' | 'custom' | 'hidden';
export type MapZoomLevel = 'neighbourhood' | 'city' | 'state' | 'country' | 'ocean' | 'continental';
export type DisplayMode = 'always' | 'auto' | 'hidden';

export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  current?: number;
  goal?: number;
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

export interface DonationGoal {
  id: string;
  name: string;
  goal: number;
  current: number;
  duration?: number;
  lastTriggered?: number;
}

export interface OverlaySettings {
  locationDisplay: LocationDisplayMode;
  customLocation?: string;
  showCountryName: boolean;
  showWeather: boolean;
  weatherConditionDisplay: DisplayMode;
  temperatureUnit?: 'both' | 'F';
  showDate?: boolean;
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
  lowBitrateAlertFont?: 'default' | 'neon' | 'retro' | 'bold' | 'impact';
  todoListPosition?: 'left' | 'right';
  showCalorieTracker?: boolean;
  calorieGoal?: number;
  calorieTrackerScale?: number;
  calorieTrackerX?: number;
  calorieTrackerY?: number;
  minimapX?: number;
  minimapY?: number;
  minimapPosition?: 'left' | 'right';
  showSocials?: boolean;
  socialXEnabled?: boolean;
  socialXName?: string;
  socialYoutubeEnabled?: boolean;
  socialYoutubeName?: string;
  socialInstagramEnabled?: boolean;
  socialInstagramName?: string;
  socialTiktokEnabled?: boolean;
  socialTiktokName?: string;
  socialRotateInterval?: number;
  socialPosition?: 'top-middle' | 'bottom-left';
  socialTextTheme?: 'default' | 'neon' | 'retro' | 'bold' | 'impact';
  socialShowBackground?: boolean;
  donationGoals?: DonationGoal[];
  showDonationGoals?: boolean;
  donationGoalsX?: number;
  donationGoalsY?: number;
  donationGoalsScale?: number;
  streamElementsEnabled?: boolean;
  streamElementsToken?: string;
  twitchRevenueSplit?: number;
  donationGoalsDuration?: number;
  timeWeatherLocationScale?: number;
}

// Default settings (single source of truth)
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  locationDisplay: 'neighbourhood',
  customLocation: '',
  showCountryName: true,
  showWeather: true,
  weatherConditionDisplay: 'auto',
  temperatureUnit: 'both',
  showDate: true,
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
  lowBitrateAlertFont: 'default',
  todoListPosition: 'left',
  showCalorieTracker: false,
  calorieGoal: 500,
  calorieTrackerScale: 1,
  calorieTrackerX: 0,
  calorieTrackerY: 0,
  minimapX: 0,
  minimapY: 0,
  minimapPosition: 'left',
  showSocials: false,
  socialXEnabled: false,
  socialXName: '',
  socialYoutubeEnabled: false,
  socialYoutubeName: '',
  socialInstagramEnabled: false,
  socialInstagramName: '',
  socialTiktokEnabled: false,
  socialTiktokName: '',
  socialRotateInterval: 5,
  socialPosition: 'top-middle',
  socialTextTheme: 'default',
  socialShowBackground: true,
  donationGoals: [],
  showDonationGoals: false,
  donationGoalsX: 0,
  donationGoalsY: 0,
  donationGoalsScale: 1,
  timeWeatherLocationScale: 1.0,
  streamElementsEnabled: false,
  streamElementsToken: '',
  twitchRevenueSplit: 50,
  donationGoalsDuration: 0,
};

// Valid settings schema for validation
// Note: 'todos', 'urls', and 'donationGoals' are handled separately in the validator as they are arrays
export const SETTINGS_CONFIG: Record<Exclude<keyof OverlaySettings, 'todos' | 'urls' | 'donationGoals'>, 'boolean' | 'string' | 'number'> = {
  locationDisplay: 'string',
  customLocation: 'string',
  showCountryName: 'boolean',
  showWeather: 'boolean',
  weatherConditionDisplay: 'string',
  temperatureUnit: 'string',
  showDate: 'boolean',
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
  lowBitrateAlertFont: 'string',
  todoListPosition: 'string',
  showCalorieTracker: 'boolean',
  calorieGoal: 'number',
  calorieTrackerScale: 'number',
  calorieTrackerX: 'number',
  calorieTrackerY: 'number',
  minimapX: 'number',
  minimapY: 'number',
  minimapPosition: 'string',
  showSocials: 'boolean',
  socialXEnabled: 'boolean',
  socialXName: 'string',
  socialYoutubeEnabled: 'boolean',
  socialYoutubeName: 'string',
  socialInstagramEnabled: 'boolean',
  socialInstagramName: 'string',
  socialTiktokEnabled: 'boolean',
  socialTiktokName: 'string',
  socialRotateInterval: 'number',
  socialPosition: 'string',
  socialTextTheme: 'string',
  socialShowBackground: 'boolean',
  showDonationGoals: 'boolean',
  donationGoalsX: 'number',
  donationGoalsY: 'number',
  donationGoalsScale: 'number',
  timeWeatherLocationScale: 'number',
  streamElementsEnabled: 'boolean',
  streamElementsToken: 'string',
  twitchRevenueSplit: 'number',
  donationGoalsDuration: 'number',
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