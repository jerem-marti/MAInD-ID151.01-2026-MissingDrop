/**
 * WebSocket communication module for the 32×32 RGB LED matrix.
 *
 * Replaces the serial.js module from ne2_water_pipe.
 * Sends RGB565 pixel data over WebSocket to the MissingDrop bridge server.
 *
 * Public API mirrors serial.js:
 *   connect(url, pair) → boolean
 *   disconnect()
 *   isConnected() → boolean
 *   sendImageData(imageData)
 */

const TOTAL_WIDTH = 32
const TOTAL_HEIGHT = 32
const COLOR_DEPTH = 16 // 16-bit RGB565

// Pre-allocate the RGB565 pixel buffer
const NUM_PIXELS = TOTAL_WIDTH * TOTAL_HEIGHT
const PIXEL_BUFFER = new Uint8Array(NUM_PIXELS * (COLOR_DEPTH / 8))

let socket = null
let connected = false

// Callbacks for external status updates
let onStatusChange = null
let onError = null

/**
 * Register a callback for connection status changes.
 * @param {function} cb - Called with (connected: boolean)
 */
export function setOnStatusChange(cb) {
    onStatusChange = cb
}

/**
 * Register a callback for errors.
 * @param {function} cb - Called with (message: string)
 */
export function setOnError(cb) {
    onError = cb
}

/**
 * Connect to the MissingDrop WSS bridge server.
 * @param {string} url - WebSocket URL (e.g. wss://my-app.onrender.com/ws)
 * @param {number} pair - Pair ID (1 or 2)
 * @returns {Promise<boolean>} true if connected successfully
 */
export function connect(url, pair) {
    return new Promise((resolve) => {
        try {
            socket = new WebSocket(url)
            socket.binaryType = 'arraybuffer'

            socket.onopen = () => {
                // Send join message
                socket.send(JSON.stringify({
                    type: 'join',
                    role: 'phone',
                    pair: pair
                }))
            }

            socket.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    const msg = JSON.parse(event.data)

                    if (msg.type === 'joined') {
                        connected = true
                        onStatusChange?.(true)
                        resolve(true)
                    }

                    if (msg.type === 'status') {
                        // Pair status update — matrix connected/disconnected
                        onStatusChange?.(connected, msg)
                    }

                    if (msg.type === 'error') {
                        onError?.(msg.message)
                    }

                    if (msg.type === 'kicked') {
                        connected = false
                        onStatusChange?.(false)
                    }
                }
            }

            socket.onclose = () => {
                connected = false
                onStatusChange?.(false)
                socket = null
            }

            socket.onerror = () => {
                connected = false
                onError?.('WebSocket connection error')
                resolve(false)
            }
        } catch (err) {
            console.error('WSS connection error:', err)
            onError?.(err.message)
            resolve(false)
        }
    })
}

/**
 * Disconnect from the WebSocket server.
 */
export function disconnect() {
    if (socket) {
        socket.close()
        socket = null
    }
    connected = false
}

/**
 * Check if the WebSocket is connected and ready.
 * @returns {boolean}
 */
export function isConnected() {
    return connected && socket !== null && socket.readyState === WebSocket.OPEN
}

/**
 * Send an ImageData (32×32 RGBA) to the server as RGB565 binary.
 * @param {ImageData} imageData - 32×32 RGBA image data
 */
export function sendImageData(imageData) {
    if (!isConnected()) return

    const pixels = imageData.data
    let idx = 0

    for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i + 0]
        const g = pixels[i + 1]
        const b = pixels[i + 2]
        const rgb16 = packRGB16(r, g, b)
        PIXEL_BUFFER[idx++] = (rgb16 >> 8) & 0xFF // high byte
        PIXEL_BUFFER[idx++] = rgb16 & 0xFF         // low byte
    }

    try {
        socket.send(PIXEL_BUFFER.buffer)
    } catch (err) {
        console.warn('WSS send skipped:', err.message)
    }
}

/**
 * Convert 8-bit RGB to 16-bit RGB565.
 * Pack into: RRRRRGGG GGGBBBBB
 */
function packRGB16(r, g, b) {
    const r5 = (r >> 3) & 0x1F
    const g6 = (g >> 2) & 0x3F
    const b5 = (b >> 3) & 0x1F
    return (r5 << 11) | (g6 << 5) | b5
}
