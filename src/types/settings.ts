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
  showWeatherWarnings?: boolean;
  showTimeWeatherLocation?: boolean;
  weatherConditionDisplay: DisplayMode;
  temperatureUnit?: 'both' | 'F';
  showDate?: boolean;
  showMinimap: boolean;
  minimapSpeedBased: boolean;
  mapZoomLevel: MapZoomLevel;
  customMapZoom?: number;
  altitudeDisplay: DisplayMode;
  speedDisplay: DisplayMode;
  todos?: TodoItem[];
  showTodoList?: boolean;
  urls?: UrlItem[];
  showUrls?: boolean;
  swapLocationTimePositions?: boolean;
  minimapScale?: number;
  showBackground?: boolean;
  mapStyle?: 'auto' | 'standard' | 'dark' | 'gta' | 'gta5';
  bitrateDisplay?: DisplayMode;
  bitrateAnchor?: 'time' | 'location';
  showLowBitrateAlert?: boolean;
  showBitrateWarnings?: boolean;
  globalFont?: string;
  globalTheme?: string;
  lowBitrateThreshold?: number;
  criticalBitrateThreshold?: number;
  lowBitrateAlertScale?: number;
  lowBitrateAlertX?: number;
  lowBitrateAlertY?: number;
  lowBitrateAlertFont?: 'disabled' | 'default' | 'neon' | 'retro' | 'bold' | 'impact' | 'basic';
  todoListPosition?: 'left' | 'right';
  todoTitle?: string;
  todoX?: number;
  todoY?: number;
  todoScale?: number;
  showCalorieTracker?: boolean;
  calorieGoal?: number;
  calorieTrackerScale?: number;
  calorieTrackerX?: number;
  calorieTrackerY?: number;
  showDistanceTracker?: boolean;
  distanceCurrent?: number;
  distanceGoal?: number;
  distanceUnit?: 'mi' | 'km' | 'm';
  distanceTitle?: string;
  distanceIcon?: string;
  distanceAutoGps?: boolean;
  distanceColor?: 'neon-green' | 'electric-blue' | 'cyber-pink' | 'sunset-orange' | 'gold';
  distanceStyle?: 'default' | 'compact' | 'no-background' | 'borderless';
  distanceFont?: 'default' | 'neon' | 'retro' | 'bold' | 'impact';
  distanceShowCurrentLocation?: boolean;
  distanceX?: number;
  distanceY?: number;
  distanceScale?: number;
  distanceMode?: 'manual' | 'destination';
  destinationLat?: number;
  destinationLon?: number;
  destinationName?: string;
  startLat?: number;
  startLon?: number;
  autoSetStartOnGps?: boolean;
  minimapX?: number;
  minimapY?: number;
  minimapPosition?: 'left' | 'right';
  minimapShape?: 'circle' | 'square';
  showSocials?: boolean;
  socialName?: string;
  socialKickEnabled?: boolean;
  socialTwitchEnabled?: boolean;
  socialXEnabled?: boolean;
  socialYoutubeEnabled?: boolean;
  socialInstagramEnabled?: boolean;
  socialTiktokEnabled?: boolean;
  socialPosition?: 'top-middle' | 'bottom-middle';
  socialX?: number;
  socialY?: number;
  socialScale?: number;
  socialTextTheme?: 'default' | 'neon' | 'retro' | 'bold' | 'impact';
  socialShowBackground?: boolean;
  socialFontFamily?: string;
  socialLoopAnimation?: boolean;
  socialLoopShowDuration?: number;
  socialLoopHideDuration?: number;
  donationGoals?: DonationGoal[];
  showDonationGoals?: boolean;
  donationGoalsX?: number;
  donationGoalsY?: number;
  donationGoalsScale?: number;
  donoShowBackground?: boolean;
  donoGoalText?: string;
  streamElementsEnabled?: boolean;
  streamElementsToken?: string;
  belaboxUrl?: string;
  belaboxPublisherKey?: string;
  twitchRevenueSplit?: number;
  donationGoalsDuration?: number;
  timeWeatherLocationScale?: number;
  totalTipGoal?: number;
  totalTipCurrent?: number;
  dailyTipGoal?: number;
  dailyTipCurrent?: number;
  dailyTipLastReset?: string;
  showSubGoals?: boolean;
  showTotalSubGoal?: boolean;
  showDailySubGoal?: boolean;
  totalSubGoal?: number;
  totalSubCurrent?: number;
  dailySubGoal?: number;
  dailySubCurrent?: number;
  dailySubLastReset?: string;
  subGoalsX?: number;
  subGoalsY?: number;
  subGoalsScale?: number;
  subGoalsStyle?: 'default' | 'no-bars' | 'no-background' | 'text-only';
  subGoalsFont?: 'default' | 'neon' | 'retro' | 'bold' | 'impact';
  subGoalsShowStroke?: boolean;
  seAutoSyncTotals?: boolean;
  twitchClientId?: string;
  twitchToken?: string;
  twitchBroadcasterId?: string;
  twitchUsername?: string;
  combineDateTimeWithLocation?: boolean;
  obsWebsocketUrl?: string;
  obsWebsocketPassword?: string;
  obsAutoSwitchSceneToggle?: boolean;
  obsOfflineSceneName?: string;
  obsLiveSceneName?: string;
  obsAutoSwitchDebugger?: boolean;
}

// Default settings (single source of truth)
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  locationDisplay: 'neighbourhood',
  customLocation: '',
  showCountryName: true,
  showWeather: true,
  showWeatherWarnings: true,
  showTimeWeatherLocation: true,
  weatherConditionDisplay: 'auto',
  temperatureUnit: 'both',
  showDate: true,
  showMinimap: false,
  minimapSpeedBased: false,
  mapZoomLevel: 'city',
  customMapZoom: 15,
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
  globalFont: 'default',
  globalTheme: 'default',
  lowBitrateThreshold: 1300,
  criticalBitrateThreshold: 900,
  lowBitrateAlertScale: 0.6,
  lowBitrateAlertX: 0,
  lowBitrateAlertY: 0,
  lowBitrateAlertFont: 'default',
  todoListPosition: 'left',
  todoTitle: '',
  todoX: 0,
  todoY: 0,
  todoScale: 1.0,
  showCalorieTracker: false,
  calorieGoal: 500,
  calorieTrackerScale: 1,
  calorieTrackerX: 0,
  calorieTrackerY: 0,
  showDistanceTracker: false,
  distanceCurrent: 154,
  distanceGoal: 378,
  distanceUnit: 'mi',
  distanceTitle: '',
  distanceIcon: '🛼',
  distanceAutoGps: false,
  distanceColor: 'neon-green',
  distanceStyle: 'default',
  distanceFont: 'default',
  distanceShowCurrentLocation: true,
  distanceX: 0,
  distanceY: 0,
  distanceScale: 1.0,
  distanceMode: 'manual',
  destinationLat: 25.7617,
  destinationLon: -80.1918,
  destinationName: 'Destination',
  startLat: undefined,
  startLon: undefined,
  autoSetStartOnGps: true,
  minimapX: 0,
  minimapY: 0,
  minimapPosition: 'left',
  minimapShape: 'circle',
  showSocials: false,
  socialName: '',
  socialKickEnabled: false,
  socialTwitchEnabled: false,
  socialXEnabled: false,
  socialYoutubeEnabled: false,
  socialInstagramEnabled: false,
  socialTiktokEnabled: false,
  socialPosition: 'top-middle',
  socialX: 0,
  socialY: 0,
  socialScale: 1,
  socialTextTheme: 'impact',
  socialShowBackground: true,
  socialFontFamily: 'Impact',
  socialLoopAnimation: false,
  socialLoopShowDuration: 15,
  socialLoopHideDuration: 15,
  donationGoals: [],
  showDonationGoals: false,
  donationGoalsX: 0,
  donationGoalsY: 0,
  donationGoalsScale: 1,
  donoShowBackground: true,
  donoGoalText: 'DONO GOAL:',
  streamElementsEnabled: false,
  streamElementsToken: '',
  belaboxUrl: '',
  belaboxPublisherKey: '',
  twitchRevenueSplit: 50,
  donationGoalsDuration: 0,
  timeWeatherLocationScale: 1.0,
  totalTipGoal: 100,
  totalTipCurrent: 0,
  dailyTipGoal: 10,
  dailyTipCurrent: 0,
  dailyTipLastReset: '',
  showSubGoals: false,
  showTotalSubGoal: true,
  showDailySubGoal: true,
  totalSubGoal: 50,
  totalSubCurrent: 0,
  dailySubGoal: 10,
  dailySubCurrent: 0,
  dailySubLastReset: '',
  subGoalsX: 0,
  subGoalsY: 100,
  subGoalsScale: 1.0,
  subGoalsStyle: 'default',
  subGoalsFont: 'default',
  subGoalsShowStroke: true,
  seAutoSyncTotals: true,
  twitchClientId: '',
  twitchToken: '',
  twitchBroadcasterId: '',
  twitchUsername: '',
  combineDateTimeWithLocation: false,
  obsWebsocketUrl: 'ws://127.0.0.1:4455',
  obsWebsocketPassword: '',
  obsAutoSwitchSceneToggle: false,
  obsOfflineSceneName: '',
  obsLiveSceneName: '',
  obsAutoSwitchDebugger: false,
};

// Valid settings schema for validation
// Note: 'todos', 'urls', and 'donationGoals' are handled separately in the validator as they are arrays
export const SETTINGS_CONFIG: Record<Exclude<keyof OverlaySettings, 'todos' | 'urls' | 'donationGoals'>, 'boolean' | 'string' | 'number'> = {
  locationDisplay: 'string',
  customLocation: 'string',
  showCountryName: 'boolean',
  showWeather: 'boolean',
  showWeatherWarnings: 'boolean',
  showTimeWeatherLocation: 'boolean',
  weatherConditionDisplay: 'string',
  temperatureUnit: 'string',
  showDate: 'boolean',
  showMinimap: 'boolean',
  minimapSpeedBased: 'boolean',
  mapZoomLevel: 'string',
  customMapZoom: 'number',
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
  globalFont: 'string',
  globalTheme: 'string',
  lowBitrateThreshold: 'number',
  criticalBitrateThreshold: 'number',
  lowBitrateAlertScale: 'number',
  lowBitrateAlertX: 'number',
  lowBitrateAlertY: 'number',
  lowBitrateAlertFont: 'string',
  todoListPosition: 'string',
  todoTitle: 'string',
  todoX: 'number',
  todoY: 'number',
  todoScale: 'number',
  showCalorieTracker: 'boolean',
  calorieGoal: 'number',
  calorieTrackerScale: 'number',
  calorieTrackerX: 'number',
  calorieTrackerY: 'number',
  showDistanceTracker: 'boolean',
  distanceCurrent: 'number',
  distanceGoal: 'number',
  distanceUnit: 'string',
  distanceTitle: 'string',
  distanceIcon: 'string',
  distanceAutoGps: 'boolean',
  distanceColor: 'string',
  distanceStyle: 'string',
  distanceFont: 'string',
  distanceShowCurrentLocation: 'boolean',
  distanceX: 'number',
  distanceY: 'number',
  distanceScale: 'number',
  distanceMode: 'string',
  destinationLat: 'number',
  destinationLon: 'number',
  destinationName: 'string',
  startLat: 'number',
  startLon: 'number',
  autoSetStartOnGps: 'boolean',
  minimapX: 'number',
  minimapY: 'number',
  minimapPosition: 'string',
  minimapShape: 'string',
  showSocials: 'boolean',
  socialName: 'string',
  socialKickEnabled: 'boolean',
  socialTwitchEnabled: 'boolean',
  socialXEnabled: 'boolean',
  socialYoutubeEnabled: 'boolean',
  socialInstagramEnabled: 'boolean',
  socialTiktokEnabled: 'boolean',
  socialPosition: 'string',
  socialX: 'number',
  socialY: 'number',
  socialScale: 'number',
  socialTextTheme: 'string',
  socialShowBackground: 'boolean',
  socialFontFamily: 'string',
  socialLoopAnimation: 'boolean',
  socialLoopShowDuration: 'number',
  socialLoopHideDuration: 'number',
  showDonationGoals: 'boolean',
  donationGoalsX: 'number',
  donationGoalsY: 'number',
  donationGoalsScale: 'number',
  donoShowBackground: 'boolean',
  donoGoalText: 'string',
  streamElementsEnabled: 'boolean',
  streamElementsToken: 'string',
  belaboxUrl: 'string',
  belaboxPublisherKey: 'string',
  twitchRevenueSplit: 'number',
  donationGoalsDuration: 'number',
  timeWeatherLocationScale: 'number',
  totalTipGoal: 'number',
  totalTipCurrent: 'number',
  dailyTipGoal: 'number',
  dailyTipCurrent: 'number',
  dailyTipLastReset: 'string',
  showSubGoals: 'boolean',
  showTotalSubGoal: 'boolean',
  showDailySubGoal: 'boolean',
  totalSubGoal: 'number',
  totalSubCurrent: 'number',
  dailySubGoal: 'number',
  dailySubCurrent: 'number',
  dailySubLastReset: 'string',
  subGoalsX: 'number',
  subGoalsY: 'number',
  subGoalsScale: 'number',
  subGoalsStyle: 'string',
  subGoalsFont: 'string',
  subGoalsShowStroke: 'boolean',
  seAutoSyncTotals: 'boolean',
  twitchClientId: 'string',
  twitchToken: 'string',
  twitchBroadcasterId: 'string',
  twitchUsername: 'string',
  combineDateTimeWithLocation: 'boolean',
  obsWebsocketUrl: 'string',
  obsWebsocketPassword: 'string',
  obsAutoSwitchSceneToggle: 'boolean',
  obsOfflineSceneName: 'string',
  obsLiveSceneName: 'string',
  obsAutoSwitchDebugger: 'boolean',
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