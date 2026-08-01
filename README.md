# 🎮 Streaming Overlay 3.0

A modern, real-time streaming overlay and admin dashboard for IRL streams. Built with Next.js 16, featuring live GPS tracking, dynamic minimap, weather integration, Belabox bitrate monitoring with **OBS Auto-Scene Switching**, StreamElements/Twitch sub & donation goals, heart rate monitoring, distance/calorie tracking, social loops, and **Vercel resource optimization**.

---

## ✨ Feature Overview

### 📡 Bitrate & OBS Auto-Switching
- **Belabox Integration**: Real-time stream bitrate (kbps) and RTT latency monitoring directly on your overlay.
- **OBS Auto-Scene Switcher**: Automatically switches your OBS scene to an `Offline` scene when bitrate drops or stream cuts, and back to your `Live` scene when the connection recovers.
- **Low Bitrate Alerts**: On-screen alerts with customizable thresholds, positions, scales, fonts, and alert sounds.
- **Resource Optimized**: Direct browser CORS fetch + edge proxy caching to ensure near-zero serverless CPU usage on Vercel.

### 📍 Smart GPS & Location System
- **Real-Time GPS**: RTIRL integration with smooth location tracking.
- **Dynamic Minimap**: Auto-shows when moving (>5 km/h) and hides when stationary. Features day/night MapLibre WebGL map themes (CartoDB tiles).
- **Location Modes**: 6 precision modes (Neighbourhood, City, State, Country, Custom, Hidden) with intelligent fallback and duplicate name detection.
- **At-Sea Mode**: Automatic ocean and sea detection with regional flags for cruise/nautical streaming.

### 🎯 Stream Goals & Alerts
- **Sub Goals**: Combined or separate Total & Daily subscriber goal trackers with Twitch & StreamElements integration.
- **Donation / Tip Goals**: Real-time tip progress bars (Total & Daily) with customizable goals and automatic daily reset handling.
- **Custom Styling**: Neon, Retro, Cyberpunk, Impact, and Minimalist typography and themes for all goal bars.

### 🏃 Distance, Speed, Elevation & Fitness
- **Distance Tracker**: Tracks progress in miles, kilometers, or meters via GPS movement or destination coordinates.
- **Calorie Tracker**: Customizable daily calorie burn goal widget.
- **Heart Rate Monitor**: Pulsoid integration with smooth animated heart rate transitions.
- **Altitude & Speed**: Elevation (m/ft) and speed (km/h / mph) with auto-display when moving or at notable elevations.

### 🎨 Customization & Widgets
- **Social Media Rotator**: Loop animated widget for Kick, Twitch, YouTube, X, Instagram, and TikTok with configurable timing.
- **To-Do List Widget**: Interactive task tracker with progress counters and custom positioning.
- **URL & Web Embeds**: Embed custom websites, HTML widgets, or images into your overlay.
- **Global Theme & Font Engine**: Select from Neon, Cyberpunk, Retro, Impact, or Bold themes across all widgets.

---

## 🚀 Quick Start Guide

### 1. Prerequisites & Installation

```bash
# Clone repository
git clone https://github.com/AlphaKing112/Overlay3.0.git
cd Overlay3.0

# Install dependencies
npm install
```

### 2. Configure Environment Variables

Create `.env.local` in the project root:

```env
# ==========================================
# REQUIRED - GPS & LOCATION & WEATHER
# ==========================================
NEXT_PUBLIC_RTIRL_PULL_KEY=your_rtirl_pull_key
NEXT_PUBLIC_LOCATIONIQ_KEY=your_locationiq_key
NEXT_PUBLIC_OPENWEATHERMAP_KEY=your_openweathermap_key

# ==========================================
# OPTIONAL - FITNESS & INTEGRATIONS
# ==========================================
NEXT_PUBLIC_PULSOID_TOKEN=your_pulsoid_token

# Twitch API (Sub & Goal Sync)
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret

# StreamElements Sync
STREAMELEMENTS_JWT=your_streamelements_jwt_token

# ==========================================
# ADMIN PANEL & SETTINGS PERSISTENCE
# ==========================================
ADMIN_PASSWORD=your_secure_admin_password

# Vercel KV (Redis) for Real-Time Sync & SSE Stream
KV_REST_API_URL=your_vercel_kv_rest_url
KV_REST_API_TOKEN=your_vercel_kv_rest_token
KV_REST_API_READ_ONLY_TOKEN=your_vercel_kv_readonly_token
```

### 3. Run Development Server

```bash
npm run dev
```

- **Admin Dashboard**: `http://localhost:3000` (Login with `ADMIN_PASSWORD`)
- **OBS Browser Overlay**: `http://localhost:3000/overlay`

---

## 📹 OBS Studio Setup

1. Add a **Browser Source** in OBS Studio.
2. **URL**: `https://your-domain.vercel.app/overlay` (or `http://localhost:3000/overlay` for local testing).
3. **Width**: `1920`, **Height**: `1080`.
4. ✅ Check **"Shutdown source when not visible"**.
5. ✅ Check **"Refresh browser when scene becomes active"**.

> 💡 **Note**: Cache-busting (`?v=<timestamp>`) is automatically attached server-side via Next.js middleware to guarantee OBS always loads the latest code without manual cache clearing.

---

## ⚡ OBS WebSocket & Auto-Scene Switcher Setup

Overlay 3.0 can control OBS Studio directly to automatically switch scenes when your stream connection drops or recovers.

1. **Enable OBS WebSocket** in OBS Studio:
   - Go to **Tools** → **WebSocket Server Settings**.
   - Check **Enable WebSocket Server**.
   - Note the **Server Port** (default `4455`) and set a **Server Password**.
2. **Configure in Admin Panel (`http://localhost:3000`)**:
   - Enter your **OBS WebSocket URL** (e.g. `ws://127.0.0.1:4455`).
   - Enter your **OBS WebSocket Password**.
   - Set **Live Scene Name** (e.g., `IRL Stream`).
   - Set **Offline Scene Name** (e.g., `BRB / Signal Lost`).
   - Enable **OBS Auto-Switch Scene Toggle**.
3. **Belabox Setup**:
   - Enter your **Belabox Publisher Key** or **Belabox Stats URL** (`https://stats.srt.belabox.net/your_publisher_key`).
   - When bitrate drops to 0 kbps, OBS switches to `BRB / Signal Lost`. When bitrate restores, OBS switches back to `IRL Stream`.

---

## ⚙️ Resource & Performance Optimization Settings

Overlay 3.0 features a built-in **Vercel Resource Optimization Engine** to stay well within Vercel Free Hobby Tier limits (1M invocations / 4h CPU):

| Setting Key | Default | Description |
| :--- | :--- | :--- |
| `enableResourceOptimization` | `true` | Enables direct browser CORS fetches & 5s edge caching. |
| `bitratePollIntervalLive` | `3000` ms | Bitrate checking frequency when stream is **LIVE**. |
| `bitratePollIntervalOffline` | `20000` ms | Bitrate checking frequency when stream is **OFFLINE** (70% request reduction). |
| `bitrateCacheTtlMs` | `5000` ms | Server & CDN edge cache duration for `/api/bitrate` responses. |

- **Direct Browser CORS Fetch**: Requests to `https://stats.srt.belabox.net/...` bypass Vercel serverless proxy completely when browser CORS is supported.
- **Server Cache**: Duplicate requests from multiple open tabs or OBS sources share 1 cached response per 5-second window.

---

## 📍 Location Display Modes & Hierarchy

Choose between 6 geographic precision levels in the Admin Panel:

1. **Neighbourhood**: Most detailed (e.g., "SoHo", "Shinjuku", "Downtown").
2. **City**: Municipality level (e.g., "Austin", "Tokyo", "Paris").
3. **State**: Region/prefecture level (e.g., "California", "Ontario").
4. **Country**: Shows country name with flag emoji.
5. **Custom**: Manual custom text (e.g., "Vegas Strip Walking Stream").
6. **Hidden**: Hides location display section completely.

**Hierarchical Fallback**: `Neighbourhood` → `City` → `State` → `Country`. If a specific neighbourhood is missing from LocationIQ, the overlay automatically falls back to the city without breaking the layout. Duplicate name detection automatically prevents redundant displays like *"Tokyo, Tokyo"*.

---

## 📊 API Integrations & Rate Limits

All APIs are strictly rate-limited client-side to prevent quota exhaustion:

- **LocationIQ**: 1 call/sec max with 18-second minimum time gate (enforces <4,500 calls/day safety limit).
- **OpenWeatherMap**: Weather updates every 5 minutes (time-based).
- **CartoDB Map Tiles**: Free WebGL map tiles (CartoDB Voyager for day, Dark Matter for night) with zero API keys required.
- **Pulsoid**: Real-time heart rate WebSocket feed.
- **StreamElements**: Tips and donation goal synchronization.

---

## 🛠️ Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript
- **Styling**: Vanilla CSS Modules with dark mode glassmorphism
- **Map Engine**: MapLibre GL WebGL
- **Real-Time Sync**: Server-Sent Events (SSE) + Vercel KV (Redis)
- **OBS Control**: `obs-websocket-js` v5

---

## 📄 CLI Commands

```bash
npm run dev      # Start development server
npm run build    # Build optimized production bundle
npm run start    # Start production server
npm run lint     # Run ESLint validation
```

---

## 📄 License

MIT License — Feel free to customize and use for your stream! 🚀
