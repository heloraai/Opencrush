/**
 * Character Creation — Three paths + sculpting + portrait generation
 *
 * Path A (30 sec–3 min): Pick archetype → sculpt look → generate portrait → done
 * Path B (2–5 min):      Describe in words → AI generates everything → portrait
 * Path C (advanced):     Start blank, edit files yourself
 *
 * Design principle: "light input, strong completion"
 * The sculpting phase makes users feel they created something real.
 * The portrait makes it undeniable.
 */

import inquirer from 'inquirer'
import chalk from 'chalk'
import ora from 'ora'
import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync } from 'fs'
import { join, extname } from 'path'
import { exec } from 'child_process'
import { PRESETS, CharacterPreset, AppearanceConfig } from './presets.js'

const ROOT_DIR = process.cwd()

export interface CreatedCharacter {
  folderName: string
  displayName: string
  gender: 'female' | 'male' | 'nonbinary'
  hasPortrait: boolean
  falKey?: string  // collected during portrait step if not already in env
}

interface SculptedConfig {
  name: string
  gender: 'female' | 'male' | 'nonbinary'
  archetype: CharacterPreset
  appearance: AppearanceConfig
  personality: string[]
  backstory: string
}

// ── HAIR / EYE / SKIN / BODY / FEATURE / FASHION OPTIONS ──────────────────

const HAIR_COLORS = [
  'Jet black',
  'Dark brown',
  'Warm honey brown',
  'Platinum blonde',
  'Rose pink',
  'Cherry red / deep burgundy',
  'Midnight blue-black',
  'Ash silver / grey',
  'Warm auburn / chestnut',
  'Two-tone (dark roots, light ends)',
]

const EYE_COLORS = [
  'Deep dark brown',
  'Warm honey amber',
  'Forest green',
  'Ice blue / steel grey',
  'Violet / amethyst',
  'Golden cat-eye',
]

const SKIN_TONES = [
  'Porcelain / pale fair',
  'Ivory / light warm',
  'Honey / warm medium',
  'Caramel / olive medium',
  'Deep golden brown',
]

const BODY_TYPES = [
  'Petite and delicate',
  'Slender and tall',
  'Athletic and toned',
  'Curvy and full',
  'Lean and angular',
]

const SIGNATURE_FEATURES = [
  'Beauty mark near the lip',
  'Freckles across the nose',
  'Fox-eye upturned shape',
  'Long elegant eyelashes',
  'Sharp defined jawline',
  'Soft round cheeks',
  'Double eyelid, very expressive',
  'High cheekbones',
  'Dimples when smiling',
  'Small nose ring',
  'Visible collarbone',
  'Tattoo (partial or small)',
  'Expressive arched eyebrows',
]

const FASHION_STYLES = [
  'K-pop stage glam — polished, idol-ready, elegant',
  'Y2K throwback — butterfly clips, crop tops, low rise',
  'Dark academia — plaid, cardigans, vintage',
  'Streetwear — oversized fits, sneakers, caps',
  'Corporate siren — power blazers, minimal jewelry',
  'Soft cottagecore — floral, linen, sundresses',
  'Cyberpunk neon — tech wear, asymmetric, LED accessories',
  'Gothic lolita — layered lace, dark florals, Victorian',
  'Effortless grunge — band tees, ripped denim, silver rings',
  'Ethereal fairy — sheer, flowy, natural earthy tones',
]

const PERSONALITY_TRAITS = [
  'Tsundere — cold outside, warm inside',
  'Yandere-lite — devoted, a little intense',
  'Kuudere — cool and calm, secretly emotional',
  'Chaotic good — unpredictable but always on your side',
  'Big sister energy — protective, checks on you',
  'Little devil — teases constantly, means no harm (much)',
  'Quietly dangerous — you underestimate until you don\'t',
  'Scholar type — always analyzing, reads the room',
  'Sun energy — genuinely warm, lifts the mood',
  'Melancholic romantic — feels everything deeply',
  'No-filter — says exactly what she thinks',
  'Gentle guardian — soft but fierce when it matters',
]

// ── MAIN ENTRY ─────────────────────────────────────────────────────────────

export async function createCharacterFlow(
  llmApiKey?: string,
  llmProvider?: string
): Promise<CreatedCharacter> {
  console.log(chalk.magenta('\n  💝 Create your companion\n'))

  const { path } = await inquirer.prompt([{
    type: 'list',
    name: 'path',
    message: 'How do you want to create your companion?',
    choices: [
      {
        name: '⚡  Pick an archetype — sculpt the look, generate a portrait',
        value: 'preset',
        short: 'Archetype',
      },
      {
        name: '✍️   Describe them — AI builds the full character from your words',
        value: 'describe',
        short: 'Describe',
      },
      {
        name: '📁  Start blank — I\'ll edit the files myself',
        value: 'blank',
        short: 'Blank',
      },
    ],
  }])

  switch (path) {
    case 'preset':   return createFromPreset(llmApiKey, llmProvider)
    case 'describe': return createFromDescription(llmApiKey, llmProvider)
    case 'blank':    return createBlank()
  }
  throw new Error('unreachable')
}

// ── PATH A: ARCHETYPE + SCULPTING ──────────────────────────────────────────

async function createFromPreset(
  apiKey?: string,
  provider?: string
): Promise<CreatedCharacter> {

  // 1. Pick archetype
  console.log(chalk.gray('\n  Pick your archetype. Everything else is customizable.\n'))

  const { presetId } = await inquirer.prompt([{
    type: 'list',
    name: 'presetId',
    message: 'Choose an archetype:',
    choices: PRESETS.map(p => ({
      name: `${p.emoji}  ${p.label}\n     ${chalk.gray(p.tagline)}`,
      value: p.id,
      short: p.label,
    })),
  }])

  const preset = PRESETS.find(p => p.id === presetId)!

  // 2. Name
  const defaultName = preset.id.charAt(0).toUpperCase() + preset.id.slice(1)
  const { customName } = await inquirer.prompt([{
    type: 'input',
    name: 'customName',
    message: 'Name your companion:',
    default: defaultName,
  }])

  const displayName = customName.trim() || defaultName
  const folderName = displayName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')

  // 3. Sculpt
  const { wantSculpt } = await inquirer.prompt([{
    type: 'list',
    name: 'wantSculpt',
    message: 'How do you want to proceed?',
    choices: [
      { name: '⚡ Use default look — start immediately', value: false },
      { name: '🎨 Sculpt the look — customize appearance, personality, backstory', value: true },
    ],
  }])

  let appearance: AppearanceConfig = { ...preset.defaultAppearance }
  let personality: string[] = [...preset.personalityDefaults]
  let backstory = ''

  if (wantSculpt) {
    console.log(chalk.cyan('\n  ── Sculpting ───────────────────────────────────────\n'))
    appearance = await sculptAppearance(preset)
    personality = await pickPersonality(preset)
    backstory = await pickBackstory(preset)
  }

  const config: SculptedConfig = {
    name: displayName,
    gender: preset.gender,
    archetype: preset,
    appearance,
    personality,
    backstory,
  }

  // 4. Portrait
  const spinner = ora('Saving character files...').start()
  const blueprint = buildBlueprintFromPreset(config)
  writeCharacterFiles(folderName, blueprint)
  spinner.succeed(chalk.green(`${displayName} created!`))

  const { hasPortrait, falKey } = await craftPortrait(config, folderName, apiKey, provider)

  printCreationSuccess(folderName, displayName)
  return { folderName, displayName, gender: preset.gender, hasPortrait, falKey }
}

// ── SCULPTING HELPERS ──────────────────────────────────────────────────────

/**
 * List picker that always includes a "✏️ Type your own..." escape hatch.
 */
async function selectOrType(
  message: string,
  choices: string[],
  defaultValue?: string
): Promise<string> {
  const CUSTOM = '__custom__'
  const { value } = await inquirer.prompt([{
    type: 'list',
    name: 'value',
    message,
    choices: [
      ...choices.map(c => ({ name: c, value: c.toLowerCase() })),
      new (inquirer as any).Separator(),
      { name: '✏️  Type your own...', value: CUSTOM },
    ],
    default: defaultValue ?? choices[0].toLowerCase(),
  }])

  if (value !== CUSTOM) return value

  const label = message.replace(':', '').toLowerCase()
  const { custom } = await inquirer.prompt([{
    type: 'input',
    name: 'custom',
    message: `Enter custom ${label}:`,
    validate: (v: string) => v.trim().length > 0 ? true : 'Required',
  }])
  return custom.trim()
}

/**
 * Checkbox picker + optional free-text additions.
 */
async function checkboxPlusCustom(
  message: string,
  choices: string[],
  defaultChecked: string[],
  max: number
): Promise<string[]> {
  const { selected } = await inquirer.prompt([{
    type: 'checkbox',
    name: 'selected',
    message: `${message} (pick up to ${max}):`,
    choices: choices.map(c => ({
      name: c,
      value: c,
      checked: defaultChecked.some(d =>
        c.toLowerCase().split(' — ')[0].includes(d.toLowerCase().split(' ')[0])
      ),
    })),
    validate: (v: string[]) =>
      v.length <= max ? true : `Pick at most ${max}`,
  }])

  // Allow free-form custom additions (up to remaining slots)
  const remaining = max - selected.length
  if (remaining > 0) {
    const { customInput } = await inquirer.prompt([{
      type: 'input',
      name: 'customInput',
      message: chalk.gray(`Add custom options (comma-separated, max ${remaining} more — press Enter to skip):`),
    }])
    if (customInput.trim()) {
      const extras = customInput.split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
        .slice(0, remaining)
      return [...selected, ...extras]
    }
  }

  return selected
}

// ── SCULPTING PHASE ────────────────────────────────────────────────────────

async function sculptAppearance(preset: CharacterPreset): Promise<AppearanceConfig> {
  console.log(chalk.bold('  👁  Appearance\n'))

  const hairColor = await selectOrType('Hair color:', HAIR_COLORS, preset.defaultAppearance.hairColor)
  const eyeColor  = await selectOrType('Eye color:',  EYE_COLORS,  preset.defaultAppearance.eyeColor)
  const skinTone  = await selectOrType('Skin tone:',  SKIN_TONES,  preset.defaultAppearance.skinTone)
  const bodyType  = await selectOrType('Body type:',  BODY_TYPES,  preset.defaultAppearance.bodyType)

  const features = await checkboxPlusCustom(
    'Signature features',
    SIGNATURE_FEATURES,
    preset.defaultAppearance.features,
    3
  )

  const fashionStyle = await selectOrType(
    'Fashion style:',
    FASHION_STYLES.map(s => s.split(' — ')[0]),
    preset.defaultAppearance.fashionStyle
  )

  return { hairColor, eyeColor, skinTone, bodyType, features, fashionStyle }
}

async function pickPersonality(preset: CharacterPreset): Promise<string[]> {
  console.log(chalk.bold('\n  💫  Personality\n'))

  return checkboxPlusCustom(
    'Core personality traits (pick 2–4)',
    PERSONALITY_TRAITS,
    preset.personalityDefaults,
    4
  )
}

async function pickBackstory(preset: CharacterPreset): Promise<string> {
  console.log(chalk.bold('\n  📖  Backstory\n'))
  console.log(chalk.gray('  Pick the defining moment. It shapes who they are now.\n'))

  const { backstory } = await inquirer.prompt([{
    type: 'list',
    name: 'backstory',
    message: 'Pick a key backstory moment:',
    choices: [
      ...preset.backstoryOptions.map(b => ({ name: b, value: b })),
      { name: '✏️  Write my own...', value: '__custom__' },
      { name: '⏭️  Skip for now', value: '' },
    ],
  }])

  if (backstory === '__custom__') {
    const { customBackstory } = await inquirer.prompt([{
      type: 'input',
      name: 'customBackstory',
      message: 'Describe the key moment (1-2 sentences):',
    }])
    return customBackstory
  }

  return backstory
}

// ── PORTRAIT GENERATION ────────────────────────────────────────────────────

async function craftPortrait(
  config: SculptedConfig,
  folderName: string,
  apiKey?: string,
  provider?: string
): Promise<{ hasPortrait: boolean; falKey?: string }> {

  console.log(chalk.bold('\n  📸  Portrait\n'))
  console.log(chalk.gray(`  A portrait image makes ${config.name} feel real — and enables visual selfies.\n`))

  const { choice } = await inquirer.prompt([{
    type: 'list',
    name: 'choice',
    message: 'How do you want to create the portrait?',
    choices: [
      { name: '🎨 Generate with AI  (fal.ai — free credits on signup)', value: 'generate' },
      { name: '📷 Upload a reference photo', value: 'upload' },
      { name: '⏭️  Skip — add portrait later', value: 'skip' },
    ],
  }])

  if (choice === 'skip') {
    console.log(chalk.gray(`  → Add reference.jpg to characters/${folderName}/ anytime\n`))
    return { hasPortrait: false }
  }

  if (choice === 'upload') {
    const uploaded = await promptForPhotoUpload(folderName, config.name)
    return { hasPortrait: uploaded }
  }

  // Generate with fal.ai
  let falKey = process.env.FAL_KEY

  if (!falKey) {
    console.log(chalk.yellow('\n  👉 Get a free fal.ai key at: https://fal.ai → Dashboard → API Keys\n'))
    const { inputKey } = await inquirer.prompt([{
      type: 'password',
      name: 'inputKey',
      message: 'Paste your fal.ai API key (or press Enter to skip):',
      mask: '*',
    }])
    if (!inputKey) {
      console.log(chalk.gray('  Skipping portrait — add FAL_KEY to .env and run: pnpm create-character\n'))
      return { hasPortrait: false }
    }
    falKey = inputKey
  }

  // Build and optionally AI-optimize the prompt
  const basePrompt = buildPortraitPrompt(config)
  let finalPrompt = basePrompt

  if (apiKey) {
    const optimizeSpinner = ora('✨ AI is crafting the portrait prompt...').start()
    try {
      finalPrompt = await optimizePortraitPrompt(basePrompt, config, apiKey, provider ?? 'anthropic')
      optimizeSpinner.succeed('Portrait prompt ready')
    } catch {
      optimizeSpinner.warn('Using base prompt (AI optimization failed)')
    }
  }

  console.log(chalk.gray(`\n  Portrait prompt:\n  ${chalk.italic(finalPrompt.slice(0, 120))}...\n`))

  // Generate loop
  const destPath = join(ROOT_DIR, 'characters', folderName, 'reference.jpg')
  let attempts = 0

  while (attempts < 3) {
    const genSpinner = ora('🎨 Generating portrait... (15–25 seconds)').start()
    try {
      const imageUrl = await callFalGenerate(finalPrompt, falKey)
      await downloadImage(imageUrl, destPath)
      genSpinner.succeed(chalk.green('Portrait generated!'))

      // Try to open it
      openImage(destPath)
      console.log(chalk.cyan(`  → Opening portrait: characters/${folderName}/reference.jpg\n`))

      const { happy } = await inquirer.prompt([{
        type: 'list',
        name: 'happy',
        message: 'How does the portrait look?',
        choices: [
          { name: '✅ Perfect — continue', value: 'yes' },
          { name: '🔄 Generate again (different random seed)', value: 'regen' },
          { name: '📷 Replace with my own photo', value: 'upload' },
          { name: '⏭️  Use this one anyway', value: 'yes' },
        ],
      }])

      if (happy === 'regen') {
        attempts++
        continue
      }

      if (happy === 'upload') {
        await promptForPhotoUpload(folderName, config.name)
      }

      break

    } catch (err: any) {
      genSpinner.fail('Generation failed')
      console.log(chalk.red(`  Error: ${err.message}`))

      const { retry } = await inquirer.prompt([{
        type: 'confirm',
        name: 'retry',
        message: 'Try again?',
        default: true,
      }])

      if (!retry) {
        return { hasPortrait: false, falKey }
      }
      attempts++
    }
  }

  // Save the portrait prompt so user can regenerate later
  writeFileSync(
    join(ROOT_DIR, 'characters', folderName, 'portrait-prompt.txt'),
    finalPrompt,
    'utf-8'
  )

  return { hasPortrait: true, falKey }
}

function buildPortraitPrompt(config: SculptedConfig): string {
  const { appearance, archetype, gender, personality } = config

  const subject = gender === 'nonbinary' ? 'person' : gender === 'male' ? 'man' : 'woman'
  const vibeHints = personality.slice(0, 2).map(p => p.split(' — ')[0].toLowerCase()).join(', ')

  const parts = [
    `ultra-detailed portrait of a ${appearance.bodyType} ${subject}`,
    `${appearance.hairColor} hair`,
    `${appearance.eyeColor} eyes`,
    `${appearance.skinTone} skin tone`,
    appearance.features.length > 0 ? appearance.features.join(', ') : '',
    `wearing ${appearance.fashionStyle} style`,
    archetype.portraitBase,
    vibeHints,
    'cinematic photography, ultra-detailed, 8k resolution, professional studio lighting, beautiful, editorial fashion, sharp focus',
  ]

  return parts.filter(Boolean).join(', ')
}

async function optimizePortraitPrompt(
  basePrompt: string,
  config: SculptedConfig,
  apiKey: string,
  provider: string
): Promise<string> {
  const system = `You are an expert at writing image generation prompts for portrait photography.
Given a character description and base prompt, write an optimized FLUX/Stable Diffusion prompt.
Rules: under 200 words, focus on visual details only, include quality tags, match the character's aesthetic.
Return ONLY the prompt text — no explanation, no quotes.`

  const userMsg = `Character: ${config.name}, ${config.gender}
Archetype: ${config.archetype.label}
Base prompt: ${basePrompt}

Optimize this into a vivid, effective portrait generation prompt. Preserve all physical details.`

  try {
    if (provider === 'anthropic') {
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const client = new Anthropic({ apiKey })
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: userMsg }],
      })
      const block = resp.content[0]
      if (block.type === 'text') return block.text.trim()
    }

    if (provider === 'openai') {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey })
      const resp = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
      })
      return resp.choices[0]?.message?.content?.trim() ?? basePrompt
    }
  } catch {
    // fall through to return basePrompt
  }

  return basePrompt
}

async function callFalGenerate(prompt: string, falKey: string): Promise<string> {
  const resp = await fetch('https://fal.run/fal-ai/flux/dev', {
    method: 'POST',
    headers: {
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      image_size: 'portrait_4_3',
      num_inference_steps: 28,
      num_images: 1,
      enable_safety_checker: true,
    }),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`fal.ai error (${resp.status}): ${body.slice(0, 200)}`)
  }

  const data = await resp.json() as { images: Array<{ url: string }> }
  if (!data.images?.[0]?.url) throw new Error('fal.ai returned no image URL')
  return data.images[0].url
}

async function downloadImage(url: string, dest: string): Promise<void> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Image download failed (${resp.status})`)
  const buf = await resp.arrayBuffer()
  writeFileSync(dest, Buffer.from(buf))
}

function openImage(filePath: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${filePath}"` :
    process.platform === 'win32'  ? `start "" "${filePath}"` :
    `xdg-open "${filePath}"`
  exec(cmd, () => { /* ignore errors */ })
}

// ── BUILD BLUEPRINT FROM PRESET + SCULPTING ────────────────────────────────

function buildBlueprintFromPreset(config: SculptedConfig): {
  identity: string; soul: string; user: string; memory: string
} {
  const { archetype, name, appearance, personality, backstory } = config

  // Replace default name with chosen name in all files
  const renameIn = (text: string) =>
    text
      .replace(new RegExp(`# ${escapeRegex(archetype.id.charAt(0).toUpperCase() + archetype.id.slice(1))}`, 'g'), `# ${name}`)
      .replace(new RegExp(`\\b${escapeRegex(archetype.id)}\\b`, 'gi'), name)
      .replace(new RegExp(`\\b(Yuna|Valentina|Hana|Nyx|Hu Lan|Riot|Kai|Eli)\\b`, 'g'), name)

  // Identity: replace appearance section with sculpted version
  let identity = renameIn(archetype.identity)
  const appearanceBlock = buildAppearanceBlock(appearance)

  if (identity.includes('## Appearance')) {
    identity = identity.replace(/## Appearance[\s\S]*$/, `## Appearance\n\n${appearanceBlock}`)
  } else {
    identity += `\n\n## Appearance\n\n${appearanceBlock}`
  }

  // Soul: prepend personality traits section
  const traitsBlock = `## Core Personality Traits\n\n${personality.map(t => `- ${t}`).join('\n')}`
  const soul = traitsBlock + '\n\n' + renameIn(archetype.soul)

  // User: rename only
  const user = renameIn(archetype.user)

  // Memory: prepend backstory if chosen
  let memory = renameIn(archetype.memory)
  if (backstory) {
    memory = `## Origin Moment\n\n${backstory}\n\n---\n\n` + memory
  }

  return { identity, soul, user, memory }
}

function buildAppearanceBlock(app: AppearanceConfig): string {
  const lines: string[] = []
  lines.push(`${capitalize(app.hairColor)} hair. ${capitalize(app.eyeColor)} eyes.`)
  lines.push(`${capitalize(app.skinTone)} skin. ${capitalize(app.bodyType)} build.`)
  if (app.features.length > 0) {
    lines.push(`Signature: ${app.features.map(capitalize).join(', ')}.`)
  }
  lines.push(`Style: ${capitalize(app.fashionStyle)}.`)
  return lines.join('\n')
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── PATH B: AI DESCRIPTION ─────────────────────────────────────────────────

async function createFromDescription(
  apiKey?: string,
  provider?: string
): Promise<CreatedCharacter> {

  if (!apiKey) {
    console.log(chalk.yellow('\n  ℹ️  No API key found yet — using template generation instead.'))
    console.log(chalk.gray('  Add ANTHROPIC_API_KEY to .env for AI-powered generation.\n'))
    return createFromPromptTemplate()
  }

  console.log(chalk.gray('\n  Just describe who you want. The AI will build everything else.\n'))
  console.log(chalk.gray('  Examples:'))
  console.log(chalk.gray('  "A 25-year-old Japanese jazz musician who is secretly shy"'))
  console.log(chalk.gray('  "A Korean idol trainee who never made it but became a barista"'))
  console.log(chalk.gray('  "A Berlin-based painter with dark humor and a complicated past"\n'))

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: "What's their name?",
      validate: (v: string) => v.trim().length > 0 ? true : 'Name is required',
    },
    {
      type: 'list',
      name: 'gender',
      message: 'Gender:',
      choices: [
        { name: '👩 Female', value: 'female' },
        { name: '👨 Male', value: 'male' },
        { name: '🌈 Non-binary', value: 'nonbinary' },
      ],
    },
    {
      type: 'input',
      name: 'description',
      message: 'Describe them in 1–3 sentences:\n  → ',
      validate: (v: string) => v.trim().length > 10 ? true : 'Tell me a bit more',
    },
    {
      type: 'input',
      name: 'relationship',
      message: 'Your relationship with them:',
      default: 'Close friends who talk almost every day',
    },
  ])

  const spinner = ora('AI is building your companion...').start()

  try {
    const blueprint = await generateBlueprintWithAI(answers, apiKey, provider)
    const folderName = answers.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')

    writeCharacterFiles(folderName, blueprint)
    spinner.succeed(chalk.green(`${answers.name} created!`))

    // Soul preview
    console.log('\n' + chalk.gray('  ── Soul preview ──────────────────────────'))
    const preview = blueprint.soul.split('\n').slice(0, 7).map((l: string) => '  ' + l).join('\n')
    console.log(chalk.white(preview))
    console.log(chalk.gray('  ──────────────────────────────────────────\n'))

    const { happy } = await inquirer.prompt([{
      type: 'confirm',
      name: 'happy',
      message: 'Does this feel right?',
      default: true,
    }])

    if (!happy) {
      spinner.start('Regenerating with a different angle...')
      const blueprint2 = await generateBlueprintWithAI(answers, apiKey, provider)
      writeCharacterFiles(folderName, blueprint2)
      spinner.succeed('Regenerated!')
    }

    // Portrait
    const mockConfig: SculptedConfig = {
      name: answers.name,
      gender: answers.gender as 'female' | 'male' | 'nonbinary',
      archetype: PRESETS[0], // placeholder
      appearance: {
        hairColor: 'natural',
        eyeColor: 'natural',
        skinTone: 'natural',
        bodyType: 'average',
        features: [],
        fashionStyle: 'casual',
      },
      personality: [],
      backstory: '',
    }
    const { hasPortrait, falKey } = await craftPortrait(mockConfig, folderName, apiKey, provider)

    printCreationSuccess(folderName, answers.name)
    return {
      folderName,
      displayName: answers.name,
      gender: answers.gender as 'female' | 'male' | 'nonbinary',
      hasPortrait,
      falKey,
    }

  } catch (err: any) {
    spinner.fail('AI generation failed')
    console.log(chalk.yellow('  Falling back to template generation...'))
    console.log(chalk.gray('  Error: ' + err.message + '\n'))
    return createFromPromptTemplate(answers)
  }
}

// ── PATH B FALLBACK: TEMPLATE (no API key) ─────────────────────────────────

async function createFromPromptTemplate(
  prefilled?: Record<string, string>
): Promise<CreatedCharacter> {
  const answers = prefilled ?? await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Name:',
      validate: (v: string) => v.trim().length > 0 ? true : 'Required',
    },
    {
      type: 'list',
      name: 'gender',
      message: 'Gender:',
      choices: [
        { name: '👩 Female', value: 'female' },
        { name: '👨 Male', value: 'male' },
        { name: '🌈 Non-binary', value: 'nonbinary' },
      ],
    },
    {
      type: 'input',
      name: 'description',
      message: 'Describe them briefly:',
    },
    {
      type: 'list',
      name: 'vibe',
      message: 'Overall vibe:',
      choices: [
        { name: '🌸 Warm & caring', value: 'warm' },
        { name: '⚡ Sharp & witty', value: 'witty' },
        { name: '🌙 Quiet & deep', value: 'quiet' },
        { name: '☀️ Bright & energetic', value: 'bright' },
        { name: '🔮 Mysterious & intense', value: 'mysterious' },
      ],
    },
    {
      type: 'input',
      name: 'hobbies',
      message: 'What do they love? (comma-separated)',
      default: 'music, movies, late-night conversations',
    },
  ])

  const folderName = answers.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
  const spinner = ora(`Creating ${answers.name}...`).start()
  const blueprint = buildTemplateBlueprint(answers)
  writeCharacterFiles(folderName, blueprint)
  spinner.succeed(chalk.green(`${answers.name} created!`))

  printCreationSuccess(folderName, answers.name)
  return {
    folderName,
    displayName: answers.name,
    gender: answers.gender as 'female' | 'male' | 'nonbinary',
    hasPortrait: false,
  }
}

// ── PATH C: BLANK ──────────────────────────────────────────────────────────

async function createBlank(): Promise<CreatedCharacter> {
  const { name, gender } = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Character name:',
      validate: (v: string) => v.trim().length > 0 ? true : 'Required',
    },
    {
      type: 'list',
      name: 'gender',
      message: 'Gender:',
      choices: [
        { name: '👩 Female', value: 'female' },
        { name: '👨 Male', value: 'male' },
        { name: '🌈 Non-binary', value: 'nonbinary' },
      ],
    },
  ])

  const folderName = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
  const dir = join(ROOT_DIR, 'characters', folderName)
  mkdirSync(dir, { recursive: true })

  const templatesDir = join(ROOT_DIR, 'templates')
  for (const file of ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
    const src = join(templatesDir, file)
    const dst = join(dir, file)
    if (existsSync(src)) {
      const content = readFileSync(src, 'utf-8').replace(/\{\{CHARACTER_NAME\}\}/g, name)
      writeFileSync(dst, content, 'utf-8')
    } else {
      writeFileSync(dst, `# ${file.replace('.md', '')}\n\nAdd content here.\n`, 'utf-8')
    }
  }

  console.log(chalk.cyan(`\n  ✓ Created characters/${folderName}/`))
  console.log(chalk.gray('  Edit the 4 markdown files to define your companion.'))
  console.log(chalk.gray('  Then run: pnpm start\n'))

  return { folderName, displayName: name, gender, hasPortrait: false }
}

// ── AI BLUEPRINT GENERATION ────────────────────────────────────────────────

async function generateBlueprintWithAI(
  answers: Record<string, string>,
  apiKey: string,
  provider = 'anthropic'
): Promise<{ identity: string; soul: string; user: string; memory: string }> {

  const system = `You are a creative writer specializing in rich, believable fictional companion characters.
Write characters that feel real and lived-in — specific details, genuine quirks, contradictions.
Avoid clichés. Make them feel like a person, not an archetype.`

  const prompt = `Create a companion character:
Name: ${answers.name}
Gender: ${answers.gender}
Description: ${answers.description}
Relationship with user: ${answers.relationship ?? 'Close friends'}

Generate exactly four sections with these exact headers:

===IDENTITY===
(Markdown with frontmatter. Include: age, city, job, languages, hobbies, appearance.
Start with:
---
gender: ${answers.gender}
language: en
timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}
---

# ${answers.name}
)

===SOUL===
(Voice, vibe, loves, dislikes, emotional patterns, speech quirks. Be specific.)

===USER===
(How they met the user, relationship dynamic, what they call each other.)

===MEMORY===
(Current state, obsessions, recent context with user.)

Be specific. Real people have contradictions. Make them feel alive.`

  let text = ''

  if (provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey })
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = resp.content[0]
    if (block.type !== 'text') throw new Error('Unexpected LLM response')
    text = block.text
  } else {
    const OpenAI = (await import('openai')).default
    const client = new OpenAI({ apiKey })
    const resp = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 2000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    })
    text = resp.choices[0]?.message?.content ?? ''
  }

  return parseAIResponse(text, answers.name, answers.gender)
}

function parseAIResponse(
  text: string,
  name: string,
  gender: string
): { identity: string; soul: string; user: string; memory: string } {
  const extract = (key: string) => {
    const m = text.match(new RegExp(`===\\s*${key}\\s*===\\s*([\\s\\S]*?)(?====\\w|$)`, 'i'))
    return m?.[1]?.trim() ?? ''
  }
  return {
    identity: extract('IDENTITY') || `---\ngender: ${gender}\nlanguage: en\n---\n\n# ${name}\n\n*(Add background here)*`,
    soul: extract('SOUL') || `## Voice & Vibe\n\n*(Add personality here)*`,
    user: extract('USER') || `## Our Dynamic\n\n*(Add relationship context here)*`,
    memory: extract('MEMORY') || `## Current State\n\n*(Add current context here)*`,
  }
}

// ── PHOTO UPLOAD ──────────────────────────────────────────────────────────

async function promptForPhotoUpload(folderName: string, displayName: string): Promise<boolean> {
  const { photoPath } = await inquirer.prompt([{
    type: 'input',
    name: 'photoPath',
    message: 'Drag the photo here (or paste path):',
    filter: (v: string) => v.trim().replace(/^['"]|['"]$/g, ''),
    validate: (v: string) => {
      const p = v.trim().replace(/^['"]|['"]$/g, '')
      if (!existsSync(p)) return 'File not found.'
      const ext = extname(p).toLowerCase()
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return 'Use JPG, PNG, or WebP'
      return true
    },
  }])

  const cleaned = photoPath.trim().replace(/^['"]|['"]$/g, '')
  const ext = extname(cleaned).toLowerCase()
  const dest = join(ROOT_DIR, 'characters', folderName, `reference${ext}`)
  copyFileSync(cleaned, dest)
  console.log(chalk.green(`  ✓ Photo saved as reference${ext}`))
  return true
}

// ── TEMPLATE FALLBACK BUILDER ──────────────────────────────────────────────

function buildTemplateBlueprint(answers: Record<string, string>): {
  identity: string; soul: string; user: string; memory: string
} {
  const vibeMap: Record<string, string> = {
    warm: 'Nurturing, emotionally available, remembers everything. Makes you feel seen.',
    witty: 'Quick humor, confident opinions, keeps you on your toes.',
    quiet: 'Thoughtful and precise. Says less, means more. Opens up slowly but genuinely.',
    bright: 'Enthusiastic about everything, lifts the mood, texts first.',
    mysterious: 'Complex and layered. You keep discovering new things.',
  }

  return {
    identity: `---
gender: ${answers.gender}
language: en
timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}
---

# ${answers.name}

${answers.description ?? ''}

**Hobbies:** ${answers.hobbies ?? 'various'}`,
    soul: `## Voice & Vibe

${vibeMap[answers.vibe] ?? 'Genuine and authentic.'}

## Loves

${(answers.hobbies ?? '').split(',').map((h: string) => h.trim()).join('\n')}

## Emotional Patterns

- Excited → shares it immediately
- Processing → gets quieter, comes back ready
- Comfortable → reveals more than expected`,
    user: `## Our Dynamic

${answers.relationship ?? 'Close friends who talk almost every day.'}`,
    memory: `## Current Obsessions

*(Updates as she lives her life)*`,
  }
}

// ── FILE WRITING ──────────────────────────────────────────────────────────

function writeCharacterFiles(
  folderName: string,
  blueprint: { identity: string; soul: string; user: string; memory: string }
): void {
  const dir = join(ROOT_DIR, 'characters', folderName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'IDENTITY.md'), blueprint.identity, 'utf-8')
  writeFileSync(join(dir, 'SOUL.md'), blueprint.soul, 'utf-8')
  writeFileSync(join(dir, 'USER.md'), blueprint.user, 'utf-8')
  writeFileSync(join(dir, 'MEMORY.md'), blueprint.memory, 'utf-8')
}

function printCreationSuccess(folderName: string, name: string): void {
  console.log()
  console.log(chalk.green(`  ✅ ${name} is ready!`))
  console.log(chalk.gray(`  Files: characters/${folderName}/`))
  console.log(chalk.gray(`  Edit personality anytime: characters/${folderName}/SOUL.md`))
  console.log()
}
