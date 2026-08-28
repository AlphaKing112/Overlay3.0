/**
 * Stream Overlay - Local Clip Bridge Service
 * 
 * Lightweight, zero-dependency background companion server that allows OBS Browser Source
 * (even when hosted on Vercel) to trim local OBS replay videos using FFmpeg and upload
 * them straight to your Discord clips channel!
 * 
 * Port: 4848 (http://127.0.0.1:4848)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const PORT = 4848;

/**
 * Locate FFmpeg binary on system
 */
function getFfmpegPath() {
  const commonPaths = [
    'ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe')
  ];

  for (const testPath of commonPaths) {
    if (testPath === 'ffmpeg') continue;
    if (fs.existsSync(testPath)) {
      return testPath;
    }
  }
  return 'ffmpeg';
}

/**
 * Trims and web-optimizes video with FFmpeg
 */
async function processClip(inputPath, durationSec) {
  const tempDir = os.tmpdir();
  const outputPath = path.join(tempDir, `stream_clip_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`);

  const cleanup = () => {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {}
  };

  const safeDuration = Math.max(5, Math.min(180, durationSec || 60));
  const ffmpeg = getFfmpegPath();

  console.log(`🎬 [Local Bridge] Trimming last ${safeDuration}s from: "${inputPath}" using ${ffmpeg}`);

  const args = [
    '-y',
    '-sseof', `-${safeDuration}`,
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '24',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    outputPath
  ];

  try {
    await execFileAsync(ffmpeg, args, { timeout: 35000 });
  } catch (err) {
    console.warn(`⚠️ [Local Bridge] Ultrafast transcode failed (${err.message}), trying fast copy...`);
    const copyArgs = [
      '-y',
      '-sseof', `-${safeDuration}`,
      '-i', inputPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath
    ];
    await execFileAsync(ffmpeg, copyArgs, { timeout: 20000 });
  }

  return { outputPath, cleanup };
}

/**
 * Uploads processed video to Discord Webhook
 */
async function uploadToDiscord(options) {
  const { webhookUrl, videoPath, username, displayName, duration, pointsSpent = 0, sceneName } = options;

  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    throw new Error('Invalid Discord Webhook URL');
  }

  const name = displayName || username || 'Viewer';
  const nowIso = new Date().toISOString();
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const filename = `clip_${name}_${Date.now()}.mp4`;

  const stats = fs.statSync(videoPath);
  console.log(`📤 [Local Bridge] Uploading ${Math.round(stats.size / 1024)} KB clip to Discord for @${name}...`);

  const discordPayload = {
    content: `🎬 **!clip** (${duration}s) captured by **${name}**!`,
    embeds: [
      {
        title: `🎬 Live Stream Clip (${duration}s)`,
        description: `Clipped by **${name}** via \`!clip\` chat command${pointsSpent > 0 ? ` (${pointsSpent} StreamElements points)` : ''}${sceneName ? `\n📺 Scene: \`${sceneName}\`` : ''}`,
        color: 0x00d2ff,
        footer: {
          text: `Stream Overlay • ${timeStr}`
        },
        timestamp: nowIso
      }
    ]
  };

  const videoBuffer = fs.readFileSync(videoPath);
  const formData = new FormData();
  formData.append('payload_json', JSON.stringify(discordPayload));
  const fileBlob = new Blob([videoBuffer], { type: 'video/mp4' });
  formData.append('files[0]', fileBlob, filename);

  const res = await fetch(webhookUrl, {
    method: 'POST',
    body: formData
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord Webhook HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  console.log(`✅ [Local Bridge] Clip successfully posted to Discord!`);
}

/**
 * Wait for file writing to stabilize
 */
async function waitForFile(filePath, maxWaitMs = 4000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    if (fs.existsSync(filePath)) {
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > 1000) {
          await new Promise(r => setTimeout(r, 200));
          return true;
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return fs.existsSync(filePath);
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url || '';

  // Health check
  if (url === '/health' || url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Stream Overlay Local Clip Bridge', port: PORT }));
    return;
  }

  // Clip Command Handler
  if (req.method === 'POST' && (url === '/api/clip-command' || url === '/process-clip')) {
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyData || '{}');
        const { action = 'process_and_upload', replayPath, duration = 60, webhookUrl, username, displayName, pointsCost = 0, sceneName } = body;

        if (action === 'health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, localBridge: true }));
          return;
        }

        if (action === 'process_and_upload') {
          if (!replayPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Missing replayPath' }));
            return;
          }

          if (!webhookUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Missing webhookUrl' }));
            return;
          }

          const fileReady = await waitForFile(replayPath, 5000);
          if (!fileReady || !fs.existsSync(replayPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Saved replay file not found on disk at "${replayPath}"` }));
            return;
          }

          const { outputPath, cleanup } = await processClip(replayPath, duration);

          try {
            await uploadToDiscord({
              webhookUrl,
              videoPath: outputPath,
              username,
              displayName,
              duration,
              pointsSpent: pointsCost,
              sceneName
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Clip processed and uploaded to Discord successfully' }));
          } finally {
            cleanup();
          }
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Unknown action: ${action}` }));
      } catch (err) {
        console.error('❌ [Local Bridge Error]:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`=======================================================`);
  console.log(`🎬 Stream Overlay - Local Clip Bridge is ONLINE!`);
  console.log(`📡 Listening on: http://127.0.0.1:${PORT}`);
  console.log(`⚡ Ready to trim OBS replays and post to Discord!`);
  console.log(`=======================================================`);
});
