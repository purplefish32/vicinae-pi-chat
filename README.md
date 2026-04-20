# Pi Chat — Vicinae Extension

A [Vicinae](https://vicinae.com) extension that lets you chat with the [pi](https://github.com/mariozechner/pi) AI coding agent directly from your launcher.

![Vicinae](https://img.shields.io/badge/Vicinae-Extension-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## Demo

Open Vicinae (`Mod+Space`), search **"Chat with Pi"**, and start talking.

- Type your message in the search bar
- A green **Send** item appears at the top — press `↵` to send
- Responses stream in live, token by token
- Tool calls (`bash`, `read`, `edit`, etc.) are shown inline as pi works

## Features

- 💬 **Live streaming** — see pi's response as it types
- 🔧 **Tool call visibility** — know when pi is running commands or reading files
- 📋 **Full message view** — press `Cmd+↵` to read any message in a markdown detail pane
- 🗑️ **Clear chat** — `Cmd+Shift+Delete` to start fresh
- 📁 **Configurable working directory** — set which folder pi operates in via extension preferences

## Requirements

- [Vicinae](https://vicinae.com) installed and running
- [pi](https://github.com/mariozechner/pi-coding-agent) installed and in your `PATH` (`which pi`)
- Node.js ≥ 18

## Installation

### From source

```bash
git clone https://github.com/purplefish32/vicinae-pi-chat
cd vicinae-pi-chat
npm install
npm run build
vicinae server --replace
```

Then open Vicinae and search for **"Chat with Pi"**.

### Manual

Copy the contents of this repo into `~/.local/share/vicinae/extensions/pi-chat/` and restart the Vicinae server.

## Usage

| Action | How |
|---|---|
| Send message | Type in search bar → `↵` |
| Abort streaming | `↵` while pi is responding |
| View full message (markdown) | `Cmd+↵` |
| Copy message | `Cmd+Shift+C` |
| Clear chat | `Cmd+Shift+Delete` |

## Configuration

Open Vicinae settings (`Cmd+,` inside the extension) to set:

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

The extension uses [pi's RPC mode](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/rpc.md) — it spawns `pi --mode rpc --no-session` as a subprocess and communicates over stdin/stdout via JSONL.

## Tech Stack

- **[Vicinae API](https://docs.vicinae.com/extensions/introduction)** — React + TypeScript extension SDK
- **[pi RPC mode](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/rpc.md)** — headless agent via JSON protocol over stdin/stdout

## License

MIT
