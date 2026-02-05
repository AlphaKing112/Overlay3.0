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
            validTodos.push({
              id: todoObj.id,
              text: String(todoObj.text).slice(0, 200), // Limit text length
              completed: Boolean(todoObj.completed)
            });
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

  // Log any rejected keys (potential malicious entries)
  for (const key of Object.keys(settings)) {
    if (!(key in SETTINGS_CONFIG) && key !== 'todos' && key !== 'urls' && key !== 'showTodoList' && key !== 'swapLocationTimePositions' && key !== 'minimapScale' && key !== 'showBackground' && key !== 'mapStyle') { // valid keys
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
    if (!(key in SETTINGS_CONFIG) && key !== 'todos' && key !== 'urls' && key !== 'showTodoList' && key !== 'swapLocationTimePositions' && key !== 'minimapScale' && key !== 'showBackground' && key !== 'mapStyle') { // valid keys
      maliciousKeys.push(key);
    }
  }

  return maliciousKeys;
} 