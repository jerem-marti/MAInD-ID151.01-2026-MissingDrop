#include "wifi_client.h"
#include "config.h"

#if USE_ENTERPRISE_WIFI
#include "esp_wpa2.h"
#endif

// External reference to the LED pin from main.cpp? 
// Actually, main.cpp uses PICO_LED_PIN from "common/pico_driver_v5_pinout.h"
// We should probably include that here too if we want to blink the LED, 
// or maybe just omit the LED blinking from this module to keep it clean?
// The numeric-flower implementation doesn't blink an LED, it just prints to Serial.
// I'll stick to Serial for now to keep dependencies low, or include the pinout if needed.
// Given the user wants "Manage the wifi as in [numeric-flower]", I will follow that logic
// which relies on Serial.

bool connectToWiFi() {
    Serial.println("Connecting to WiFi...");
    
    // Disconnect previous connection
    WiFi.disconnect(true);
    delay(1000);
    
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    
    // Debug: Print MAC Address
    Serial.print("Device MAC: ");
    Serial.println(WiFi.macAddress());

    // Debug: Scan Networks
    Serial.println("Scanning networks...");
    int n = WiFi.scanNetworks();
    if (n == 0) {
        Serial.println("No networks found!");
    } else {
        Serial.printf("%d networks found:\n", n);
        for (int i = 0; i < n; ++i) {
            Serial.printf("  %d: %s (%d) %s\n", i + 1, WiFi.SSID(i).c_str(), WiFi.RSSI(i), (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "Open" : "Secured");
        }
    }

#if USE_ENTERPRISE_WIFI
    // WPA2-Enterprise (e.g. eduroam)
    // NOTE: This uses the older SDK macro as found in previous steps
    // Make static so it persists in memory if the SDK keeps a pointer to it
    static esp_wpa2_config_t wpa2_config = WPA2_CONFIG_INIT_DEFAULT();
    esp_wifi_sta_wpa2_ent_enable(&wpa2_config);

    esp_wifi_sta_wpa2_ent_set_identity((uint8_t *)EAP_IDENTITY, strlen(EAP_IDENTITY));
    esp_wifi_sta_wpa2_ent_set_username((uint8_t *)EAP_USERNAME, strlen(EAP_USERNAME));
    esp_wifi_sta_wpa2_ent_set_password((uint8_t *)EAP_PASSWORD, strlen(EAP_PASSWORD));

    // Disable certificate verification for simplicity/compatibility
    esp_wifi_sta_wpa2_ent_set_ca_cert(NULL, 0);
    esp_wifi_sta_wpa2_ent_set_cert_key(NULL, 0, NULL, 0, NULL, 0);

    WiFi.begin(WIFI_SSID);
#else
    // WPA2-Personal
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
#endif

    unsigned long startAttemptTime = millis();

    // Try for 20 seconds (as per main.cpp original timeout, numeric-flower had 30s)
    while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 30000) {
        Serial.print(".");
        delay(500);
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("✅ Wi-Fi connected!");
        Serial.print("IP: ");
        Serial.println(WiFi.localIP());

        // Setup NTP
        configTime(0, 0, "pool.ntp.org", "time.nist.gov");
        Serial.println("⏰ NTP Sync...");
        
        return true;
    } else {
        Serial.println("❌ WiFi failed. Restarting...");
        delay(2000);
        ESP.restart();
        return false;
    }
}

void checkWiFiConnection() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("⚠️ WiFi lost. Reconnecting...");
        connectToWiFi();
        // Re-init WebSocket after WiFi reconnect
        setupWebSocket();
    }
}
