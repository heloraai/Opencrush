/**
 * Voice Engine
 *
 * TTS (Text-to-Speech) providers:
 *   1. ElevenLabs — most natural, emotional ($5/mo or free tier)
 *   2. Fish Audio — good quality, Chinese support (free tier available)
 *   3. FAL Kokoro — cheapest ($0.02/1K chars), uses existing FAL key
 *
 * STT (Speech-to-Text):
 *   Primary: OpenAI Whisper API
 *   Fallback: Returns null (user must type)
 */

import OpenAI, { toFile } from 'openai'

export type TtsProvider = 'elevenlabs' | 'fishaudio' | 'fal'

export interface VoiceConfig {
  provider?: TtsProvider
  // ElevenLabs
  elevenLabsApiKey?: string
  elevenLabsVoiceId?: string
  // Fish Audio
  fishAudioApiKey?: string
  fishAudioVoiceId?: string
  // FAL Kokoro (reuses existing FAL key)
  falKey?: string
  falVoiceId?: string  // e.g. 'af_heart' — see https://fal.ai/models/fal-ai/kokoro
  // STT
  openaiApiKey?: string
}

// Kokoro language-specific endpoints on fal.ai
const KOKORO_ENDPOINTS: Record<string, string> = {
  en: 'fal-ai/kokoro/american-english',
  zh: 'fal-ai/kokoro/mandarin-chinese',
  ja: 'fal-ai/kokoro/japanese',
  fr: 'fal-ai/kokoro/french',
  es: 'fal-ai/kokoro/spanish',
}

// Default voices per language for non-English Kokoro endpoints
const KOKORO_DEFAULT_VOICES: Record<string, string> = {
  zh: 'zf_xiaobei',
  ja: 'jf_alpha',
  fr: 'ff_siwis',
  es: 'ef_dora',
}

export class VoiceEngine {
  private config: VoiceConfig
  private openai?: OpenAI

  constructor(config: VoiceConfig) {
    this.config = config

    if (config.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: config.openaiApiKey })
    }
  }

  /**
   * Convert text to speech audio buffer.
   * Returns MP3 buffer, or null if TTS unavailable.
   */
  async textToSpeech(text: string): Promise<Buffer | null> {
    const cleanText = sanitizeForSpeech(text)
    if (!cleanText) return null

    const provider = this.resolveProvider()
    if (!provider) {
      console.warn('[Voice] No TTS provider configured')
      return null
    }

    try {
      switch (provider) {
        case 'elevenlabs':
          return await this.elevenLabsTTS(cleanText)
        case 'fishaudio':
          return await this.fishAudioTTS(cleanText)
        case 'fal':
          return await this.falKokoroTTS(cleanText)
      }
    } catch (err) {
      console.error(`[Voice/${provider}] Error:`, err)
      return null
    }
  }

  private resolveProvider(): TtsProvider | null {
    // Explicit provider choice
    if (this.config.provider) {
      return this.config.provider
    }
    // Auto-detect from available keys
    if (this.config.elevenLabsApiKey) return 'elevenlabs'
    if (this.config.fishAudioApiKey) return 'fishaudio'
    if (this.config.falKey) return 'fal'
    return null
  }

  // ── ElevenLabs ──────────────────────────────────────────────────────────

  private async elevenLabsTTS(text: string): Promise<Buffer | null> {
    if (!this.config.elevenLabsApiKey) return null

    const voiceId = this.config.elevenLabsVoiceId ?? '21m00Tcm4TlvDq8ikWAM' // Rachel default

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.config.elevenLabsApiKey,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            style: 0.2,
            use_speaker_boost: true,
          },
        }),
      }
    )

    if (!response.ok) {
      const errBody = await response.text()
      console.error(`[Voice/ElevenLabs] API error ${response.status}:`, errBody)
      return null
    }

    return Buffer.from(await response.arrayBuffer())
  }

  // ── Fish Audio ──────────────────────────────────────────────────────────

  private async fishAudioTTS(text: string): Promise<Buffer | null> {
    if (!this.config.fishAudioApiKey) return null

    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.fishAudioApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        reference_id: this.config.fishAudioVoiceId ?? undefined,
        format: 'mp3',
        latency: 'balanced',
      }),
    })

    if (!response.ok) {
      const errBody = await response.text()
      console.error(`[Voice/FishAudio] API error ${response.status}:`, errBody)
      return null
    }

    return Buffer.from(await response.arrayBuffer())
  }

  // ── FAL Kokoro ──────────────────────────────────────────────────────────

  private async falKokoroTTS(text: string): Promise<Buffer | null> {
    if (!this.config.falKey) return null

    const lang = detectLanguage(text)
    const endpoint = KOKORO_ENDPOINTS[lang] ?? KOKORO_ENDPOINTS.en

    // Different Kokoro endpoints use different param names
    const isEnglish = endpoint.includes('english')
    const input: Record<string, unknown> = isEnglish
      ? { text, output_format: 'mp3' }
      : { prompt: text, output_format: 'mp3', voice: this.config.falVoiceId ?? KOKORO_DEFAULT_VOICES[lang] ?? 'zf_xiaobei' }

    if (this.config.falVoiceId && isEnglish) {
      input.voice = this.config.falVoiceId
    }

    // Kokoro is fast enough for synchronous calls (fal.run, not queue)
    const resp = await fetch(`https://fal.run/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${this.config.falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })

    if (!resp.ok) {
      const errText = await resp.text()
      console.error(`[Voice/FAL] API error (${resp.status}):`, errText)
      return null
    }

    const result = await resp.json() as { audio?: { url?: string } }
    const audioUrl = result.audio?.url
    if (!audioUrl) {
      console.error('[Voice/FAL] No audio URL in result:', JSON.stringify(result).slice(0, 200))
      return null
    }

    const audioResp = await fetch(audioUrl)
    if (!audioResp.ok) return null
    return Buffer.from(await audioResp.arrayBuffer())
  }

  // ── STT (Speech-to-Text) ────────────────────────────────────────────────

  /**
   * Transcribe audio to text using Whisper.
   * Input: audio buffer (any format Whisper supports)
   * Returns: transcribed text, or null if unavailable
   */
  async speechToText(audioBuffer: Buffer): Promise<string | null> {
    if (!this.openai) {
      console.warn('[Voice/STT] No OpenAI API key — STT unavailable')
      return null
    }

    try {
      const file = await toFile(audioBuffer, 'audio.ogg', { type: 'audio/ogg' })

      const response = await this.openai.audio.transcriptions.create({
        model: 'whisper-1',
        file,
        language: 'en',
      })

      return response.text || null
    } catch (err) {
      console.error('[Voice/STT] Whisper error:', err)
      return null
    }
  }
}

function sanitizeForSpeech(text: string): string {
  return text
    // Remove action tags
    .replace(/\[SELFIE:[^\]]*\]/gi, '')
    .replace(/\[VOICE:[^\]]*\]/gi, '')
    .replace(/\[VIDEO:[^\]]*\]/gi, '')
    // Remove stage directions: *soft singing*, (laughs), [giggles], ~hums~
    .replace(/\*[^*]+\*/g, '')        // *action descriptions*
    .replace(/\([^)]+\)/g, '')        // (action descriptions)
    .replace(/\[[^\]]*\]/g, '')       // [any remaining brackets]
    .replace(/~[^~]+~/g, '')          // ~action descriptions~
    // Remove ALL emojis — comprehensive Unicode property match
    .replace(/\p{Extended_Pictographic}/gu, '')
    // Remove remaining emoji-related codepoints (joiners, selectors, modifiers)
    .replace(/[\u{200D}\u{FE0E}\u{FE0F}\u{20E3}]/gu, '')  // ZWJ, variation selectors
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')                 // skin tone modifiers
    .replace(/[\u{E0020}-\u{E007F}]/gu, '')                  // tag characters
    // Remove common text emoticons that TTS reads literally
    .replace(/[:;][-']?[)(DPpOo3><\\/|]/g, '')
    .replace(/[<>]3/g, '')            // <3 heart
    .replace(/xD+/gi, '')             // xD
    // Remove markdown formatting
    .replace(/[*_`~#]/g, '')
    // Remove URLs
    .replace(/https?:\/\/\S+/g, '')
    // Clean up extra whitespace from removals
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Simple language detection — checks for CJK characters */
function detectLanguage(text: string): string {
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const jpCount = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length

  if (jpCount > 2) return 'ja'
  if (cjkCount > text.length * 0.2) return 'zh'
  return 'en'
}
