# 🎮 Streaming Overlay 3.0

> **A professional, real-time IRL streaming overlay and live admin dashboard built with Next.js 16 (Turbopack), Tailwind-free responsive CSS, Server-Sent Events (SSE), and Upstash KV.**

Designed specifically for IRL streamers using **Belabox**, **RTIRL GPS**, **OBS Studio**, **Twitch**, and **StreamElements**. Features zero-latency instant updates, intelligent auto-scene switching, dynamic WebGL maps, sub/donation goals, chat commands, and fitness tracking.

---

## 🌟 Key Highlights

- ⚡ **Zero-Lag Admin Panel**: All sliders, toggles, and position controls update overlay instances with **0ms latency** via Server-Sent Events (SSE) and Upstash KV.
- 📡 **Belabox Bitrate & Auto-Scene Switcher**: Real-time bitrate (kbps) and RTT latency monitoring with automated OBS scene switching (Live ↔ Offline/BRB).
- 💬 **Twitch Chat Control Engine**: Manage OBS directly from Twitch chat (`!start`, `!end`, `!refresh`, `!so @user`) with broadcaster permission checks and toggle protection.
- 📍 **Smart GPS & Adaptive WebGL Minimap**: Vector map automatically displays when walking or driving (>5 km/h) and hides when stationary.
- 🎯 **Goals & Live Alerts**: Automated subscriber and donation goal bars with daily reset support, plus interactive on-screen Twitch shoutout cards.
- 🏃 **Fitness & Environment**: Live Heart Rate (Pulsoid), Distance traveled, Calorie burn counter, Altitude, Speed, and OpenWeatherMap integration.
- ☁️ **Vercel Hobby Tier Optimized**: Serverless edge caching and direct client-side fetch bypass reduce serverless invocation overhead by over 70%.

---

## 📑 Feature Breakdown

### 1. 📡 Belabox Bitrate Monitor & OBS Auto-Switching
- **Real-Time SRT Monitoring**: Polls Belabox cloud server directly for live bitrate (kbps) and network round-trip time (RTT).
- **Standalone Detection**: Bitrate is fetched continuously from Belabox API even when the admin panel is opened on mobile or disconnected from OBS WebSocket.
- **Automated Scene Switching**:
  - Automatically switches OBS to your **Offline / BRB Scene** when bitrate drops to 0 kbps.
  - Automatically switches back to your **Live Scene** when bitrate recovers.
- **Low Bitrate Warning Alert**: On-screen warning banner when bitrate drops below customizable thresholds (e.g. 1500 kbps), complete with sound alerts and font styling.

### 2. ⚡ Remote OBS Stream Commands
- **Chat Commands**:
  - `!start` / `!golive` — Starts stream in OBS Studio.
  - `!end` / `!stop` — Stops stream in OBS Studio.
  - `!refresh` / `!ref` / `!fixaudio` — Instantly cycles from current scene → refresh scene → back to live scene to fix audio desync or frozen video feeds.
- **Security & Permissions**: Restrict command execution to Broadcaster only.
- **Master Toggle Switch**: Instantly disable all chat stream commands with one click from the Admin Dashboard or Settings page.

### 3. 📍 GPS, Location & WebGL Minimap
- **RTIRL Integration**: Real-time coordinate and speed streaming.
- **6 Location Precision Modes**:
  1. `Neighbourhood` (e.g., *SoHo*, *Shinjuku*, *Downtown*)
  2. `City` (e.g., *Austin*, *Tokyo*, *London*)
  3. `State` (e.g., *California*, *Ontario*)
  4. `Country` (Shows country name with national flag emoji)
  5. `Custom` (Custom user-defined text)
  6. `Hidden`
- **At-Sea Detection**: Automatically detects when streaming over open oceans, seas, and gulfs with regional nautical flags.
- **Dynamic Minimap**:
  - CartoDB Day (Voyager) and Night (Dark Matter) WebGL tiles.
  - Configurable circle or square shape, position fine-tuning, and customizable speed threshold.

### 4. 🎯 Stream Goals & Shoutouts
- **Twitch & StreamElements Sub Goals**: Tracks combined or separate **Total Goals** and **Daily Goals**.
- **Donation & Tip Goals**: Real-time donation progress with target amounts and automatic daily midnight reset.
- **Interactive Shoutouts (`!so @user`)**:
  - When you or mods type `!so @username` in Twitch chat, an animated shoutout banner pops up with their Twitch avatar, display name, and last played category.

### 5. 📋 To-Do & Objectives Widget
- **Interactive Task List**: Add, edit, check off, and delete tasks directly from the Admin Dashboard.
- **Goal Progress Counters**: Add counters to tasks (e.g., `Eat 5 Tacos (2/5)`).
- **Custom Header Scale Size**: Dedicated scale size slider (`50%` to `250%`) to customize header title typography.
- **Flexible Positioning**: Dock on Top Left or Top Right with D-Pad positioning controls.

### 6. 🏃 Health, Fitness & Weather
- **Pulsoid Heart Rate Monitor**: Live BPM with animated pulse rate transitions and high-BPM color warnings.
- **Distance Tracker**: Calculates total distance covered in Miles, Kilometers, or Meters. Supports GPS tracking or target destination coordinate mode.
- **Calorie Tracker**: Daily calorie burn progress bar widget.
- **Live Weather**: Temperature (°C / °F) and weather condition descriptions from OpenWeatherMap.

### 7. 🔄 Social Media Rotator & Web Embeds
- **Social Loop**: Animated carousel displaying handles for Kick, Twitch, YouTube, X (Twitter), Instagram, and TikTok with configurable switch delays.
- **Custom Web Embeds**: Embed custom URLs, HTML widgets, and transparent images directly into the overlay scene.

---

## 🚀 Deployment Guide (Vercel)

### Method 1: Deploy with Vercel CLI (Recommended)

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/AlphaKing112/Overlay3.0.git
   cd Overlay3.0
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Deploy to Vercel**:
   ```bash
   npx vercel --prod
   ```

4. **Add Upstash KV Storage on Vercel**:
   - In your [Vercel Dashboard](https://vercel.com/dashboard), open your project.
   - Go to the **Storage** tab → click **Create Database** → select **KV (Redis)**.
   - Connect the KV database to your project (Vercel automatically sets `KV_REST_API_URL`, `KV_REST_API_TOKEN`, and `KV_REST_API_READ_ONLY_TOKEN`).

5. **Set Environment Variables**:
   In Vercel Project Settings → **Environment Variables**, add:
   - `ADMIN_PASSWORD`: Your password to access `/login` (e.g. `MySecurePassword123`)
   - `API_SECRET`: A random 64-character string (e.g. generated via `openssl rand -hex 32`)
   - `NEXT_PUBLIC_API_SECRET`: Same value as `API_SECRET`
   - `NEXT_PUBLIC_RTIRL_PULL_KEY`: Your RTIRL GPS Pull Key
   - `NEXT_PUBLIC_LOCATIONIQ_KEY`: Your LocationIQ API Key
   - `NEXT_PUBLIC_OPENWEATHERMAP_KEY`: Your OpenWeatherMap API Key
   - `NEXT_PUBLIC_TWITCH_CLIENT_ID`: `xjl7wqa2c3pyrb7u1d9wyzp6xlyyiw` (or your own Twitch Dev Client ID)

---

## 🖥️ Local Development Setup

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
2. Fill in your API keys in `.env.local`.
3. Start the Next.js development server:
   ```bash
   npm run dev
   ```
4. Open your browser:
   - **Admin Panel**: [http://localhost:3000](http://localhost:3000) (Login with `ADMIN_PASSWORD`)
   - **OBS Overlay View**: [http://localhost:3000/overlay](http://localhost:3000/overlay)

---

## 📹 OBS Studio Configuration

To add Overlay 3.0 to OBS Studio:

1. In OBS Studio, create a new source: **Sources** → **`+`** → **Browser**.
2. Set the properties:
   - **URL**: `https://your-app-name.vercel.app/overlay`
   - **Width**: `1920`
   - **Height**: `1080`
   - ❌ **UNCHECK** **"Shutdown source when not visible"** (Must be unchecked so the overlay stays active in the background)
   - ❌ **UNCHECK** **"Refresh browser when scene becomes active"** (Must be unchecked to prevent reconnect loops)
3. Click **OK**.

> ⚠️ **CRITICAL FOR AUTO-SWITCHING & CHAT COMMANDS**:
> Keeping both options **UNCHECKED** is required so the overlay keeps running continuously in OBS memory. This allows it to monitor Belabox bitrate, execute Twitch chat commands (`!start`, `!end`, `!refresh`), and automatically switch back to your Live scene when signal restores.
>
> 💡 **Tip**: Whenever you deploy updates or make code changes, right-click the Browser Source in OBS → **Properties** → click **"Refresh cache of current page"**.

---

## 🔌 OBS WebSocket Connection (For Remote Control & Auto-Switching)

1. In OBS Studio, open **Tools** → **WebSocket Server Settings**.
2. Check **Enable WebSocket Server**.
3. Set a **Server Port** (default: `4455`) and set a **Server Password**.
4. In the **Admin Dashboard** (`/` or `/settings`):
   - Enter **OBS WebSocket URL**: `ws://127.0.0.1:4455`
   - Enter **OBS WebSocket Password**: Your configured password.
   - Set **Live Scene Name** (e.g. `IRL Live`).
   - Set **Offline Scene Name** (e.g. `BRB / Signal Lost`).
   - Set **Refresh Scene Name** (e.g. `Refresh Feed`).
   - Enable **OBS Auto-Switch Scene Toggle**.

---

## 💬 Twitch Chat Commands Reference

| Command | Permission | Description |
| :--- | :--- | :--- |
| `!start` / `!golive` | Broadcaster | Starts stream in OBS Studio. |
| `!end` / `!stop` | Broadcaster | Stops stream in OBS Studio. |
| `!refresh` / `!ref` / `!fixaudio` | Broadcaster | Switches scene to `Refresh` then back to `Live` to fix desynced audio/video feeds. |
| `!so @username` / `!shoutout @username` | Broadcaster / Mods | Displays an animated on-screen shoutout card for the specified streamer. |

*Note: Stream commands can be toggled on/off in the Admin Dashboard at any time.*

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
