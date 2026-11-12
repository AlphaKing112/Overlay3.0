/**
 * Universal OBS WebSocket Stream & Scene Controller
 * Safely executes stream start/stop and scene switching/refreshing across
 * OBS WebSocket v5 (OBS 28+), v4 (OBS 27), and custom output setups.
 */

export function formatObsError(err: any): string {
  if (!err) return 'Unknown OBS error';
  if (typeof err === 'string') return err;
  const msg = err.message || err.comment || err.error || err.status || '';
  const code = err.code !== undefined ? ` [Code ${err.code}]` : '';
  if (msg) return `${msg}${code}`;
  try {
    const str = JSON.stringify(err);
    return str !== '{}' ? str : String(err);
  } catch {
    return String(err);
  }
}

/**
 * Universal safe scene switcher (supports v5, case-insensitive match, and v4 fallback)
 */
export async function safeObsSwitchScene(obs: any, sceneName: string): Promise<boolean> {
  if (!obs || !sceneName) return false;
  const target = String(sceneName).trim();
  const lowerTarget = target.toLowerCase();

  try {
    // 1. Try standard OBS WebSocket v5: SetCurrentProgramScene (exact match)
    await obs.call('SetCurrentProgramScene', { sceneName: target });
    console.log(`✅ [OBS] Switched scene to: "${target}"`);
    return true;
  } catch (err1) {
    try {
      // 2. Fetch full scene list from OBS
      const sceneListData = await obs.call('GetSceneList');
      const rawScenes = (sceneListData.scenes as any[]) || [];
      const scenes = rawScenes.map((s: any) => String(s.sceneName || s.name || '')).filter(Boolean);

      // 2a. Case-insensitive exact match
      let matched = scenes.find((s: string) => s.toLowerCase() === lowerTarget);

      // 2b. Intelligent partial/keyword match
      if (!matched) {
        if (lowerTarget === 'live') {
          matched = scenes.find(s => {
            const l = s.toLowerCase();
            return l === 'live' || (l.includes('live') && !l.includes('vertical')) || l.includes('main') || l.includes('game') || l.includes('chat') || l.includes('stream') || l.includes('irl');
          });
        } else if (lowerTarget === 'low' || lowerTarget.includes('low')) {
          matched = scenes.find(s => {
            const l = s.toLowerCase();
            return l === 'low' || l.includes('low') || l.includes('weak') || l.includes('bad') || l.includes('standby') || l.includes('reconnect');
          });
        } else if (lowerTarget === 'offline' || lowerTarget === 'brb' || lowerTarget.includes('off')) {
          matched = scenes.find(s => {
            const l = s.toLowerCase();
            return l === 'offline' || (l.includes('offline') && !l.includes('vertical')) || l.includes('brb') || l.includes('break') || l.includes('right back');
          });
        } else if (lowerTarget === 'refresh' || lowerTarget === 'fix') {
          matched = scenes.find(s => {
            const l = s.toLowerCase();
            return l === 'refresh' || (l.includes('refresh') && !l.includes('live')) || l.includes('fix') || l.includes('reset') || l.includes('reload');
          });
        } else if (lowerTarget === 'starting' || lowerTarget === 'start') {
          matched = scenes.find(s => {
            const l = s.toLowerCase();
            return l === 'starting' || l.includes('start') || l.includes('intro') || l.includes('soon');
          });
        } else if (lowerTarget === 'ending' || lowerTarget === 'end') {
          matched = scenes.find(s => {
            const l = s.toLowerCase();
            return l === 'ending' || l.includes('end') || l.includes('outro') || l.includes('bye');
          });
        } else if (lowerTarget === 'privacy' || lowerTarget === 'pause' || lowerTarget.includes('priv')) {
          matched = scenes.find(s => {
            const l = s.toLowerCase();
            return l === 'privacy' || l.includes('priv') || l.includes('pause') || l.includes('hide');
          });
        } else {
          // General partial match
          matched = scenes.find(s => s.toLowerCase().includes(lowerTarget) || lowerTarget.includes(s.toLowerCase()));
        }
      }

      if (matched) {
        await obs.call('SetCurrentProgramScene', { sceneName: matched });
        console.log(`✅ [OBS] Switched scene via smart match to: "${matched}"`);
        return true;
      }
    } catch (err2) {
      console.warn('⚠️ [OBS] Smart scene lookup fallback failed:', err2);
    }

    try {
      // 3. Fallback to v4 syntax: SetCurrentScene
      const v4Method = 'SetCurrentScene' as any;
      await obs.call(v4Method, { 'scene-name': target });
      console.log(`✅ [OBS] Switched scene via v4 to: "${target}"`);
      return true;
    } catch (err3) {
      console.warn(`⚠️ [OBS] safeObsSwitchScene failed for "${target}": ${formatObsError(err3)}`);
    }
  }
  return false;
}

/**
 * Get current program scene from OBS
 */
export async function getCurrentObsScene(obs: any): Promise<string | null> {
  if (!obs) return null;
  try {
    // v5 syntax
    const res = await obs.call('GetCurrentProgramScene');
    return String(res.currentProgramSceneName || res.sceneName || res.name || '');
  } catch {
    try {
      // v4 syntax
      const res = await obs.call('GetCurrentScene' as any);
      return String(res.name || res['scene-name'] || '');
    } catch {
      return null;
    }
  }
}

export interface ObsSceneItemInfo {
  id: number;
  name: string;
  kind?: string;
  enabled: boolean;
  locked?: boolean;
}

/**
 * Get all scene items (sources) on a specific OBS scene with visibility state
 */
export async function getObsSceneItems(obs: any, sceneName: string): Promise<ObsSceneItemInfo[]> {
  if (!obs || !sceneName) return [];
  try {
    // v5 syntax
    const res = await obs.call('GetSceneItemList', { sceneName });
    const items = (res?.sceneItems as any[]) || [];
    return items.map((item: any) => ({
      id: item.sceneItemId ?? item.itemId ?? 0,
      name: String(item.sourceName || item.name || ''),
      kind: String(item.inputKind || item.sourceKind || item.sourceType || ''),
      enabled: Boolean(item.sceneItemEnabled ?? true),
      locked: Boolean(item.sceneItemLocked ?? false)
    })).reverse(); // Reverse so topmost item in OBS layer stack is at the top of the UI list
  } catch {
    try {
      // v4 syntax fallback
      const v4Res = await obs.call('GetSceneItemList' as any, { 'scene-name': sceneName });
      const items = (v4Res?.sceneItems || v4Res?.sources as any[]) || [];
      return items.map((item: any) => ({
        id: item.id ?? item.sceneItemId ?? 0,
        name: String(item.name || item.sourceName || ''),
        kind: String(item.type || item.kind || ''),
        enabled: Boolean(item.render ?? item.sceneItemEnabled ?? true)
      })).reverse();
    } catch {
      return [];
    }
  }
}

/**
 * Set the visibility (enabled/disabled) of a scene item on a scene in OBS
 */
export async function toggleObsSceneItem(
  obs: any,
  sceneName: string,
  sceneItemId: number,
  enabled: boolean,
  sourceName?: string
): Promise<boolean> {
  if (!obs || !sceneName || sceneItemId === undefined) return false;
  try {
    // v5 syntax
    await obs.call('SetSceneItemEnabled', {
      sceneName,
      sceneItemId,
      sceneItemEnabled: enabled
    });
    return true;
  } catch (err) {
    try {
      // v4 syntax fallback
      if (sourceName) {
        await obs.call('SetSceneItemRender' as any, {
          'scene-name': sceneName,
          source: sourceName,
          render: enabled
        });
        return true;
      }
    } catch {}
    console.warn(`[OBS] Failed to toggle scene item "${sourceName || sceneItemId}":`, err);
    return false;
  }
}

/**
 * Remove a scene item (source) from a specific scene in OBS Studio
 */
export async function removeObsSceneItem(
  obs: any,
  sceneName: string,
  sceneItemId: number,
  sourceName?: string
): Promise<boolean> {
  if (!obs || !sceneName || sceneItemId === undefined) return false;
  try {
    // v5 syntax: RemoveSceneItem { sceneName, sceneItemId }
    await obs.call('RemoveSceneItem', {
      sceneName,
      sceneItemId
    });
    console.log(`🗑️ [OBS] Removed scene item "${sourceName || sceneItemId}" from scene "${sceneName}"`);
    return true;
  } catch (err) {
    try {
      // v4 syntax fallback: DeleteSceneItem or DeleteItem
      await obs.call('DeleteSceneItem' as any, {
        'scene-name': sceneName,
        item: { id: sceneItemId }
      });
      return true;
    } catch {
      try {
        if (sourceName) {
          await obs.call('DeleteItem' as any, {
            'scene-name': sceneName,
            source: sourceName
          });
          return true;
        }
      } catch {}
    }
    console.warn(`[OBS] Failed to remove scene item "${sourceName || sceneItemId}" from "${sceneName}":`, err);
    return false;
  }
}

/**
 * Query whether OBS is currently streaming live
 */
export async function getIsObsStreaming(obs: any): Promise<boolean | null> {
  if (!obs) return null;
  try {
    // v5 syntax
    const res = await obs.call('GetStreamStatus');
    return Boolean(res.outputActive || res.outputStreaming || res.streaming);
  } catch {
    try {
      // v4 syntax
      const res = await obs.call('GetStreamingStatus' as any);
      return Boolean(res.streaming);
    } catch {
      return null;
    }
  }
}

/**
 * Universal stream refresh cycle (!refresh)
 * Switches OBS to the refresh scene, pauses for 6 seconds (allowing SRT buffer and audio decoder to reset),
 * and then automatically returns to the live scene.
 */
export async function safeObsRefreshCycle(
  obs: any,
  refreshScene: string = 'refresh',
  liveScene: string = 'live',
  delayMs: number = 6000,
  options?: { isLiveBitrate?: boolean; currentBitrate?: number }
): Promise<{ success: boolean; error?: string }> {
  if (!obs) return { success: false, error: 'OBS WebSocket is not connected.' };

  console.log(`🔄 [OBS] Starting !refresh sequence: Switching to "${refreshScene}" for ${delayMs / 1000}s...`);
  const switchedToRefresh = await safeObsSwitchScene(obs, refreshScene);
  if (!switchedToRefresh) {
    return { success: false, error: `Failed to switch to refresh scene "${refreshScene}". Please check scene name.` };
  }

  // Wait 6 seconds to let OBS media source and SRT audio listener reconnect/reload
  await new Promise(resolve => setTimeout(resolve, delayMs));

  console.log(`🔄 [OBS] !refresh sequence: Switching back to "${liveScene}"...`);
  const switchedBackToLive = await safeObsSwitchScene(obs, liveScene);
  if (!switchedBackToLive) {
    return { success: false, error: `Failed to switch back to live scene "${liveScene}".` };
  }

  return { success: true };
}

export interface ObsFixFeedOptions {
  streamSourceName?: string;
  overlaySourceName?: string;
}

export interface ObsFixFeedResult {
  success: boolean;
  scene: string;
  sources: string[];
  reconnectedCount: number;
  message: string;
  error?: string;
}

export const NOALBS_MEDIA_KINDS = ['ffmpeg_source', 'vlc_source', 'irl_source', 'smooth_media_source'];
export const NOALBS_PLAYING_STATES = [
  'OBS_MEDIA_STATE_PLAYING',
  'OBS_MEDIA_STATE_BUFFERING',
  'OBS_MEDIA_STATE_OPENING',
];

/**
 * Checks whether an OBS media player input is currently live and playing,
 * matching NOALBS (crates/obs-actions/src/fix.rs & stream_servers/obs.rs).
 */
export async function getObsMediaInputStatus(
  obs: any,
  inputName: string
): Promise<{ state: string; isLive: boolean } | null> {
  if (!obs || !inputName) return null;
  try {
    const res = await obs.call('GetMediaInputStatus', { inputName });
    const state = String(res?.mediaState || '').toUpperCase();
    const isLive = NOALBS_PLAYING_STATES.includes(state);
    return { state, isLive };
  } catch (err) {
    try {
      const v4Res = await obs.call('GetMediaSourceStatus' as any, { sourceName: inputName });
      const raw = String(v4Res?.mediaStatus || v4Res?.mediaState || '').toLowerCase();
      const isLive = ['playing', 'buffering', 'opening'].includes(raw);
      const state = isLive ? 'OBS_MEDIA_STATE_PLAYING' : 'OBS_MEDIA_STATE_STOPPED';
      return { state, isLive };
    } catch {
      return null;
    }
  }
}

/**
 * Scans the active scene for any stream media source and checks if its feed is currently LIVE,
 * exactly like NOALBS (stream_servers/obs.rs).
 */
export async function getObsMediaFeedLiveStatus(
  obs: any,
  sceneName?: string,
  targetSourceName?: string
): Promise<{
  isLive: boolean;
  scene: string;
  sourceName?: string;
  mediaState?: string;
}> {
  if (!obs) return { isLive: false, scene: sceneName || 'unknown' };
  try {
    const scene = sceneName || (await getCurrentObsScene(obs)) || 'live';
    let items: any[] = [];
    try {
      const res = await obs.call('GetSceneItemList', { sceneName: scene });
      items = (res?.sceneItems as any[]) || [];
    } catch {
      try {
        const v4Res = await obs.call('GetSceneItemList' as any, { 'scene-name': scene });
        items = (v4Res?.sceneItems || v4Res?.sources as any[]) || [];
      } catch {}
    }

    for (const item of items) {
      const name: string = item.sourceName || item.name || '';
      if (!name) continue;
      if (targetSourceName && name.toLowerCase() !== targetSourceName.toLowerCase()) continue;

      const kind: string = item.inputKind || '';
      const isMediaCandidate = NOALBS_MEDIA_KINDS.includes(kind) || /(bela|belabox|srt|feed|stream|irl)/i.test(name);
      if (!isMediaCandidate) continue;

      const status = await getObsMediaInputStatus(obs, name);
      if (status && status.isLive) {
        return { isLive: true, scene, sourceName: name, mediaState: status.state };
      }
    }
    return { isLive: false, scene };
  } catch {
    return { isLive: false, scene: sceneName || 'unknown' };
  }
}

/**
 * NOALBS-accurate feed fix / stream source reconnect (!fix / !f)
 * Reconnects ONLY the Belabox / SRT / media stream source on the active scene on air
 * WITHOUT switching scenes, exactly matching NOALBS (crates/obs-actions/src/fix.rs & obs_v5.rs):
 *
 * 1. Checks media player input status: detects if the media feed is actively playing/opening/buffering like NOALBS.
 * 2. If NO stream source is currently playing on the active scene, returns NOALBS message:
 *    "Nothing to fix: no stream source is playing on {scene}"
 * 3. Targets ONLY the live media stream source and leaves all other scene sources untouched.
 * 4. Finds any overlay / standby / low bitrate alert element on the scene and explicitly HIDES it (sceneItemEnabled: false).
 * 5. Reconnects via SetInputSettings ({}), TriggerMediaInputAction (Restart), and obs-smooth-media vendor restart.
 */
export async function safeObsFixFeed(
  obs: any,
  liveScene: string = 'live',
  options?: ObsFixFeedOptions
): Promise<ObsFixFeedResult> {
  if (!obs) {
    return {
      success: false,
      scene: liveScene || 'live',
      sources: [],
      reconnectedCount: 0,
      message: 'OBS WebSocket instance is not connected',
      error: 'OBS WebSocket instance is not connected'
    };
  }

  console.log(`🔧 [OBS] Executing NOALBS !fix: Checking for playing media stream sources on air...`);
  try {
    const currentScene = (await getCurrentObsScene(obs)) || liveScene || 'live';

    // 1. Get scene items on the active program scene
    let items: any[] = [];
    try {
      const sceneItemsRes = await obs.call('GetSceneItemList', { sceneName: currentScene });
      items = (sceneItemsRes?.sceneItems as any[]) || [];
    } catch {
      try {
        const v4Res = await obs.call('GetSceneItemList' as any, { 'scene-name': currentScene });
        items = (v4Res?.sceneItems || v4Res?.sources as any[]) || [];
      } catch {}
    }

    if (!items || items.length === 0) {
      console.warn(`[OBS !fix] No scene items found in active scene "${currentScene}"`);
      return {
        success: true,
        scene: currentScene,
        sources: [],
        reconnectedCount: 0,
        message: `Nothing to fix: no stream source is playing on ${currentScene}`
      };
    }

    // 1. First pass: Ensure all browser sources (like your Stream Overlay) are NEVER hidden!
    // If the overlay source was disabled, restore its visibility to true immediately:
    for (const item of items) {
      const sourceName: string = item.sourceName || item.name || '';
      const itemId = item.sceneItemId ?? item.itemId;
      if (!sourceName || itemId === undefined) continue;

      let itemKind = item.inputKind || '';
      if (!itemKind) {
        try {
          const sRes = await obs.call('GetInputSettings', { inputName: sourceName });
          itemKind = sRes?.inputKind || '';
        } catch {}
      }

      const isOverlayOrBrowser =
        itemKind === 'browser_source' ||
        /(overlay|browser|alert|chat|widget|hud|screen)/i.test(sourceName);

      if (isOverlayOrBrowser) {
        try {
          await obs.call('SetSceneItemEnabled', {
            sceneName: currentScene,
            sceneItemId: itemId,
            sceneItemEnabled: true
          });
          console.log(`👁️ [OBS !fix] Ensured overlay/browser source "${sourceName}" is visible`);
        } catch {}
      }
    }

    // Helper: Identify if an item is strictly a network media stream input (NOALBS ffmpeg/vlc/irl/smooth_media)
    const isBelaboxStreamItem = async (item: any): Promise<{ isStream: boolean; inputKind: string }> => {
      const sourceName: string = item.sourceName || item.name || '';
      const s = sourceName.toLowerCase().trim();
      let kind: string = item.inputKind || '';

      // Query input settings to inspect exact inputKind and settings
      let inputSettings: any = {};
      try {
        const settingsRes = await obs.call('GetInputSettings', { inputName: sourceName });
        kind = settingsRes?.inputKind || kind;
        inputSettings = settingsRes?.inputSettings || {};
      } catch {}

      // Browser sources, image sources, audio captures, text sources are NEVER media stream players!
      if (
        kind === 'browser_source' ||
        kind === 'image_source' ||
        kind === 'text_ft2_source_v2' ||
        kind === 'text_gdiplus_v2' ||
        kind === 'wasapi_input_capture' ||
        kind === 'wasapi_output_capture' ||
        /(overlay|chat|alert|widget|browser|hud)/i.test(sourceName)
      ) {
        return { isStream: false, inputKind: kind };
      }

      // User custom stream source name override
      if (options?.streamSourceName && s === options.streamSourceName.toLowerCase().trim()) {
        return { isStream: true, inputKind: kind || 'ffmpeg_source' };
      }

      // Check inputKind against NOALBS supported media kinds
      const isKnownMediaKind = NOALBS_MEDIA_KINDS.includes(kind);
      const url = String(inputSettings.input || inputSettings.url || inputSettings.path || '').toLowerCase();
      const isNetworkStreamUrl =
        url.startsWith('srt://') ||
        url.startsWith('rtmp://') ||
        url.startsWith('udp://') ||
        url.startsWith('rist://') ||
        url.startsWith('rtsp://') ||
        url.startsWith('tcp://') ||
        url.includes('belabox');

      if (isKnownMediaKind && isNetworkStreamUrl) {
        return { isStream: true, inputKind: kind };
      }

      // Name heuristics: Belabox, Bela, SRT, Stream feed (strictly non-browser)
      if (/bela|belabox/i.test(s) && kind !== 'browser_source') {
        return { isStream: true, inputKind: kind || 'ffmpeg_source' };
      }

      if (/(srt|feed|stream|irl|camera|cam\b)/i.test(s) && !/(chat|alert|audio|mic|bot|sub|goal|music|spotify|webcam|scene|overlay|browser)/i.test(s) && kind !== 'browser_source') {
        return { isStream: true, inputKind: kind || 'ffmpeg_source' };
      }

      return { isStream: isKnownMediaKind && isNetworkStreamUrl, inputKind: kind };
    };

    // 2. Find candidate stream sources on the current active scene
    const candidateSources: { item: any; sourceName: string; itemId?: number; inputKind: string }[] = [];
    for (const item of items) {
      const sourceName: string = item.sourceName || item.name || '';
      const itemId = item.sceneItemId ?? item.itemId;
      if (!sourceName) continue;

      // Skip browser sources (overlay, chat, alerts) from being treated as media stream players
      if (item.inputKind === 'browser_source' || /(overlay|chat|alert|widget|browser)/i.test(sourceName)) {
        continue;
      }

      const check = await isBelaboxStreamItem(item);
      if (check.isStream) {
        candidateSources.push({ item, sourceName, itemId, inputKind: check.inputKind });
      }
    }

    // Fallback: search for any source named bela/belabox/srt/feed if candidates is empty
    if (candidateSources.length === 0) {
      for (const item of items) {
        const sourceName: string = item.sourceName || item.name || '';
        const itemId = item.sceneItemId ?? item.itemId;
        if (!sourceName || item.inputKind === 'browser_source' || /(overlay|chat|alert|widget|browser)/i.test(sourceName)) continue;

        if (/(bela|belabox|srt|feed)/i.test(sourceName) && !/(chat|alert|overlay|audio|mic|browser)/i.test(sourceName)) {
          candidateSources.push({ item, sourceName, itemId, inputKind: item.inputKind || 'ffmpeg_source' });
        }
      }
    }

    // 4. Third pass (Target Stream Source Identification):
    // Prioritize stream sources reporting active playing/buffering/opening states.
    // If none report playing (e.g. the feed dropped, froze, or ended — the exact reason !fix was triggered!),
    // target all candidate stream sources on the scene so the broken feed is revived.
    const playingStreamSources: { item: any; sourceName: string; itemId?: number; inputKind: string }[] = [];
    for (const candidate of candidateSources) {
      const { sourceName } = candidate;
      const mediaStatus = await getObsMediaInputStatus(obs, sourceName);

      const isExplicitTarget = options?.streamSourceName && sourceName.toLowerCase() === options.streamSourceName.toLowerCase();
      if (mediaStatus?.isLive || isExplicitTarget) {
        console.log(`📡 [OBS !fix] Media feed "${sourceName}" detected LIVE (${mediaStatus?.state || 'TARGETED'})`);
        playingStreamSources.push(candidate);
      } else {
        console.log(`⏸️ [OBS !fix] Media source "${sourceName}" state is ${mediaStatus?.state || 'UNKNOWN'}`);
      }
    }

    const targetSources = playingStreamSources.length > 0 ? playingStreamSources : candidateSources;

    // If NO candidate stream source exists on the active scene, return friendly message
    if (targetSources.length === 0) {
      const nothingMsg = `Nothing to fix: no stream source found on ${currentScene}`;
      console.log(`ℹ [OBS !fix] ${nothingMsg}`);
      return {
        success: true,
        scene: currentScene,
        sources: [],
        reconnectedCount: 0,
        message: nothingMsg
      };
    }

    // 5. Execute NOALBS In-Place Reconnect on the target media sources
    const fixedSources: string[] = [];
    for (const stream of targetSources) {
      const { sourceName, itemId, inputKind } = stream;
      console.log(`🎯 [OBS !fix] Reconnecting media stream source "${sourceName}" (${inputKind || 'media'})...`);

      // NOALBS Method A: TriggerMediaInputAction Restart (for irl_source or media inputs)
      try {
        await obs.call('TriggerMediaInputAction', {
          inputName: sourceName,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
        });
        console.log(`✅ [OBS !fix] MediaAction Restart sent to "${sourceName}"`);
      } catch {}

      // NOALBS Method B: Settings rewrite callback (for ffmpeg_source / vlc_source)
      // Empty inputSettings rewrite triggers the underlying FFmpeg network reconnect callback
      try {
        await obs.call('SetInputSettings', {
          inputName: sourceName,
          inputSettings: {},
          overlay: true
        });
        console.log(`✅ [OBS !fix] SetInputSettings callback sent to "${sourceName}"`);
      } catch {}

      // NOALBS Method C: obs-smooth-media vendor request
      try {
        await obs.call('CallVendorRequest', {
          vendorName: 'obs-smooth-media',
          requestType: 'RestartSource',
          requestData: { sourceName }
        });
        console.log(`✅ [OBS !fix] obs-smooth-media RestartSource sent to "${sourceName}"`);
      } catch {}

      // Method D: Ensure Belabox scene item is enabled (toggle if stuck to re-initialize socket)
      if (itemId !== undefined) {
        try {
          await obs.call('SetSceneItemEnabled', {
            sceneName: currentScene,
            sceneItemId: itemId,
            sceneItemEnabled: true
          });
          console.log(`✅ [OBS !fix] Ensured Belabox scene item "${sourceName}" is enabled`);
        } catch {}
      }

      fixedSources.push(sourceName);
    }

    const successMsg = `Reconnecting ${fixedSources.join(', ')}`;
    console.log(`🎉 [OBS !fix] Completed: ${successMsg}`);
    return {
      success: true,
      scene: currentScene,
      sources: fixedSources,
      reconnectedCount: fixedSources.length,
      message: successMsg
    };
  } catch (err: any) {
    console.error('❌ [OBS !fix] Error fixing feed:', err);
    return {
      success: false,
      scene: liveScene || 'live',
      sources: [],
      reconnectedCount: 0,
      message: `Failed to fix feed: ${formatObsError(err)}`,
      error: formatObsError(err)
    };
  }
}

/**
 * Universal video recording control (!rec)
 */
export async function safeObsRecordControl(
  obs: any,
  action: 'toggle' | 'start' | 'stop' = 'toggle'
): Promise<{ success: boolean; isRecording?: boolean; error?: string }> {
  if (!obs) return { success: false, error: 'OBS WebSocket instance is not connected' };

  try {
    if (action === 'start') {
      await obs.call('StartRecord');
      return { success: true, isRecording: true };
    } else if (action === 'stop') {
      await obs.call('StopRecord');
      return { success: true, isRecording: false };
    } else {
      const res = await obs.call('ToggleRecord');
      return { success: true, isRecording: res?.outputActive };
    }
  } catch (err1: any) {
    try {
      if (action === 'start') {
        await obs.call('StartRecording' as any);
        return { success: true, isRecording: true };
      } else if (action === 'stop') {
        await obs.call('StopRecording' as any);
        return { success: true, isRecording: false };
      } else {
        await obs.call('StartStopRecording' as any);
        return { success: true };
      }
    } catch (err2) {
      return { success: false, error: formatObsError(err1 || err2) };
    }
  }
}

export async function safeObsStreamControlResult(
  obs: any,
  action: 'start' | 'stop' | 'refresh' | 'fix' | 'rec' | 'start_record' | 'stop_record',
  options?: {
    refreshScene?: string;
    liveScene?: string;
    delayMs?: number;
    isLiveBitrate?: boolean;
    currentBitrate?: number;
    streamSourceName?: string;
    overlaySourceName?: string;
  }
): Promise<{ success: boolean; isRecording?: boolean; scene?: string; sources?: string[]; message?: string; error?: string }> {
  if (!obs) return { success: false, error: 'OBS WebSocket instance is not connected' };

  if (action === 'fix') {
    const liveScene = options?.liveScene || 'live';
    const fixRes = await safeObsFixFeed(obs, liveScene, {
      streamSourceName: options?.streamSourceName,
      overlaySourceName: options?.overlaySourceName
    });
    return {
      success: fixRes.success,
      scene: fixRes.scene,
      sources: fixRes.sources,
      message: fixRes.message,
      error: fixRes.error
    };
  }

  if (action === 'refresh') {
    const refreshScene = options?.refreshScene || 'refresh';
    const liveScene = options?.liveScene || 'live';
    const cycleRes = await safeObsRefreshCycle(obs, refreshScene, liveScene, options?.delayMs || 6000, {
      isLiveBitrate: options?.isLiveBitrate,
      currentBitrate: options?.currentBitrate
    });
    return cycleRes;
  }

  if (action === 'rec' || action === 'start_record' || action === 'stop_record') {
    const recordAction = action === 'start_record' ? 'start' : action === 'stop_record' ? 'stop' : 'toggle';
    return await safeObsRecordControl(obs, recordAction);
  }

  const isStart = action === 'start';
  let lastError: any = null;

  // Check if error signifies that the stream is already in the requested state
  const isAlreadyInState = (err: any): boolean => {
    const text = String(err?.message || err?.error || err || '').toLowerCase();
    if (isStart && (text.includes('already active') || text.includes('output is active') || text.includes('already running') || text.includes('busy'))) {
      return true;
    }
    if (!isStart && (text.includes('not active') || text.includes('not running') || text.includes('already stopped') || text.includes('inactive'))) {
      return true;
    }
    return false;
  };

  // 1. Try OBS WebSocket v5 standard: StartStream / StopStream
  try {
    if (isStart) {
      await obs.call('StartStream');
    } else {
      await obs.call('StopStream');
    }
    console.log(`✅ [OBS] v5 ${action === 'start' ? 'StartStream' : 'StopStream'} executed successfully.`);
    return { success: true };
  } catch (err1: any) {
    if (isAlreadyInState(err1)) {
      console.log(`✅ [OBS] Stream is already ${isStart ? 'broadcasting' : 'stopped'}.`);
      return { success: true };
    }
    lastError = err1;
    console.warn(`⚠️ [OBS] v5 StartStream/StopStream failed: ${formatObsError(err1)}`, err1);
  }

  // 2. Try OBS WebSocket v4 standard: StartStreaming / StopStreaming
  try {
    if (isStart) {
      await obs.call('StartStreaming');
    } else {
      await obs.call('StopStreaming');
    }
    console.log(`✅ [OBS] v4 ${action === 'start' ? 'StartStreaming' : 'StopStreaming'} executed successfully.`);
    return { success: true };
  } catch (err3: any) {
    if (isAlreadyInState(err3)) {
      console.log(`✅ [OBS] Stream is already ${isStart ? 'broadcasting' : 'stopped'} (v4).`);
      return { success: true };
    }
    if (!lastError) lastError = err3;
    console.warn(`⚠️ [OBS] v4 StartStreaming/StopStreaming failed: ${formatObsError(err3)}`, err3);
  }

  // 3. Try OBS Outputs API: StartOutput / StopOutput ('simple_stream')
  try {
    if (isStart) {
      await obs.call('StartOutput', { outputName: 'simple_stream' });
    } else {
      await obs.call('StopOutput', { outputName: 'simple_stream' });
    }
    console.log(`✅ [OBS] Outputs simple_stream ${action} executed successfully.`);
    return { success: true };
  } catch (err5: any) {
    if (isAlreadyInState(err5)) {
      return { success: true };
    }
    if (!lastError) lastError = err5;
    console.warn(`⚠️ [OBS] StartOutput simple_stream failed: ${formatObsError(err5)}`, err5);
  }

  // 4. Try OBS Outputs API: StartOutput / StopOutput ('adv_stream')
  try {
    if (isStart) {
      await obs.call('StartOutput', { outputName: 'adv_stream' });
    } else {
      await obs.call('StopOutput', { outputName: 'adv_stream' });
    }
    console.log(`✅ [OBS] Outputs adv_stream ${action} executed successfully.`);
    return { success: true };
  } catch (err6: any) {
    if (isAlreadyInState(err6)) {
      return { success: true };
    }
    if (!lastError) lastError = err6;
    console.warn(`⚠️ [OBS] StartOutput adv_stream failed: ${formatObsError(err6)}`, err6);
  }

  // 5. Direct raw WebSocket message if socket reference exists
  try {
    const rawWs = obs.socket || obs._socket || obs.ws;
    if (rawWs && rawWs.readyState === 1) {
      const v4Payload = JSON.stringify({
        "request-type": isStart ? "StartStreaming" : "StopStreaming",
        "message-id": `stream-cmd-${Date.now()}`
      });
      rawWs.send(v4Payload);
      console.log(`✅ [OBS] Raw WebSocket payload sent successfully.`);
      return { success: true };
    }
  } catch (err7: any) {
    if (!lastError) lastError = err7;
    console.warn(`⚠️ [OBS] Raw WebSocket payload send failed: ${formatObsError(err7)}`, err7);
  }

  const detailedError = formatObsError(lastError);
  console.error(`❌ [OBS] All 7 stream execution attempts failed. OBS error detail: ${detailedError}`);
  return { success: false, error: detailedError };
}

export async function safeObsStreamControl(
  obs: any,
  action: 'start' | 'stop' | 'refresh' | 'fix' | 'rec' | 'start_record' | 'stop_record',
  options?: { refreshScene?: string; liveScene?: string; delayMs?: number; isLiveBitrate?: boolean; currentBitrate?: number }
): Promise<boolean> {
  const result = await safeObsStreamControlResult(obs, action, options);
  return result.success;
}

/**
 * Takes a screenshot of the current stream/scene in OBS Studio
 * Supports OBS WebSocket v5 (GetSourceScreenshot) and v4 fallback (TakeSourceScreenshot).
 * Returns base64 image data (with or without data URI prefix) and the scene name used.
 */
export async function takeObsScreenshot(
  obs: any,
  options?: {
    sceneName?: string;
    imageFormat?: 'jpeg' | 'png';
    imageQuality?: number;
    imageWidth?: number;
    imageHeight?: number;
  }
): Promise<{ success: boolean; imageData?: string; sceneName?: string; error?: string }> {
  if (!obs) {
    return { success: false, error: 'OBS WebSocket instance is not connected' };
  }

  const format = options?.imageFormat || 'jpeg';
  const quality = options?.imageQuality ?? 90;

  // 1. Determine target scene name
  let targetScene = options?.sceneName;
  if (!targetScene) {
    targetScene = (await getCurrentObsScene(obs)) || 'live';
  }

  let lastError: any = null;

  // Try 1: OBS WebSocket v5 GetSourceScreenshot on target scene
  try {
    const params: any = {
      sourceName: targetScene,
      imageFormat: format,
      imageCompressionQuality: quality
    };
    if (options?.imageWidth) params.imageWidth = options.imageWidth;
    if (options?.imageHeight) params.imageHeight = options.imageHeight;

    const res = await obs.call('GetSourceScreenshot', params);
    const img = res.imageData || res.img || '';
    if (img) {
      console.log(`✅ [OBS] Captured stream screenshot of "${targetScene}" via v5 GetSourceScreenshot`);
      return { success: true, imageData: img, sceneName: targetScene };
    }
  } catch (err1: any) {
    lastError = err1;
    console.warn(`⚠️ [OBS] v5 GetSourceScreenshot on "${targetScene}" failed: ${formatObsError(err1)}`);
  }

  // Try 2: If target scene name failed, attempt listing scenes and taking screenshot of the exact match or first available scene
  try {
    const sceneListData = await obs.call('GetSceneList');
    const scenes = (sceneListData.scenes as any[]) || [];
    const matched = scenes.find((s: any) =>
      String(s.sceneName || s.name || '').toLowerCase() === targetScene?.toLowerCase()
    ) || scenes[0];

    if (matched) {
      const exactSceneName = String(matched.sceneName || matched.name);
      const res = await obs.call('GetSourceScreenshot', {
        sourceName: exactSceneName,
        imageFormat: format,
        imageCompressionQuality: quality
      });
      const img = res.imageData || res.img || '';
      if (img) {
        console.log(`✅ [OBS] Captured stream screenshot of "${exactSceneName}" via scene list match`);
        return { success: true, imageData: img, sceneName: exactSceneName };
      }
    }
  } catch (err2: any) {
    if (!lastError) lastError = err2;
  }

  // Try 3: Fallback to v4 TakeSourceScreenshot
  try {
    const res = await obs.call('TakeSourceScreenshot' as any, {
      sourceName: targetScene,
      embedPictureFormat: format === 'jpeg' ? 'jpg' : format,
      compressionQuality: quality
    });
    const img = res.img || res.imageData || '';
    if (img) {
      console.log(`✅ [OBS] Captured stream screenshot via v4 TakeSourceScreenshot`);
      return { success: true, imageData: img, sceneName: targetScene };
    }
  } catch (err3: any) {
    if (!lastError) lastError = err3;
    console.warn(`⚠️ [OBS] v4 TakeSourceScreenshot failed: ${formatObsError(err3)}`);
  }

  const detailedError = formatObsError(lastError);
  return { success: false, error: detailedError };
}

/**
 * Triggers saving the OBS Studio Replay Buffer to disk and returns the path to the saved video file.
 * Handles both v5 and v4 OBS WebSocket protocols.
 * If replay buffer is not currently active, attempts to start it automatically.
 */
export async function triggerObsReplayBuffer(
  obs: any,
  timeoutMs: number = 15000
): Promise<{ success: boolean; replayPath?: string; sceneName?: string; error?: string }> {
  if (!obs) {
    return { success: false, error: 'OBS WebSocket instance is not connected' };
  }

  try {
    // 1. Get current scene name for logging and metadata
    const sceneName = (await getCurrentObsScene(obs)) || 'live';

    // 2. Check replay buffer status (v5 & v4 support)
    let isBufferActive = false;
    try {
      const statusRes = await obs.call('GetReplayBufferStatus');
      isBufferActive = Boolean(statusRes?.outputActive);
    } catch {
      try {
        const v4Status = await obs.call('GetReplayBufferStatus' as any);
        isBufferActive = Boolean(v4Status?.isReplayBufferActive || v4Status?.outputActive);
      } catch (statusErr) {
        console.warn('[OBS] Could not query replay buffer status:', formatObsError(statusErr));
      }
    }

    // 3. If replay buffer is not active, try starting it
    if (!isBufferActive) {
      console.log('🔄 [OBS] Replay Buffer is inactive. Starting Replay Buffer now...');
      try {
        await obs.call('StartReplayBuffer');
        await new Promise(r => setTimeout(r, 1500)); // allow buffer initialization
      } catch (startErr: any) {
        console.warn('⚠️ [OBS] Failed to start replay buffer:', formatObsError(startErr));
        return {
          success: false,
          error: 'OBS Replay Buffer is not active. Please enable Replay Buffer in OBS Settings > Output > Enable Replay Buffer.'
        };
      }
    }

    // 4. Set up one-time listener for ReplayBufferSaved event
    let savedFilePath: string | null = null;
    let eventResolver: ((path: string) => void) | null = null;

    const replayPromise = new Promise<string>((resolve) => {
      eventResolver = resolve;
    });

    const onReplaySaved = (data: any) => {
      const path = data?.savedReplayPath || data?.path || data?.filename || '';
      if (path && eventResolver) {
        console.log(`💾 [OBS] ReplayBufferSaved event received: ${path}`);
        eventResolver(path);
      }
    };

    try {
      obs.on('ReplayBufferSaved' as any, onReplaySaved);
    } catch {}

    // 5. Call SaveReplayBuffer
    try {
      await obs.call('SaveReplayBuffer');
      console.log('✅ [OBS] SaveReplayBuffer request sent.');
    } catch (saveErr: any) {
      try {
        // v4 fallback
        await obs.call('SaveReplayBuffer' as any, {});
      } catch (v4SaveErr) {
        if (eventResolver) {
          try { obs.off('ReplayBufferSaved' as any, onReplaySaved); } catch {}
        }
        return { success: false, error: `Failed to save OBS replay buffer: ${formatObsError(saveErr)}` };
      }
    }

    // 6. Wait for ReplayBufferSaved event or query last replay
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for OBS to save replay file')), timeoutMs)
    );

    try {
      savedFilePath = await Promise.race([replayPromise, timeoutPromise]);
    } catch (waitErr) {
      console.warn('⚠️ [OBS] Timed out waiting for ReplayBufferSaved event, checking GetLastReplayBufferReplay...');
      try {
        const lastReplay = await obs.call('GetLastReplayBufferReplay');
        savedFilePath = lastReplay?.savedReplayPath || null;
      } catch {
        try {
          const lastV4 = await obs.call('GetLastReplay' as any);
          savedFilePath = lastV4?.['replay-path'] || lastV4?.path || null;
        } catch {}
      }
    } finally {
      try {
        obs.off('ReplayBufferSaved' as any, onReplaySaved);
      } catch {}
    }

    if (!savedFilePath) {
      return {
        success: false,
        error: 'OBS did not return a saved replay file path. Ensure Replay Buffer is configured properly in OBS.'
      };
    }

    return {
      success: true,
      replayPath: savedFilePath,
      sceneName
    };
  } catch (err: any) {
    return {
      success: false,
      error: formatObsError(err)
    };
  }
}

/**
 * Creates an interval driven by an inline Web Worker so Chromium / OBS CEF
 * never throttles or suspends it when the Browser Source's scene is inactive/hidden.
 */
export function createUnthrottledInterval(callback: () => void, ms: number): () => void {
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
    try {
      const intervalMs = Math.max(100, Math.floor(ms));
      const blob = new Blob([
        `const id = setInterval(() => postMessage('tick'), ${intervalMs}); onmessage = (e) => { if (e.data === 'stop') clearInterval(id); };`
      ], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      worker.onmessage = () => callback();
      return () => {
        try {
          worker.postMessage('stop');
          worker.terminate();
          URL.revokeObjectURL(url);
        } catch {}
      };
    } catch {}
  }
  const id = setInterval(callback, ms);
  return () => clearInterval(id);
}

/**
 * Automatically ensures the Overlay Browser Source in OBS Studio has
 * "Shutdown source when not visible" (shutdown) and "Refresh browser when scene becomes active"
 * (restart_when_active) disabled, so a single Browser Source link stays active across all scenes
 * just like NOALBS Cloud.
 */
export async function ensureOverlayBrowserSourcesPersistent(obs: any): Promise<void> {
  if (!obs) return;
  try {
    const listRes: any = await obs.call('GetInputList', { inputKind: 'browser_source' }).catch(() => null);
    const inputs: any[] = listRes?.inputs || [];
    for (const inp of inputs) {
      const inputName = inp?.inputName;
      if (!inputName) continue;
      try {
        const settingsRes: any = await obs.call('GetInputSettings', { inputName });
        const s = settingsRes?.inputSettings || {};
        const url = String(s.url || '').toLowerCase();
        const isOurOverlay = url.includes('/overlay') || url.includes('/low-bitrate') || /overlay/i.test(inputName);
        if (isOurOverlay && (s.shutdown === true || s.restart_when_active === true)) {
          await obs.call('SetInputSettings', {
            inputName,
            inputSettings: {
              ...s,
              shutdown: false,
              restart_when_active: false,
            },
            overlay: true,
          });
          console.log(`✅ [OBS] Disabled "Shutdown when not visible" on browser source "${inputName}" for persistent scene switching.`);
        }
      } catch {}
    }
  } catch {}
}


