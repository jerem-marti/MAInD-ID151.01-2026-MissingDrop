/**
 * MissingDrop — WSS Matrix Client
 *
 * ESP32 firmware that connects to the MissingDrop WSS bridge server
 * and receives RGB565 frames to display on a 32×32 SmartMatrix LED panel.
 *
 * Features:
 *   - WPA2-Personal or WPA2-Enterprise WiFi (compile-time flag)
 *   - WebSocket client with auto-reconnect
 *   - RGB565 → RGB24 conversion for SmartMatrix display
 *   - Config-based secrets (config.h, gitignored)
 *
 * Dependencies:
 *   - SmartMatrix: https://github.com/Kameeno/SmartMatrix
 *   - ArduinoWebsockets: https://github.com/gilmaimon/ArduinoWebsockets
 */

// ─── Configuration ───────────────────────────────────────────────────────────

#include "config.h"

// Pinout configuration for the PicoDriver v5.0
#include "common/pico_driver_v5_pinout.h"

#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoWebsockets.h>
#include <ArduinoJson.h>

#if USE_ENTERPRISE_WIFI
#include "esp_wpa2.h"
#endif

// ─── SmartMatrix Configuration ───────────────────────────────────────────────

#include <SmartMatrix.h>

#define COLOR_DEPTH   24
#define TOTAL_WIDTH   32
#define TOTAL_HEIGHT  32

#define kRefreshDepth 24
#define kDmaBufferRows 4
#define kPanelType SM_PANELTYPE_HUB75_32ROW_32COL_MOD8SCAN
#define kMatrixOptions (SM_HUB75_OPTIONS_NONE)
#define kbgOptions (SM_BACKGROUND_OPTIONS_NONE)

SMARTMATRIX_ALLOCATE_BUFFERS(matrix, TOTAL_WIDTH, TOTAL_HEIGHT, kRefreshDepth, kDmaBufferRows, kPanelType, kMatrixOptions);
SMARTMATRIX_ALLOCATE_BACKGROUND_LAYER(bg, TOTAL_WIDTH, TOTAL_HEIGHT, COLOR_DEPTH, kbgOptions);

// ─── Constants ───────────────────────────────────────────────────────────────

const uint8_t  INCOMING_COLOR_DEPTH = 16;  // RGB565
const uint16_t NUM_LEDS = TOTAL_WIDTH * TOTAL_HEIGHT;
const uint16_t BUFFER_SIZE = NUM_LEDS * (INCOMING_COLOR_DEPTH / 8);

#define WIFI_TIMEOUT       20000   // 20s WiFi connection timeout
#define WS_RECONNECT_DELAY 3000    // 3s between reconnect attempts
#define LED_BLINK_INTERVAL 500     // Status LED blink rate

// ─── Global State ────────────────────────────────────────────────────────────

static uint8_t frameBuf[BUFFER_SIZE] __attribute__((aligned(4)));
static uint32_t frameCount = 0;
static uint32_t lastReconnectAttempt = 0;
static bool wsConnected = false;

using namespace websockets;
WebsocketsClient wsClient;

// ─── WiFi Connection ─────────────────────────────────────────────────────────

void connectWiFi() {
    Serial.println("Connecting to WiFi...");
    pinMode(PICO_LED_PIN, OUTPUT);
    digitalWrite(PICO_LED_PIN, HIGH);

#if USE_ENTERPRISE_WIFI
    // WPA2-Enterprise (e.g. eduroam)
    WiFi.disconnect(true);
    WiFi.mode(WIFI_STA);

    esp_wifi_sta_wpa2_ent_set_identity((uint8_t *)EAP_IDENTITY, strlen(EAP_IDENTITY));
    esp_wifi_sta_wpa2_ent_set_username((uint8_t *)EAP_USERNAME, strlen(EAP_USERNAME));
    esp_wifi_sta_wpa2_ent_set_password((uint8_t *)EAP_PASSWORD, strlen(EAP_PASSWORD));
    esp_wifi_sta_wpa2_ent_enable();

    WiFi.begin(WIFI_SSID);
#else
    // WPA2-Personal
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
#endif

    uint32_t startTime = millis();
    bool ledState = false;

    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - startTime > WIFI_TIMEOUT) {
            Serial.println("WiFi timeout — restarting...");
            ESP.restart();
        }
        ledState = !ledState;
        digitalWrite(PICO_LED_PIN, ledState);
        delay(250);
    }

    digitalWrite(PICO_LED_PIN, LOW);
    Serial.print("WiFi connected! IP: ");
    Serial.println(WiFi.localIP());
}

// ─── RGB565 → RGB24 Conversion ──────────────────────────────────────────────

inline void convert16to24bit(const uint8_t high, const uint8_t low, rgb24* col) {
    uint16_t rgb16 = ((uint16_t)high << 8) | low;
    col->red   = ((rgb16 >> 11) & 0x1F) << 3;
    col->green = ((rgb16 >>  5) & 0x3F) << 2;
    col->blue  = (rgb16 & 0x1F) << 3;
}

// ─── Display Frame ──────────────────────────────────────────────────────────

void displayFrame(const uint8_t* data, size_t length) {
    if (length != BUFFER_SIZE) {
        Serial.printf("Frame size mismatch: got %u, expected %u\n", length, BUFFER_SIZE);
        return;
    }

    rgb24* buffer = bg.backBuffer();

    // Convert RGB565 to RGB24
    uint16_t idx = 0;
    for (uint16_t i = 0; i < NUM_LEDS; i++, idx += 2) {
        convert16to24bit(data[idx], data[idx + 1], &buffer[i]);
    }

    bg.swapBuffers();
    frameCount++;
}

// ─── WebSocket Callbacks ─────────────────────────────────────────────────────

void onWsMessage(WebsocketsMessage message) {
    if (message.isBinary()) {
        // Binary frame: RGB565 pixel data
        const uint8_t* data = (const uint8_t*)message.c_str();
        size_t length = message.length();
        displayFrame(data, length);
    } else {
        // JSON message from server
        Serial.print("WS message: ");
        Serial.println(message.data());
    }
}

void onWsEvent(WebsocketsEvent event, String data) {
    switch (event) {
        case WebsocketsEvent::ConnectionOpened:
            Serial.println("WS connected!");
            wsConnected = true;
            digitalWrite(PICO_LED_PIN, HIGH);

            // Send join message
            {
                char joinMsg[64];
                snprintf(joinMsg, sizeof(joinMsg),
                    "{\"type\":\"join\",\"role\":\"matrix\",\"pair\":%d}", PAIR_ID);
                wsClient.send(joinMsg);
                Serial.printf("Joined as matrix, pair %d\n", PAIR_ID);
            }
            break;

        case WebsocketsEvent::ConnectionClosed:
            Serial.println("WS disconnected.");
            wsConnected = false;
            digitalWrite(PICO_LED_PIN, LOW);
            break;

        case WebsocketsEvent::GotPing:
            // ArduinoWebsockets auto-responds with pong
            break;

        case WebsocketsEvent::GotPong:
            break;
    }
}

// ─── WebSocket Connection ────────────────────────────────────────────────────

void connectWebSocket() {
    Serial.println("Connecting to WebSocket server...");

    wsClient.onMessage(onWsMessage);
    wsClient.onEvent(onWsEvent);

#if WSS_USE_SSL
    wsClient.connect(WSS_SERVER_HOST, WSS_SERVER_PORT, WSS_SERVER_PATH);
#else
    wsClient.connect(WSS_SERVER_HOST, WSS_SERVER_PORT, WSS_SERVER_PATH);
#endif
}

// ─── Setup ───────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    Serial.println("\n=== MissingDrop Matrix Client ===");
    Serial.printf("Pair ID: %d\n", PAIR_ID);

#if USE_ENTERPRISE_WIFI
    Serial.println("WiFi mode: WPA2-Enterprise");
#else
    Serial.println("WiFi mode: WPA2-Personal");
#endif

    // Initialize LED matrix
    bg.enableColorCorrection(true);
    matrix.addLayer(&bg);
    matrix.setBrightness(255);
    matrix.begin();

    // Show a brief startup color
    rgb24* buffer = bg.backBuffer();
    for (uint16_t i = 0; i < NUM_LEDS; i++) {
        buffer[i] = rgb24(0, 0, 30); // dim blue
    }
    bg.swapBuffers();

    // Connect WiFi
    connectWiFi();

    // Connect WebSocket
    connectWebSocket();
}

// ─── Loop ────────────────────────────────────────────────────────────────────

void loop() {
    // Poll WebSocket for incoming messages
    if (wsConnected) {
        wsClient.poll();
    }

    // Auto-reconnect if disconnected
    if (!wsConnected && WiFi.status() == WL_CONNECTED) {
        uint32_t now = millis();
        if (now - lastReconnectAttempt > WS_RECONNECT_DELAY) {
            lastReconnectAttempt = now;
            Serial.println("Attempting WS reconnect...");
            connectWebSocket();
        }
    }

    // Reconnect WiFi if lost
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi lost — reconnecting...");
        connectWiFi();
        connectWebSocket();
    }
}
