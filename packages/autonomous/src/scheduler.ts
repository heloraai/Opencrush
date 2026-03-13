/**
 * Autonomous Behavior Scheduler
 *
 * Manages the character's "life" — when she listens to music,
 * watches dramas, browses the web, and proactively reaches out.
 *
 * Uses a daily routine system with randomized intervals to simulate
 * natural human-like behavior. Activities update Discord Rich Presence
 * in real time and can optionally open real browser windows via Playwright.
 *
 * All timings respect quiet hours (don't disturb while user sleeps).
 */

import * as cron from 'node-cron'
import { ConversationEngine, ProactiveTrigger } from '@openlove/core'
import { MusicEngine } from './music.js'
import { DramaEngine } from './drama.js'
import { ActivityManager } from './activities.js'
import { BrowserAgent } from './browser.js'

export interface SchedulerConfig {
  engine: ConversationEngine
  music: MusicEngine
  drama: DramaEngine
  activityManager: ActivityManager
  browserAgent?: BrowserAgent
  quietHoursStart?: number  // 0-23, default 23
  quietHoursEnd?: number    // 0-23, default 8
  minIntervalMinutes?: number  // minimum gap between proactive messages
  maxIntervalMinutes?: number
  // Callback to actually send the message via the active bridge(s)
  onProactiveMessage: (trigger: ProactiveTrigger) => Promise<void>
}

export class AutonomousScheduler {
  private config: SchedulerConfig
  private lastProactiveMessage: number = 0
  private jobs: cron.ScheduledTask[] = []
  private activityLoopTimer?: NodeJS.Timeout
  private running = false

  constructor(config: SchedulerConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    console.log('[Autonomous] Scheduler starting...')
    this.running = true

    // Launch browser if available
    if (this.config.browserAgent) {
      const launched = await this.config.browserAgent.launch()
      if (launched) {
        console.log('[Autonomous] Browser agent ready — real browser automation enabled')
      } else {
        console.log('[Autonomous] Browser agent unavailable — presence-only mode')
      }
    }

    // Morning greeting — 8:30 AM
    this.jobs.push(
      cron.schedule('30 8 * * *', () => this.morningGreeting())
    )

    // Random thoughts throughout the day — every 2 hours during active hours
    this.jobs.push(
      cron.schedule('0 */2 9-22 * * *', () => this.maybeRandomThought())
    )

    // Check if she should reach out (if been too long since last contact)
    this.jobs.push(
      cron.schedule('*/30 * * * *', () => this.checkMissingUser())
    )

    // Start the autonomous activity loop — picks activities based on daily routine
    this.startActivityLoop()

    console.log('[Autonomous] Scheduler started. She has a life now ✨')
  }

  async stop(): Promise<void> {
    this.running = false

    for (const job of this.jobs) {
      job.stop()
    }
    this.jobs = []

    if (this.activityLoopTimer) {
      clearTimeout(this.activityLoopTimer)
      this.activityLoopTimer = undefined
    }

    // Close browser
    if (this.config.browserAgent) {
      await this.config.browserAgent.close()
    }

    console.log('[Autonomous] Scheduler stopped')
  }

  // ── Autonomous Activity Loop ─────────────────────────────────────────

  /**
   * Continuously pick and execute activities based on the daily routine.
   * Uses randomized intervals (20-60 min) between activities to feel natural.
   */
  private startActivityLoop(): void {
    if (!this.running) return

    const doNext = async () => {
      if (!this.running) return
      if (this.isQuietHours()) {
        // During quiet hours, just idle and check again in 30 min
        this.scheduleNextActivity(30 * 60 * 1000)
        return
      }

      await this.performRoutineActivity()

      // Random interval until next activity: 20-60 minutes
      const minMs = 20 * 60 * 1000
      const maxMs = 60 * 60 * 1000
      const nextInterval = minMs + Math.random() * (maxMs - minMs)
      this.scheduleNextActivity(nextInterval)
    }

    // First activity after a short delay (2-5 min after boot)
    const bootDelay = (2 + Math.random() * 3) * 60 * 1000
    this.activityLoopTimer = setTimeout(doNext, bootDelay)
  }

  private scheduleNextActivity(delayMs: number): void {
    if (!this.running) return
    this.activityLoopTimer = setTimeout(() => {
      if (!this.running) return
      this.startActivityLoop()
    }, delayMs)
  }

  /**
   * Pick and execute an activity based on the current time slot in the daily routine.
   */
  private async performRoutineActivity(): Promise<void> {
    const activityType = this.config.activityManager.pickNextActivityType()
    if (!activityType) return

    try {
      switch (activityType) {
        case 'music':
          await this.listenToMusic()
          break
        case 'drama':
          await this.watchDrama()
          break
        case 'youtube':
          await this.browseYouTube()
          break
        case 'browse':
          await this.browseRandom()
          break
        default:
          console.log(`[Autonomous] Unknown activity type: ${activityType}`)
      }
    } catch (err) {
      console.error(`[Autonomous] Activity error (${activityType}):`, err)
    }
  }

  // ── Individual Activities ────────────────────────────────────────────

  private isQuietHours(): boolean {
    const hour = new Date().getHours()
    const start = this.config.quietHoursStart ?? 23
    const end = this.config.quietHoursEnd ?? 8

    if (start > end) {
      return hour >= start || hour < end
    }
    return hour >= start && hour < end
  }

  private hasRecentlySentMessage(): boolean {
    const minGapMs = (this.config.minIntervalMinutes ?? 60) * 60 * 1000
    return Date.now() - this.lastProactiveMessage < minGapMs
  }

  private async sendIfAppropriate(trigger: ProactiveTrigger): Promise<void> {
    if (this.isQuietHours()) {
      console.log(`[Autonomous] Quiet hours — skipping ${trigger.type}`)
      return
    }
    if (this.hasRecentlySentMessage()) {
      console.log(`[Autonomous] Too soon since last message — skipping ${trigger.type}`)
      return
    }

    try {
      await this.config.onProactiveMessage(trigger)
      this.lastProactiveMessage = Date.now()
      console.log(`[Autonomous] Sent proactive message: ${trigger.type}`)
    } catch (err) {
      console.error(`[Autonomous] Failed to send ${trigger.type}:`, err)
    }
  }

  private async morningGreeting(): Promise<void> {
    await this.sendIfAppropriate({ type: 'morning' })
  }

  private async listenToMusic(): Promise<void> {
    try {
      const track = await this.config.music.listenToSomething()

      // Randomized duration: 2-5 minutes
      const durationMs = (2 + Math.random() * 3) * 60 * 1000

      this.config.activityManager.startActivity(
        {
          type: 'listening',
          track: track.track,
          artist: track.artist,
          album: track.album,
        },
        durationMs
      )

      // Open Spotify in real browser if available
      if (this.config.browserAgent?.isAvailable()) {
        await this.config.browserAgent.listenToSpotify(`${track.track} ${track.artist}`)
      }

      // Log to memory
      await this.config.engine.getMemory().logEpisode({
        type: 'music',
        title: `Listened to "${track.track}" by ${track.artist}`,
        description: `Feeling ${track.emotion ?? 'something'} after this one.`,
        metadata: { track: track.track, artist: track.artist },
        timestamp: Date.now(),
      })

      // 40% chance she shares it with you
      if (Math.random() < 0.4) {
        await this.sendIfAppropriate({
          type: 'music',
          data: { track: track.track, artist: track.artist },
        })
      }
    } catch (err) {
      console.error('[Autonomous] Music listen error:', err)
    }
  }

  private async watchDrama(): Promise<void> {
    try {
      const episode = await this.config.drama.watchNextEpisode()

      // Randomized duration: 20-40 minutes
      const durationMs = (20 + Math.random() * 20) * 60 * 1000

      this.config.activityManager.startActivity(
        {
          type: 'watching',
          title: episode.showName,
          details: `S${episode.season}E${episode.episode}`,
        },
        durationMs
      )

      // Open YouTube to "watch" in real browser if available
      if (this.config.browserAgent?.isAvailable()) {
        await this.config.browserAgent.watchYouTube(
          `${episode.showName} season ${episode.season} episode ${episode.episode}`
        )
      }

      // Log to memory
      await this.config.engine.getMemory().logEpisode({
        type: 'drama',
        title: `Watched ${episode.showName} S${episode.season}E${episode.episode}`,
        description: episode.episodeTitle
          ? `"${episode.episodeTitle}" — ${episode.summary ?? 'watched an episode'}`
          : `Watched episode ${episode.episode}`,
        metadata: {
          show: episode.showName,
          episode: String(episode.episode),
          season: String(episode.season),
        },
        timestamp: Date.now(),
      })

      // 50% chance she reaches out to talk about it
      if (Math.random() < 0.5) {
        await this.sendIfAppropriate({
          type: 'drama',
          data: {
            show: episode.showName,
            episode: String(episode.episode),
            episodeTitle: episode.episodeTitle ?? '',
          },
        })
      }
    } catch (err) {
      console.error('[Autonomous] Drama watch error:', err)
    }
  }

  private async browseYouTube(): Promise<void> {
    if (this.isQuietHours()) return

    const topics = [
      'cute cat videos', 'cooking recipes', 'music videos',
      'fashion haul', 'travel vlog', 'study with me',
      'asmr', 'makeup tutorial', 'room tour', 'day in my life vlog',
      'aesthetic cafe vlog', 'k-drama highlights', 'anime openings',
    ]
    const topic = topics[Math.floor(Math.random() * topics.length)]

    // Randomized duration: 5-15 minutes
    const durationMs = (5 + Math.random() * 10) * 60 * 1000

    this.config.activityManager.startActivity(
      { type: 'browsing', title: `YouTube: ${topic}` },
      durationMs
    )

    if (this.config.browserAgent?.isAvailable()) {
      await this.config.browserAgent.watchYouTube(topic)
    }

    await this.config.engine.getMemory().logEpisode({
      type: 'event',
      title: `Watched YouTube videos about ${topic}`,
      description: `Found some interesting ${topic} content on YouTube.`,
      timestamp: Date.now(),
    })

    console.log(`[Autonomous] Browsing YouTube: ${topic}`)
  }

  private async browseRandom(): Promise<void> {
    if (this.isQuietHours()) return

    const activities = [
      { title: 'scrolling Twitter', label: 'Twitter' },
      { title: 'reading articles', label: 'the news' },
      { title: 'shopping online', label: 'online shopping' },
      { title: 'scrolling Pinterest', label: 'Pinterest' },
      { title: 'reading Reddit', label: 'Reddit' },
      { title: 'looking at memes', label: 'memes' },
    ]
    const activity = activities[Math.floor(Math.random() * activities.length)]

    // Randomized duration: 5-12 minutes
    const durationMs = (5 + Math.random() * 7) * 60 * 1000

    this.config.activityManager.startActivity(
      { type: 'browsing', title: activity.title },
      durationMs
    )

    if (this.config.browserAgent?.isAvailable()) {
      await this.config.browserAgent.browseRandom()
    }

    await this.config.engine.getMemory().logEpisode({
      type: 'event',
      title: `Was ${activity.title}`,
      description: `Spent some time ${activity.title}.`,
      timestamp: Date.now(),
    })

    console.log(`[Autonomous] ${activity.title}`)
  }

  private async maybeRandomThought(): Promise<void> {
    if (Math.random() > 0.1) return  // 10% chance (was 20%)

    // Inject recent activity context so the LLM knows what she's been doing
    const recentActivity = this.config.activityManager.getRecentActivitySummary()

    await this.sendIfAppropriate({
      type: 'random_thought',
      data: { recentActivity },
    })
  }

  private async checkMissingUser(): Promise<void> {
    const maxGapMs = (this.config.maxIntervalMinutes ?? 240) * 60 * 1000
    const timeSinceLastMessage = Date.now() - this.lastProactiveMessage

    if (timeSinceLastMessage > maxGapMs && !this.isQuietHours()) {
      await this.sendIfAppropriate({ type: 'missing_you' })
    }
  }
}
