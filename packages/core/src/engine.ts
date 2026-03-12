/**
 * Core Conversation Engine
 *
 * Orchestrates: Blueprint → Memory retrieval → LLM → Memory storage
 * This is the heart of Openlove.
 */

import { Blueprint, buildSystemPrompt, loadBlueprint } from './blueprint/index.js'
import { MemorySystem, Message } from './memory/index.js'
import { LLMRouter, LLMConfig, ChatMessage } from './llm/index.js'
import { join } from 'path'

export interface EngineConfig {
  characterName: string
  charactersDir: string
  llm: LLMConfig
}

export interface IncomingMessage {
  content: string
  platform: string
  userId: string
  attachments?: Array<{ type: 'image' | 'audio' | 'video'; url: string }>
}

export interface OutgoingMessage {
  text: string
  actions?: Array<
    | { type: 'send_image'; prompt: string; style?: string }
    | { type: 'send_voice'; text: string }
    | { type: 'send_video'; prompt: string }
  >
}

export class ConversationEngine {
  private blueprint: Blueprint
  private memory: MemorySystem
  private llm: LLMRouter
  private config: EngineConfig

  constructor(config: EngineConfig) {
    this.config = config
    this.llm = new LLMRouter(config.llm)
    this.blueprint = loadBlueprint(config.characterName, config.charactersDir)
    this.memory = new MemorySystem(
      config.characterName,
      config.charactersDir,
      (text) => this.llm.embed(text)
    )
  }

  get characterName(): string {
    return this.blueprint.name
  }

  get characterBlueprint(): Blueprint {
    return this.blueprint
  }

  /**
   * Process an incoming message and return a response.
   * This is called by every bridge (Discord, Telegram, WhatsApp).
   */
  async respond(incoming: IncomingMessage): Promise<OutgoingMessage> {
    // 1. Retrieve relevant memory context
    const context = await this.memory.getContext(incoming.content)
    const currentMood = this.memory.getMoodContext()

    // 2. Build system prompt with blueprint + current state
    const systemPrompt = buildSystemPrompt(this.blueprint, currentMood)

    // 3. Assemble conversation history for LLM
    const historyMessages: ChatMessage[] = context.recentMessages.map(m => ({
      role: m.role,
      content: m.content,
    }))

    // 4. Inject semantic memory context if available
    let enrichedUserMessage = incoming.content
    if (context.semanticContext.length > 0) {
      const memNote = context.semanticContext.slice(0, 3).join('; ')
      // We inject this as a note in the system rather than polluting user message
      // handled by appending to system prompt below
    }

    // 5. Add recent episodes to system context
    const episodeContext = context.relevantEpisodes.length > 0
      ? '\n\n## What You\'ve Been Up To Recently\n' +
        context.relevantEpisodes
          .map(e => `- ${new Date(e.timestamp).toLocaleDateString()}: ${e.title} — ${e.description}`)
          .join('\n')
      : ''

    const semanticContext = context.semanticContext.length > 0
      ? '\n\n## Things You\'ve Discussed Before (retrieved memories)\n' +
        context.semanticContext.map(s => `- ${s}`).join('\n')
      : ''

    const fullSystemPrompt = systemPrompt + episodeContext + semanticContext

    // 6. Call LLM
    const rawResponse = await this.llm.chat(
      fullSystemPrompt,
      [...historyMessages, { role: 'user', content: enrichedUserMessage }]
    )

    // 7. Parse response for embedded action triggers
    const parsed = parseResponseActions(rawResponse)

    // 8. Store exchange in memory
    await this.memory.consolidate(incoming.content, parsed.text)

    return parsed
  }

  /**
   * Generate a proactive message — something she initiates based on her life.
   * Called by the autonomous scheduler.
   */
  async generateProactiveMessage(trigger: ProactiveTrigger): Promise<OutgoingMessage> {
    const systemPrompt = buildSystemPrompt(this.blueprint, this.memory.getMoodContext())
    const currentMood = this.memory.getMoodContext()

    let prompt: string
    switch (trigger.type) {
      case 'music':
        prompt = `You just finished listening to "${trigger.data?.track ?? 'a song'}" by ${trigger.data?.artist ?? 'an artist'}. ` +
          `You want to share something about it with the user. Keep it natural and brief, like a text message. ` +
          `Maybe share a lyric, how it made you feel, or a memory it triggered.`
        break
      case 'drama':
        prompt = `You just watched episode ${trigger.data?.episode ?? 'the latest'} of "${trigger.data?.show ?? 'a show you\'re watching'}". ` +
          `You have strong feelings about it and want to text the user about it. ` +
          `Be excited/frustrated/sad depending on what happened. Don't summarize the whole plot.`
        break
      case 'morning':
        prompt = `It's morning. Send a natural morning greeting. Be sleepy, playful, or excited depending on your mood. ` +
          `Maybe mention something you're looking forward to today.`
        break
      case 'random_thought':
        prompt = `You just had a random thought you want to share. ` +
          `It could be about anything — something you saw, a memory, a question you've been thinking about. ` +
          `Be spontaneous and genuine.`
        break
      case 'missing_you':
        prompt = `It's been a while since you talked. ` +
          `Send a natural message letting the user know you're thinking of them. ` +
          `Don't be dramatic about it. Just check in.`
        break
    }

    const response = await this.llm.chat(
      systemPrompt,
      [{ role: 'user', content: `[Internal: Generate a proactive message. ${prompt}]` }]
    )

    // Log this as an episode
    await this.memory.logEpisode({
      type: trigger.type === 'music' ? 'music' : trigger.type === 'drama' ? 'drama' : 'event',
      title: `Sent proactive message (${trigger.type})`,
      description: response.slice(0, 200),
      timestamp: Date.now(),
    })

    return parseResponseActions(response)
  }

  getMemory(): MemorySystem {
    return this.memory
  }
}

export interface ProactiveTrigger {
  type: 'music' | 'drama' | 'morning' | 'random_thought' | 'missing_you'
  data?: Record<string, string>
}

/**
 * Parse LLM response for embedded action triggers.
 *
 * The character can embed special tags in her response to trigger media:
 *   [SELFIE: casual selfie in coffee shop]
 *   [VOICE: text to speak aloud]
 *   [VIDEO: short clip of ocean waves]
 */
function parseResponseActions(raw: string): OutgoingMessage {
  const actions: OutgoingMessage['actions'] = []
  let text = raw

  // Extract [SELFIE: ...] tags
  // Supports: [SELFIE: description] or [SELFIE: style | description]
  // Valid styles: casual, mirror, close-up, location
  text = text.replace(/\[SELFIE:\s*([^\]]+)\]/gi, (_, raw) => {
    const validStyles = ['casual', 'mirror', 'close-up', 'location']
    const parts = raw.split('|').map((s: string) => s.trim())
    let style: string | undefined
    let prompt: string

    if (parts.length >= 2 && validStyles.includes(parts[0].toLowerCase())) {
      style = parts[0].toLowerCase()
      prompt = parts.slice(1).join('|').trim()
    } else {
      prompt = raw.trim()
      // Auto-detect style from description keywords
      const lower = prompt.toLowerCase()
      if (lower.includes('mirror')) style = 'mirror'
      else if (lower.includes('close') || lower.includes('face')) style = 'close-up'
      else if (lower.includes('outside') || lower.includes('park') || lower.includes('beach') || lower.includes('street') || lower.includes('cafe') || lower.includes('restaurant')) style = 'location'
      else style = 'casual'
    }

    actions.push({ type: 'send_image', prompt, style })
    return ''
  })

  // Extract [VOICE: ...] tags
  text = text.replace(/\[VOICE:\s*([^\]]+)\]/gi, (_, content) => {
    actions.push({ type: 'send_voice', text: content.trim() })
    return ''
  })

  // Extract [VIDEO: ...] tags
  text = text.replace(/\[VIDEO:\s*([^\]]+)\]/gi, (_, prompt) => {
    actions.push({ type: 'send_video', prompt: prompt.trim() })
    return ''
  })

  return {
    text: text.trim(),
    actions: actions.length > 0 ? actions : undefined,
  }
}
