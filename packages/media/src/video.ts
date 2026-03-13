/**
 * Video Generation Engine
 *
 * Two-step pipeline for character-consistent video:
 *   1. Generate a still frame with PuLID (face-consistent with reference)
 *   2. Animate the frame with Wan 2.1 image-to-video
 *
 * Model hierarchy:
 *   1. PuLID still → fal-ai/wan-i2v — face-consistent, ~$0.10, ~45s
 *   2. fal-ai/wan-t2v — text-only fallback (no face consistency)
 *
 * All videos are silent (no audio). Audio not supported by Wan models.
 */

import { fal } from '@fal-ai/client'
import { readFileSync, existsSync, appendFileSync } from 'fs'

function debugLog(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  console.log(msg)
  try { appendFileSync('/tmp/openlove-debug.log', line) } catch { /* ignore */ }
}

export interface VideoConfig {
  falKey?: string
  model?: string
  referenceImagePath?: string
}

export class VideoEngine {
  private config: VideoConfig

  constructor(config: VideoConfig) {
    this.config = config
    if (config.falKey) {
      fal.config({ credentials: config.falKey })
    }
  }

  /**
   * Generate a short video clip with character consistency.
   *
   * Pipeline:
   *   1. If reference image → PuLID still frame → Wan i2v animate
   *   2. No reference → wan-t2v text-to-video (random face)
   */
  async generateClip(prompt: string): Promise<Buffer | null> {
    if (!this.config.falKey) {
      console.warn('[Media/Video] No FAL_KEY configured — skipping video generation')
      return null
    }

    try {
      const hasRef = this.config.referenceImagePath && existsSync(this.config.referenceImagePath)

      if (hasRef) {
        debugLog(`[Media/Video] Using reference pipeline (PuLID still → Wan i2v)`)
        return await this.generateWithReference(prompt)
      }

      debugLog(`[Media/Video] No reference image, using text-to-video`)
      return await this.generateTextToVideo(prompt)
    } catch (err) {
      debugLog(`[Media/Video] Generation FAILED: ${err instanceof Error ? err.stack : err}`)
      return null
    }
  }

  /**
   * Step 1: PuLID still frame (face-consistent)
   * Step 2: Wan i2v animate
   */
  private async generateWithReference(prompt: string): Promise<Buffer | null> {
    const refPath = this.config.referenceImagePath!
    const imageData = readFileSync(refPath)
    const base64Image = `data:image/jpeg;base64,${imageData.toString('base64')}`

    // Step 1: Generate still frame with PuLID
    debugLog(`[Media/Video] Step 1: PuLID still frame...`)
    const stillResult = await fal.subscribe('fal-ai/flux-pulid', {
      input: {
        prompt: `${prompt}, cinematic still frame, volumetric lighting, shallow depth of field, warm color grading, film grain, ultra detailed`,
        reference_image_url: base64Image,
        image_size: 'portrait_4_3',
        guidance_scale: 5.5,
        num_inference_steps: 28,   // more steps → finer details
        id_weight: 0.7,           // balanced: character consistency + natural expression
      },
    }) as any

    const stillUrl = stillResult?.data?.images?.[0]?.url
      ?? stillResult?.images?.[0]?.url
      ?? stillResult?.data?.image?.url
      ?? stillResult?.image?.url

    if (!stillUrl) {
      debugLog(`[Media/Video] PuLID still frame failed. Falling back to text-to-video.`)
      return await this.generateTextToVideo(prompt)
    }

    debugLog(`[Media/Video] Step 1 done: ${stillUrl.slice(0, 80)}...`)

    // Step 2: Animate with Wan i2v
    return await this.animateWithWan(prompt, stillUrl)
  }

  /**
   * Wan i2v: image-to-video, 3s clip, ~$0.10.
   */
  private async animateWithWan(prompt: string, imageUrl: string): Promise<Buffer | null> {
    try {
      debugLog(`[Media/Video] Step 2: Wan i2v animate...`)

      const result = await fal.subscribe('fal-ai/wan-i2v', {
        input: {
          prompt: `${prompt}, subtle natural movement, gentle breathing, slight smile, hair sway, cinematic, volumetric lighting, smooth motion`,
          image_url: imageUrl,
          num_frames: 81,
          resolution: '480p',
          aspect_ratio: '9:16',
        },
      }) as any

      debugLog(`[Media/Video] Wan i2v result keys: ${JSON.stringify(Object.keys(result))}`)
      return await this.extractVideoBuffer(result)
    } catch (err) {
      debugLog(`[Media/Video] Wan i2v error: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  /**
   * Fallback: pure text-to-video (no face consistency).
   */
  private async generateTextToVideo(prompt: string): Promise<Buffer | null> {
    const model = this.config.model ?? 'fal-ai/wan-t2v'
    debugLog(`[Media/Video] Text-to-video: ${model}`)

    const result = await fal.subscribe(model, {
      input: {
        prompt: `${prompt}, cinematic, high quality, natural lighting`,
        num_frames: 81,
        resolution: '480p',
        aspect_ratio: '9:16',
      },
    }) as any

    return await this.extractVideoBuffer(result)
  }

  private async extractVideoBuffer(result: any): Promise<Buffer | null> {
    const videoUrl = result?.data?.video?.url
      ?? result?.data?.videos?.[0]?.url
      ?? result?.video?.url
      ?? result?.videos?.[0]?.url

    if (!videoUrl) {
      debugLog(`[Media/Video] No video URL: ${JSON.stringify(result).slice(0, 500)}`)
      return null
    }

    // Download with retry (fal CDN can be slow/flaky)
    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        debugLog(`[Media/Video] Downloading (attempt ${attempt}): ${videoUrl.slice(0, 80)}...`)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000) // 30s timeout
        const response = await fetch(videoUrl, { signal: controller.signal })
        clearTimeout(timeout)

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        debugLog(`[Media/Video] Downloaded: ${buffer.length} bytes`)
        return buffer
      } catch (err) {
        debugLog(`[Media/Video] Download attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`)
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000 * attempt)) // backoff
        }
      }
    }

    debugLog(`[Media/Video] All ${maxRetries} download attempts failed`)
    return null
  }
}
