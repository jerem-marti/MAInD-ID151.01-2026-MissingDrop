/**
 * @file wifi_client.h
 * @brief Wi-Fi connection management
 */

#ifndef WIFI_CLIENT_H
#define WIFI_CLIENT_H

#include <Arduino.h>
#include <WiFi.h>

// Forward declaration of setupWebSocket from main.cpp
void setupWebSocket();

/**
 * @brief Connect to WiFi (blocking)
 * @return true if connected, false if failed
 */
bool connectToWiFi();

/**
 * @brief Check connection and reconnect if lost
 */
void checkWiFiConnection();

#endif // WIFI_CLIENT_H
