# Pi Coding Agent — Vicinae Extension

A [Vicinae](https://vicinae.com) extension that lets you chat with the [pi](https://github.com/mariozechner/pi-coding-agent) AI coding agent directly from your launcher — with live streaming, model switching, token tracking, and more.

![Vicinae](https://img.shields.io/badge/Vicinae-Extension-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- 💬 **Live streaming** — see pi's response token by token as it arrives
- 📖 **Inline detail pane** — full markdown response renders on the right as you browse messages
- 🔀 **Model switcher** — swap between any configured model (Claude, GPT, Gemini…) without leaving the chat
- 🧠 **Thinking level toggle** — cycle through `off → low → medium → high` reasoning modes on the fly
- 💰 **Token & cost tracking** — per-message token count, cost, and total session cost shown in metadata
- ⚠️ **Context usage warning** — see how full the context window is; compact it with one action
- 📋 **Ask about clipboard** — instantly send whatever's in your clipboard as a message
- 🔧 **Tool call visibility** — see which tools pi is running (`bash`, `read`, `edit`…) in real time
- 💾 **Session persistence** — conversations are saved and resumed automatically; start fresh any time
- 🔄 **Crash recovery** — if pi exits unexpectedly, a restart button appears with the error reason

## Requirements

- [Vicinae](https://vicinae.com) installed and running
- [pi](https://github.com/mariozechner/pi-coding-agent) installed and in your `PATH` — verify with `which pi`
- Node.js ≥ 18

## Installation

```bash
git clone https://github.com/purplefish32/vicinae-pi-chat
cd vicinae-pi-chat
npm install && npm run build
```

Open Vicinae and search **"Pi — Chat"**.

## Usage

| Action | How |
|---|---|
| Send message | Type in search bar → `↵` |
| Abort streaming | `↵` while pi is responding |
| Copy message | `Cmd+Shift+C` |
| Switch model | Action panel → Switch Model |
| Cycle thinking level | `Cmd+T` |
| Compact context | `Cmd+K` |
| Ask about clipboard | `Cmd+B` |
| New session | `Cmd+N` |
| Clear messages | `Cmd+Shift+Delete` |

## Configuration

Open Vicinae settings (`Cmd+,`) to set:

| Preference | Description | Default |
|---|---|---|
| Working Directory | The folder pi uses when running tools | `~` (home directory) |

## Development

```bash
# Watch mode — rebuilds on every save
npm run dev

# One-off build
npm run build
```

## How it works

The extension spawns `pi --mode rpc` as a subprocess and communicates over stdin/stdout via the [pi JSON-RPC protocol](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/rpc.md). Readiness is detected via a `get_state` handshake rather than a blind timer. All commands use proper request/response correlation with timeouts.

## License

MIT
