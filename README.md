# 🎮 Streaming Overlay 3.0

> **A professional, real-time IRL & gaming streaming overlay and live admin dashboard built with Next.js 16 (Turbopack), Tailwind-free responsive CSS, Server-Sent Events (SSE), and Upstash KV.**

Designed for streamers using **Belabox**, **RTIRL GPS**, **OBS Studio**, **Twitch**, **StreamElements**, and **Discord**. Features zero-latency instant updates, automated scene switching, dynamic WebGL maps, sub/donation goals, stream clipping/snapshots to Discord, chat commands, and fitness tracking.

---

## 🌟 Key Highlights

- 🎬 **Cloud & Local Stream Clipping (`!clip`)**: Viewers can clip the stream in chat (`!clip` or `!clip 30`) and instantly send a playable video to your Discord channel. Supports **🟣 Twitch Cloud Clip (0 PC Storage)** and **🎬 OBS Replay Buffer MP4**.
- 📸 **Live Stream Snapshots (`!pic`)**: Viewers can snap a live high-res stream screenshot sent straight to your Discord photos channel.
- ⚡ **Zero-Lag Admin Panel**: All sliders, toggles, and position controls update overlay instances with **0ms latency** via Server-Sent Events (SSE) and Upstash KV.
- 📡 **Belabox Bitrate & Auto-Scene Switcher**: Real-time bitrate (kbps) and RTT latency monitoring with automated OBS scene switching (Live ↔ Offline/BRB).
- 💬 **Twitch Chat Control Engine**: Manage OBS directly from Twitch chat (`!start`, `!end`, `!refresh`, `!so @user`, `!clip`, `!pic`) with broadcaster permission checks, per-viewer cooldowns, and loyalty points.
- 📍 **Smart GPS & Adaptive WebGL Minimap**: Vector map automatically displays when walking or driving (>5 km/h) and hides when stationary.
- 🎯 **Goals & Live Alerts**: Automated subscriber and donation goal bars with daily reset support, plus interactive on-screen Twitch shoutout cards.
- 🏃 **Fitness & Environment**: Live Heart Rate (Pulsoid), Distance traveled, Calorie burn counter, Altitude, Speed, and OpenWeatherMap integration.
- ☁️ **Vercel Hobby Tier Optimized**: Serverless edge caching and direct client-side fetch bypass reduce serverless invocation overhead by over 70%.

---

## 📑 Feature Breakdown

### 1. 🎬 Stream Clipping (`!clip` Command) & Discord Channel
- **Dual Clipping Engines**:
  - **🟣 Twitch Cloud Clip Engine (Recommended - Zero PC Storage)**:
    - Generates clips directly on Twitch servers via Twitch Helix API.
    - **0 MB disk space used on your PC** — no video files saved locally.
    - Automatically posts the Twitch clip link to your Discord Webhook channel, where Discord **natively embeds the playable video player**.
    - Saves the clip to your channel's permanent Twitch Clips Manager.
  - **🎬 OBS Replay Buffer Engine (Local MP4 Mode)**:
    - Trims the exact last N seconds from your local OBS Replay Buffer using FFmpeg.
    - Uploads the raw MP4 video file directly to your Discord webhook.
- **Custom Duration Syntax**:
  - `!clip` ➔ Captures the default **60 seconds**.
  - `!clip 30` ➔ Captures custom duration of **30 seconds**.
  - `!clip 45` ➔ Captures custom duration of **45 seconds** (clamped between 10s and 60s max).
  - Aliases supported: `!clip`, `!cliptheclip`, `!replay`, `!highlight`.
- **Per-Viewer 3-Minute Cooldown**:
  - Each viewer has their own independent 3-minute (180s) cooldown.
  - If triggered on cooldown, the bot replies with the exact remaining time (e.g. `⏳ @User, !clip is on cooldown for you. Please wait 2m 14s before clipping again.`).
  - Cooldowns automatically clear if a capture or upload fails.
- **Flexible StreamElements Points or Free Mode**:
  - Toggle between charging StreamElements loyalty points (e.g. 300 pts) or running in **100% Free Mode**.
- **Live On-Screen Overlay Toast**:
  - Triggers an animated glassmorphic notification banner on stream: `🎬 STREAM CLIP CREATED! @User clipped the stream!`.

---

### 2. 📸 Stream Snapshot (`!pic` Command) & Discord Channel
- **Live Screenshot Capture**:
  - Grabs a full-resolution 1080p frame from your active OBS stream view via OBS WebSocket.
  - Uploads the image instantly to your Discord channel webhook.
- **Loyalty Points & Free Mode**:
  - Configure point costs or toggle Free Mode with automated refunds if OBS is disconnected.
- **On-Screen Flash & Toast**:
  - Displays an on-screen camera snapshot notification on the stream.

---

### 3. 📡 Belabox Bitrate Monitor & OBS Auto-Switching
- **Real-Time SRT Monitoring**: Polls Belabox cloud server directly for live bitrate (kbps) and network round-trip time (RTT).
- **Automated Scene Switching**:
  - Automatically switches OBS to your **Offline / BRB Scene** when bitrate drops to 0 kbps.
  - Automatically switches back to your **Live Scene** when bitrate recovers.
- **Low Bitrate Warning Alert**: On-screen warning banner when bitrate drops below customizable thresholds (e.g. 1500 kbps), complete with sound alerts and font styling.

---

### 4. ⚡ Remote OBS Stream Commands
- **Chat Commands**:
  - `!start` / `!golive` — Starts stream in OBS Studio.
  - `!end` / `!stop` — Stops stream in OBS Studio.
  - `!refresh` / `!ref` / `!fixaudio` — Instantly cycles from current scene → refresh scene → back to live scene to fix audio desync or frozen video feeds.
- **Security & Permissions**: Restrict command execution to Broadcaster only.
- **Master Toggle Switch**: Instantly disable all chat stream commands with one click from the Admin Dashboard or Settings page.

---

### 5. 📍 GPS, Location & WebGL Minimap
- **RTIRL Integration**: Real-time coordinate and speed streaming.
- **6 Location Precision Modes**: `Neighbourhood`, `City`, `State`, `Country`, `Custom`, or `Hidden`.
- **At-Sea Detection**: Automatically detects when streaming over open oceans, seas, and gulfs with regional nautical flags.
- **Dynamic Minimap**: CartoDB Day (Voyager) and Night (Dark Matter) WebGL tiles with customizable speed threshold.

---

### 6. 🎯 Stream Goals & Shoutouts
- **Twitch & StreamElements Sub Goals**: Tracks combined or separate **Total Goals** and **Daily Goals**.
- **Donation & Tip Goals**: Real-time donation progress with target amounts and automatic daily midnight reset.
- **Interactive Shoutouts (`!so @user`)**: Animated shoutout banner with streamer avatar, display name, and last played category.

---

### 7. 📋 To-Do & Objectives Widget
- **Interactive Task List**: Add, edit, check off, and delete tasks directly from the Admin Dashboard.
- **Goal Progress Counters**: Add counters to tasks (e.g., `Eat 5 Tacos (2/5)`).
- **Flexible Positioning**: Dock on Top Left or Top Right with D-Pad positioning controls.

---

### 8. 🏃 Health, Fitness & Weather
- **Pulsoid Heart Rate Monitor**: Live BPM with animated pulse rate transitions and high-BPM color warnings.
- **Distance Tracker**: Calculates total distance covered in Miles, Kilometers, or Meters.
- **Calorie Tracker**: Daily calorie burn progress bar widget.
- **Live Weather**: Temperature (°C / °F) and weather descriptions from OpenWeatherMap.

---

## 🚀 Quick Setup Guide for New Users

### Step 1: Deploy to Vercel

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/AlphaKing112/Overlay3.0.git
   cd Overlay3.0
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Deploy with Vercel CLI**:
   ```bash
   npx vercel --prod
   ```

4. **Connect Upstash KV on Vercel**:
   - In your [Vercel Dashboard](https://vercel.com/dashboard), open your project.
   - Go to the **Storage** tab → click **Create Database** → select **KV (Redis)**.
   - Connect the KV database to your project.

5. **Set Environment Variables on Vercel**:
   In Vercel Project Settings → **Environment Variables**, add the **essential security keys**:
   - `ADMIN_PASSWORD`: Your password to access `/login` and the admin panel (e.g. `MySecurePassword123`)
   - `API_SECRET`: A random 64-character string (e.g. generated via `openssl rand -hex 32`)
   - `NEXT_PUBLIC_API_SECRET`: Same value as `API_SECRET`

   > 💡 **No other env vars required!** All other service keys (RTIRL GPS, LocationIQ, OpenWeatherMap, Pulsoid, Belabox, StreamElements, and Discord Webhooks) can be pasted and saved **directly in your Settings Page UI (`/settings`)** without needing to configure them in Vercel or redeploy!

---

### Step 2: Add Overlay to OBS Studio

1. In OBS Studio, create a new source: **Sources** → **`+`** → **Browser**.
2. Set properties:
   - **URL**: `https://your-app-name.vercel.app/overlay`
   - **Width**: `1920`
   - **Height**: `1080`
   - ❌ **UNCHECK** **"Shutdown source when not visible"** *(Required so overlay monitors events continuously)*
   - ❌ **UNCHECK** **"Refresh browser when scene becomes active"**
3. Click **OK**.

---

### Step 3: Connect Twitch & Discord (For `!clip` and `!pic`)

1. Open your **Overlay Settings** at `https://your-app-name.vercel.app/settings` (or click Settings in the dashboard).
2. **Twitch Login**:
   - Click the purple **"Twitch Login"** button in the header.
   - Click **"Authorize"** on Twitch's prompt screen to enable chat replies and Twitch cloud clipping.
3. **Discord Clips Webhook**:
   - In Discord, go to your Clips channel ➔ **Edit Channel** ➔ **Integrations** ➔ **Webhooks** ➔ **New Webhook** ➔ **Copy Webhook URL**.
   - Paste into **Discord Clips Channel Webhook URL** in Settings.
4. **Select Clip Mode**:
   - Choose **`🟣 Twitch Cloud Clip (Zero PC Storage)`** to generate clips in the cloud with zero disk space on your computer!

---

### Step 4 (Optional): Using OBS Replay Buffer MP4 Mode

If you prefer saving raw MP4 replay files locally and uploading them to Discord:
1. In OBS Studio Settings ➔ **Output** ➔ check **Enable Replay Buffer** (Set Maximum Replay Time to `60 sec` or `120 sec`, Memory: `1024 MB`).
2. Start the local clip bridge on your PC:
   - Double-click **`start-clip-bridge.bat`** (or run `npm run clip-bridge`).
3. In Settings, select **`🎬 OBS Replay Buffer MP4`**.

---

## 💬 Twitch Chat Commands Reference

| Command | Permission | Description |
| :--- | :--- | :--- |
| `!clip` / `!clip [sec]` | Everyone | Clips the stream (e.g. `!clip 30`) and posts playable video to Discord. (3-min cooldown) |
| `!pic` / `!photo` | Everyone | Snaps a live 1080p stream picture and uploads to Discord. |
| `!so @user` / `!shoutout @user` | Broadcaster / Mods | Displays an animated on-screen shoutout banner for a streamer. |
| `!start` / `!golive` | Broadcaster | Starts stream in OBS Studio. |
| `!end` / `!stop` | Broadcaster | Stops stream in OBS Studio. |
| `!refresh` / `!ref` / `!fixaudio` | Broadcaster | Cycles scenes in OBS to fix audio desync or frozen video feeds. |

---

## 🖥️ Local Development

```bash
# 1. Clone & install
git clone https://github.com/AlphaKing112/Overlay3.0.git
cd Overlay3.0
npm install

# 2. Configure environment
cp .env.example .env.local

# 3. Start local development server
npm run dev

# 4. (Optional) Start local clip bridge
npm run clip-bridge
```

- **Admin Dashboard**: [http://localhost:3000](http://localhost:3000)
- **Config & Settings**: [http://localhost:3000/settings](http://localhost:3000/settings)
- **Overlay Browser View**: [http://localhost:3000/overlay](http://localhost:3000/overlay)

---

## 🔑 Obtaining Free API Keys

| Service | Purpose | Where to get key | Free Tier Limit |
| :--- | :--- | :--- | :--- |
| **RTIRL** | Live GPS Movement | [rtirl.com](https://rtirl.com) | Unlimited |
| **LocationIQ** | Reverse Geocoding (City/Neighbourhood) | [locationiq.com](https://locationiq.com) | 5,000 req/day |
| **OpenWeatherMap** | Live Weather & Temperature | [openweathermap.org](https://openweathermap.org/api) | 1,000 req/day |
| **Upstash** | Cloud Redis Storage & SSE Broadcast | [upstash.com](https://upstash.com) | 10,000 commands/day |
| **Belabox** | Live SRT Bitrate & RTT | [cloud.belabox.net](https://cloud.belabox.net) | Included with Belabox |
| **Pulsoid** | Live Heart Rate | [pulsoid.net](https://pulsoid.net) | Free tier available |

---

## 🛠️ Tech Stack & Architecture

- **Core**: Next.js 16 (App Router, Turbopack) & React 19
- **Database & Sync**: Upstash Redis REST API + Server-Sent Events (SSE)
- **Map Renderer**: MapLibre GL WebGL Engine
- **OBS Controller**: `obs-websocket-js` v5
- **Icons & Styling**: Vanilla CSS Modules (Glassmorphism & Cyberpunk Design System)
- **Deployment**: Vercel Serverless & Edge Network

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE). Feel free to fork, customize, and use it for your own streams! 🚀
