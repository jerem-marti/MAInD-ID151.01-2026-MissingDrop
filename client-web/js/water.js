/**
 * Water simulation module — 2D wave equation on a 32×32 grid.
 *
 * Ported from ne1_restart_1 C++ firmware into a browser-side JS module.
 * The simulation runs entirely in the browser; only the rendered frame
 * is sent to the LED matrix via WebSocket.
 *
 * Physics:
 *   - Height field `h` and velocity field `v` (Float32Arrays, row-major).
 *   - Each step: Laplacian of `h` drives `v`; `v` updates `h`.
 *   - `waveDamp < 1.0` causes ripples to lose energy over time.
 *
 * Rendering:
 *   - Per-pixel gradient (gx, gy) → directional shading.
 *   - Shade is multiplied by a user-chosen tint color.
 */

const SIZE = 32
const N = SIZE * SIZE

// ─── Simulation fields ───────────────────────────────────────────────────────

const h = new Float32Array(N) // height field
const v = new Float32Array(N) // velocity field

// ─── Tuneable parameters (with sensible defaults) ────────────────────────────

let waveK = 0.20     // wave propagation speed
let waveDamp = 0.985  // damping per tick (< 1.0 → energy loss)
let renderGain = 2.3  // brightness multiplier for the gradient shade
let dropStrength = 1.0 // default drop energy
let dropRadius = 2    // default drop radius (px)
let dropBurst = 1     // number of jittered sub-drops per trigger

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x
}

function fract(x) {
    return x - Math.floor(x)
}

/** Simple hash for deterministic pseudo-random jitter. */
function hash11(x) {
    return fract(Math.sin(x * 127.1 + 311.7) * 43758.5453)
}

/** Row-major index. */
function idx(x, y) {
    return y * SIZE + x
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Inject a water drop at (cx, cy).
 * @param {number} cx     - X position (0–31)
 * @param {number} cy     - Y position (0–31)
 * @param {object} [opts] - Optional overrides
 * @param {number} [opts.strength]   - Drop energy (default: module dropStrength)
 * @param {number} [opts.radius]     - Drop radius in px (1–5)
 * @param {number} [opts.burstCount] - Number of jittered sub-drops (1–8)
 */
export function dropAt(cx, cy, opts = {}) {
    const str = opts.strength ?? dropStrength
    const rad = clamp(opts.radius ?? dropRadius, 1, 5)
    const bursts = clamp(opts.burstCount ?? dropBurst, 1, 8)

    const falloff = 2.2 / (rad * rad)
    const jitter = rad * 0.45

    for (let b = 0; b < bursts; b++) {
        const seed = performance.now() * 0.001 + (b * 17 + cx * 5 + cy * 3)
        const jcx = Math.round((hash11(seed * 1.37 + 2.1) - 0.5) * 2.0 * jitter)
        const jcy = Math.round((hash11(seed * 1.93 + 9.4) - 0.5) * 2.0 * jitter)
        const px = clamp(cx + jcx, 1, SIZE - 2)
        const py = clamp(cy + jcy, 1, SIZE - 2)

        for (let dx = -rad; dx <= rad; dx++) {
            for (let dy = -rad; dy <= rad; dy++) {
                const x = px + dx
                const y = py + dy
                if (x < 1 || x > SIZE - 2 || y < 1 || y > SIZE - 2) continue
                const r2 = dx * dx + dy * dy
                const w = Math.exp(-r2 * falloff)
                v[idx(x, y)] += str * w
            }
        }
    }
}

/**
 * Advance the simulation by one time step.
 * Call once per animation frame.
 */
export function step() {
    // Laplacian → velocity
    for (let x = 1; x < SIZE - 1; x++) {
        for (let y = 1; y < SIZE - 1; y++) {
            const i = idx(x, y)
            const lap = h[idx(x - 1, y)] + h[idx(x + 1, y)] +
                h[idx(x, y - 1)] + h[idx(x, y + 1)] -
                4.0 * h[i]
            v[i] = (v[i] + waveK * lap) * waveDamp
        }
    }

    // Velocity → height
    for (let x = 1; x < SIZE - 1; x++) {
        for (let y = 1; y < SIZE - 1; y++) {
            const i = idx(x, y)
            h[i] += v[i]
        }
    }
}

/**
 * Render the current height field into a 32×32 ImageData.
 * Uses gradient-based directional shading, tinted by the given color.
 *
 * @param {{ r: number, g: number, b: number }} tint - RGB tint (0–255 each)
 * @returns {ImageData} 32×32 RGBA image data
 */
export function getImageData(tint) {
    const imageData = new ImageData(SIZE, SIZE)
    const data = imageData.data

    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const xm = x > 0 ? x - 1 : x
            const xp = x < SIZE - 1 ? x + 1 : x
            const ym = y > 0 ? y - 1 : y
            const yp = y < SIZE - 1 ? y + 1 : y

            const gx = h[idx(xp, y)] - h[idx(xm, y)]
            const gy = h[idx(x, yp)] - h[idx(x, ym)]
            const shade = clamp(0.5 + renderGain * (gx * 0.5 + gy * 0.25), 0.0, 1.0)

            const offset = (y * SIZE + x) * 4
            data[offset + 0] = Math.round(tint.r * shade)
            data[offset + 1] = Math.round(tint.g * shade)
            data[offset + 2] = Math.round(tint.b * shade)
            data[offset + 3] = 255
        }
    }

    return imageData
}

/**
 * Reset both fields to zero (flat water).
 */
export function reset() {
    h.fill(0)
    v.fill(0)
}

// ─── Parameter setters ──────────────────────────────────────────────────────

export function setWaveK(val) { waveK = val }
export function setWaveDamp(val) { waveDamp = val }
export function setRenderGain(val) { renderGain = val }
export function setDropStrength(val) { dropStrength = val }
export function setDropRadius(val) { dropRadius = clamp(Math.round(val), 1, 5) }
export function setDropBurst(val) { dropBurst = clamp(Math.round(val), 1, 8) }

// ─── Parameter getters (for UI sync) ────────────────────────────────────────

export function getWaveK() { return waveK }
export function getWaveDamp() { return waveDamp }
export function getRenderGain() { return renderGain }
export function getDropStrength() { return dropStrength }
export function getDropRadius() { return dropRadius }
export function getDropBurst() { return dropBurst }
