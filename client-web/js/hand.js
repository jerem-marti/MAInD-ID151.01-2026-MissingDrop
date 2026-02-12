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
