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
  try {
    // 1. Try standard OBS WebSocket v5: SetCurrentProgramScene
    await obs.call('SetCurrentProgramScene', { sceneName });
    console.log(`✅ [OBS] Switched scene to: "${sceneName}"`);
    return true;
  } catch (err1) {
    try {
      // 2. Case-insensitive scene name lookup matching
      const sceneListData = await obs.call('GetSceneList');
      const scenes = (sceneListData.scenes as any[]) || [];
      const matched = scenes.find((s: any) => 
        String(s.sceneName || s.name || '').toLowerCase() === sceneName.toLowerCase()
      );
      if (matched) {
        const exactName = String(matched.sceneName || matched.name);
        await obs.call('SetCurrentProgramScene', { sceneName: exactName });
        console.log(`✅ [OBS] Switched scene via case-insensitive match to: "${exactName}"`);
        return true;
      }
    } catch {}

    try {
      // 3. Fallback to v4 syntax: SetCurrentScene
      const v4Method = 'SetCurrentScene' as any;
      await obs.call(v4Method, { 'scene-name': sceneName });
      console.log(`✅ [OBS] Switched scene via v4 to: "${sceneName}"`);
      return true;
    } catch (err3) {
      console.warn(`⚠️ [OBS] safeObsSwitchScene failed for "${sceneName}": ${formatObsError(err3)}`);
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

export async function safeObsStreamControlResult(
  obs: any,
  action: 'start' | 'stop' | 'refresh',
  options?: { refreshScene?: string; liveScene?: string; delayMs?: number; isLiveBitrate?: boolean; currentBitrate?: number }
): Promise<{ success: boolean; error?: string }> {
  if (!obs) return { success: false, error: 'OBS WebSocket instance is not connected' };

  if (action === 'refresh') {
    const refreshScene = options?.refreshScene || 'refresh';
    const liveScene = options?.liveScene || 'live';
    const cycleRes = await safeObsRefreshCycle(obs, refreshScene, liveScene, options?.delayMs || 6000, {
      isLiveBitrate: options?.isLiveBitrate,
      currentBitrate: options?.currentBitrate
    });
    return cycleRes;
  }

  const isStart = action === 'start';
  let lastError: any = null;

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
    lastError = err1;
    console.warn(`⚠️ [OBS] v5 StartStream/StopStream failed: ${formatObsError(err1)}`, err1);
  }

  // 2. Try OBS WebSocket v5 toggle: ToggleStream
  try {
    await obs.call('ToggleStream');
    console.log(`✅ [OBS] v5 ToggleStream executed successfully.`);
    return { success: true };
  } catch (err2: any) {
    if (!lastError) lastError = err2;
    console.warn(`⚠️ [OBS] v5 ToggleStream failed: ${formatObsError(err2)}`, err2);
  }

  // 3. Try OBS WebSocket v4 standard: StartStreaming / StopStreaming
  try {
    if (isStart) {
      await obs.call('StartStreaming');
    } else {
      await obs.call('StopStreaming');
    }
    console.log(`✅ [OBS] v4 ${action === 'start' ? 'StartStreaming' : 'StopStreaming'} executed successfully.`);
    return { success: true };
  } catch (err3: any) {
    if (!lastError) lastError = err3;
    console.warn(`⚠️ [OBS] v4 StartStreaming/StopStreaming failed: ${formatObsError(err3)}`, err3);
  }

  // 4. Try OBS WebSocket v4 toggle: ToggleStreaming
  try {
    await obs.call('ToggleStreaming');
    console.log(`✅ [OBS] v4 ToggleStreaming executed successfully.`);
    return { success: true };
  } catch (err4: any) {
    if (!lastError) lastError = err4;
    console.warn(`⚠️ [OBS] v4 ToggleStreaming failed: ${formatObsError(err4)}`, err4);
  }

  // 5. Try OBS Outputs API: StartOutput / StopOutput ('simple_stream')
  try {
    if (isStart) {
      await obs.call('StartOutput', { outputName: 'simple_stream' });
    } else {
      await obs.call('StopOutput', { outputName: 'simple_stream' });
    }
    console.log(`✅ [OBS] Outputs simple_stream ${action} executed successfully.`);
    return { success: true };
  } catch (err5: any) {
    if (!lastError) lastError = err5;
    console.warn(`⚠️ [OBS] StartOutput simple_stream failed: ${formatObsError(err5)}`, err5);
  }

  // 6. Try OBS Outputs API: StartOutput / StopOutput ('adv_stream')
  try {
    if (isStart) {
      await obs.call('StartOutput', { outputName: 'adv_stream' });
    } else {
      await obs.call('StopOutput', { outputName: 'adv_stream' });
    }
    console.log(`✅ [OBS] Outputs adv_stream ${action} executed successfully.`);
    return { success: true };
  } catch (err6: any) {
    if (!lastError) lastError = err6;
    console.warn(`⚠️ [OBS] StartOutput adv_stream failed: ${formatObsError(err6)}`, err6);
  }

  // 7. Direct raw WebSocket message if socket reference exists
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
  action: 'start' | 'stop' | 'refresh',
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
