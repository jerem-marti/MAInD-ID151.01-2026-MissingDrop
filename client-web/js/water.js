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

export class WaterSimulation {
    constructor() {
        // ─── Simulation fields ───────────────────────────────────────────────────────
        this.h = new Float32Array(N) // height field
        this.v = new Float32Array(N) // velocity field

        // ─── Tuneable parameters (with sensible defaults) ────────────────────────────
        this.waveK = 0.20     // wave propagation speed
        this.waveDamp = 0.985  // damping per tick (< 1.0 → energy loss)
        this.renderGain = 2.3  // brightness multiplier for the gradient shade
        this.dropStrength = 1.0 // default drop energy
        this.dropRadius = 2    // default drop radius (px)
        this.dropBurst = 1     // number of jittered sub-drops per trigger
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
    dropAt(cx, cy, opts = {}) {
        const str = opts.strength ?? this.dropStrength
        const rad = clamp(opts.radius ?? this.dropRadius, 1, 5)
        const bursts = clamp(opts.burstCount ?? this.dropBurst, 1, 8)

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
                    this.v[idx(x, y)] += str * w
                }
            }
        }
    }

    /**
     * Advance the simulation by one time step.
     * Call once per animation frame.
     */
    step() {
        // Laplacian → velocity
        for (let x = 1; x < SIZE - 1; x++) {
            for (let y = 1; y < SIZE - 1; y++) {
                const i = idx(x, y)
                const lap = this.h[idx(x - 1, y)] + this.h[idx(x + 1, y)] +
                    this.h[idx(x, y - 1)] + this.h[idx(x, y + 1)] -
                    4.0 * this.h[i]
                this.v[i] = (this.v[i] + this.waveK * lap) * this.waveDamp
            }
        }

        // Velocity → height
        for (let x = 1; x < SIZE - 1; x++) {
            for (let y = 1; y < SIZE - 1; y++) {
                const i = idx(x, y)
                this.h[i] += this.v[i]
            }
        }
    }

    /**
     * Get the shading map for the current state (values 0.0 - 1.0).
     * @returns {Float32Array} 32x32 shading values
     */
    getShadingMap() {
        const map = new Float32Array(N)
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const xm = x > 0 ? x - 1 : x
                const xp = x < SIZE - 1 ? x + 1 : x
                const ym = y > 0 ? y - 1 : y
                const yp = y < SIZE - 1 ? y + 1 : y

                const gx = this.h[idx(xp, y)] - this.h[idx(xm, y)]
                const gy = this.h[idx(x, yp)] - this.h[idx(x, ym)]
                const shade = clamp(0.5 + this.renderGain * (gx * 0.5 + gy * 0.25), 0.0, 1.0)
                map[idx(x, y)] = shade
            }
        }
        return map
    }

    /**
     * Additively render the current height field into a target buffer.
     * 
     * @param {Uint8ClampedArray} data - The RGBA buffer to write to
     * @param {{ r: number, g: number, b: number }} tint - RGB tint (0–255 each)
     */
    addRenderTo(data, tint) {
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const xm = x > 0 ? x - 1 : x
                const xp = x < SIZE - 1 ? x + 1 : x
                const ym = y > 0 ? y - 1 : y
                const yp = y < SIZE - 1 ? y + 1 : y

                const gx = this.h[idx(xp, y)] - this.h[idx(xm, y)]
                const gy = this.h[idx(x, yp)] - this.h[idx(x, ym)]
                const shade = clamp(0.5 + this.renderGain * (gx * 0.5 + gy * 0.25), 0.0, 1.0)

                const offset = (y * SIZE + x) * 4
                // Additive blending: dest = dest + source
                data[offset + 0] = clamp(data[offset + 0] + Math.round(tint.r * shade), 0, 255)
                data[offset + 1] = clamp(data[offset + 1] + Math.round(tint.g * shade), 0, 255)
                data[offset + 2] = clamp(data[offset + 2] + Math.round(tint.b * shade), 0, 255)
                data[offset + 3] = 255 // Alpha always full
            }
        }
    }

    /**
     * Legacy rendering method (renders to fresh ImageData)
     */
    getImageData(tint) {
        const imageData = new ImageData(SIZE, SIZE)
        this.addRenderTo(imageData.data, tint)
        return imageData
    }

    /**
     * Reset both fields to zero (flat water).
     */
    reset() {
        this.h.fill(0)
        this.v.fill(0)
    }

    // ─── Parameter setters ──────────────────────────────────────────────────────

    setWaveK(val) { this.waveK = val }
    setWaveDamp(val) { this.waveDamp = val }
    setRenderGain(val) { this.renderGain = val }
    setDropStrength(val) { this.dropStrength = val }
    setDropRadius(val) { this.dropRadius = clamp(Math.round(val), 1, 5) }
    setDropBurst(val) { this.dropBurst = clamp(Math.round(val), 1, 8) }

    // ─── Parameter getters (for UI sync) ────────────────────────────────────────

    getWaveK() { return this.waveK }
    getWaveDamp() { return this.waveDamp }
    getRenderGain() { return this.renderGain }
    getDropStrength() { return this.dropStrength }
    getDropRadius() { return this.dropRadius }
    getDropBurst() { return this.dropBurst }
}
