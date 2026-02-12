/**
 * MissingDrop — WSS Bridge Server
 *
 * Bridges smartphones (MediaPipe hand tracking + water sim) with LED matrices.
 * Supports 2 independent pairs, each binding one phone and one matrix.
 *
 * Protocol:
 *   1. Client connects via WebSocket at /ws
 *   2. Client sends JSON: { "type": "join", "role": "phone"|"matrix", "pair": 1|2 }
 *   3. Phone sends binary frames (RGB565) → server forwards to paired matrix
 *   4. Server sends JSON status updates back to clients
 */

const path = require('path')
const express = require('express')
const http = require('http')
const { WebSocketServer } = require('ws')

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
const HEARTBEAT_INTERVAL = 30_000 // 30s ping interval
const VALID_PAIRS = [1, 2]
const VALID_ROLES = ['phone', 'matrix']

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express()

// Serve the smartphone web client
const clientPath = path.join(__dirname, '..', 'client-web')
app.use(express.static(clientPath))

// Health check endpoint (useful for Render)
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', pairs: getPairsStatus() })
})

// ─── HTTP + WebSocket Server ─────────────────────────────────────────────────

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

// ─── Pair State ──────────────────────────────────────────────────────────────

/**
 * pairs[pairId] = { phone: WebSocket | null, matrix: WebSocket | null }
 */
const pairs = {
    1: { phone: null, matrix: null },
    2: { phone: null, matrix: null }
}

/** Return a summary of pair connection status. */
function getPairsStatus() {
    const status = {}
    for (const id of VALID_PAIRS) {
        status[id] = {
            phone: pairs[id].phone !== null,
            matrix: pairs[id].matrix !== null
        }
    }
    return status
}

/** Send a JSON message to a WebSocket client. */
function sendJSON(ws, data) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(data))
    }
}

/** Notify both members of a pair about the current connection status. */
function notifyPairStatus(pairId) {
    const pair = pairs[pairId]
    const status = {
        type: 'status',
        pair: pairId,
        phone: pair.phone !== null,
        matrix: pair.matrix !== null
    }
    sendJSON(pair.phone, status)
    sendJSON(pair.matrix, status)
}

// ─── WebSocket Connection Handler ────────────────────────────────────────────

wss.on('connection', (ws) => {
    let clientRole = null
    let clientPair = null

    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', (data, isBinary) => {
        // ── Binary data: forward from phone → matrix ──
        if (isBinary) {
            if (clientRole === 'phone' && clientPair) {
                const target = pairs[clientPair].matrix
                if (target && target.readyState === 1) {
                    target.send(data, { binary: true })
                }
            }
            return
        }

        // ── JSON messages ──
        let msg
        try {
            msg = JSON.parse(data.toString())
        } catch {
            sendJSON(ws, { type: 'error', message: 'Invalid JSON' })
            return
        }

        if (msg.type === 'drop') {
            // Broadcast drop to the OTHER pair's phone
            // We want drop to appear on BOTH pairs.
            // If Pair 1 sends drop, we send it to Pair 2's phone (and optionally back to Pair 1 if client doesn't do it locally, but client does it locally).
            // Actually, requirements say "drop to be apply to the 2 pair".
            
            // Let's broadcast to ALL connected 'phone' clients in valid pairs, EXCEPT the sender (since sender does it locally).
            // Or simpler: just broadcast to the OTHER pair.
            
            // Logic: if I am Pair 1, send to Pair 2. If I am Pair 2, send to Pair 1.
            const targetPairId = clientPair === 1 ? 2 : 1
            const targetPhone = pairs[targetPairId].phone
            
            if (targetPhone && targetPhone.readyState === 1) {
                // Forward the drop message
                sendJSON(targetPhone, msg)
            }
            return
        }

        if (msg.type === 'join') {
            const { role, pair } = msg

            // Validate
            if (!VALID_ROLES.includes(role)) {
                sendJSON(ws, { type: 'error', message: `Invalid role: ${role}` })
                return
            }
            if (!VALID_PAIRS.includes(pair)) {
                sendJSON(ws, { type: 'error', message: `Invalid pair: ${pair}` })
                return
            }

            // Check if slot is already taken
            if (pairs[pair][role] && pairs[pair][role] !== ws) {
                // Kick the previous occupant
                sendJSON(pairs[pair][role], { type: 'kicked', reason: 'Replaced by new connection' })
                pairs[pair][role].close()
            }

            // Remove from previous slot if re-joining
            if (clientPair && clientRole) {
                if (pairs[clientPair][clientRole] === ws) {
                    pairs[clientPair][clientRole] = null
                    notifyPairStatus(clientPair)
                }
            }

            // Register
            clientRole = role
            clientPair = pair
            pairs[pair][role] = ws

            console.log(`[Pair ${pair}] ${role} joined`)

            sendJSON(ws, { type: 'joined', role, pair })
            notifyPairStatus(pair)
        }
    })

    ws.on('close', () => {
        if (clientPair && clientRole) {
            if (pairs[clientPair][clientRole] === ws) {
                pairs[clientPair][clientRole] = null
                console.log(`[Pair ${clientPair}] ${clientRole} disconnected`)
                notifyPairStatus(clientPair)
            }
        }
    })

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message)
    })
})

// ─── Heartbeat ───────────────────────────────────────────────────────────────

const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            ws.terminate()
            return
        }
        ws.isAlive = false
        ws.ping()
    })
}, HEARTBEAT_INTERVAL)

wss.on('close', () => {
    clearInterval(heartbeat)
})

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`MissingDrop server listening on port ${PORT}`)
    console.log(`  → Web client: http://localhost:${PORT}`)
    console.log(`  → WebSocket:  ws://localhost:${PORT}/ws`)
})
