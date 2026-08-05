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
  resolution?: '800x600' | '720p' | '1080p';
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

export interface ShoutoutData {
  username: string;
  displayName: string;
  avatarUrl?: string;
  gameName?: string;
  title?: string;
  customText?: string;
  active: boolean;
  triggeredAt: number;
  durationSeconds?: number;
}

export interface OverlaySettings {
  shoutout?: ShoutoutData | null;
  shoutoutAnnouncementTemplate?: string;
  shoutoutX?: number;
  shoutoutY?: number;
  shoutoutScale?: number;
  shoutoutDuration?: number;
  shoutoutPermBroadcaster?: boolean;
  shoutoutPermMods?: boolean;
  shoutoutPermVips?: boolean;
  shoutoutPermEveryone?: boolean;
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
  todoShowBackground?: boolean;
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
  distanceStyle?: 'default' | 'compact' | 'cyberpunk' | 'minimal-bar' | 'no-background' | 'borderless';
  distanceFont?: 'default' | 'neon' | 'retro' | 'bold' | 'impact';
  distanceShowCurrentLocation?: boolean;
  distanceX?: number;
  distanceY?: number;
  distanceScale?: number;
  distanceMode?: 'manual' | 'destination';
  destinationLat?: number;
  destinationLon?: number;
  destinationName?: string;
  startLat?: number | null;
  startLon?: number | null;
  autoSetStartOnGps?: boolean;
  isTestingFill?: boolean;
  testFillProgress?: number;
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
  subGoalsShowBackground?: boolean;
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
  enableResourceOptimization?: boolean;
  bitratePollIntervalLive?: number;
  bitratePollIntervalOffline?: number;
  bitrateCacheTtlMs?: number;
}

// Default settings (single source of truth)
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  shoutout: null,
  shoutoutAnnouncementTemplate: '📣 Shoutout to @{username} {game}at {url} !',
  shoutoutX: 0,
  shoutoutY: 0,
  shoutoutScale: 1.0,
  shoutoutDuration: 15,
  shoutoutPermBroadcaster: true,
  shoutoutPermMods: true,
  shoutoutPermVips: false,
  shoutoutPermEveryone: false,
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
  todoShowBackground: true,
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
  isTestingFill: false,
  testFillProgress: undefined,
  minimapX: 0,
  minimapY: 0,
  minimapPosition: 'left',
  minimapShape: 'circle',
  showSocials: false,
  socialName: 'streamer',
  socialKickEnabled: true,
  socialTwitchEnabled: true,
  socialXEnabled: true,
  socialYoutubeEnabled: true,
  socialInstagramEnabled: false,
  socialTiktokEnabled: false,
  socialPosition: 'top-middle',
  socialX: 0,
  socialY: 0,
  socialScale: 1.0,
  socialTextTheme: 'default',
  socialShowBackground: true,
  socialFontFamily: 'default',
  socialLoopAnimation: false,
  socialLoopShowDuration: 10,
  socialLoopHideDuration: 5,
  donationGoals: [],
  showDonationGoals: false,
  donationGoalsX: 0,
  donationGoalsY: 0,
  donationGoalsScale: 1.0,
  donoShowBackground: true,
  donoGoalText: 'Goal',
  streamElementsEnabled: false,
  streamElementsToken: '',
  belaboxUrl: '',
  belaboxPublisherKey: '',
  twitchRevenueSplit: 50,
  donationGoalsDuration: 0,
  timeWeatherLocationScale: 1.0,
  totalTipGoal: 100,
  totalTipCurrent: 0,
  dailyTipGoal: 50,
  dailyTipCurrent: 0,
  dailyTipLastReset: '',
  showSubGoals: false,
  showTotalSubGoal: true,
  showDailySubGoal: false,
  totalSubGoal: 100,
  totalSubCurrent: 0,
  dailySubGoal: 10,
  dailySubCurrent: 0,
  dailySubLastReset: '',
  subGoalsX: 0,
  subGoalsY: 0,
  subGoalsScale: 1.0,
  subGoalsStyle: 'default',
  subGoalsFont: 'default',
  subGoalsShowStroke: true,
  subGoalsShowBackground: true,
  seAutoSyncTotals: false,
  twitchClientId: '',
  twitchToken: '',
  twitchBroadcasterId: '',
  twitchUsername: '',
  combineDateTimeWithLocation: false,
  obsWebsocketUrl: 'ws://127.0.0.1:4455',
  obsWebsocketPassword: '',
  obsAutoSwitchSceneToggle: false,
  obsOfflineSceneName: 'offline',
  obsLiveSceneName: 'live',
  obsAutoSwitchDebugger: false,
  enableResourceOptimization: true,
  bitratePollIntervalLive: 3000,
  bitratePollIntervalOffline: 6000,
  bitrateCacheTtlMs: 5000,
};

// Valid settings schema for validation
// Note: 'todos', 'urls', 'donationGoals', and 'shoutout' are handled separately in the validator as they are objects/arrays
export const SETTINGS_CONFIG: Record<Exclude<keyof OverlaySettings, 'todos' | 'urls' | 'donationGoals' | 'shoutout'>, 'boolean' | 'string' | 'number'> = {
  shoutoutAnnouncementTemplate: 'string',
  shoutoutX: 'number',
  shoutoutY: 'number',
  shoutoutScale: 'number',
  shoutoutDuration: 'number',
  shoutoutPermBroadcaster: 'boolean',
  shoutoutPermMods: 'boolean',
  shoutoutPermVips: 'boolean',
  shoutoutPermEveryone: 'boolean',
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
  todoShowBackground: 'boolean',
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
  isTestingFill: 'boolean',
  testFillProgress: 'number',
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
  subGoalsShowBackground: 'boolean',
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
  enableResourceOptimization: 'boolean',
  bitratePollIntervalLive: 'number',
  bitratePollIntervalOffline: 'number',
  bitrateCacheTtlMs: 'number',
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