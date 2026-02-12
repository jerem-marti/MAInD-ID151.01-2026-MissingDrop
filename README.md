# MissingDrop

Real-time WebSocket bridge connecting smartphones (MediaPipe hand tracking + water simulation) to 32×32 LED matrices via ESP32.

## Architecture

```
┌────────────┐      WSS       ┌──────────────┐      WS       ┌────────────┐
│ Smartphone │ ──────────────▶ │  Express WSS │ ──────────────▶ │ ESP32 LED  │
│  (Browser) │   RGB565 data  │    Server    │  RGB565 data   │   Matrix   │
└────────────┘                 └──────────────┘                └────────────┘
```

Supports **2 independent pairs** — each pair binds one smartphone and one matrix.

## Project Structure

```
MissingDrop/
├── server/          # Express + WS bridge server (deploy to Render)
├── client-web/      # Smartphone web client (served by Express)
│   ├── index.html
│   └── js/
│       ├── app.js   # Orchestrator
│       ├── hand.js  # MediaPipe hand tracking
│       ├── water.js # Water ripple simulation
│       └── wss.js   # WebSocket client
└── client-matrix/   # ESP32 PlatformIO firmware
    ├── platformio.ini
    └── src/
        ├── main.cpp
        ├── config.h           # ⚠️ Your secrets (gitignored)
        ├── config.example.h   # Template
        └── common/
            └── pico_driver_v5_pinout.h
```

## Setup

### 1. Server

```bash
cd server
npm install
npm start
```

Server runs on port 3000 (or `PORT` env var). For Render: push the `server/` folder and set start command to `node server.js`.

### 2. Smartphone Client

Served automatically by the Express server at the root URL. Open `http://localhost:3000` (or your Render URL) on your phone.

1. Enter the WebSocket URL (e.g. `wss://your-app.onrender.com/ws`)
2. Select your pair (1 or 2)
3. Click **Connect**
4. Click **Start Tracking** and pinch to create water drops

### 3. Matrix Client (ESP32)

1. Copy `src/config.example.h` → `src/config.h`
2. Fill in your WiFi credentials, server URL, and pair ID
3. For WPA2-Enterprise: set `USE_ENTERPRISE_WIFI` to `1` and fill EAP fields
4. Build and upload:

```bash
cd client-matrix
pio run --target upload
```

## Protocol

1. Client connects to `ws(s)://host/ws`
2. Sends JSON: `{ "type": "join", "role": "phone"|"matrix", "pair": 1|2 }`
3. Phone sends binary RGB565 frames (2048 bytes = 32×32×2)
4. Server forwards binary data to the paired matrix
