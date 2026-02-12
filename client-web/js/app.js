/**
 * Main application module — orchestrates hand tracking, water simulation, and WSS.
 *
 * Loop: detect → drop → simulate → render → send → next frame
 *
 * Tap gesture triggers a water drop at the index finger position.
 * The simulation runs every frame regardless of hand presence.
 * WebSocket transmission is non-blocking (fire-and-forget binary send).
 */

import { connect, disconnect, isConnected, sendImageData, setOnStatusChange, setOnError, setOnDrop, sendDrop } from './wss.js'
import * as Hand from './hand.js'
import { WaterSimulation } from './water.js'

const MATRIX_SIZE = 32

// ─── DOM Elements ────────────────────────────────────────────────────────────

const video = document.getElementById('video')
const matrixCanvas = document.getElementById('matrixCanvas')
const btnConnect = document.getElementById('btnConnect')
const btnStart = document.getElementById('btnStart')
const btnClear = document.getElementById('btnClear')
const btnTest = document.getElementById('btnTest')
const btnContinuous = document.getElementById('btnContinuous')
const colorPicker = document.getElementById('colorPicker')
const strengthSlider = document.getElementById('strengthSlider')
const strengthValue = document.getElementById('strengthValue')
const radiusSlider = document.getElementById('radiusSlider')
const radiusValue = document.getElementById('radiusValue')
const dampSlider = document.getElementById('dampSlider')
const dampValue = document.getElementById('dampValue')
const gainSlider = document.getElementById('gainSlider')
const gainValue = document.getElementById('gainValue')
const logEl = document.getElementById('log')
const statusDot = document.getElementById('statusDot')
const matrixDot = document.getElementById('matrixDot')
const pairSelect = document.getElementById('pairSelect')
const serverUrl = document.getElementById('serverUrl')

// ─── Canvas context ──────────────────────────────────────────────────────────

const matrixCtx = matrixCanvas.getContext('2d', { willReadFrequently: true })

// ─── State ───────────────────────────────────────────────────────────────────

let modelReady = false
let wasNotTapping = true
let localTint = { r: 60, g: 150, b: 255 }
let remoteTint = { r: 255, g: 100, b: 100 } // Default remote color until updated
let continuousDrop = false

// Instantiate TWO simulations:
// 1. localWater: driven by THIS user's hand
// 2. remoteWater: driven by OTHER user's drops via WSS
const localWater = new WaterSimulation()
const remoteWater = new WaterSimulation()

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    const time = new Date().toLocaleTimeString()
    logEl.textContent = `[${time}] ${msg}\n` + logEl.textContent
}

// ─── WSS Status Callbacks ────────────────────────────────────────────────────

setOnStatusChange((connected, statusMsg) => {
    statusDot.className = `status-dot ${connected ? 'online' : 'offline'}`
    btnConnect.textContent = connected ? 'Disconnect' : 'Connect'

    if (statusMsg && statusMsg.type === 'status') {
        matrixDot.className = `status-dot ${statusMsg.matrix ? 'online' : 'offline'}`
    }
})

setOnError((message) => {
    log('WSS error: ' + message)
})

setOnDrop((x, y, strength, radius, r, g, b) => {
    // Received a drop from the other user!
    // Update remote tint if color data is present
    if (r !== undefined && g !== undefined && b !== undefined) {
        remoteTint = { r, g, b }
    }

    // Trigger drop in the remote simulation layer
    remoteWater.dropAt(x, y, { strength, radius })
    // log(`Remote drop at (${x},${y})`)
})

// ─── Initialization ──────────────────────────────────────────────────────────

async function initModel() {
    log('Loading MediaPipe hand model…')
    try {
        await Hand.init()
        modelReady = true
        btnStart.disabled = false
        log('Hand model loaded ✓')
    } catch (err) {
        log('Failed to load hand model: ' + err.message)
    }
}

// Start model loading immediately
initModel()

// ─── WebSocket Connection ────────────────────────────────────────────────────

btnConnect.addEventListener('click', async () => {
    if (isConnected()) {
        disconnect()
        btnConnect.textContent = 'Connect'
        statusDot.className = 'status-dot offline'
        matrixDot.className = 'status-dot offline'
        log('WebSocket disconnected.')
    } else {
        const url = serverUrl.value.trim()
        const pair = parseInt(pairSelect.value)

        if (!url) {
            log('Enter a server URL first.')
            return
        }

        log(`Connecting to ${url} (pair ${pair})…`)
        const ok = await connect(url, pair)
        if (ok) {
            log(`Connected to pair ${pair}!`)
        } else {
            log('Connection failed.')
        }
    }
})

// ─── Start / Stop Tracking ──────────────────────────────────────────────────

btnStart.addEventListener('click', async () => {
    if (Hand.isRunning()) {
        stopTracking()
    } else {
        await startTracking()
    }
})

async function startTracking() {
    if (!modelReady) {
        log('Hand model not ready yet.')
        return
    }

    try {
        await Hand.start(video)
        video.classList.remove('hidden')
        btnStart.textContent = 'Stop Tracking'
        btnStart.classList.add('active')
        log('Hand tracking started.')
    } catch (err) {
        log('Camera error: ' + err.message)
    }
}

function stopTracking() {
    Hand.stop()
    video.classList.add('hidden')
    btnStart.textContent = 'Start Tracking'
    btnStart.classList.remove('active')
    wasNotTapping = true
    log('Hand tracking stopped.')
}

// ─── Hand → Water Drop & Color Control ───────────────────────────────────────

function hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return {
        r: Math.round(255 * f(0)),
        g: Math.round(255 * f(8)),
        b: Math.round(255 * f(4))
    };
}

function rgbToHex(r, g, b) {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function processHandDetection() {
    const results = Hand.detect()
    if (!results) return

    const pos = Hand.getIndexFingerTip(results)
    const pinching = Hand.isPinching(results) // Kept but unused for now
    const tapping = Hand.isTapping(results)
    const openHand = Hand.isOpenHand(results)

    if (pos) {
        // ─── COLOR CONTROL (OPEN HAND) ───
        if (openHand) {
            // Map X (0-31) to Hue (0-360)
            // Map Y (0-31) to Lightness (100-0) -- Up is Lighter

            const hue = Math.round((pos.x / MATRIX_SIZE) * 360)
            const lightness = Math.round(100 - (pos.y / MATRIX_SIZE) * 100)
            const saturation = 100 // Keep valid vivid color

            // Convert HSL -> RGB
            const rgb = hslToRgb(hue, saturation, lightness)

            // Update local state
            localTint = rgb

            // Update UI (optional smoothness check could be added)
            colorPicker.value = rgbToHex(rgb.r, rgb.g, rgb.b)

            // Visual feedback via log (throttled/optional)
            // log(`Color: H${hue} L${lightness}`)
        }

        // ─── DROP TRIGGER (TAP) ───
        // Only allow tapping if NOT in open hand mode to avoid conflicts
        if (tapping && !openHand) {
            if (wasNotTapping || continuousDrop) {
                // Trigger LOCAL drop
                localWater.dropAt(pos.x, pos.y)

                // Broadcast drop to remote (with our color)
                const s = localWater.getDropStrength()
                const r = localWater.getDropRadius()
                sendDrop(pos.x, pos.y, s, r, localTint.r, localTint.g, localTint.b)

                if (wasNotTapping) {
                    log(`💧 Drop at (${pos.x}, ${pos.y})`)
                }
            }
            wasNotTapping = false
        } else {
            wasNotTapping = true
        }
    } else {
        wasNotTapping = true
    }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

function mainLoop() {
    // 1. Hand detection → trigger drops
    if (Hand.isRunning()) {
        processHandDetection()
    }

    // 2. Advance simulations
    localWater.step()
    remoteWater.step()

    // 3. Output Rendering:
    //    Base color is localTint.
    //    Remote waves push the color towards remoteTint.

    // Get raw shading maps (0.0 - 1.0)
    const shadeLocal = localWater.getShadingMap()
    const shadeRemote = remoteWater.getShadingMap()

    const imageData = new ImageData(MATRIX_SIZE, MATRIX_SIZE)
    const data = imageData.data

    // Brightness boost factor to make colors pop
    const BRIGHTNESS_BOOST = 2.0

    // Total pixels
    const N = MATRIX_SIZE * MATRIX_SIZE

    for (let i = 0; i < N; i++) {
        // Shading values are 0.0 - 1.0 (0.5 is flat water)
        const s1 = shadeLocal[i]
        const s2 = shadeRemote[i]

        // Superposition of wave slopes (approximate)
        // flat + (slope1 + slope2)
        // s1 = 0.5 + slope1  -> slope1 = s1 - 0.5
        // total = 0.5 + (s1 - 0.5) + (s2 - 0.5)
        let totalShade = s1 + s2 - 0.5

        // Clamp shade
        if (totalShade < 0) totalShade = 0
        if (totalShade > 1) totalShade = 1

        // Calculate how much "remote activity" is here
        // We use deviation from 0.5 as a proxy for wave height/slope
        const remoteActivity = Math.abs(s2 - 0.5)

        // Gain up the activity to make color shift more visible even for small ripples
        // 4.0 is a magic number: higher = more sensitive color shift
        let mixFactor = remoteActivity * 4.0
        if (mixFactor > 1.0) mixFactor = 1.0

        // Lerp color: local -> remote based on mixFactor
        const r = localTint.r * (1 - mixFactor) + remoteTint.r * mixFactor
        const g = localTint.g * (1 - mixFactor) + remoteTint.g * mixFactor
        const b = localTint.b * (1 - mixFactor) + remoteTint.b * mixFactor

        // Apply directional shading to the composed color AND boost brightness
        const idx = i * 4

        // Note: we can go above 255 before clamping if we want "HDR" highlights
        const rFinal = r * totalShade * BRIGHTNESS_BOOST
        const gFinal = g * totalShade * BRIGHTNESS_BOOST
        const bFinal = b * totalShade * BRIGHTNESS_BOOST

        data[idx + 0] = rFinal > 255 ? 255 : rFinal
        data[idx + 1] = gFinal > 255 ? 255 : gFinal
        data[idx + 2] = bFinal > 255 ? 255 : bFinal
        data[idx + 3] = 255
    }

    // 4. Preview on canvas
    matrixCtx.putImageData(imageData, 0, 0)

    // 5. Send to matrix via WSS (fire-and-forget)
    if (isConnected()) {
        sendImageData(imageData)
    }

    // 6. Next frame
    requestAnimationFrame(mainLoop)
}

// Start the loop immediately
requestAnimationFrame(mainLoop)

// ─── UI Controls ─────────────────────────────────────────────────────────────

// Water tint color
colorPicker.addEventListener('input', () => {
    const hex = colorPicker.value
    localTint = {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16)
    }
})

// Drop strength
strengthSlider.addEventListener('input', () => {
    const val = parseFloat(strengthSlider.value)
    localWater.setDropStrength(val)
    remoteWater.setDropStrength(val)
    strengthValue.textContent = val.toFixed(1)
})

// Drop radius
radiusSlider.addEventListener('input', () => {
    const val = parseInt(radiusSlider.value)
    localWater.setDropRadius(val)
    remoteWater.setDropRadius(val)
    radiusValue.textContent = val
})

// Wave damping
dampSlider.addEventListener('input', () => {
    const val = parseFloat(dampSlider.value)
    localWater.setWaveDamp(val)
    remoteWater.setWaveDamp(val)
    dampValue.textContent = val.toFixed(3)
})

// Render gain
gainSlider.addEventListener('input', () => {
    const val = parseFloat(gainSlider.value)
    localWater.setRenderGain(val)
    remoteWater.setRenderGain(val)
    gainValue.textContent = val.toFixed(1)
})

// Continuous drop toggle
if (btnContinuous) {
    btnContinuous.addEventListener('click', () => {
        continuousDrop = !continuousDrop
        btnContinuous.classList.toggle('active', continuousDrop)
        btnContinuous.textContent = continuousDrop ? 'Continuous: ON' : 'Continuous: OFF'
        log(`Continuous drop: ${continuousDrop ? 'ON' : 'OFF'}`)
    })
}

// Clear / Reset
btnClear.addEventListener('click', () => {
    localWater.reset()
    remoteWater.reset()
    log('Water reset.')
})

// Test — send a solid cyan frame
if (btnTest) {
    btnTest.addEventListener('click', () => {
        if (!isConnected()) {
            log('Connect WebSocket first.')
            return
        }
        const testData = new ImageData(32, 32)
        for (let i = 0; i < testData.data.length; i += 4) {
            testData.data[i + 0] = 0    // R
            testData.data[i + 1] = 200  // G
            testData.data[i + 2] = 255  // B
            testData.data[i + 3] = 255  // A
        }
        sendImageData(testData)
        log('Test frame sent (solid cyan).')
    })
}
