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
import { appendFileSync } from 'fs'

function debugLog(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  console.log(msg)
  try { appendFileSync('/tmp/openlove-debug.log', line) } catch { /* ignore */ }
}

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

    debugLog(`[Engine] Raw LLM response (first 200): ${rawResponse.slice(0, 200)}`)
    debugLog(`[Engine] Parsed actions: ${JSON.stringify(parsed.actions ?? [])}`)

    const mediaIntent = detectMediaIntent(incoming.content)
    debugLog(`[Engine] Media intent for "${incoming.content}": ${mediaIntent}`)

    if (!parsed.actions) parsed.actions = []

    // 7b. Fallback: if user clearly asked for media but LLM forgot the tag, inject one
    const hasSelfieAction = parsed.actions.some(a => a.type === 'send_image')
    const hasVoiceAction = parsed.actions.some(a => a.type === 'send_voice')
    const hasVideoAction = parsed.actions.some(a => a.type === 'send_video')

    if (mediaIntent === 'selfie' && !hasSelfieAction) {
      const isScene = detectSceneRequest(incoming.content, rawResponse)
      const fallbackPrompt = isScene
        ? extractSceneContext(incoming.content, rawResponse, this.blueprint.name)
        : extractSelfieContext(incoming.content, rawResponse, this.blueprint.name)
      const fallbackStyle = isScene ? 'location' : inferSelfieStyle(incoming.content, rawResponse)
      parsed.actions.push({ type: 'send_image', prompt: fallbackPrompt, style: fallbackStyle })
      debugLog(`[Engine] Fallback ${isScene ? 'scene' : 'selfie'} injected: style=${fallbackStyle}, "${fallbackPrompt}"`)
    }

    if (mediaIntent === 'voice' && !hasVoiceAction) {
      // Extract what to say from LLM response text (it often contains the intended speech)
      const voiceText = parsed.text?.replace(/\s+/g, ' ').trim() || 'hey, here you go'
      parsed.actions.push({ type: 'send_voice', text: voiceText })
      debugLog(`[Engine] Fallback voice injected: "${voiceText.slice(0, 80)}"`)
    }

    if (mediaIntent === 'video' && !hasVideoAction) {
      const videoPrompt = extractVideoContext(incoming.content, rawResponse, this.blueprint.name)
      parsed.actions.push({ type: 'send_video', prompt: videoPrompt })
      debugLog(`[Engine] Fallback video injected: "${videoPrompt}"`)
    }

    // 7c. Second fallback: detect when LLM is "pretending" to send media
    // DeepSeek often says "here you go" + blank lines where a tag should be, but no actual tag
    if (parsed.actions.length === 0 && !mediaIntent) {
      const pretendIntent = detectPretendMedia(incoming.content, rawResponse)
      if (pretendIntent) {
        debugLog(`[Engine] Detected pretend-send: "${pretendIntent.type}" from LLM response`)
        if (pretendIntent.type === 'image') {
          // Check if user wants a SCENE photo vs a selfie
          const isSceneRequest = detectSceneRequest(incoming.content, rawResponse)
          const prompt = isSceneRequest
            ? extractSceneContext(incoming.content, rawResponse, this.blueprint.name)
            : extractSelfieContext(incoming.content, rawResponse, this.blueprint.name)
          const style = isSceneRequest ? 'location' : inferSelfieStyle(incoming.content, rawResponse)
          parsed.actions.push({ type: 'send_image', prompt, style })
          debugLog(`[Engine] Pretend-send fallback: ${isSceneRequest ? 'scene' : 'selfie'} injected: "${prompt}"`)
        } else if (pretendIntent.type === 'voice') {
          const voiceText = parsed.text?.replace(/\s+/g, ' ').trim() || 'hey'
          parsed.actions.push({ type: 'send_voice', text: voiceText })
          debugLog(`[Engine] Pretend-send fallback: voice injected`)
        } else if (pretendIntent.type === 'video') {
          const videoPrompt = extractVideoContext(incoming.content, rawResponse, this.blueprint.name)
          parsed.actions.push({ type: 'send_video', prompt: videoPrompt })
          debugLog(`[Engine] Pretend-send fallback: video injected`)
        }
      }
    }

    // Debug: log final actions
    if (parsed.actions.length > 0) {
      debugLog(`[Engine] Final actions: ${JSON.stringify(parsed.actions)}`)
    }

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
      case 'random_thought': {
        const recentActivity = trigger.data?.recentActivity
        if (recentActivity) {
          prompt = `You've been ${recentActivity} recently. ` +
            `Something about it made you think of the user — maybe it reminded you of a past conversation, ` +
            `or you want to share what you found interesting. ` +
            `Send a SHORT, natural text message that connects what you were just doing to your relationship with the user. ` +
            `Don't explain that you were doing the activity — just share the thought it triggered. ` +
            `Keep it to 1-2 sentences max, like a real text.`
        } else {
          prompt = `You want to check in with the user. ` +
            `Send a natural, brief message — maybe ask what they're up to, share something small from your day, ` +
            `or reference something you talked about before. ` +
            `Keep it to 1-2 sentences, like a real text message. Don't be dramatic or philosophical.`
        }
        break
      }
      case 'missing_you':
        prompt = `It's been a while since you talked to the user. ` +
          `Send a casual check-in — like you would text a close friend. ` +
          `Don't say "I miss you" or be dramatic. Just be normal. ` +
          `Examples of natural check-ins: "hey, you alive?", "whatcha doing", ` +
          `or mention something you're doing right now. Keep it to 1 sentence.`
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

/**
 * Detect what media the user is requesting: 'selfie', 'voice', 'video', or null.
 * Priority: video > voice > selfie (more specific first).
 * Supports English and Chinese.
 */
function detectMediaIntent(content: string): 'selfie' | 'voice' | 'video' | null {
  const lower = content.toLowerCase()

  // Video patterns (check first — most specific)
  const videoPatterns = [
    /video/i, /\bclip\b/i, /\bfilm\b/i, /record.*for me/i,
    /视频/i, /录像/i, /录.*视/i, /发.*视频/i,
  ]
  if (videoPatterns.some(p => p.test(lower))) return 'video'

  // Voice patterns
  const voicePatterns = [
    /voice/i, /hear (you|your)/i, /listen to you/i, /say something/i,
    /talk to me/i, /speak/i, /audio/i, /send.*voice/i,
    /声音/i, /语音/i, /说话/i, /听.*你/i, /发.*语音/i,
    /wanna hear/i, /want to hear/i, /sing/i,
  ]
  if (voicePatterns.some(p => p.test(lower))) return 'voice'

  // Selfie / photo patterns (broadest — check last)
  // Be careful: "show me the view" or "see the sunset" are NOT selfie requests
  const selfiePatterns = [
    /selfie/i, /self[- ]?ie/i,
    /take a pic/i, /send.*photo/i, /send.*pic/i, /show.*face/i,
    /see you\b/i, /see.*in the screen/i, /what.*look like/i,
    /看看你/i, /自拍/i, /发.*照/i, /拍.*照/i,
    /give me a (selfie|photo|pic)/i, /can (i|you).*selfie/i,
    /send me a (selfie|photo|pic)/i, /take a (selfie|photo|pic)/i,
    /let me see you/i, /看.*你/i, /想看你/i,
    /show me (you|your|yourself)/i,
    /photo of you/i, /picture of you/i, /pic of you/i,
    // Scene / non-selfie image requests (treated as selfie intent, scene detection happens later)
    /see.*view/i, /see.*window/i, /see.*room/i, /see.*setup/i,
    /show.*view/i, /show.*window/i, /show.*room/i, /show.*setup/i,
    /show.*matcha/i, /show.*food/i, /show.*drink/i,
    /see.*matcha/i, /see.*food/i, /see.*drink/i,
    /wanna see/i, /want to see/i, /i wanna see/i,
    /看.*窗/i, /看.*外面/i, /看.*房间/i,
  ]
  if (selfiePatterns.some(p => p.test(lower))) return 'selfie'

  return null
}

/** Legacy alias for backward compatibility */
function isSelfieRequest(content: string): boolean {
  return detectMediaIntent(content) === 'selfie'
}

/**
 * Detect when LLM is "pretending" to send media without using tags.
 * DeepSeek often outputs "here you go" + blank lines where a [SELFIE:] tag should be.
 *
 * Strategy:
 * 1. Check if LLM response has "sending" language + suspicious blank gaps
 * 2. Infer media type from BOTH user message AND LLM response content
 *    - LLM says "here's a clip/video" → video
 *    - LLM says "listen to this" / user asked for voice → voice
 *    - LLM says "here's a photo" / user asked for photo → image
 * 3. Require either user request intent OR strong LLM sending intent
 *    to prevent false positives on casual chat ("photo is ok babe")
 */
function detectPretendMedia(
  userMessage: string,
  llmResponse: string
): { type: 'image' | 'voice' | 'video' } | null {
  const llmLower = llmResponse.toLowerCase()
  const userLower = userMessage.toLowerCase()

  // LLM is pretending to send something if it uses "here" phrases with blank line gaps
  const pretendPatterns = [
    /here you go/i, /here it is/i, /here's (the|a|my)/i,
    /there you go/i, /sending it/i, /let me send/i,
    /sent it/i, /attached/i, /took a (quick|little)/i,
    /给你/i, /发给你/i, /这是/i, /拍了/i, /录了/i,
  ]
  const isPretending = pretendPatterns.some(p => p.test(llmLower))
  if (!isPretending) return null

  // Has suspicious blank line gaps (where a tag should have been)
  const hasGaps = /\n\s*\n\s*\n/.test(llmResponse)
  if (!hasGaps) return null

  // --- Determine intent source: user request OR LLM sending intent ---

  // User explicitly requested media?
  const userWantsMedia = /send|show|see|take|give|wanna|want|can (i|you)|let me|拍|发|看|给|要/.test(userLower)
    && /photo|pic|image|selfie|video|clip|voice|audio|hear|照|图|拍|视频|语音|声音|sing|歌/.test(userLower)

  // User following up on missing media?
  const userFollowUp = /where.*(photo|pic|image|video|clip|selfie|it)|没(有)?发|没收到|怎么没|didn't (send|attach|go)/i.test(userLower)

  // LLM is strongly indicating it's sending specific media type?
  const llmSendsVideo = /here's.*(clip|video|recording)|quick (clip|video)|录.*(了|好)/i.test(llmLower)
  const llmSendsVoice = /here's.*(voice|audio|recording)|listen to (this|me)|hear (this|me)|说给你听|唱给你/i.test(llmLower)
  const llmSendsImage = /here's.*(photo|pic|selfie|shot|view)|took.*(photo|pic|shot)|拍了.*照/i.test(llmLower)

  const hasIntent = userWantsMedia || userFollowUp || llmSendsVideo || llmSendsVoice || llmSendsImage

  if (!hasIntent) {
    debugLog(`[Engine] Pretend-send suppressed: no media intent in user="${userMessage.slice(0, 50)}" or LLM response`)
    return null
  }

  // --- Determine media TYPE from both user message and LLM response ---
  // Priority: LLM response type > user message type > default image

  // Video signals (from either side)
  if (llmSendsVideo || /video|clip|film|视频|录像/.test(userLower)) return { type: 'video' }

  // Voice signals (from either side)
  if (llmSendsVoice || /voice|hear|listen|speak|sing|声音|语音|唱/.test(userLower)) return { type: 'voice' }

  // Image is the default
  return { type: 'image' }
}

/**
 * Extract video context from user message and LLM response.
 */
function extractVideoContext(userMessage: string, llmResponse: string, characterName: string): string {
  const combined = `${userMessage} ${llmResponse}`.toLowerCase()
  const locationContext = extractLocationContext(combined)
  const activityContext = extractActivityContext(combined)
  const timeContext = extractTimeContext(combined)

  const parts = [
    `short video clip of ${characterName}`,
    activityContext || 'waving at camera',
    locationContext,
    timeContext,
  ].filter(Boolean)

  return parts.join(', ')
}

/**
 * Extract context from BOTH the user's message and LLM response to build a rich selfie prompt.
 * Uses conversation context to determine scene, outfit, activity, and time of day.
 */
function extractSelfieContext(userMessage: string, llmResponse: string, characterName: string): string {
  const combined = `${userMessage} ${llmResponse}`.toLowerCase()

  // Extract time/setting context
  const timeContext = extractTimeContext(combined)
  const locationContext = extractLocationContext(combined)
  const outfitContext = extractOutfitContext(combined)
  const activityContext = extractActivityContext(combined)

  const parts = [
    `selfie of ${characterName}`,
    outfitContext,
    locationContext,
    activityContext,
    timeContext,
  ].filter(Boolean)

  return parts.join(', ')
}

function extractTimeContext(text: string): string {
  if (/sleep|bed|night|晚安|睡觉|困了|sleepy|tired|exhausted/.test(text)) return 'nighttime, soft warm lamp lighting, cozy bedroom atmosphere'
  if (/morning|wake|早上|起床|just woke/.test(text)) return 'early morning, soft natural window light, just woke up'
  if (/afternoon|lunch|中午|下午/.test(text)) return 'afternoon, bright natural daylight'
  if (/evening|sunset|晚上|傍晚|dinner/.test(text)) return 'evening, golden hour warm lighting'
  return 'natural lighting'
}

function extractLocationContext(text: string): string {
  if (/bed|bedroom|pillow|blanket|床|卧室/.test(text)) return 'in bed, cozy bedroom'
  if (/kitchen|cook|baking|厨房|做饭/.test(text)) return 'in the kitchen'
  if (/cafe|coffee|starbucks|matcha|咖啡|奶茶/.test(text)) return 'at a cozy cafe'
  if (/office|work|desk|办公|工作/.test(text)) return 'at desk, workspace'
  if (/outside|park|walk|street|外面|公园|散步/.test(text)) return 'outdoors, natural environment'
  if (/gym|workout|exercise|健身|运动/.test(text)) return 'at the gym'
  if (/bath|shower|洗澡/.test(text)) return 'bathroom mirror, steam'
  if (/sofa|couch|living room|沙发|客厅/.test(text)) return 'on the couch, living room'
  if (/car|drive|开车|车里/.test(text)) return 'in the car'
  return ''
}

function extractOutfitContext(text: string): string {
  if (/pajama|pj|睡衣|sleep|bed|sleepy|nightgown/.test(text)) return 'wearing comfortable pajamas'
  if (/hoodie|卫衣/.test(text)) return 'wearing a cozy hoodie'
  if (/dress|裙子|连衣裙/.test(text)) return 'wearing a cute dress'
  if (/workout|gym|sport|运动/.test(text)) return 'wearing athletic wear'
  if (/suit|formal|正装/.test(text)) return 'dressed formally'
  if (/towel|bath|浴巾/.test(text)) return 'wrapped in a towel, fresh from shower'
  if (/oversized|t-shirt|tee|T恤/.test(text)) return 'wearing an oversized t-shirt'
  if (/sweater|毛衣/.test(text)) return 'wearing a soft sweater'
  // Don't default to hoodie - pick something contextual
  if (/morning|wake|just woke/.test(text)) return 'wearing comfortable sleepwear'
  if (/night|evening|relax|chill/.test(text)) return 'in comfortable loungewear'
  return 'casually dressed'
}

function extractActivityContext(text: string): string {
  if (/eat|food|cooking|dinner|lunch|breakfast|吃|做饭|cooking/.test(text)) return 'with food visible'
  if (/coffee|tea|matcha|drink|喝|咖啡|茶|奶茶/.test(text)) return 'holding a warm drink'
  if (/read|book|reading|看书|阅读/.test(text)) return 'with a book nearby'
  if (/game|gaming|playing|游戏|打游戏/.test(text)) return 'gaming setup visible'
  if (/study|homework|学习|作业/.test(text)) return 'studying, books and notes around'
  if (/music|listen|听歌|音乐/.test(text)) return 'wearing earbuds, vibing to music'
  if (/watch|movie|drama|看剧|电影/.test(text)) return 'screen glow on face, watching something'
  if (/computer|laptop|coding|电脑/.test(text)) return 'laptop open nearby'
  return ''
}

/**
 * Infer the best selfie style from conversation context.
 */
/**
 * Detect if the user is asking for a SCENE photo (landscape, view, object)
 * rather than a selfie/photo of the character.
 */
function detectSceneRequest(userMessage: string, llmResponse: string): boolean {
  const combined = `${userMessage} ${llmResponse}`.toLowerCase()

  // User-side scene patterns
  const scenePatterns = [
    /window view/i, /view from/i, /the view/i, /outside.*(window|view)/i,
    /sunset/i, /sunrise/i, /landscape/i, /scenery/i,
    /show.*room/i, /show.*setup/i, /show.*desk/i, /show.*food/i,
    /what.*eating/i, /what.*drinking/i, /what.*cooking/i,
    /see.*room/i, /see.*place/i, /see.*setup/i,
    /matcha/i, /coffee.*cup/i, /food.*photo/i,
    /窗外/i, /风景/i, /看.*窗/i, /看.*外面/i,
    /not you/i, /not.*selfie/i, /not.*face/i,
  ]

  // LLM response scene patterns — if the LLM describes sending a scene photo
  const llmScenePatterns = [
    /photo.*(of|i took).*(flower|plant|tree|garden|sky|cloud|ocean|beach|mountain)/i,
    /photo.*(of|i took).*(food|meal|dish|cake|dessert|drink|matcha|coffee|tea)/i,
    /photo.*(of|i took).*(room|desk|setup|view|window|sunset|sunrise)/i,
    /here's.*(the view|my view|the sky|the sunset|the sunrise|my room|my desk|my setup)/i,
    /flower|floral|bouquet|bloom/i,
    /farmer'?s? market/i,
    /市场|花|风景|日落|日出|房间|桌子/i,
  ]

  const userLower = userMessage.toLowerCase()
  if (/not (you|your face|a selfie)/i.test(userLower)) return true
  if (scenePatterns.some(p => p.test(combined))) return true

  // Check LLM response specifically for scene descriptions
  const llmLower = llmResponse.toLowerCase()
  if (llmScenePatterns.some(p => p.test(llmLower))) return true

  return false
}

/**
 * Extract scene context for non-selfie photo requests.
 * Generates a prompt describing the scene, not the character.
 */
function extractSceneContext(userMessage: string, llmResponse: string, characterName: string): string {
  const combined = `${userMessage} ${llmResponse}`.toLowerCase()
  const parts: string[] = []

  // Determine the scene subject from context
  if (/window|view|outside|窗/.test(combined)) {
    parts.push('view from a cozy apartment window')
    if (/haz[ey]|fog|mist/.test(combined)) parts.push('slightly hazy atmosphere')
    if (/tree|bloom|flower/.test(combined)) parts.push('trees visible outside')
    if (/city|urban|building/.test(combined)) parts.push('city skyline in the distance')
    else parts.push('peaceful neighborhood view')
  } else if (/matcha|coffee|tea|drink|cup/.test(combined)) {
    parts.push('aesthetic matcha latte on a wooden table')
    parts.push('cozy cafe ambiance')
  } else if (/food|eat|cook|meal/.test(combined)) {
    parts.push('delicious home-cooked meal')
    parts.push('warm kitchen lighting')
  } else if (/setup|desk|workspace/.test(combined)) {
    parts.push('aesthetic desk setup with warm lighting')
    parts.push('sketchbook and stationery visible')
  } else if (/flower|floral|bouquet|bloom|garden/.test(combined)) {
    parts.push('beautiful fresh flowers close-up')
    if (/market|farmer/.test(combined)) parts.push('at a farmer\'s market stall')
    else parts.push('natural soft lighting')
  } else if (/room|place|apartment/.test(combined)) {
    parts.push('cozy apartment interior')
    parts.push('warm ambient lighting')
  } else if (/sunset|sunrise/.test(combined)) {
    parts.push('beautiful sunset sky')
    parts.push('warm golden and pink hues')
  } else if (/sky|cloud|outdoor|outside|park|street/.test(combined)) {
    parts.push('beautiful outdoor scenery')
    parts.push('natural daylight')
  } else {
    // Generic scene from LLM response context — try to extract nouns
    const llmLower = llmResponse.toLowerCase()
    const subjectMatch = llmLower.match(/photo.*(of|i took)\s+(?:some\s+)?(.{5,40})/)
    if (subjectMatch) {
      parts.push(subjectMatch[2].replace(/[.!,].*/, '').trim())
    } else {
      parts.push(`scene described by ${characterName}`)
    }
  }

  // Add time context
  const timeCtx = extractTimeContext(combined)
  if (timeCtx !== 'natural lighting') parts.push(timeCtx)
  else parts.push('natural lighting, high quality photo')

  return parts.join(', ')
}

function inferSelfieStyle(userMessage: string, llmResponse: string): string {
  const combined = `${userMessage} ${llmResponse}`.toLowerCase()
  if (/mirror|outfit|dress|全身|穿搭/.test(combined)) return 'mirror'
  if (/outside|park|beach|street|travel|cafe|restaurant|外面|公园|咖啡/.test(combined)) return 'location'
  if (/close|face|eyes|cute|脸|眼睛/.test(combined)) return 'close-up'
  return 'casual'
}
