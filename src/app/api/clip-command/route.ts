import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  getStreamElementsChannelId,
  getStreamElementsUserPoints,
  modifyStreamElementsPoints
} from '@/lib/streamelements-helper';
import { OverlayLogger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

/**
 * Helper to retrieve current settings from cache or KV
 */
async function getSettings(): Promise<any> {
  let settings: any = (typeof globalThis !== 'undefined' ? (globalThis as any).__cachedOverlaySettings : null) || null;
  if (!settings) {
    try {
      const kvData = await kv.get('overlay_settings');
      if (kvData && typeof kvData === 'object') {
        settings = kvData;
      }
    } catch {}
  }
  return settings || {};
}

/**
 * Helper to wait for file writing to stabilize
 */
async function waitForFile(filePath: string, maxWaitMs: number = 3000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    if (fs.existsSync(filePath)) {
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > 1000) {
          // Wait an extra 150ms to ensure OBS has released any lock
          await new Promise(r => setTimeout(r, 150));
          return true;
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return fs.existsSync(filePath);
}

/**
 * Trims and compresses the OBS replay video using ffmpeg
 */
async function processClipWithFfmpeg(
  inputPath: string,
  durationSec: number
): Promise<{ outputPath: string; cleanup: () => void }> {
  const tempDir = os.tmpdir();
  const rawOutputName = `stream_clip_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.mp4`;
  const outputPath = path.join(tempDir, rawOutputName);

  const cleanup = () => {
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch {}
  };

  // Safe duration clamp
  const safeDuration = Math.max(5, Math.min(180, durationSec || 60));

  // Find ffmpeg binary
  let ffmpegPath = 'ffmpeg';
  const commonFfmpegPaths = [
    'ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
  ];

  for (const testPath of commonFfmpegPaths) {
    if (testPath === 'ffmpeg' || fs.existsSync(testPath)) {
      ffmpegPath = testPath;
      break;
    }
  }

  // FFmpeg command:
  // -sseof -N : seeks N seconds from the end of the input file
  // -c:v libx264 -preset fast -crf 23 -maxrate 3500k -bufsize 7000k : high quality web-optimized H.264
  // -c:a aac -b:a 128k : crisp AAC audio
  // -movflags +faststart : puts metadata at start of MP4 for fast Discord streaming
  const ffmpegArgs = [
    '-y',
    '-sseof', `-${safeDuration}`,
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-maxrate', '3500k',
    '-bufsize', '7000k',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ];

  OverlayLogger.overlay(`Running FFmpeg clip extraction: duration ${safeDuration}s on ${inputPath}`);

  try {
    await execFileAsync(ffmpegPath, ffmpegArgs, { timeout: 45000 });
  } catch (execErr: any) {
    OverlayLogger.error('FFmpeg execution failed with -sseof, attempting fallback trim:', execErr);
    // Fallback: extract last N seconds without sseof or direct copy
    const fallbackArgs = [
      '-y',
      '-i', inputPath,
      '-t', `${safeDuration}`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '24',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    ];
    await execFileAsync(ffmpegPath, fallbackArgs, { timeout: 45000 });
  }

  // Verify file size (Discord free webhook limit is 25MB = 26,214,400 bytes)
  if (fs.existsSync(outputPath)) {
    const stats = fs.statSync(outputPath);
    const maxBytes = 24.5 * 1024 * 1024; // 24.5 MB buffer

    if (stats.size > maxBytes) {
      OverlayLogger.warn(`Clip size (${(stats.size / 1024 / 1024).toFixed(1)}MB) exceeds 24.5MB. Re-encoding at 720p...`);
      const compressedOutputName = `stream_clip_comp_${Date.now()}.mp4`;
      const compressedPath = path.join(tempDir, compressedOutputName);

      try {
        await execFileAsync(ffmpegPath, [
          '-y',
          '-i', outputPath,
          '-vf', 'scale=-2:720',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-b:v', '1800k',
          '-maxrate', '2000k',
          '-bufsize', '4000k',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '96k',
          '-movflags', '+faststart',
          compressedPath
        ], { timeout: 45000 });

        cleanup(); // delete previous oversized file
        return {
          outputPath: compressedPath,
          cleanup: () => {
            try {
              if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
            } catch {}
          }
        };
      } catch (compErr) {
        OverlayLogger.error('Secondary compression failed, continuing with original file:', compErr);
      }
    }
  }

  return { outputPath, cleanup };
}

/**
 * Uploads a video clip buffer to Discord Webhook
 */
async function postClipToDiscord(options: {
  webhookUrl: string;
  videoBuffer: Buffer;
  filename: string;
  username: string;
  displayName: string;
  duration: number;
  pointsSpent?: number;
  sceneName?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { webhookUrl, videoBuffer, filename, username, displayName, duration, pointsSpent = 300, sceneName } = options;

  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    return { success: false, error: 'Invalid or missing Discord Webhook URL' };
  }

  if (!videoBuffer || videoBuffer.length === 0) {
    return { success: false, error: 'Empty video buffer received' };
  }

  try {
    const name = displayName || username || 'Viewer';
    const nowIso = new Date().toISOString();
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const discordPayload = {
      content: `🎬 **!clip** (${duration}s) captured by **${name}**!`,
      embeds: [
        {
          title: `🎬 Live Stream Clip (${duration}s)`,
          description: `Clipped by **${name}** via \`!clip ${duration}\` (**${pointsSpent}** StreamElements points)${sceneName ? `\n📺 Scene: \`${sceneName}\`` : ''}`,
          color: 0x00d2ff, // Vibrant neon cyan
          footer: {
            text: `Stream Overlay • ${timeStr}`
          },
          timestamp: nowIso
        }
      ]
    };

    const formData = new FormData();
    formData.append('payload_json', JSON.stringify(discordPayload));

    const videoBlob = new Blob([new Uint8Array(videoBuffer)], { type: 'video/mp4' });
    formData.append('files[0]', videoBlob, filename || 'stream_clip.mp4');

    const discordRes = await fetch(webhookUrl, {
      method: 'POST',
      body: formData
    });

    if (discordRes.ok || discordRes.status === 204) {
      OverlayLogger.overlay(`Successfully posted !clip (${duration}s) to Discord for @${name}`);
      return { success: true };
    }

    const errText = await discordRes.text().catch(() => '');
    OverlayLogger.error(`Discord webhook failed (HTTP ${discordRes.status}):`, errText);
    return { success: false, error: `Discord Webhook HTTP ${discordRes.status}: ${errText.slice(0, 200)}` };
  } catch (err: any) {
    OverlayLogger.error('Error posting clip to Discord:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * POST /api/clip-command
 * 
 * Supports:
 * 1. action: 'check_and_deduct' - verifies viewer has sufficient SE points and deducts them
 * 2. action: 'refund_points' - refunds points if clip capture/upload fails
 * 3. action: 'process_and_upload' - trims OBS replay with ffmpeg, compresses, and posts to Discord
 * 4. action: 'test' - sends a test card to Discord clip webhook
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action || 'process_and_upload';
    const settings = await getSettings();

    const seToken = body.seToken || settings.streamElementsToken || '';
    const webhookUrl = body.webhookUrl || settings.discordClipWebhookUrl || settings.discordPicWebhookUrl || '';
    const pointsCost = typeof body.pointsCost === 'number' ? body.pointsCost : (settings.clipPointsCost ?? 300);

    // ==========================================
    // ACTION: create_twitch_clip (Cloud Native Twitch Clip)
    // ==========================================
    if (action === 'create_twitch_clip') {
      const { broadcasterId, token, clientId = 'xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw', username, displayName, sceneName } = body;
      const targetWebhook = body.webhookUrl || webhookUrl;

      if (!token || !broadcasterId) {
        return NextResponse.json({
          success: false,
          error: 'Twitch account is not connected. Please connect Twitch in Settings to enable Twitch clips.'
        }, { status: 400 });
      }

      const name = displayName || username || 'Viewer';
      OverlayLogger.overlay(`Triggering Twitch Helix Create Clip API for broadcaster ${broadcasterId}...`);

      try {
        const twitchRes = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${encodeURIComponent(broadcasterId)}`, {
          method: 'POST',
          headers: {
            'Client-Id': clientId,
            'Authorization': `Bearer ${token}`
          }
        });

        if (!twitchRes.ok) {
          const errText = await twitchRes.text().catch(() => '');
          let cleanErrMsg = 'Stream must be live to create clips.';
          try {
            const errJson = JSON.parse(errText);
            if (errJson.message === 'Channel offline.' || twitchRes.status === 404) {
              cleanErrMsg = 'Channel is offline. Stream must be live on Twitch to create clips.';
            } else if (errJson.message) {
              cleanErrMsg = errJson.message;
            }
          } catch {}

          OverlayLogger.error(`Twitch Clip API error HTTP ${twitchRes.status}:`, errText);
          return NextResponse.json({
            success: false,
            error: cleanErrMsg
          }, { status: twitchRes.status });
        }

        const twitchData = await twitchRes.json();
        const clipInfo = twitchData?.data?.[0];

        if (!clipInfo || !clipInfo.id) {
          return NextResponse.json({
            success: false,
            error: 'Twitch did not return a clip ID. Clips can only be created while the stream is actively live.'
          }, { status: 500 });
        }

        const clipSlug = clipInfo.id;
        const clipUrl = `https://clips.twitch.tv/${clipSlug}`;
        const editUrl = clipInfo.edit_url || clipUrl;

        // Post to Discord Webhook if configured
        if (targetWebhook && targetWebhook.startsWith('https://')) {
          const nowIso = new Date().toISOString();
          const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          const discordPayload = {
            content: `🎬 **!clip** captured by **${name}**!\n${clipUrl}`,
            embeds: [
              {
                title: `🎬 Twitch Stream Clip`,
                url: clipUrl,
                description: `Clipped by **${name}** via \`!clip\` chat command${pointsCost > 0 ? ` (${pointsCost} points)` : ''}${sceneName ? `\n📺 Scene: \`${sceneName}\`` : ''}\n\n👉 [Watch on Twitch](${clipUrl}) • [Edit Clip](${editUrl})`,
                color: 0x9146ff,
                footer: {
                  text: `Twitch Clips • Stream Overlay • ${timeStr}`
                },
                timestamp: nowIso
              }
            ]
          };

          fetch(targetWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(discordPayload)
          }).catch(err => OverlayLogger.error('Failed to post Twitch clip to Discord webhook:', err));
        }

        return NextResponse.json({
          success: true,
          clipId: clipSlug,
          clipUrl,
          editUrl,
          message: 'Twitch clip created and sent to Discord successfully!'
        });
      } catch (clipErr: any) {
        OverlayLogger.error('Exception calling Twitch Clip API:', clipErr);
        return NextResponse.json({
          success: false,
          error: clipErr?.message || 'Failed to communicate with Twitch Clip API'
        }, { status: 500 });
      }
    }

    // ==========================================
    // ACTION: check_and_deduct
    // ==========================================
    if (action === 'check_and_deduct') {
      const { username } = body;
      if (!username) {
        return NextResponse.json({ success: false, error: 'Missing username' }, { status: 400 });
      }

      // If points cost is 0 or less, allow free clipping
      if (pointsCost <= 0) {
        return NextResponse.json({
          success: true,
          channelId: body.channelId || 'free',
          previousPoints: 0,
          newPoints: 0,
          pointsDeducted: 0,
          free: true
        });
      }

      if (!seToken) {
        return NextResponse.json({
          success: false,
          error: 'StreamElements is not connected. Please set StreamElements JWT token in Settings.'
        }, { status: 400 });
      }

      const channelId = body.channelId || await getStreamElementsChannelId(seToken);
      if (!channelId) {
        return NextResponse.json({
          success: false,
          error: 'Could not resolve StreamElements channel ID from JWT token.'
        }, { status: 400 });
      }

      // Check current points
      const pointsRes = await getStreamElementsUserPoints(seToken, channelId, username);
      if (!pointsRes.success) {
        return NextResponse.json({
          success: false,
          error: `Could not verify loyalty points: ${pointsRes.error || 'User not found'}`
        }, { status: 400 });
      }

      if (pointsRes.points < pointsCost) {
        return NextResponse.json({
          success: false,
          insufficient: true,
          currentPoints: pointsRes.points,
          requiredPoints: pointsCost,
          error: `Insufficient points (requires ${pointsCost}, user has ${pointsRes.points})`
        });
      }

      // Deduct points
      const deductRes = await modifyStreamElementsPoints(seToken, channelId, username, -pointsCost);
      if (!deductRes.success) {
        return NextResponse.json({
          success: false,
          error: `Failed to deduct points: ${deductRes.error}`
        }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        channelId,
        previousPoints: pointsRes.points,
        newPoints: deductRes.newPoints,
        pointsDeducted: pointsCost
      });
    }

    // ==========================================
    // ACTION: refund_points
    // ==========================================
    if (action === 'refund_points') {
      const { username, channelId, amount = pointsCost } = body;
      if (amount <= 0) {
        return NextResponse.json({ success: true, refundedAmount: 0, newPoints: 0 });
      }
      if (!username || !seToken) {
        return NextResponse.json({ success: false, error: 'Missing username or token' }, { status: 400 });
      }

      const resolvedChannelId = channelId || await getStreamElementsChannelId(seToken);
      if (!resolvedChannelId) {
        return NextResponse.json({ success: false, error: 'Could not resolve channel ID' }, { status: 400 });
      }

      const refundRes = await modifyStreamElementsPoints(seToken, resolvedChannelId, username, amount);
      return NextResponse.json({
        success: refundRes.success,
        newPoints: refundRes.newPoints,
        refundedAmount: amount,
        error: refundRes.error
      });
    }

    // ==========================================
    // ACTION: test (Discord Webhook test)
    // ==========================================
    if (action === 'test') {
      const testWebhook = body.webhookUrl || webhookUrl;
      if (!testWebhook || !testWebhook.startsWith('https://')) {
        return NextResponse.json({ success: false, error: 'Please provide a valid Discord Webhook URL' }, { status: 400 });
      }

      const nowIso = new Date().toISOString();
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const testPayload = {
        content: `🎬 **Test Notification:** Discord Clip Channel Integration connected successfully!`,
        embeds: [
          {
            title: `🎬 Stream Clip System Online`,
            description: `Your stream \`!clip\` command is configured and ready to receive stream video clips.\n\n• **Command**: \`!clip\` (or \`!clip <seconds>\` e.g. \`!clip 45\`)\n• **Points Cost**: **${pointsCost}** StreamElements points`,
            color: 0x00d2ff,
            footer: {
              text: `Stream Overlay • ${timeStr}`
            },
            timestamp: nowIso
          }
        ]
      };

      const res = await fetch(testWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testPayload)
      });

      if (res.ok || res.status === 204) {
        return NextResponse.json({ success: true, message: 'Test message sent to Discord successfully!' });
      }

      const errText = await res.text().catch(() => '');
      return NextResponse.json({ success: false, error: `Discord HTTP ${res.status}: ${errText.slice(0, 200)}` }, { status: 400 });
    }

    // ==========================================
    // ACTION: process_and_upload
    // ==========================================
    if (action === 'process_and_upload') {
      const { replayPath, duration = 60, username, displayName, sceneName } = body;

      if (!webhookUrl) {
        return NextResponse.json({
          success: false,
          error: 'Discord Clip Webhook URL is not configured.'
        }, { status: 400 });
      }

      if (!replayPath) {
        return NextResponse.json({
          success: false,
          error: 'Missing saved OBS replay path.'
        }, { status: 400 });
      }

      // Check if file exists on disk
      const fileReady = await waitForFile(replayPath, 4000);
      if (!fileReady || !fs.existsSync(replayPath)) {
        return NextResponse.json({
          success: false,
          error: `Saved OBS replay file not found on disk at "${replayPath}".`
        }, { status: 404 });
      }

      // Process and trim with FFmpeg
      let processed: { outputPath: string; cleanup: () => void } | null = null;
      try {
        processed = await processClipWithFfmpeg(replayPath, duration);

        if (!fs.existsSync(processed.outputPath)) {
          return NextResponse.json({
            success: false,
            error: 'FFmpeg failed to generate the trimmed clip MP4.'
          }, { status: 500 });
        }

        const videoBuffer = fs.readFileSync(processed.outputPath);
        if (videoBuffer.length === 0) {
          return NextResponse.json({
            success: false,
            error: 'Generated clip file is empty.'
          }, { status: 500 });
        }

        const filename = `clip_${(displayName || username || 'stream').replace(/[^a-zA-Z0-9_-]/g, '_')}_${duration}s.mp4`;

        // Upload to Discord Webhook
        const uploadRes = await postClipToDiscord({
          webhookUrl,
          videoBuffer,
          filename,
          username: username || 'Viewer',
          displayName: displayName || username || 'Viewer',
          duration,
          pointsSpent: pointsCost,
          sceneName
        });

        return NextResponse.json({
          success: uploadRes.success,
          duration,
          fileSize: videoBuffer.length,
          error: uploadRes.error
        });
      } finally {
        if (processed && typeof processed.cleanup === 'function') {
          processed.cleanup();
        }
      }
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error: any) {
    OverlayLogger.error('Unhandled error in /api/clip-command:', error);
    return NextResponse.json({
      success: false,
      error: error?.message || 'Internal server error in clip command'
    }, { status: 500 });
  }
}
