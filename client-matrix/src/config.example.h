/**
 * MissingDrop — Configuration Template
 *
 * Copy this file to config.h and fill in your actual credentials.
 * config.h is gitignored and will not be committed.
 */

#ifndef CONFIG_H
#define CONFIG_H

// ─── WiFi Mode ───────────────────────────────────────────────────────────────
// Set to 1 for WPA2-Enterprise (e.g. eduroam), 0 for standard WPA2-Personal
#define USE_ENTERPRISE_WIFI 0

// ─── WiFi Credentials (WPA2-Personal) ───────────────────────────────────────
#define WIFI_SSID     "YourNetworkName"
#define WIFI_PASSWORD "YourPassword"

// ─── WiFi Credentials (WPA2-Enterprise) ─────────────────────────────────────
// Only used when USE_ENTERPRISE_WIFI is 1
#define EAP_IDENTITY "anonymous@university.edu"
#define EAP_USERNAME "your.username@university.edu"
#define EAP_PASSWORD "YourEnterprisePassword"

// ─── WebSocket Server ────────────────────────────────────────────────────────
// The URL of your MissingDrop WSS bridge server
// For local testing:  "ws://192.168.1.100:3000/ws"
// For Render deploy:  "wss://your-app.onrender.com/ws"
#define WSS_SERVER_HOST "your-app.onrender.com"  // bare hostname, no wss:// prefix
#define WSS_SERVER_PORT 443
#define WSS_SERVER_PATH "/ws"
#define WS_SECURE       true  // false = WS, true = WSS

// ─── Pair Configuration ─────────────────────────────────────────────────────
// Which pair this matrix belongs to (1 or 2)
#define PAIR_ID 1

#endif // CONFIG_H
