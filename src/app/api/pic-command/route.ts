import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import {
  getStreamElementsChannelId,
  getStreamElementsUserPoints,
  modifyStreamElementsPoints
} from '@/lib/streamelements-helper';
import { OverlayLogger } from '@/lib/logger';

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
 * Converts a base64 or Data URI string to a Buffer and mime type
 */
function parseBase64Image(raw: string): { buffer: Buffer; mimeType: string; filename: string } {
  let base64 = raw;
  let mimeType = 'image/jpeg';
  let filename = 'stream_snapshot.jpg';

  if (raw.startsWith('data:')) {
    const parts = raw.split(',');
    const header = parts[0] || '';
    base64 = parts[1] || '';
    if (header.includes('image/png')) {
      mimeType = 'image/png';
      filename = 'stream_snapshot.png';
    } else if (header.includes('image/webp')) {
      mimeType = 'image/webp';
      filename = 'stream_snapshot.webp';
    }
  }

  const buffer = Buffer.from(base64, 'base64');
  return { buffer, mimeType, filename };
}

/**
 * Sends a captured stream snapshot to the Discord Pic Channel Webhook
 */
async function postSnapshotToDiscord(options: {
  webhookUrl: string;
  imageData: string;
  username: string;
  displayName: string;
  pointsSpent?: number;
  sceneName?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { webhookUrl, imageData, username, displayName, pointsSpent = 200, sceneName } = options;

  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    return { success: false, error: 'Invalid or missing Discord Webhook URL' };
  }

  if (!imageData) {
    return { success: false, error: 'Missing image data for Discord upload' };
  }

  try {
    const { buffer, mimeType, filename } = parseBase64Image(imageData);

    if (buffer.length === 0) {
      return { success: false, error: 'Empty image buffer received' };
    }

    const name = displayName || username || 'Viewer';
    const nowIso = new Date().toISOString();
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const discordPayload = {
      content: `📸 **!pic** snapshot captured by **${name}**!`,
      embeds: [
        {
          title: `📸 Live Stream Snapshot`,
          description: `Captured by **${name}** via \`!pic\` chat command (**${pointsSpent}** StreamElements points)${sceneName ? `\n📺 Scene: \`${sceneName}\`` : ''}`,
          color: 0x53fc19, // Vibrant stream green
          image: {
            url: `attachment://${filename}`
          },
          footer: {
            text: `Stream Overlay • ${timeStr}`
          },
          timestamp: nowIso
        }
      ]
    };

    const formData = new FormData();
    formData.append('payload_json', JSON.stringify(discordPayload));
    
    // Create a Blob from the Buffer for standard fetch FormData support
    const imageBlob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    formData.append('files[0]', imageBlob, filename);

    const discordRes = await fetch(webhookUrl, {
      method: 'POST',
      body: formData
    });

    if (discordRes.ok || discordRes.status === 204) {
      OverlayLogger.overlay(`Successfully posted !pic snapshot to Discord for @${name}`);
      return { success: true };
    }

    const errText = await discordRes.text().catch(() => '');
    OverlayLogger.error(`Discord webhook failed (HTTP ${discordRes.status}):`, errText);
    return { success: false, error: `Discord Webhook HTTP ${discordRes.status}: ${errText.slice(0, 200)}` };
  } catch (err: any) {
    OverlayLogger.error('Error posting snapshot to Discord:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * POST /api/pic-command
 * 
 * Supports:
 * 1. action: 'check_and_deduct' - verifies viewer has sufficient SE points and deducts them
 * 2. action: 'refund_points' - refunds points if snapshot capture/upload fails
 * 3. action: 'post_to_discord' - sends image to Discord webhook
 * 4. action: 'process_pic' - complete pipeline (verify, deduct, post, refund on error)
 * 5. action: 'test' - sends a test card/snapshot to Discord webhook
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action || 'process_pic';
    const settings = await getSettings();

    const seToken = body.seToken || settings.streamElementsToken || '';
    const webhookUrl = body.webhookUrl || settings.discordPicWebhookUrl || '';
    const pointsCost = typeof body.pointsCost === 'number' ? body.pointsCost : (settings.picPointsCost ?? 200);

    // ==========================================
    // ACTION: verify_se_token
    // ==========================================
    if (action === 'verify_se_token') {
      const targetToken = (body.seToken || seToken || '').trim();
      if (!targetToken) {
        return NextResponse.json({ success: false, error: 'No StreamElements token provided' }, { status: 400 });
      }

      try {
        const cleanT = targetToken.toLowerCase().startsWith('bearer ') ? targetToken.slice(7).trim() : targetToken.replace(/^["']|["']$/g, '').trim();
        const res = await fetch('https://api.streamelements.com/kappa/v2/channels/me', {
          headers: {
            'Authorization': `Bearer ${cleanT}`,
            'Accept': 'application/json'
          }
        });

        if (res.ok) {
          const data = await res.json();
          return NextResponse.json({
            success: true,
            channelId: data?._id || data?.id,
            username: data?.username || data?.displayName,
            displayName: data?.displayName || data?.username
          });
        }

        const errText = await res.text().catch(() => '');
        let detailedMsg = `HTTP ${res.status}: ${errText}`;
        if (res.status === 401) {
          detailedMsg = '401 Unauthorized: Token is invalid or expired. In StreamElements Dashboard > Account Settings > Channel Settings > click "Show secrets" and copy the entire JWT Token (starts with eyJ...).';
        }

        return NextResponse.json({
          success: false,
          status: res.status,
          error: detailedMsg
        });
      } catch (err: any) {
        return NextResponse.json({ success: false, error: err?.message || String(err) }, { status: 500 });
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

      // If points cost is 0 or less, allow free snapshot without StreamElements points check
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
    // ACTION: post_to_discord
    // ==========================================
    if (action === 'post_to_discord') {
      const { imageData, username, displayName, sceneName } = body;

      if (!webhookUrl) {
        return NextResponse.json({
          success: false,
          error: 'Discord Pic Channel Webhook URL is not configured.'
        }, { status: 400 });
      }

      if (!imageData) {
        return NextResponse.json({ success: false, error: 'No image data provided' }, { status: 400 });
      }

      const postRes = await postSnapshotToDiscord({
        webhookUrl,
        imageData,
        username: username || 'Viewer',
        displayName: displayName || username || 'Viewer',
        pointsSpent: pointsCost,
        sceneName
      });

      return NextResponse.json(postRes, { status: postRes.success ? 200 : 500 });
    }

    // ==========================================
    // ACTION: process_pic (Full pipeline)
    // ==========================================
    if (action === 'process_pic') {
      const { username, displayName, imageData, sceneName } = body;

      if (!username) {
        return NextResponse.json({ success: false, error: 'Missing username' }, { status: 400 });
      }

      if (!webhookUrl) {
        return NextResponse.json({
          success: false,
          error: 'Discord Pic Webhook is not configured in Settings.'
        }, { status: 400 });
      }

      if (!imageData) {
        return NextResponse.json({ success: false, error: 'Missing stream image data' }, { status: 400 });
      }

      let channelId = body.channelId;
      let pointsDeducted = false;

      // 1. Check and deduct StreamElements points if SE token is provided
      if (seToken && pointsCost > 0) {
        channelId = channelId || await getStreamElementsChannelId(seToken);
        if (!channelId) {
          return NextResponse.json({
            success: false,
            error: 'Could not connect to StreamElements channel with current token.'
          }, { status: 400 });
        }

        const pointsRes = await getStreamElementsUserPoints(seToken, channelId, username);
        if (!pointsRes.success) {
          return NextResponse.json({
            success: false,
            error: `Failed to query loyalty points: ${pointsRes.error}`
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

        const deductRes = await modifyStreamElementsPoints(seToken, channelId, username, -pointsCost);
        if (!deductRes.success) {
          return NextResponse.json({
            success: false,
            error: `Failed to deduct StreamElements points: ${deductRes.error}`
          }, { status: 500 });
        }
        pointsDeducted = true;
      }

      // 2. Post to Discord
      const postRes = await postSnapshotToDiscord({
        webhookUrl,
        imageData,
        username,
        displayName: displayName || username,
        pointsSpent: pointsCost,
        sceneName
      });

      // 3. If Discord failed and we deducted points, refund them automatically!
      if (!postRes.success && pointsDeducted && channelId) {
        await modifyStreamElementsPoints(seToken, channelId, username, pointsCost).catch(() => {});
        return NextResponse.json({
          success: false,
          refunded: true,
          error: `Discord upload failed (${postRes.error}). Points refunded.`
        }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        pointsDeducted: pointsCost,
        user: displayName || username
      });
    }

    // ==========================================
    // ACTION: test
    // ==========================================
    if (action === 'test') {
      const targetWebhook = webhookUrl || body.webhookUrl;
      if (!targetWebhook || !targetWebhook.startsWith('https://')) {
        return NextResponse.json({
          success: false,
          error: 'Please enter a valid Discord Webhook URL (starts with https://discord.com/api/webhooks/...)'
        }, { status: 400 });
      }

      let testImage = body.imageData;

      // If no image passed, generate a sample 1x1 transparent/colored JPEG test image
      if (!testImage) {
        // Minimal valid 1x1 JPEG base64
        testImage = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
      }

      const postRes = await postSnapshotToDiscord({
        webhookUrl: targetWebhook,
        imageData: testImage,
        username: 'Streamer (Test)',
        displayName: 'Streamer (Test)',
        pointsSpent: pointsCost,
        sceneName: 'Test Scene'
      });

      return NextResponse.json(postRes);
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error: any) {
    OverlayLogger.error('pic-command route error:', error);
    return NextResponse.json({ success: false, error: error?.message || 'Internal server error' }, { status: 500 });
  }
}
