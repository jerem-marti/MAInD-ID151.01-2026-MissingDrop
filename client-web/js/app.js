/**
 * Main application module — orchestrates hand tracking, water simulation, and WSS.
 *
 * Loop: detect → drop → simulate → render → send → next frame
 *
 * Pinch gesture triggers a water drop at the index finger position.
 * The simulation runs every frame regardless of hand presence.
 * WebSocket transmission is non-blocking (fire-and-forget binary send).
 */

import { connect, disconnect, isConnected, sendImageData, setOnStatusChange, setOnError } from './wss.js'
import * as Hand from './hand.js'
import * as Water from './water.js'

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
let wasNotPinching = true
let tintColor = { r: 60, g: 150, b: 255 }
let continuousDrop = false

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
    wasNotPinching = true
    log('Hand tracking stopped.')
}

// ─── Hand → Water Drop ──────────────────────────────────────────────────────

function processHandDetection() {
    const results = Hand.detect()
    if (!results) return

    const pos = Hand.getIndexFingerTip(results)
    const pinching = Hand.isPinching(results)

    if (pos && pinching) {
        if (wasNotPinching || continuousDrop) {
            Water.dropAt(pos.x, pos.y)
            if (wasNotPinching) {
                log(`💧 Drop at (${pos.x}, ${pos.y})`)
            }
        }
        wasNotPinching = false
    } else {
        wasNotPinching = true
    }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

function mainLoop() {
    // 1. Hand detection → trigger drops
    if (Hand.isRunning()) {
        processHandDetection()
    }

    // 2. Advance water simulation
    Water.step()

    // 3. Render to ImageData with tint
    const imageData = Water.getImageData(tintColor)

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
    tintColor = {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16)
    }
})

// Drop strength
strengthSlider.addEventListener('input', () => {
    const val = parseFloat(strengthSlider.value)
    Water.setDropStrength(val)
    strengthValue.textContent = val.toFixed(1)
})

// Drop radius
radiusSlider.addEventListener('input', () => {
    const val = parseInt(radiusSlider.value)
    Water.setDropRadius(val)
    radiusValue.textContent = val
})

// Wave damping
dampSlider.addEventListener('input', () => {
    const val = parseFloat(dampSlider.value)
    Water.setWaveDamp(val)
    dampValue.textContent = val.toFixed(3)
})

// Render gain
gainSlider.addEventListener('input', () => {
    const val = parseFloat(gainSlider.value)
    Water.setRenderGain(val)
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
    Water.reset()
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
