/**
 * Autonomous Behavior Scheduler
 *
 * Manages the character's "life" — when she listens to music,
 * watches dramas, and proactively reaches out to the user.
 *
 * All timings respect quiet hours (don't disturb while user sleeps).
 * Runs as a set of cron jobs alongside the main bridge process.
 */

import * as cron from 'node-cron'
import { ConversationEngine, ProactiveTrigger } from '@openlove/core'
import { MusicEngine } from './music.js'
import { DramaEngine } from './drama.js'

export interface ActivityEvent {
  type: 'music' | 'drama'
  music?: { title: string; artist: string; emotion?: string }
  drama?: { title: string; season: number; episode: number }
}

export interface SchedulerConfig {
  engine: ConversationEngine
  music: MusicEngine
  drama: DramaEngine
  quietHoursStart?: number  // 0-23, default 23
  quietHoursEnd?: number    // 0-23, default 8
  minIntervalMinutes?: number  // minimum gap between proactive messages
  maxIntervalMinutes?: number
  // Callback to actually send the message via the active bridge(s)
  onProactiveMessage: (trigger: ProactiveTrigger) => Promise<void>
  // Optional callback for OpenClaw to receive activity updates
  onActivityUpdate?: (event: ActivityEvent) => void
}

export class AutonomousScheduler {
  private config: SchedulerConfig
  private lastProactiveMessage: number = 0
  private jobs: cron.ScheduledTask[] = []

  constructor(config: SchedulerConfig) {
    this.config = config
  }

  start(): void {
    console.log('[Autonomous] Scheduler starting...')

    // Morning greeting — 8:30 AM
    this.jobs.push(
      cron.schedule('30 8 * * *', () => this.morningGreeting())
    )

    // Music listening — twice a day (lunch & evening)
    this.jobs.push(
      cron.schedule('0 12 * * *', () => this.listenToMusic())
    )
    this.jobs.push(
      cron.schedule('0 20 * * *', () => this.listenToMusic())
    )

    // Drama watching — evening (9 PM)
    this.jobs.push(
      cron.schedule('0 21 * * *', () => this.watchDrama())
    )

    // Random thoughts throughout the day — every 2 hours during active hours
    this.jobs.push(
      cron.schedule('0 */2 9-22 * * *', () => this.maybeRandomThought())
    )

    // Check if she should reach out (if been too long since last contact)
    this.jobs.push(
      cron.schedule('*/30 * * * *', () => this.checkMissingUser())
    )

    console.log('[Autonomous] Scheduler started. She has a life now ✨')
  }

  stop(): void {
    for (const job of this.jobs) {
      job.stop()
    }
    this.jobs = []
    console.log('[Autonomous] Scheduler stopped')
  }

  private isQuietHours(): boolean {
    const hour = new Date().getHours()
    const start = this.config.quietHoursStart ?? 23
    const end = this.config.quietHoursEnd ?? 8

    if (start > end) {
      // E.g., quiet from 23 to 8 (overnight)
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

      // Log to memory
      await this.config.engine.getMemory().logEpisode({
        type: 'music',
        title: `Listened to "${track.track}" by ${track.artist}`,
        description: `Feeling ${track.emotion ?? 'something'} after this one.`,
        metadata: { track: track.track, artist: track.artist },
        timestamp: Date.now(),
      })

      // Notify OpenClaw about the activity
      this.config.onActivityUpdate?.({
        type: 'music',
        music: { title: track.track, artist: track.artist, emotion: track.emotion },
      })

      // 60% chance she shares it with you
      if (Math.random() < 0.6) {
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

      // Notify OpenClaw about the activity
      this.config.onActivityUpdate?.({
        type: 'drama',
        drama: { title: episode.showName, season: episode.season, episode: episode.episode },
      })

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

      // 70% chance she reaches out to talk about it
      if (Math.random() < 0.7) {
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

  private async maybeRandomThought(): Promise<void> {
    // Only about 20% chance each check — keeps it from being too frequent
    if (Math.random() > 0.2) return
    await this.sendIfAppropriate({ type: 'random_thought' })
  }

  private async checkMissingUser(): Promise<void> {
    const maxGapMs = (this.config.maxIntervalMinutes ?? 240) * 60 * 1000
    const timeSinceLastMessage = Date.now() - this.lastProactiveMessage

    if (timeSinceLastMessage > maxGapMs && !this.isQuietHours()) {
      await this.sendIfAppropriate({ type: 'missing_you' })
    }
  }
}
