// Settings validation utility to prevent malicious entries

import { OverlaySettings, DEFAULT_OVERLAY_SETTINGS, SETTINGS_CONFIG, TodoItem, UrlItem } from '@/types/settings';



/**
 * Validates and sanitizes settings object
 * Removes any malicious or unknown properties
 */
export function validateAndSanitizeSettings(input: unknown): OverlaySettings {
  if (!input || typeof input !== 'object') {
    throw new Error('Settings must be an object');
  }

  const settings = input as Record<string, unknown>;
  const cleanSettings: Partial<OverlaySettings> = {};
  const rejectedKeys: string[] = [];

  // Validate specific string fields
  const stringFields = ['theme', 'timeFormat', 'locationDisplay', 'fontFamily', 'todoTheme', 'donoTheme', 'donoStyle', 'socialTheme', 'globalFont', 'globalTheme', 'donoGoalText'];
  stringFields.forEach(field => {
    if (settings[field as keyof OverlaySettings] !== undefined) {
      if (typeof settings[field as keyof OverlaySettings] === 'string') {
        (cleanSettings as any)[field] = settings[field as keyof OverlaySettings];
      }
    }
  });

  // Validate each field according to schema
  for (const [key, expectedType] of Object.entries(SETTINGS_CONFIG)) {
    const value = settings[key];

    if (value !== undefined) {
      if (expectedType === 'boolean' && typeof value === 'boolean') {
        (cleanSettings as Record<string, unknown>)[key] = value;
      } else if (expectedType === 'string' && typeof value === 'string') {
        (cleanSettings as Record<string, unknown>)[key] = value;
      } else if (expectedType === 'number' && typeof value === 'number') {
        (cleanSettings as Record<string, unknown>)[key] = value;
      } else {
        console.warn(`Invalid type for ${key}: expected ${expectedType}, got ${typeof value}`);
        rejectedKeys.push(key);
      }
    }
  }

  // Validate todos array (special handling)
  if (settings.todos !== undefined) {
    if (Array.isArray(settings.todos)) {
      const validTodos: TodoItem[] = [];
      for (const todo of settings.todos) {
        if (todo && typeof todo === 'object' && 'id' in todo && 'text' in todo && 'completed' in todo) {
          const todoObj = todo as Record<string, unknown>;
          if (typeof todoObj.id === 'string' && typeof todoObj.text === 'string' && typeof todoObj.completed === 'boolean') {
            const validTodo: TodoItem = {
              id: todoObj.id,
              text: String(todoObj.text).slice(0, 200), // Limit text length
              completed: Boolean(todoObj.completed)
            };
            if (todoObj.current !== undefined && typeof todoObj.current === 'number') {
              validTodo.current = todoObj.current;
            }
            if (todoObj.goal !== undefined && typeof todoObj.goal === 'number') {
              validTodo.goal = todoObj.goal;
            }
            validTodos.push(validTodo);
          }
        }
      }
      cleanSettings.todos = validTodos;
    } else {
      console.warn('Invalid type for todos: expected array');
      rejectedKeys.push('todos');
    }
  }

  // Validate urls array
  if (settings.urls !== undefined) {
    if (Array.isArray(settings.urls)) {
      const validUrls: UrlItem[] = [];
      for (const url of settings.urls) {
        if (url && typeof url === 'object' && 'id' in url && 'url' in url && 'label' in url) {
          const urlObj = url as Record<string, unknown>;
          if (typeof urlObj.id === 'string' && typeof urlObj.url === 'string' && typeof urlObj.label === 'string') {
            validUrls.push({
              id: urlObj.id,
              url: String(urlObj.url).slice(0, 500), // Limit url length
              label: String(urlObj.label).slice(0, 100), // Limit label length
              active: typeof urlObj.active === 'boolean' ? urlObj.active : true,
              type: (urlObj.type === 'embed' || urlObj.type === 'text') ? urlObj.type : 'text',
              scale: typeof urlObj.scale === 'number' ? urlObj.scale : 1,
              x: typeof urlObj.x === 'number' ? urlObj.x : 0,
              y: typeof urlObj.y === 'number' ? urlObj.y : 0
            });
          }
        }
      }
      cleanSettings.urls = validUrls;
    } else {
      console.warn('Invalid type for urls: expected array');
      rejectedKeys.push('urls');
    }
  }

  // Validate donationGoals array
  if (settings.donationGoals !== undefined) {
    if (Array.isArray(settings.donationGoals)) {
      const validGoals = [];
      for (const g of settings.donationGoals) {
        if (g && typeof g === 'object' && 'id' in g && 'name' in g && 'goal' in g && 'current' in g) {
          const gObj = g as Record<string, unknown>;
          if (typeof gObj.id === 'string' && typeof gObj.name === 'string' && typeof gObj.goal === 'number' && typeof gObj.current === 'number') {
            validGoals.push({
              id: gObj.id,
              name: String(gObj.name).slice(0, 100),
              goal: Math.max(0, gObj.goal),
              current: Math.max(0, gObj.current),
              duration: typeof gObj.duration === 'number' ? Math.min(Math.max(0, gObj.duration), 1440) : 0,
              lastTriggered: typeof gObj.lastTriggered === 'number' ? gObj.lastTriggered : 0
            });
          }
        }
      }
      cleanSettings.donationGoals = validGoals;
    } else {
      console.warn('Invalid type for donationGoals: expected array');
      rejectedKeys.push('donationGoals');
    }
  }

  // Validate showTodoList (it's in SETTINGS_CONFIG but handle explicitly for clarity)
  if (settings.showTodoList !== undefined) {
    if (typeof settings.showTodoList === 'boolean') {
      cleanSettings.showTodoList = settings.showTodoList;
    } else {
      console.warn('Invalid type for showTodoList: expected boolean');
      rejectedKeys.push('showTodoList');
    }
  }

  // Validate swapLocationTimePositions
  if (settings.swapLocationTimePositions !== undefined) {
    if (typeof settings.swapLocationTimePositions === 'boolean') {
      cleanSettings.swapLocationTimePositions = settings.swapLocationTimePositions;
    } else {
      console.warn('Invalid type for swapLocationTimePositions: expected boolean');
      rejectedKeys.push('swapLocationTimePositions');
    }
  }

  // Validate minimapScale
  if (settings.minimapScale !== undefined) {
    if (typeof settings.minimapScale === 'number') {
      // Clamp between 50 and 200
      cleanSettings.minimapScale = Math.min(Math.max(settings.minimapScale, 50), 200);
    } else if (typeof settings.minimapScale === 'string') {
      // Try to parse string
      const parsed = parseInt(settings.minimapScale, 10);
      if (!isNaN(parsed)) {
        cleanSettings.minimapScale = Math.min(Math.max(parsed, 50), 200);
      } else {
        console.warn('Invalid type for minimapScale: expected number');
        rejectedKeys.push('minimapScale');
      }
    } else {
      console.warn('Invalid type for minimapScale: expected number');
      rejectedKeys.push('minimapScale');
    }
  }

  // Validate showBackground
  if (settings.showBackground !== undefined) {
    if (typeof settings.showBackground === 'boolean') {
      cleanSettings.showBackground = settings.showBackground;
    } else {
      console.warn('Invalid type for showBackground: expected boolean');
      rejectedKeys.push('showBackground');
    }
  }

  // Validate mapStyle
  if (settings.mapStyle !== undefined) {
    const validStyles = ['auto', 'standard', 'dark', 'gta'];
    if (typeof settings.mapStyle === 'string' && validStyles.includes(settings.mapStyle)) {
      cleanSettings.mapStyle = settings.mapStyle as any;
    } else {
      // Fallback to auto if invalid
      cleanSettings.mapStyle = 'auto';
      console.warn('Invalid value for mapStyle, defaulting to auto');
    }
  }

  // Validate bitrateAnchor
  if (settings.bitrateAnchor !== undefined) {
    const validAnchors = ['location', 'time'];
    if (typeof settings.bitrateAnchor === 'string' && validAnchors.includes(settings.bitrateAnchor)) {
      cleanSettings.bitrateAnchor = settings.bitrateAnchor as any;
    } else {
      cleanSettings.bitrateAnchor = 'location';
    }
  }

  // Log any rejected keys (potential malicious entries)
  for (const key of Object.keys(settings)) {
    if (!(key in SETTINGS_CONFIG) && key !== 'todos' && key !== 'urls' && key !== 'showTodoList' && key !== 'swapLocationTimePositions' && key !== 'minimapScale' && key !== 'showBackground' && key !== 'mapStyle' && key !== 'bitrateDisplay' && key !== 'bitrateAnchor' && key !== 'showLowBitrateAlert' && key !== 'showBitrateWarnings' && key !== 'globalFont' && key !== 'globalTheme' && key !== 'lowBitrateThreshold' && key !== 'criticalBitrateThreshold' && key !== 'lowBitrateAlertScale' && key !== 'lowBitrateAlertX' && key !== 'lowBitrateAlertY' && key !== 'todoListPosition' && key !== 'showCalorieTracker' && key !== 'calorieGoal' && key !== 'minimapX' && key !== 'minimapY' && key !== 'minimapPosition' && key !== 'donationGoals' && key !== 'donoShowBackground' && key !== 'donoGoalText') { // valid keys
      rejectedKeys.push(key);
    }
  }

  if (rejectedKeys.length > 0) {
    // Check if these are just old chat bot settings that were removed
    const deprecatedChatBotKeys = ['enableChatBot', 'chatBotMessageTemplates', 'chatBotToken', 'kickClientId', 'kickClientSecret'];
    const isDeprecatedSettings = rejectedKeys.every(key => deprecatedChatBotKeys.includes(key));

    if (isDeprecatedSettings) {
      console.log('ℹ️  Ignoring old chat bot settings (removed during cleanup):', rejectedKeys);
    } else {
      console.warn('🚨 Rejected malicious/invalid settings keys:', rejectedKeys);
    }
  }

  // Ensure all required settings are present with defaults
  const completeSettings: OverlaySettings = {
    locationDisplay: cleanSettings.locationDisplay ?? DEFAULT_OVERLAY_SETTINGS.locationDisplay,
    customLocation: cleanSettings.customLocation ?? DEFAULT_OVERLAY_SETTINGS.customLocation,
    showCountryName: cleanSettings.showCountryName ?? DEFAULT_OVERLAY_SETTINGS.showCountryName,
    showWeather: cleanSettings.showWeather ?? DEFAULT_OVERLAY_SETTINGS.showWeather,
    weatherConditionDisplay: cleanSettings.weatherConditionDisplay ?? DEFAULT_OVERLAY_SETTINGS.weatherConditionDisplay,
    temperatureUnit: (cleanSettings.temperatureUnit === 'F' || cleanSettings.temperatureUnit === 'both')
      ? cleanSettings.temperatureUnit
      : DEFAULT_OVERLAY_SETTINGS.temperatureUnit,
    showDate: cleanSettings.showDate ?? DEFAULT_OVERLAY_SETTINGS.showDate,
    showMinimap: cleanSettings.showMinimap ?? DEFAULT_OVERLAY_SETTINGS.showMinimap,
    minimapSpeedBased: cleanSettings.minimapSpeedBased ?? DEFAULT_OVERLAY_SETTINGS.minimapSpeedBased,
    mapZoomLevel: cleanSettings.mapZoomLevel ?? DEFAULT_OVERLAY_SETTINGS.mapZoomLevel,
    altitudeDisplay: cleanSettings.altitudeDisplay ?? DEFAULT_OVERLAY_SETTINGS.altitudeDisplay,
    speedDisplay: cleanSettings.speedDisplay ?? DEFAULT_OVERLAY_SETTINGS.speedDisplay,
    todos: cleanSettings.todos ?? DEFAULT_OVERLAY_SETTINGS.todos,
    urls: cleanSettings.urls ?? DEFAULT_OVERLAY_SETTINGS.urls,
    showTodoList: cleanSettings.showTodoList ?? DEFAULT_OVERLAY_SETTINGS.showTodoList,
    swapLocationTimePositions: cleanSettings.swapLocationTimePositions ?? DEFAULT_OVERLAY_SETTINGS.swapLocationTimePositions,
    minimapScale: cleanSettings.minimapScale ?? DEFAULT_OVERLAY_SETTINGS.minimapScale,
    showBackground: cleanSettings.showBackground ?? DEFAULT_OVERLAY_SETTINGS.showBackground,
    mapStyle: cleanSettings.mapStyle ?? DEFAULT_OVERLAY_SETTINGS.mapStyle,
    bitrateDisplay: cleanSettings.bitrateDisplay ?? DEFAULT_OVERLAY_SETTINGS.bitrateDisplay,
    bitrateAnchor: cleanSettings.bitrateAnchor ?? DEFAULT_OVERLAY_SETTINGS.bitrateAnchor,
    showLowBitrateAlert: cleanSettings.showLowBitrateAlert ?? DEFAULT_OVERLAY_SETTINGS.showLowBitrateAlert,
    showBitrateWarnings: cleanSettings.showBitrateWarnings ?? DEFAULT_OVERLAY_SETTINGS.showBitrateWarnings,
    globalFont: cleanSettings.globalFont ?? DEFAULT_OVERLAY_SETTINGS.globalFont,
    globalTheme: cleanSettings.globalTheme ?? DEFAULT_OVERLAY_SETTINGS.globalTheme,
    lowBitrateThreshold: cleanSettings.lowBitrateThreshold ?? DEFAULT_OVERLAY_SETTINGS.lowBitrateThreshold,
    criticalBitrateThreshold: cleanSettings.criticalBitrateThreshold ?? DEFAULT_OVERLAY_SETTINGS.criticalBitrateThreshold,
    lowBitrateAlertScale: typeof cleanSettings.lowBitrateAlertScale === 'number'
      ? Math.min(Math.max(cleanSettings.lowBitrateAlertScale, 0.1), 2.0)
      : DEFAULT_OVERLAY_SETTINGS.lowBitrateAlertScale,
    lowBitrateAlertX: typeof cleanSettings.lowBitrateAlertX === 'number'
      ? Math.min(Math.max(cleanSettings.lowBitrateAlertX, -1000), 1000)
      : DEFAULT_OVERLAY_SETTINGS.lowBitrateAlertX,
    lowBitrateAlertY: typeof cleanSettings.lowBitrateAlertY === 'number'
      ? Math.min(Math.max(cleanSettings.lowBitrateAlertY, -1000), 1000)
      : DEFAULT_OVERLAY_SETTINGS.lowBitrateAlertY,
    lowBitrateAlertFont: (cleanSettings.lowBitrateAlertFont === 'default' ||
                          cleanSettings.lowBitrateAlertFont === 'neon' ||
                          cleanSettings.lowBitrateAlertFont === 'retro' ||
                          cleanSettings.lowBitrateAlertFont === 'bold' ||
                          cleanSettings.lowBitrateAlertFont === 'impact')
      ? cleanSettings.lowBitrateAlertFont
      : DEFAULT_OVERLAY_SETTINGS.lowBitrateAlertFont,
    todoListPosition: cleanSettings.todoListPosition ?? DEFAULT_OVERLAY_SETTINGS.todoListPosition,
    showCalorieTracker: cleanSettings.showCalorieTracker ?? DEFAULT_OVERLAY_SETTINGS.showCalorieTracker,
    calorieGoal: cleanSettings.calorieGoal ?? DEFAULT_OVERLAY_SETTINGS.calorieGoal,
    calorieTrackerScale: typeof cleanSettings.calorieTrackerScale === 'number'
      ? Math.min(Math.max(cleanSettings.calorieTrackerScale, 0.5), 2.0)
      : DEFAULT_OVERLAY_SETTINGS.calorieTrackerScale,
    calorieTrackerX: typeof cleanSettings.calorieTrackerX === 'number'
      ? Math.min(Math.max(cleanSettings.calorieTrackerX, -1000), 1000)
      : DEFAULT_OVERLAY_SETTINGS.calorieTrackerX,
    calorieTrackerY: typeof cleanSettings.calorieTrackerY === 'number'
      ? Math.min(Math.max(cleanSettings.calorieTrackerY, -500), 500)
      : DEFAULT_OVERLAY_SETTINGS.calorieTrackerY,
    minimapX: typeof cleanSettings.minimapX === 'number'
      ? Math.min(Math.max(cleanSettings.minimapX, -2000), 2000)
      : DEFAULT_OVERLAY_SETTINGS.minimapX,
    minimapY: typeof cleanSettings.minimapY === 'number'
      ? Math.min(Math.max(cleanSettings.minimapY, -2000), 2000)
      : DEFAULT_OVERLAY_SETTINGS.minimapY,
    minimapPosition: cleanSettings.minimapPosition ?? DEFAULT_OVERLAY_SETTINGS.minimapPosition,
    socialXEnabled: cleanSettings.socialXEnabled ?? DEFAULT_OVERLAY_SETTINGS.socialXEnabled,
    socialXName: cleanSettings.socialXName ?? DEFAULT_OVERLAY_SETTINGS.socialXName,
    socialYoutubeEnabled: cleanSettings.socialYoutubeEnabled ?? DEFAULT_OVERLAY_SETTINGS.socialYoutubeEnabled,
    socialYoutubeName: cleanSettings.socialYoutubeName ?? DEFAULT_OVERLAY_SETTINGS.socialYoutubeName,
    socialInstagramEnabled: cleanSettings.socialInstagramEnabled ?? DEFAULT_OVERLAY_SETTINGS.socialInstagramEnabled,
    socialInstagramName: cleanSettings.socialInstagramName ?? DEFAULT_OVERLAY_SETTINGS.socialInstagramName,
    socialTiktokEnabled: cleanSettings.socialTiktokEnabled ?? DEFAULT_OVERLAY_SETTINGS.socialTiktokEnabled,
    socialTiktokName: cleanSettings.socialTiktokName ?? DEFAULT_OVERLAY_SETTINGS.socialTiktokName,
    showSocials: cleanSettings.showSocials ?? DEFAULT_OVERLAY_SETTINGS.showSocials,
    socialRotateInterval: typeof cleanSettings.socialRotateInterval === 'number'
      ? Math.min(Math.max(cleanSettings.socialRotateInterval, 1), 60)
      : DEFAULT_OVERLAY_SETTINGS.socialRotateInterval,
    socialPosition: (cleanSettings.socialPosition === 'top-middle' || cleanSettings.socialPosition === 'bottom-left')
      ? cleanSettings.socialPosition
      : DEFAULT_OVERLAY_SETTINGS.socialPosition,
    socialTextTheme: (['default', 'neon', 'retro', 'bold', 'impact'] as const).includes(cleanSettings.socialTextTheme as any)
      ? cleanSettings.socialTextTheme as 'default' | 'neon' | 'retro' | 'bold' | 'impact'
      : DEFAULT_OVERLAY_SETTINGS.socialTextTheme,
    socialShowBackground: cleanSettings.socialShowBackground ?? DEFAULT_OVERLAY_SETTINGS.socialShowBackground,
    donationGoals: (() => {
      if (!Array.isArray(cleanSettings.donationGoals)) return DEFAULT_OVERLAY_SETTINGS.donationGoals;
      const valid = [];
      for (const g of cleanSettings.donationGoals) {
        if (g && typeof g === 'object' && typeof g.id === 'string' && typeof g.name === 'string' && typeof g.goal === 'number' && typeof g.current === 'number') {
          valid.push({
            id: g.id,
            name: String(g.name).slice(0, 100),
            goal: Math.max(0, g.goal),
            current: Math.max(0, g.current),
            duration: typeof g.duration === 'number' ? Math.min(Math.max(0, g.duration), 1440) : 0,
            lastTriggered: typeof g.lastTriggered === 'number' ? g.lastTriggered : 0
          });
        }
      }
      return valid;
    })(),
    showDonationGoals: cleanSettings.showDonationGoals ?? DEFAULT_OVERLAY_SETTINGS.showDonationGoals,
    donationGoalsX: typeof cleanSettings.donationGoalsX === 'number' ? cleanSettings.donationGoalsX : DEFAULT_OVERLAY_SETTINGS.donationGoalsX,
    donationGoalsY: typeof cleanSettings.donationGoalsY === 'number' ? cleanSettings.donationGoalsY : DEFAULT_OVERLAY_SETTINGS.donationGoalsY,
    donationGoalsScale: typeof cleanSettings.donationGoalsScale === 'number' ? cleanSettings.donationGoalsScale : DEFAULT_OVERLAY_SETTINGS.donationGoalsScale,
    donoShowBackground: cleanSettings.donoShowBackground ?? DEFAULT_OVERLAY_SETTINGS.donoShowBackground,
    donoGoalText: cleanSettings.donoGoalText ?? DEFAULT_OVERLAY_SETTINGS.donoGoalText,
    streamElementsEnabled: cleanSettings.streamElementsEnabled ?? DEFAULT_OVERLAY_SETTINGS.streamElementsEnabled,
    streamElementsToken: cleanSettings.streamElementsToken ?? DEFAULT_OVERLAY_SETTINGS.streamElementsToken,
    twitchRevenueSplit: typeof cleanSettings.twitchRevenueSplit === 'number'
      ? Math.min(Math.max(cleanSettings.twitchRevenueSplit, 0), 100)
      : DEFAULT_OVERLAY_SETTINGS.twitchRevenueSplit,
    donationGoalsDuration: typeof cleanSettings.donationGoalsDuration === 'number'
      ? Math.min(Math.max(cleanSettings.donationGoalsDuration, 0), 1440)
      : DEFAULT_OVERLAY_SETTINGS.donationGoalsDuration,
    timeWeatherLocationScale: typeof cleanSettings.timeWeatherLocationScale === 'number'
      ? Math.min(Math.max(cleanSettings.timeWeatherLocationScale, 0.3), 3.0)
      : DEFAULT_OVERLAY_SETTINGS.timeWeatherLocationScale,
    showSubGoals: cleanSettings.showSubGoals ?? DEFAULT_OVERLAY_SETTINGS.showSubGoals,
    totalSubGoal: typeof cleanSettings.totalSubGoal === 'number' ? cleanSettings.totalSubGoal : DEFAULT_OVERLAY_SETTINGS.totalSubGoal,
    totalSubCurrent: typeof cleanSettings.totalSubCurrent === 'number' ? cleanSettings.totalSubCurrent : DEFAULT_OVERLAY_SETTINGS.totalSubCurrent,
    dailySubGoal: typeof cleanSettings.dailySubGoal === 'number' ? cleanSettings.dailySubGoal : DEFAULT_OVERLAY_SETTINGS.dailySubGoal,
    dailySubCurrent: typeof cleanSettings.dailySubCurrent === 'number' ? cleanSettings.dailySubCurrent : DEFAULT_OVERLAY_SETTINGS.dailySubCurrent,
    dailySubLastReset: typeof cleanSettings.dailySubLastReset === 'string' ? cleanSettings.dailySubLastReset : DEFAULT_OVERLAY_SETTINGS.dailySubLastReset,
    subGoalsX: typeof cleanSettings.subGoalsX === 'number' ? cleanSettings.subGoalsX : DEFAULT_OVERLAY_SETTINGS.subGoalsX,
    subGoalsY: typeof cleanSettings.subGoalsY === 'number' ? cleanSettings.subGoalsY : DEFAULT_OVERLAY_SETTINGS.subGoalsY,
    subGoalsScale: typeof cleanSettings.subGoalsScale === 'number' ? cleanSettings.subGoalsScale : DEFAULT_OVERLAY_SETTINGS.subGoalsScale,
  };

  return completeSettings;
}

/**
 * Check if settings object contains any suspicious keys
 */
export function detectMaliciousKeys(settings: unknown): string[] {
  if (!settings || typeof settings !== 'object') {
    return [];
  }

  const maliciousKeys: string[] = [];
  const settingsObj = settings as Record<string, unknown>;

  for (const key of Object.keys(settingsObj)) {
    if (!(key in SETTINGS_CONFIG) && key !== 'todos' && key !== 'urls' && key !== 'showTodoList' && key !== 'swapLocationTimePositions' && key !== 'minimapScale' && key !== 'showBackground' && key !== 'mapStyle' && key !== 'bitrateDisplay' && key !== 'bitrateAnchor' && key !== 'showLowBitrateAlert' && key !== 'showBitrateWarnings' && key !== 'lowBitrateAlertScale' && key !== 'lowBitrateAlertX' && key !== 'lowBitrateAlertY' && key !== 'todoListPosition' && key !== 'showCalorieTracker' && key !== 'calorieGoal' && key !== 'calorieTrackerScale' && key !== 'calorieTrackerX' && key !== 'calorieTrackerY' && key !== 'minimapX' && key !== 'minimapY' && key !== 'minimapPosition' && key !== 'donationGoals' && key !== 'showSubGoals' && key !== 'totalSubGoal' && key !== 'totalSubCurrent' && key !== 'dailySubGoal' && key !== 'dailySubCurrent' && key !== 'dailySubLastReset' && key !== 'subGoalsX' && key !== 'subGoalsY' && key !== 'subGoalsScale') { // valid keys
      maliciousKeys.push(key);
    }
  }

  return maliciousKeys;
} 