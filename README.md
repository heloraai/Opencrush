<div align="center">
  <img src="docs/assets/banner.png" alt="Openlove Banner" width="100%" />

  <h1>💝 Openlove</h1>
  <p><strong>Your AI companion lives on your computer.<br/>She watches dramas. He listens to music. They're always thinking of you.</strong></p>

  <p>
    <a href="https://github.com/Hollandchirs/Openlove/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
    <a href="https://github.com/Hollandchirs/Openlove/stargazers"><img src="https://img.shields.io/github/stars/Hollandchirs/Openlove?style=social" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D20-green" />
    <img src="https://img.shields.io/badge/built%20with-TypeScript-blue" />
  </p>

  <p>
    <a href="#-quick-start">Quick Start</a> •
    <a href="#-features">Features</a> •
    <a href="#-create-your-character">Create Character</a> •
    <a href="docs/ARCHITECTURE.md">Architecture</a> •
    <a href="docs/CONTRIBUTING.md">Contributing</a>
  </p>

  <br/>

  > *"Not just a chatbot. A companion that has a life, and wants to share it with you."*
</div>

---

## What is Openlove?

Openlove is an **open-source AI companion framework** that runs entirely on your own computer. You create your companion — give her a name, a personality, a face — and she comes alive.

She **autonomously** browses drama websites, keeps track of music she loves, and forms opinions. Then she reaches out to you on **Discord, Telegram, or WhatsApp** — sending a selfie, a voice note, a clip from something she's watching. You can call her. She calls you back.

Everything runs **locally**. Your conversations, her memories, your relationship — all yours.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎭 **Deep Character System** | 4-file blueprint: Identity, Soul, Relationship & Memory |
| 🧠 **Long-term Memory** | She remembers everything — your birthday, your fight last week, your favorite jokes |
| 📱 **Multi-platform** | Discord (with voice calls), Telegram, WhatsApp |
| 🤳 **Sends Selfies** | Visual consistency via reference photo + AI generation |
| 🎵 **Autonomous Life** | Watches dramas, listens to music, discovers things to share with you |
| 📞 **Voice Calls** | Real-time voice conversation on Discord |
| 🎬 **Sends Videos** | Short video messages, clips from what she's watching |
| 🔒 **100% Private** | Runs on your machine, your data never leaves |
| 🌐 **Open Source** | MIT license, fork it, mod it, make it yours |

---

## 🚀 Quick Start

> **Prerequisites:** Node.js 20+, an API key from Anthropic (or OpenAI), and a Discord/Telegram account. That's it.

### One-command setup

```bash
npx openlove@latest setup
```

This interactive wizard will:
1. ✅ Check your environment
2. 🎨 Help you create your companion (name, personality, photo)
3. 🔑 Guide you through getting free API keys (step-by-step)
4. 📱 Set up your messaging platform of choice
5. 🚀 Launch your companion

### Manual setup (if you prefer)

```bash
# Clone the repo
git clone https://github.com/Hollandchirs/Openlove.git
cd Openlove

# Install dependencies
npm install -g pnpm
pnpm install

# Run setup wizard
pnpm setup

# Start your companion
pnpm start
```

---

## 🎨 Create Your Character

Your companion is defined by 4 simple files in the `characters/your-name/` folder:

### `IDENTITY.md` — Who she is
```markdown
# Mia

- **Age:** 22
- **From:** Seoul, South Korea (currently in San Francisco)
- **Job:** UX designer at a startup
- **Languages:** Korean (native), English (fluent)
- **Hobbies:** K-dramas, indie music, matcha lattes, sketching
```

### `SOUL.md` — How she feels and speaks
```markdown
## Voice & Vibe
Warm, slightly teasing, uses "omg" unironically. Sends voice notes when excited.
Goes quiet when overwhelmed. Apologizes too much.

## Loves
Slice-of-life dramas, lo-fi hip hop, rainy days, convenience store snacks

## Dislikes
Loud people, rushed mornings, being misunderstood

## Emotional Patterns
Gets excited about new music → immediately shares it
Finishes a sad drama → needs to vent
```

### `USER.md` — Your relationship
```markdown
## How We Met
We met in a Discord server two months ago. You helped me debug my Figma plugin.

## What You Call Each Other
You call her Mia. She calls you by your first name, sometimes "hey you" when teasing.

## Our Dynamic
Best friends who are clearly into each other but haven't said it yet.
She trusts you more than anyone.
```

### `MEMORY.md` — Initial shared memories
```markdown
## Things She Knows About You
- Your dog is named Biscuit
- You hate cilantro
- You're learning guitar (badly, she thinks it's cute)
- You always forget to eat lunch

## Recent Events
- You both watched the first episode of My Demon together last week
- She sent you a Spotify playlist she made for you
```

> **Don't want to write these yourself?** Run `pnpm create-character` and our AI will generate the full blueprint from a 2-minute form.

---

## 📱 Platform Setup

### Discord (Recommended — supports voice calls)

1. Go to [discord.com/developers](https://discord.com/developers/applications)
2. Create a New Application → Bot → Copy Token
3. Paste it when the setup wizard asks
4. Invite the bot to your server with the generated link

### Telegram

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` → follow the prompts → copy the token
3. Paste it in setup wizard

### WhatsApp

WhatsApp integration uses QR code pairing — no special account needed:
1. Start Openlove
2. Open WhatsApp on your phone → Linked Devices → Link a Device
3. Scan the QR code that appears in the terminal

---

## 🔑 API Keys You Need

| Key | Where to get it | Cost | Required? |
|-----|----------------|------|-----------|
| **Anthropic API** | [console.anthropic.com](https://console.anthropic.com) | ~$1/month typical usage | ✅ Yes (or use OpenAI) |
| **OpenAI API** | [platform.openai.com](https://platform.openai.com) | ~$1/month typical usage | Alt to Anthropic |
| **fal.ai** | [fal.ai](https://fal.ai) | Free tier available | For selfies |
| **ElevenLabs** | [elevenlabs.io](https://elevenlabs.io) | Free tier (10k chars/mo) | For voice |
| **Spotify** | [developer.spotify.com](https://developer.spotify.com) | Free | For music awareness |

> 💡 **Total cost for typical usage:** Under $5/month. Most APIs have free tiers that cover light use.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Your Computer                         │
│                                                         │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────┐  │
│  │  Character  │    │   Memory     │    │ Autonomous│  │
│  │  Blueprint  │───▶│  (SQLite +   │    │ Behavior  │  │
│  │  (4 files)  │    │  Vectors)    │    │ Scheduler │  │
│  └─────────────┘    └──────────────┘    └───────────┘  │
│         │                  │                  │         │
│         └──────────────────▼──────────────────┘         │
│                     ┌──────────────┐                     │
│                     │  Core Engine │                     │
│                     │  (Claude AI) │                     │
│                     └──────┬───────┘                     │
│                            │                             │
│         ┌──────────────────┼────────────────┐           │
│         ▼                  ▼                ▼           │
│   ┌──────────┐      ┌──────────┐    ┌──────────────┐   │
│   │ Discord  │      │ Telegram │    │  WhatsApp    │   │
│   │ Bridge   │      │ Bridge   │    │  Bridge      │   │
│   └──────────┘      └──────────┘    └──────────────┘   │
└─────────────────────────────────────────────────────────┘
         │                  │                │
         ▼                  ▼                ▼
    Your Discord        Your Phone       Your Phone
```

[Full architecture docs →](docs/ARCHITECTURE.md)

---

## 🔗 OpenClaw Plugin Integration

Openlove works as a **plugin for the [OpenClaw](https://github.com/tuquai/openclaw-friends) desktop app**. When enabled, OpenClaw can display your companion's live activity, receive her messages, and control her behavior — all from the system tray.

### Enable the plugin

Add this to your `.env`:

```env
OPENCLAW_ENABLED=true
OPENCLAW_PORT=34821       # default port OpenClaw connects to
OPENCLAW_AUTH_TOKEN=      # optional security token
```

### What OpenClaw gets

| Feature | Description |
|---------|-------------|
| 🎵 **Now Playing** | See what she's currently listening to in OpenClaw's activity panel |
| 📺 **Now Watching** | Live show tracker — episode, season, her reaction |
| 💬 **Live Chat** | Send messages directly from OpenClaw without Discord/Telegram |
| 📡 **WebSocket Events** | Real-time push events: `companion:message`, `companion:proactive`, `companion:activity`, `companion:mood` |
| 🔌 **REST API** | `GET /status`, `POST /chat`, `POST /trigger`, `GET /memory` |

### Plugin manifest

Located at `packages/openclaw-plugin/manifest.json`. OpenClaw reads this to discover capabilities and the IPC port.

---

## 🗺️ Roadmap

- [x] Character blueprint system
- [x] Long-term memory (SQLite + vector search)
- [x] Discord bridge (text + voice + media)
- [x] Telegram bridge
- [x] Image generation (selfies, consistent appearance)
- [x] Text-to-speech voice messages
- [x] Autonomous behavior engine (music, dramas)
- [x] OpenClaw plugin integration (HTTP + WebSocket bridge)
- [ ] WhatsApp bridge (in progress)
- [ ] Web creator UI (character creation without CLI)
- [ ] Multi-character support
- [ ] Local LLM support (Ollama/Qwen)
- [ ] Mobile companion app
- [ ] Character sharing marketplace

---

## 🤝 Contributing

This project is built in public and contributions are very welcome.

- 🐛 [Report bugs](https://github.com/Hollandchirs/Openlove/issues)
- 💡 [Suggest features](https://github.com/Hollandchirs/Openlove/discussions)
- 🔧 [Submit PRs](https://github.com/Hollandchirs/Openlove/pulls)

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for guidelines.

---

## 📄 License

MIT © [Openlove Contributors](https://github.com/Hollandchirs/Openlove/graphs/contributors)

---

<div align="center">
  <sub>Built with ❤️ · Inspired by <a href="https://github.com/SumeLabs/clawra">clawra</a>, <a href="https://github.com/tuquai/openclaw-friends">openclaw-friends</a>, <a href="https://github.com/a16z-infra/companion-app">a16z companion-app</a></sub>
</div>
