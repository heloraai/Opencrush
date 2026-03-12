/**
 * Image Generation Engine
 *
 * Generates character selfies with visual consistency.
 * Primary: fal.ai FLUX 2 Realism LoRA (photorealistic, portrait ratios)
 * Fallback: fal.ai flux-realism (original)
 *
 * Visual consistency strategy:
 *   - IP-Adapter reference image anchors face/style
 *   - Consistent style prefix in every prompt
 *   - Character appearance description from SOUL.md
 *
 * Aspect ratios: 4:5 (casual/close-up) or 9:16 (mirror/location)
 * NEVER generates 1:1 square images — always portrait like a real phone.
 */

import { fal } from '@fal-ai/client'
import { readFileSync, existsSync } from 'fs'

export interface ImageConfig {
  falKey?: string
  model?: string
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
    if (config.falKey) {
      fal.config({ credentials: config.falKey })
    }
  }

  async generateSelfie(request: SelfieRequest): Promise<Buffer | null> {
    if (!this.config.falKey) {
      console.warn('[Media/Image] No FAL_KEY configured — skipping image generation')
      return null
    }

    try {
      const styledPrompt = this.buildImagePrompt(request)
      const imageSize = this.getImageSizePreset(request)

      console.log(`[Media/Image] Generating: style=${request.style ?? 'casual'}, ratio=${imageSize}, model=${this.config.model ?? 'fal-ai/flux-realism'}`)

      if (request.referenceImagePath && existsSync(request.referenceImagePath)) {
        return await this.generateWithReference(styledPrompt, request.referenceImagePath, imageSize)
      }

      return await this.generateDirect(styledPrompt, imageSize)
    } catch (err) {
      console.error('[Media/Image] Generation failed:', err)
      return null
    }
  }

  private buildImagePrompt(request: SelfieRequest): string {
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
   * IP-Adapter face-id generation — uses reference image for face consistency.
   * Note: ip-adapter-face-id uses width/height numbers, not string presets.
   */
  private async generateWithReference(prompt: string, imagePath: string, imageSize: FalImageSize): Promise<Buffer | null> {
    const imageData = readFileSync(imagePath)
    const base64Image = `data:image/jpeg;base64,${imageData.toString('base64')}`

    // Convert string preset to pixel dimensions for ip-adapter
    const dims = this.presetToPixels(imageSize)

    const result = await fal.subscribe('fal-ai/ip-adapter-face-id', {
      input: {
        prompt,
        face_image_url: base64Image,
        guidance_scale: 7.5,
        num_inference_steps: 30,
        width: dims.width,
        height: dims.height,
      },
    }) as unknown as { images: Array<{ url: string }> }

    if (!result.images?.[0]?.url) return null
    return await fetchImageAsBuffer(result.images[0].url)
  }

  /**
   * Direct generation without reference image.
   * Uses FLUX Realism model with string preset for guaranteed correct aspect ratio.
   */
  private async generateDirect(prompt: string, imageSize: FalImageSize): Promise<Buffer | null> {
    const model = this.config.model ?? 'fal-ai/flux-realism'

    const result = await fal.subscribe(model, {
      input: {
        prompt,
        num_images: 1,
        image_size: imageSize,
        guidance_scale: 3.5,
        num_inference_steps: 28,
        output_format: 'jpeg',
      },
    }) as unknown as { images: Array<{ url: string }> }

    if (!result.images?.[0]?.url) return null
    return await fetchImageAsBuffer(result.images[0].url)
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
