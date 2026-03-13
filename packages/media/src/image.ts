/**
 * Image Generation Engine
 *
 * Generates character selfies with visual consistency.
 *
 * Model hierarchy (reference image available):
 *   1. fal-ai/flux-pulid — FLUX-based face consistency (best quality)
 *   2. fal-ai/instant-character — character consistency across poses
 *   3. fal-ai/ip-adapter-face-id — legacy SD-based fallback
 *
 * Model hierarchy (no reference image):
 *   1. fal-ai/nano-banana — Google's photorealistic model
 *   2. fal-ai/flux-realism — FLUX realism LoRA fallback
 *
 * Visual consistency strategy:
 *   - Reference image anchors face/style via PuLID or InstantCharacter
 *   - Consistent style prefix in every prompt
 *   - Character appearance description from SOUL.md
 *
 * Aspect ratios: 4:5 (casual/close-up) or 9:16 (mirror/location)
 * NEVER generates 1:1 square images — always portrait like a real phone.
 */

import { readFileSync, existsSync, appendFileSync } from 'fs'

function debugLog(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  console.log(msg)
  try { appendFileSync('/tmp/openlove-debug.log', line) } catch { /* ignore */ }
}

/**
 * Direct REST API call to fal.ai queue — 3x faster than SDK subscribe.
 * SDK subscribe: ~20s (polling with long sleep intervals)
 * Direct REST:   ~8s  (tight 500ms polling loop)
 */
async function falQueueRun(model: string, input: Record<string, any>, falKey: string): Promise<any> {
  // Step 1: Submit to queue
  const submitResp = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  if (!submitResp.ok) {
    const errText = await submitResp.text()
    throw new Error(`FAL submit failed (${submitResp.status}): ${errText}`)
  }

  const { request_id: requestId } = await submitResp.json() as { request_id: string }
  debugLog(`[FAL] Submitted ${model}: request_id=${requestId}`)

  // Step 2: Poll for result with tight loop (500ms)
  const maxWait = 120_000 // 2 min timeout
  const start = Date.now()

  while (Date.now() - start < maxWait) {
    const statusResp = await fetch(
      `https://queue.fal.run/${model}/requests/${requestId}/status`,
      { headers: { 'Authorization': `Key ${falKey}` } }
    )
    const status = await statusResp.json() as { status: string }

    if (status.status === 'COMPLETED') {
      const resultResp = await fetch(
        `https://queue.fal.run/${model}/requests/${requestId}`,
        { headers: { 'Authorization': `Key ${falKey}` } }
      )
      return await resultResp.json()
    }

    if (status.status === 'FAILED') {
      throw new Error(`FAL job failed: ${JSON.stringify(status)}`)
    }

    // Tight polling — 500ms between checks
    await new Promise(r => setTimeout(r, 500))
  }

  throw new Error(`FAL job timed out after ${maxWait / 1000}s`)
}

export interface ImageConfig {
  falKey?: string
  model?: string          // override for direct generation model
  referenceModel?: string // override for reference-based model
  defaultStyle?: string
}

export interface SelfieRequest {
  prompt: string
  referenceImagePath?: string
  characterDescription?: string
  style?: 'casual' | 'mirror' | 'close-up' | 'location'
  aspectRatio?: '4:5' | '9:16'
}

// fal.ai image_size string presets — guaranteed to produce correct aspect ratio
type FalImageSize = 'portrait_4_3' | 'portrait_16_9' | 'square_hd' | 'square' | 'landscape_4_3' | 'landscape_16_9'

export class ImageEngine {
  private config: ImageConfig

  constructor(config: ImageConfig) {
    this.config = config
  }

  async generateSelfie(request: SelfieRequest): Promise<Buffer | null> {
    if (!this.config.falKey) {
      console.warn('[Media/Image] No FAL_KEY configured — skipping image generation')
      return null
    }

    try {
      const styledPrompt = this.buildImagePrompt(request)
      const imageSize = this.getImageSizePreset(request)

      debugLog(`[Media/Image] Generating: style=${request.style ?? 'casual'}, ratio=${imageSize}`)

      if (request.referenceImagePath && existsSync(request.referenceImagePath)) {
        debugLog(`[Media/Image] Using reference image: ${request.referenceImagePath}`)
        const result = await this.generateWithReference(styledPrompt, request.referenceImagePath, imageSize)
        debugLog(`[Media/Image] generateWithReference result: ${result ? `${result.length} bytes` : 'null'}`)
        return result
      }

      debugLog(`[Media/Image] No reference image, using direct generation`)
      const result = await this.generateDirect(styledPrompt, imageSize)
      debugLog(`[Media/Image] generateDirect result: ${result ? `${result.length} bytes` : 'null'}`)
      return result
    } catch (err) {
      debugLog(`[Media/Image] Generation FAILED: ${err instanceof Error ? err.stack : err}`)
      return null
    }
  }

  private buildImagePrompt(request: SelfieRequest): string {
    // Scene photos (no referenceImagePath) get a different prompt style
    const isScenePhoto = !request.referenceImagePath && request.style === 'location'

    if (isScenePhoto) {
      // Scene photo — no selfie prefix, no face description, just the scene
      return [
        request.prompt,
        'shot on iPhone 15 Pro, raw unedited photo',
        'realistic natural lighting, authentic smartphone photo',
        'no AI artifacts, not illustrated, not rendered, high quality',
      ].filter(Boolean).join(', ')
    }

    // Selfie/portrait photos — include face and style prefix
    const stylePrefix: Record<NonNullable<SelfieRequest['style']>, string> = {
      casual: 'casual selfie shot on iPhone, natural lighting, front-facing camera, authentic candid photo, slightly off-center framing',
      mirror: 'full body mirror selfie shot on iPhone, outfit visible, natural indoor lighting, vertical framing, raw photo',
      'close-up': 'close-up selfie portrait shot on iPhone, shallow depth of field, warm golden hour lighting, front camera distortion, raw photo',
      location: 'selfie at a scenic location shot on iPhone, environment visible in background, candid travel photo, natural lighting',
    }

    const prefix = stylePrefix[request.style ?? 'casual']
    const appearance = request.characterDescription ?? ''
    const mainPrompt = request.prompt

    return [
      prefix,
      appearance,
      mainPrompt,
      // Photorealism anchors — critical for avoiding AI look
      'shot on iPhone 15 Pro, raw unedited photo, natural skin texture with pores and imperfections',
      'no makeup filter, no beauty mode, realistic lighting, slight lens distortion',
      'no AI artifacts, not illustrated, not rendered, authentic smartphone photo',
    ].filter(Boolean).join(', ')
  }

  /**
   * Returns fal.ai string preset for image size.
   * Uses portrait_4_3 for casual/close-up selfies (like Instagram portrait).
   * Uses portrait_16_9 for mirror/location shots (like phone screen).
   * NEVER returns square — real phone photos are always portrait.
   */
  private getImageSizePreset(request: SelfieRequest): FalImageSize {
    // Scene photos (no reference) should use landscape ratio
    const isScenePhoto = !request.referenceImagePath && request.style === 'location'
    if (isScenePhoto) return 'landscape_16_9'

    const ratio = request.aspectRatio ?? this.defaultRatioForStyle(request.style)
    switch (ratio) {
      case '9:16': return 'portrait_16_9'
      case '4:5':  return 'portrait_4_3'
      default:     return 'portrait_4_3'
    }
  }

  private defaultRatioForStyle(style?: string): '4:5' | '9:16' {
    switch (style) {
      case 'mirror':   return '9:16'
      case 'location': return '9:16'
      case 'casual':   return '4:5'
      case 'close-up': return '4:5'
      default:         return '4:5'
    }
  }

  /**
   * Reference-based generation with face consistency.
   * Tries models in order: PuLID → InstantCharacter → IP-Adapter (fallback).
   */
  private async generateWithReference(prompt: string, imagePath: string, imageSize: FalImageSize): Promise<Buffer | null> {
    const imageData = readFileSync(imagePath)
    const base64Image = `data:image/jpeg;base64,${imageData.toString('base64')}`
    const dims = this.presetToPixels(imageSize)

    const refModel = this.config.referenceModel ?? 'fal-ai/flux-pulid'

    // Try PuLID (FLUX-based, best quality)
    if (refModel === 'fal-ai/flux-pulid') {
      const result = await this.tryPuLID(prompt, base64Image, imageSize)
      if (result) return result
      debugLog(`[Media/Image] PuLID failed, falling back to InstantCharacter`)
    }

    // Try InstantCharacter
    if (refModel === 'fal-ai/instant-character' || refModel === 'fal-ai/flux-pulid') {
      const result = await this.tryInstantCharacter(prompt, base64Image, imageSize)
      if (result) return result
      debugLog(`[Media/Image] InstantCharacter failed, falling back to IP-Adapter`)
    }

    // Fallback: IP-Adapter face-id (legacy)
    return await this.tryIPAdapter(prompt, base64Image, dims)
  }

  /**
   * PuLID: FLUX-based tuning-free face consistency.
   * Best photorealism with single reference image.
   */
  private async tryPuLID(prompt: string, referenceImageUrl: string, imageSize: FalImageSize): Promise<Buffer | null> {
    try {
      debugLog(`[Media/Image] Trying fal-ai/flux-pulid`)

      const result = await falQueueRun('fal-ai/flux-pulid', {
        prompt,
        reference_image_url: referenceImageUrl,
        image_size: imageSize,
        guidance_scale: 4,
        num_inference_steps: 20,
        id_weight: 0.5,  // lower = better looking, more prompt-following; higher = more face-locked
      }, this.config.falKey!)

      debugLog(`[Media/Image] PuLID result keys: ${JSON.stringify(Object.keys(result))}`)
      return this.extractImageFromResult(result, 'PuLID')
    } catch (err) {
      debugLog(`[Media/Image] PuLID error: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  /**
   * InstantCharacter: character consistency across poses and scenes.
   */
  private async tryInstantCharacter(prompt: string, imageUrl: string, imageSize: FalImageSize): Promise<Buffer | null> {
    try {
      debugLog(`[Media/Image] Trying fal-ai/instant-character`)

      const result = await falQueueRun('fal-ai/instant-character', {
        prompt,
        image_url: imageUrl,
        image_size: imageSize,
        guidance_scale: 3.5,
        num_inference_steps: 28,
        scale: 1.0,
        num_images: 1,
        output_format: 'jpeg',
      }, this.config.falKey!)

      debugLog(`[Media/Image] InstantCharacter result keys: ${JSON.stringify(Object.keys(result))}`)
      return this.extractImageFromResult(result, 'InstantCharacter')
    } catch (err) {
      debugLog(`[Media/Image] InstantCharacter error: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  /**
   * IP-Adapter face-id: legacy SD-based fallback.
   */
  private async tryIPAdapter(prompt: string, base64Image: string, dims: { width: number; height: number }): Promise<Buffer | null> {
    try {
      debugLog(`[Media/Image] Trying fal-ai/ip-adapter-face-id (legacy fallback): ${dims.width}x${dims.height}`)

      const result = await falQueueRun('fal-ai/ip-adapter-face-id', {
        prompt,
        face_image_url: base64Image,
        guidance_scale: 7.5,
        num_inference_steps: 30,
        width: dims.width,
        height: dims.height,
      }, this.config.falKey!)

      debugLog(`[Media/Image] IP-Adapter result keys: ${JSON.stringify(Object.keys(result))}`)
      return this.extractImageFromResult(result, 'IP-Adapter')
    } catch (err) {
      debugLog(`[Media/Image] IP-Adapter error: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  /**
   * Direct generation without reference image.
   * Tries Nano Banana first, falls back to FLUX Realism.
   */
  private async generateDirect(prompt: string, imageSize: FalImageSize): Promise<Buffer | null> {
    const model = this.config.model ?? 'fal-ai/nano-banana'

    // Try primary model
    const result = await this.tryDirectModel(prompt, imageSize, model)
    if (result) return result

    // Fallback to flux-realism if primary fails
    if (model !== 'fal-ai/flux-realism') {
      debugLog(`[Media/Image] ${model} failed, falling back to fal-ai/flux-realism`)
      return await this.tryDirectModel(prompt, imageSize, 'fal-ai/flux-realism')
    }

    return null
  }

  private async tryDirectModel(prompt: string, imageSize: FalImageSize, model: string): Promise<Buffer | null> {
    try {
      debugLog(`[Media/Image] Trying direct model: ${model}`)

      // Nano Banana uses aspect_ratio string instead of image_size preset
      const isNanoBanana = model.includes('nano-banana')
      const aspectRatio = this.imageSizeToAspectRatio(imageSize)

      const input: Record<string, any> = {
        prompt,
        num_images: 1,
        output_format: 'jpeg',
      }

      if (isNanoBanana) {
        input.aspect_ratio = aspectRatio
      } else {
        input.image_size = imageSize
        input.guidance_scale = 3.5
        input.num_inference_steps = 28
      }

      const result = await falQueueRun(model, input, this.config.falKey!)

      debugLog(`[Media/Image] ${model} result keys: ${JSON.stringify(Object.keys(result))}`)
      return this.extractImageFromResult(result, model)
    } catch (err) {
      debugLog(`[Media/Image] ${model} error: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  /**
   * Extract image URL from various FAL response shapes.
   * Different models return different structures.
   */
  private async extractImageFromResult(result: any, modelName: string): Promise<Buffer | null> {
    // Direct REST API returns flat structure (no data wrapper)
    const imageUrl = result?.images?.[0]?.url
      ?? result?.image?.url
      ?? result?.data?.images?.[0]?.url
      ?? result?.data?.image?.url

    if (!imageUrl) {
      debugLog(`[Media/Image] ${modelName}: no image URL in result: ${JSON.stringify(result).slice(0, 500)}`)
      return null
    }

    debugLog(`[Media/Image] ${modelName}: downloading from ${imageUrl.slice(0, 80)}...`)
    return await fetchImageAsBuffer(imageUrl)
  }

  private imageSizeToAspectRatio(imageSize: FalImageSize): string {
    switch (imageSize) {
      case 'portrait_4_3':  return '3:4'
      case 'portrait_16_9': return '9:16'
      case 'square_hd':     return '1:1'
      case 'square':        return '1:1'
      case 'landscape_4_3': return '4:3'
      case 'landscape_16_9': return '16:9'
      default:              return '3:4'
    }
  }

  private presetToPixels(preset: FalImageSize): { width: number; height: number } {
    switch (preset) {
      case 'portrait_4_3':  return { width: 768, height: 1024 }
      case 'portrait_16_9': return { width: 576, height: 1024 }
      case 'square_hd':     return { width: 1024, height: 1024 }
      case 'square':        return { width: 512, height: 512 }
      case 'landscape_4_3': return { width: 1024, height: 768 }
      case 'landscape_16_9': return { width: 1024, height: 576 }
      default:              return { width: 768, height: 1024 }
    }
  }
}

async function fetchImageAsBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url)
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
