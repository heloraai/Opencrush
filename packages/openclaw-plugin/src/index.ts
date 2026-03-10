/**
 * OpenClaw Plugin Bridge
 *
 * Connects Openlove to the OpenClaw desktop app.
 * OpenClaw is the host application; Openlove is the companion plugin.
 *
 * Communication:
 *   - HTTP REST  (port 34821) → OpenClaw calls into Openlove
 *   - WebSocket  (port 34821) → Openlove pushes real-time events to OpenClaw
 *
 * OpenClaw can:
 *   - Send chat messages to the companion
 *   - Query her current status / activity / mood
 *   - Trigger autonomous behaviors (listen to music, watch drama)
 *   - Subscribe to all events (proactive messages, mood changes, etc.)
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { ConversationEngine, ProactiveTrigger } from '@openlove/core'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Types ──────────────────────────────────────────────────────────────────

export interface OpenClawPluginConfig {
  engine: ConversationEngine
  port?: number
  host?: string
  /** Secret token OpenClaw must send as Bearer auth (optional but recommended) */
  authToken?: string
}

export interface OpenClawEvent {
  type: string
  payload: Record<string, unknown>
  timestamp: number
}

export interface ActivityState {
  currentActivity: 'idle' | 'listening_music' | 'watching_drama' | 'chatting' | 'thinking'
  currentTrack?: { title: string; artist: string; emotion?: string }
  currentShow?: { title: string; season: number; episode: number }
  mood?: string
  lastSeen?: number
}

// ── Plugin Server ──────────────────────────────────────────────────────────

export class OpenClawPlugin {
  private config: OpenClawPluginConfig
  private httpServer: Server
  private wss: WebSocketServer
  private clients: Set<WebSocket> = new Set()
  private activityState: ActivityState = { currentActivity: 'idle' }

  constructor(config: OpenClawPluginConfig) {
    this.config = config

    this.httpServer = createServer((req, res) => this.handleHTTP(req, res))
    this.wss = new WebSocketServer({ server: this.httpServer })

    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      console.log('[OpenClaw] Client connected')

      // Send current state immediately on connect
      this.send(ws, {
        type: 'companion:ready',
        payload: {
          name: this.config.engine.characterName,
          activity: this.activityState,
          manifest: this.getManifest(),
        },
        timestamp: Date.now(),
      })

      ws.on('close', () => {
        this.clients.delete(ws)
        console.log('[OpenClaw] Client disconnected')
      })

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          this.handleWSMessage(ws, msg)
        } catch {
          // ignore malformed messages
        }
      })
    })
  }

  // ── HTTP handler ──────────────────────────────────────────────────────────

  private async handleHTTP(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS for OpenClaw desktop app (Electron)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Auth check
    if (this.config.authToken) {
      const authHeader = req.headers.authorization ?? ''
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== this.config.authToken) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    res.setHeader('Content-Type', 'application/json')

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        // Health check + plugin info
        res.writeHead(200)
        res.end(JSON.stringify({
          plugin: 'openlove',
          name: this.config.engine.characterName,
          status: 'running',
          activity: this.activityState,
        }))

      } else if (req.method === 'GET' && url.pathname === '/manifest') {
        res.writeHead(200)
        res.end(JSON.stringify(this.getManifest()))

      } else if (req.method === 'GET' && url.pathname === '/status') {
        res.writeHead(200)
        res.end(JSON.stringify(this.activityState))

      } else if (req.method === 'POST' && url.pathname === '/chat') {
        const body = await readBody(req)
        const { content, userId = 'openclaw' } = JSON.parse(body)

        if (!content) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'content is required' }))
          return
        }

        this.setActivity('chatting')
        const response = await this.config.engine.respond({
          content,
          platform: 'openclaw',
          userId,
        })
        this.setActivity('idle')

        // Broadcast chat event to all WS clients
        this.broadcast({
          type: 'companion:message',
          payload: { response, incoming: content },
          timestamp: Date.now(),
        })

        res.writeHead(200)
        res.end(JSON.stringify(response))

      } else if (req.method === 'POST' && url.pathname === '/trigger') {
        // Trigger autonomous behavior manually
        const body = await readBody(req)
        const trigger: ProactiveTrigger = JSON.parse(body)

        if (!trigger.type) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'trigger.type is required' }))
          return
        }

        const response = await this.config.engine.generateProactiveMessage(trigger)

        this.broadcast({
          type: 'companion:proactive',
          payload: { trigger, response },
          timestamp: Date.now(),
        })

        res.writeHead(200)
        res.end(JSON.stringify(response))

      } else if (req.method === 'GET' && url.pathname === '/memory') {
        const query = url.searchParams.get('q') ?? ''
        const memory = this.config.engine.getMemory()
        const episodes = memory.getRecentEpisodes(10)
        const recent = memory.getRecentMessages(20)

        res.writeHead(200)
        res.end(JSON.stringify({ episodes, recent }))

      } else {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    } catch (err) {
      console.error('[OpenClaw] HTTP error:', err)
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'Internal error', message: (err as Error).message }))
    }
  }

  // ── WebSocket message handler ─────────────────────────────────────────────

  private async handleWSMessage(ws: WebSocket, msg: { type: string; payload?: Record<string, unknown> }): Promise<void> {
    switch (msg.type) {
      case 'chat': {
        const content = msg.payload?.content as string
        const userId = (msg.payload?.userId as string) ?? 'openclaw'
        if (!content) return

        try {
          this.setActivity('chatting')
          const response = await this.config.engine.respond({
            content,
            platform: 'openclaw',
            userId,
          })
          this.setActivity('idle')

          this.send(ws, {
            type: 'companion:message',
            payload: { response, incoming: content },
            timestamp: Date.now(),
          })
        } catch (err) {
          this.send(ws, {
            type: 'error',
            payload: { message: (err as Error).message },
            timestamp: Date.now(),
          })
        }
        break
      }

      case 'ping': {
        this.send(ws, {
          type: 'pong',
          payload: { name: this.config.engine.characterName },
          timestamp: Date.now(),
        })
        break
      }
    }
  }

  // ── Activity state management (called by scheduler/bridges) ───────────────

  setActivity(activity: ActivityState['currentActivity'], extra?: Partial<ActivityState>): void {
    this.activityState = {
      ...this.activityState,
      currentActivity: activity,
      ...extra,
    }

    this.broadcast({
      type: 'companion:activity',
      payload: this.activityState as unknown as Record<string, unknown>,
      timestamp: Date.now(),
    })
  }

  setMood(mood: string): void {
    this.activityState.mood = mood
    this.broadcast({
      type: 'companion:mood',
      payload: { mood },
      timestamp: Date.now(),
    })
  }

  /**
   * Called when she listens to music — updates OpenClaw's activity panel.
   */
  onMusicListened(track: { title: string; artist: string; emotion?: string }): void {
    this.setActivity('listening_music', { currentTrack: track })

    setTimeout(() => {
      // Return to idle after "listening" for a while
      this.setActivity('idle', { currentTrack: track })
    }, 30_000)
  }

  /**
   * Called when she watches an episode — updates OpenClaw's activity panel.
   */
  onDramaWatched(show: { title: string; season: number; episode: number }): void {
    this.setActivity('watching_drama', { currentShow: show })

    setTimeout(() => {
      this.setActivity('idle', { currentShow: show })
    }, 60_000)
  }

  /**
   * Push a proactive message to all connected OpenClaw clients.
   * Called when she sends a message from the autonomous scheduler.
   */
  pushProactiveMessage(trigger: ProactiveTrigger, response: { text: string }): void {
    this.broadcast({
      type: 'companion:proactive',
      payload: {
        trigger,
        response,
        activity: this.activityState,
      },
      timestamp: Date.now(),
    })
  }

  // ── Broadcast ─────────────────────────────────────────────────────────────

  broadcast(event: OpenClawEvent): void {
    const data = JSON.stringify(event)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    }
  }

  private send(ws: WebSocket, event: OpenClawEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event))
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const port = this.config.port ?? 34821
    const host = this.config.host ?? '127.0.0.1'

    await new Promise<void>((resolve, reject) => {
      this.httpServer.listen(port, host, () => {
        console.log(`[OpenClaw] Plugin server listening on ${host}:${port}`)
        console.log(`[OpenClaw] WebSocket ready for OpenClaw desktop app`)
        console.log(`[OpenClaw] HTTP API: http://${host}:${port}`)
        resolve()
      })
      this.httpServer.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    this.wss.close()
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()))
    console.log('[OpenClaw] Plugin server stopped')
  }

  private getManifest(): Record<string, unknown> {
    try {
      const manifestPath = join(__dirname, '..', 'manifest.json')
      return JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch {
      return { id: 'openlove', name: 'Openlove', version: '0.1.0' }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
