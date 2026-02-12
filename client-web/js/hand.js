/**
 * Hand tracking module — MediaPipe Hands via the Vision task API.
 *
 * Initializes webcam capture and runs real-time hand landmark detection.
 * Exposes the index finger tip position (landmark 8) normalized to 0–31.
 *
 * Uses MediaPipe Tasks Vision (CDN) for hand landmark detection.
 * Detection is driven externally via detect() — no internal loop.
 */

const MATRIX_SIZE = 32

let videoStream = null
let videoElement = null
let handLandmarker = null
let running = false
let lastTimestamp = -1

/**
 * Load the MediaPipe HandLandmarker model.
 * Must be called before start().
 */
export async function init() {
    const { HandLandmarker, FilesetResolver } = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21'
    )

    const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
    )

    handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
            delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
    })
}

/**
 * Start the webcam. Detection is driven by calling detect().
 * @param {HTMLVideoElement} video - The video element to attach the stream to
 */
export async function start(video) {
    if (!handLandmarker) {
        throw new Error('HandLandmarker not initialized. Call init() first.')
    }

    videoElement = video

    const constraints = {
        video: {
            facingMode: 'user',
            width: { ideal: 640 },
            height: { ideal: 480 }
        }
    }

    videoStream = await navigator.mediaDevices.getUserMedia(constraints)
    video.srcObject = videoStream
    await video.play()

    running = true
}

/**
 * Stop hand detection and release the camera.
 */
export function stop() {
    running = false

    if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop())
        videoStream = null
    }
    if (videoElement) {
        videoElement.srcObject = null
        videoElement = null
    }
}

/**
 * Check if hand tracking is currently running.
 * @returns {boolean}
 */
export function isRunning() {
    return running
}

/**
 * Run one detection on the current video frame.
 * Call this from your own RAF loop.
 * @returns {object|null} MediaPipe hand results, or null if not ready
 */
export function detect() {
    if (!running || !handLandmarker || !videoElement || videoElement.readyState < 2) {
        return null
    }

    try {
        // Ensure strictly increasing timestamp (required by MediaPipe)
        let now = performance.now()
        if (now <= lastTimestamp) now = lastTimestamp + 1
        lastTimestamp = now

        return handLandmarker.detectForVideo(videoElement, now)
    } catch (err) {
        console.error('Hand detection error:', err)
        return null
    }
}

/**
 * Extract the index finger tip (landmark 8) position mapped to matrix coords.
 * Returns null if no hand is detected.
 * @param {object} results - MediaPipe hand results
 * @returns {{ x: number, y: number }|null} Position in 0..31 matrix space
 */
export function getIndexFingerTip(results) {
    if (!results || !results.landmarks || results.landmarks.length === 0) {
        return null
    }

    const landmarks = results.landmarks[0]
    const tip = landmarks[8] // INDEX_FINGER_TIP

    // Mirror horizontally (selfie view) and scale to matrix
    const x = Math.floor((1 - tip.x) * MATRIX_SIZE)
    const y = Math.floor(tip.y * MATRIX_SIZE)

    return {
        x: Math.max(0, Math.min(MATRIX_SIZE - 1, x)),
        y: Math.max(0, Math.min(MATRIX_SIZE - 1, y))
    }
}

// ─── Pinch Detection ─────────────────────────────────────────────────────────

/**
 * Check if the thumb and index finger are pinched together.
 * Uses the 3D Euclidean distance between THUMB_TIP (4) and INDEX_FINGER_TIP (8).
 * @param {object} results - MediaPipe hand results
 * @param {number} [threshold=0.07] - Normalized distance threshold (0–1 space)
 * @returns {boolean} true if pinching
 */
export function isPinching(results, threshold = 0.07) {
    if (!results || !results.landmarks || results.landmarks.length === 0) {
        return false
    }

    const landmarks = results.landmarks[0]
    const thumb = landmarks[4]  // THUMB_TIP
    const index = landmarks[8]  // INDEX_FINGER_TIP

    const dx = thumb.x - index.x
    const dy = thumb.y - index.y
    const dz = (thumb.z || 0) - (index.z || 0)
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

    return dist < threshold
}

// ─── Open Hand Detection ─────────────────────────────────────────────────────

/**
 * Check if the hand is fully open (all 5 fingers extended).
 * @param {object} results - MediaPipe hand results
 * @returns {boolean} true if open hand
 */
export function isOpenHand(results) {
    if (!results || !results.landmarks || results.landmarks.length === 0) {
        return false
    }

    const landmarks = results.landmarks[0]
    const wrist = landmarks[0]

    // Helper: dist^2 between point and wrist
    function distSq(idx) {
        const dx = landmarks[idx].x - wrist.x
        const dy = landmarks[idx].y - wrist.y
        const dz = (landmarks[idx].z || 0) - (wrist.z || 0)
        return dx * dx + dy * dy + dz * dz
    }

    // Check if TIP is further from wrist than PIP for fingers
    // Landmarks:
    // Thumb: 4 (Tip), 2 (MCP) -- Thumb is tricky, let's use simple distance check for now
    // Index: 8 (Tip), 6 (PIP)
    // Middle: 12 (Tip), 10 (PIP)
    // Ring: 16 (Tip), 14 (PIP)
    // Pinky: 20 (Tip), 18 (PIP)

    const tips = [4, 8, 12, 16, 20]
    const pips = [2, 6, 10, 14, 18] // Using MCP for thumb, PIP for others

    let openCount = 0
    for (let i = 0; i < 5; i++) {
        if (distSq(tips[i]) > distSq(pips[i])) {
            openCount++
        }
    }

    // Require all 5 fingers to be extended
    return openCount === 5
}

// ─── Tap Detection State ─────────────────────────────────────────────────────

const TAP_HISTORY_SIZE = 8     // Number of frames to track
const TAP_THRESHOLD = 0.02     // Minimum forward velocity to detect tap
const tapHistory = []          // Circular buffer of index finger z positions

/**
 * Detect finger tap by tracking forward movement toward the camera.
 * Uses the index finger tip position (landmark 8) z-coordinate.
 * A tap is detected when the finger moves forward (negative z direction).
 * @param {object} results - MediaPipe hand results
 * @param {number} [threshold=0.02] - Minimum velocity threshold for tap detection
 * @returns {boolean} true if tapping
 */
export function isTapping(results, threshold = TAP_THRESHOLD) {
    if (!results || !results.landmarks || results.landmarks.length === 0) {
        // Clear history when hand is lost
        tapHistory.length = 0
        return false
    }

    const landmarks = results.landmarks[0]
    const indexTip = landmarks[8]  // INDEX_FINGER_TIP

    // Add current index finger z position to history
    // Note: in MediaPipe, negative z = toward camera
    tapHistory.push(indexTip.z || 0)

    // Keep only recent history
    if (tapHistory.length > TAP_HISTORY_SIZE) {
        tapHistory.shift()
    }

    // Need enough history to detect motion
    if (tapHistory.length < 5) {
        return false
    }

    // Calculate velocity by comparing recent positions
    // Recent frames should have MORE NEGATIVE z (closer to camera)
    const recentAvg = (tapHistory[tapHistory.length - 1] +
        tapHistory[tapHistory.length - 2] +
        tapHistory[tapHistory.length - 3]) / 3

    const previousAvg = (tapHistory[tapHistory.length - 4] +
        tapHistory[tapHistory.length - 5] +
        (tapHistory[tapHistory.length - 6] || tapHistory[tapHistory.length - 5])) / 3

    // Forward velocity = previous - recent (should be positive when moving toward camera)
    const velocity = previousAvg - recentAvg

    return velocity > threshold
}
