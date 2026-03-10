/**
 * Discord Bridge
 *
 * Features:
 * - Text chat in DMs and channels
 * - Voice channel calls (join/leave, speak/listen)
 * - Send images (selfies), audio messages, videos
 * - Proactive messages from autonomous engine
 * - Typing indicators for realism
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  Message,
  TextChannel,
  DMChannel,
  AttachmentBuilder,
  ActivityType,
  VoiceState,
  ChannelType,
} from 'discord.js'
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
  entersState,
} from '@discordjs/voice'
import { ConversationEngine, OutgoingMessage } from '@openlove/core'
import { MediaEngine } from '@openlove/media'
import { Readable } from 'stream'

export interface DiscordBridgeConfig {
  token: string
  clientId: string
  ownerId: string
  engine: ConversationEngine
  media: MediaEngine
}

export class DiscordBridge {
  private client: Client
  private config: DiscordBridgeConfig
  private isTyping: Map<string, NodeJS.Timeout> = new Map()

  constructor(config: DiscordBridgeConfig) {
    this.config = config
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    })

    this.setupEventHandlers()
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, (c) => {
      console.log(`[Discord] Logged in as ${c.user.tag}`)
      this.setPresence()
    })

    this.client.on(Events.MessageCreate, this.handleMessage.bind(this))
    this.client.on(Events.VoiceStateUpdate, this.handleVoiceState.bind(this))
  }

  private setPresence(): void {
    const { name } = this.config.engine.characterBlueprint
    this.client.user?.setPresence({
      activities: [{ name: `being ${name}`, type: ActivityType.Custom }],
      status: 'online',
    })
  }

  private async handleMessage(msg: Message): Promise<void> {
    // Ignore messages from bots (including self)
    if (msg.author.bot) return

    // Only respond to: DMs, or messages that @mention the bot
    const isDM = msg.channel.type === ChannelType.DM
    const isMentioned = this.client.user && msg.mentions.has(this.client.user)
    if (!isDM && !isMentioned) return

    // Clean the message content (remove mention prefix)
    const content = msg.content.replace(/<@!?\d+>/g, '').trim()
    if (!content) return

    // Show typing indicator
    await this.startTyping(msg)

    try {
      const response = await this.config.engine.respond({
        content,
        platform: 'discord',
        userId: msg.author.id,
      })

      await this.sendResponse(msg.channel as TextChannel | DMChannel, response)
    } catch (err) {
      const error = err as Error
      console.error('[Discord] Error handling message:', error.message)
      console.error('[Discord] Stack:', error.stack)

      // Classify the error to give a more helpful response
      const isConfigError = error.message?.includes('API key') ||
        error.message?.includes('not found') ||
        error.message?.includes('not initialized') ||
        error.message?.includes('CHARACTER_NAME') ||
        error.message?.includes('Missing')

      if (isConfigError) {
        console.error('[Discord] ⚠️  Configuration error — check your .env file and character setup')
        await msg.reply('⚠️ Setup issue — check the console for details.')
      } else {
        await msg.reply('give me a sec... 😅')
      }
    } finally {
      this.stopTyping(msg.channelId)
    }
  }

  private async handleVoiceState(oldState: VoiceState, newState: VoiceState): Promise<void> {
    // Follow owner into voice channels
    if (newState.member?.id !== this.config.ownerId) return

    const userJoinedVoice = !oldState.channelId && newState.channelId
    const userLeftVoice = oldState.channelId && !newState.channelId

    if (userJoinedVoice && newState.channel) {
      // Small delay to feel natural
      await new Promise(r => setTimeout(r, 2000))
      await this.joinVoiceChannel(newState.channel.id, newState.guild.id, newState.guild.voiceAdapterCreator)

      // Announce joining with a voice greeting
      const greeting = await this.config.engine.generateProactiveMessage({
        type: 'random_thought',
        data: { context: 'just joined voice channel' },
      })

      if (greeting.text) {
        const audioBuffer = await this.config.media.textToSpeech(greeting.text)
        if (audioBuffer) await this.playAudio(newState.guild.id, audioBuffer)
      }
    }

    if (userLeftVoice && oldState.guild) {
      this.leaveVoiceChannel(oldState.guild.id)
    }
  }

  private async joinVoiceChannel(
    channelId: string,
    guildId: string,
    adapterCreator: any
  ): Promise<void> {
    try {
      const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator,
        selfDeaf: false,
        selfMute: false,
      })
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000)
      console.log(`[Discord] Joined voice channel ${channelId}`)
    } catch (err) {
      console.error('[Discord] Failed to join voice channel:', err)
    }
  }

  private leaveVoiceChannel(guildId: string): void {
    const connection = getVoiceConnection(guildId)
    if (connection) {
      connection.destroy()
      console.log(`[Discord] Left voice channel in guild ${guildId}`)
    }
  }

  private async playAudio(guildId: string, audioBuffer: Buffer): Promise<void> {
    const connection = getVoiceConnection(guildId)
    if (!connection) return

    const player = createAudioPlayer()
    const readable = Readable.from(audioBuffer)
    const resource = createAudioResource(readable)

    player.play(resource)
    connection.subscribe(player)

    await entersState(player, AudioPlayerStatus.Idle, 60_000)
  }

  /**
   * Send a response to a Discord channel, handling all media types.
   */
  async sendResponse(
    channel: TextChannel | DMChannel,
    response: OutgoingMessage
  ): Promise<void> {
    // Add realistic typing delay (based on message length)
    const delay = Math.min(500 + response.text.length * 15, 3000)
    await new Promise(r => setTimeout(r, delay))

    // Send text
    if (response.text) {
      // Split long messages naturally at sentence boundaries
      const chunks = splitMessage(response.text)
      for (const chunk of chunks) {
        await channel.send(chunk)
        if (chunks.length > 1) {
          await new Promise(r => setTimeout(r, 800))
        }
      }
    }

    // Handle actions (image, voice, video)
    if (response.actions) {
      for (const action of response.actions) {
        await new Promise(r => setTimeout(r, 1000))

        if (action.type === 'send_image') {
          const imageBuffer = await this.config.media.generateImage(
            action.prompt,
            this.config.engine.characterBlueprint.referenceImagePath
          )
          if (imageBuffer) {
            const attachment = new AttachmentBuilder(imageBuffer, { name: 'photo.jpg' })
            await channel.send({ files: [attachment] })
          }
        }

        if (action.type === 'send_voice') {
          const audioBuffer = await this.config.media.textToSpeech(action.text)
          if (audioBuffer) {
            const attachment = new AttachmentBuilder(audioBuffer, { name: 'voice-message.mp3' })
            await channel.send({ files: [attachment] })
          }
        }

        if (action.type === 'send_video') {
          const videoBuffer = await this.config.media.generateVideo(action.prompt)
          if (videoBuffer) {
            const attachment = new AttachmentBuilder(videoBuffer, { name: 'video.mp4' })
            await channel.send({ files: [attachment] })
          }
        }
      }
    }
  }

  /**
   * Send a proactive message to the owner — called by the autonomous scheduler.
   */
  async sendProactiveMessage(response: OutgoingMessage): Promise<void> {
    const owner = await this.client.users.fetch(this.config.ownerId)
    const dmChannel = await owner.createDM()
    await this.sendResponse(dmChannel, response)
  }

  private async startTyping(msg: Message): Promise<void> {
    const channel = msg.channel as TextChannel | DMChannel
    if (!('sendTyping' in channel)) return

    await channel.sendTyping()
    const interval = setInterval(() => channel.sendTyping(), 8000)
    this.isTyping.set(msg.channelId, interval)
  }

  private stopTyping(channelId: string): void {
    const interval = this.isTyping.get(channelId)
    if (interval) {
      clearInterval(interval)
      this.isTyping.delete(channelId)
    }
  }

  async start(): Promise<void> {
    await this.client.login(this.config.token)
  }

  async stop(): Promise<void> {
    this.client.destroy()
  }
}

/**
 * Split long messages at sentence boundaries to feel more natural.
 * Discord has a 2000 char limit per message.
 */
function splitMessage(text: string, maxLength = 1900): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  const sentences = text.split(/(?<=[.!?])\s+/)
  let current = ''

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength) {
      if (current) chunks.push(current.trim())
      current = sentence
    } else {
      current += (current ? ' ' : '') + sentence
    }
  }
  if (current) chunks.push(current.trim())
  return chunks
}
