# Atheletia

Atheletia is a personal desktop productivity hub built with Tauri v2, React, TypeScript, and Rust. It brings activity tracking, AI chat, a notes vault, scheduling, LeetCode study tools, music, focus timers, and local data management into one desktop app.

The app is designed for a local-first workflow: your main data lives in the desktop app, AI features are opt-in through configured providers, and integrations such as Google Calendar or Google Tasks only work after you provide credentials.

## Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Requirements](#requirements)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Project Structure](#project-structure)
- [Main Views](#main-views)
- [Architecture Notes](#architecture-notes)
- [Data And Privacy](#data-and-privacy)
- [Utilities](#utilities)
- [Troubleshooting](#troubleshooting)

## Features

| Area | What It Does |
| --- | --- |
| AI chat | Multi-session assistant with model/provider selection, streaming responses, markdown, Mermaid diagrams, and optional activity context. |
| Activity tracking | Records active apps and windows, categorizes usage, and shows time-based activity breakdowns. |
| Dashboard | Summaries, project/deadline cards, goals, fitness, news, LeetCode progress, and task alerts. |
| Diary | Daily journal entries with AI-generated summaries based on tracked activity. |
| Brain notes | Local vault-style notes with a TipTap editor, markdown support, search/retrieval context, and an AI side panel. |
| Schedule | Calendar and task planning with optional Google Calendar and Google Tasks sync. |
| Code tracker | LeetCode problem list, solved status, notes, explanations, and study activity tracking. |
| Music | YouTube-backed music player with playlists, liked songs, recently played tracks, queueing, and playback controls. |
| Zen mode | Focus timer, Pomodoro modes, focus playlists, and timer/music coordination. |
| Tray panel | Compact tray window for timer controls, music controls, navigation, incognito mode, and game mode. |
| Settings | AI provider keys, model configuration, privacy controls, startup behavior, storage tools, and appearance settings. |
| Data tools | Export/import local app data and clear stored data from the Settings view. |

## Tech Stack

### Frontend

| Tool | Purpose |
| --- | --- |
| React 19 | UI framework |
| TypeScript | Type safety |
| Vite | Frontend dev server and build |
| Zustand | Client-side state stores |
| Framer Motion | UI animation |
| TipTap | Rich note editor |
| React Markdown, remark, rehype | Markdown rendering, math, and sanitization |
| Mermaid | Diagram rendering |
| react-youtube | Music playback engine |
| Lucide React | Icons |
| jsPDF | PDF export support |

### Desktop And Backend

| Tool | Purpose |
| --- | --- |
| Tauri v2 | Desktop shell, IPC, windows, tray, global shortcuts, bundling |
| Rust | Backend commands and app services |
| rusqlite | Embedded SQLite storage |
| reqwest, tokio | Async HTTP and streaming AI requests |
| keyring | Secure API key storage where supported |
| active-win-pos-rs | Active window detection |
| xcap, image, windows | Screen capture, OCR, and Windows media/system integrations |
| fastembed | Local embedding/retrieval support |
| walkdir, regex | Vault traversal and text processing |

## Requirements

- Node.js 18 or newer
- npm 9 or newer
- Rust stable toolchain from [rustup](https://rustup.rs/)
- Windows is the primary supported target
- Tauri system prerequisites for your platform

Some features rely on Windows-specific APIs for active window detection, OCR, and media metadata. The app may build on other platforms, but those integrations can be limited.

## Getting Started

```bash
git clone <repo-url>
cd <repo-folder>
npm install
copy .env.example .env
npm run tauri:dev
```

On macOS or Linux, use `cp .env.example .env` instead of `copy .env.example .env`.

To build a production bundle:

```bash
npm run tauri:build
```

## Configuration

Create a local `.env` file from `.env.example`:

```env
VITE_A4F_API_KEY=your_a4f_api_key_here
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
```

Do not commit `.env`. It is ignored by git.

### AI Providers

Atheletia supports these providers through the Settings view and backend query engine:

- NVIDIA NIM
- OpenAI
- Anthropic
- Groq
- Gemini
- Local LM Studio-compatible endpoint

Provider keys can be configured in the app under Settings. The backend also checks provider-specific environment variables when needed:

```env
NVIDIA_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GROQ_API_KEY=
GEMINI_API_KEY=
```

For LM Studio, start the local server, load a model, then set the LM Studio base URL in Settings.

### Google Sync

Google Calendar and Google Tasks sync require OAuth credentials:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

After credentials are configured, connect Google from the Schedule view or Settings flow exposed by the app.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite frontend only. |
| `npm run build` | Build the frontend with Vite. |
| `npm run preview` | Preview the built frontend. |
| `npm run tauri:dev` | Start the full desktop app in development mode. |
| `npm run tauri:build` | Build a production desktop bundle. |

## Project Structure

```text
.
|-- App.tsx                    # Root React component and view routing
|-- index.tsx                  # Frontend entry point
|-- index.html                 # Vite HTML shell
|-- tauri-api.ts               # window.atheletiaAPI bridge around Tauri invoke calls
|-- package.json               # Frontend dependencies and scripts
|-- vite.config.mjs            # Vite config, dev URL, and env handling
|-- leetcode_problems.csv      # Bundled LeetCode problem source data
|-- organize_leetcode.py       # Helper for organizing/enriching LeetCode data
|-- setup.py                   # Python setup helper
|-- components/                # Shared UI and feature components
|-- hooks/                     # React hooks
|-- lib/                       # Shared frontend utilities and constants
|-- services/                  # Frontend service wrappers and Brain AI logic
|-- store/                     # Zustand stores
|-- views/                     # Top-level app views
|-- docs/                      # Architecture notes and audits
|-- plans/                     # Planning documents
`-- src-tauri/                 # Rust/Tauri backend
    |-- tauri.conf.json        # Tauri app and bundle configuration
    |-- Cargo.toml             # Rust crate manifest
    |-- capabilities/          # Tauri IPC capability declarations
    `-- src/
        |-- lib.rs             # App setup, windows, tray, commands, Google/music helpers
        |-- main.rs            # Binary entry point
        |-- intent/            # Activity, chat, dashboard, diary, settings, storage modules
        |-- models/            # Backend data models
        |-- services/          # Query engine and retrieval helpers
        `-- utils/             # Config and shared utilities
```

## Main Views

| View | Files | Notes |
| --- | --- | --- |
| Dashboard | `views/DashboardView.tsx`, `components/dashboard/*` | AI summaries, projects, goals, fitness, news, LeetCode progress, and task alerts. |
| Chat | `views/ChatView.tsx`, `components/chat/*`, `services/chatService.ts` | Multi-session chat backed by Tauri chat commands. |
| Activity | `views/ActivityView.tsx`, `src-tauri/src/intent/activity*.rs` | Activity timeline, categories, and range filters. |
| Diary | `views/DiaryView.tsx`, `src-tauri/src/intent/diary.rs` | Manual entries plus AI summaries from activity context. |
| Code | `views/CodeView.tsx`, `store/useCodeStore.ts` | LeetCode problem browsing, solved tracking, notes, and AI help. |
| Brain | `views/BrainView.tsx`, `views/brain/*`, `services/brainAiService.ts` | Vault notes, rich editing, local retrieval, and AI note actions. |
| Schedule | `views/ScheduleView.tsx`, `components/schedule/*`, `store/useScheduleStore.ts` | Calendar events, tasks, and Google sync. |
| Zen | `views/ZenView.tsx`, `store/useTimerStore.ts` | Focus timer, Pomodoro modes, and music integration. |
| Music | `views/MusicView.tsx`, `components/zen/MusicEngine.tsx`, `store/useMusicStore.ts` | YouTube-backed playback, playlists, liked songs, and queue controls. |
| Settings | `views/SettingsView.tsx`, `src-tauri/src/intent/settings.rs` | Providers, keys, privacy, startup, storage, and appearance. |
| Tray | `views/TrayPanelView.tsx` | Compact timer/music/navigation controls from the system tray. |

## Architecture Notes

### Frontend State

The frontend uses Zustand stores under `store/`:

- `useNavStore` tracks the active sidebar view.
- `useIntentStore` holds settings, activity state, chat sessions, and diary state.
- `useMusicStore` manages playlists, current track, playback state, liked songs, and queue behavior.
- `useTimerStore` manages Zen/Pomodoro state.
- `useScheduleStore` stores tasks, events, and Google connection state.
- `useCodeStore` and `useLeetCodeActivityStore` support LeetCode workflows.

### Tauri Bridge

`tauri-api.ts` exposes `window.atheletiaAPI`, which wraps Tauri `invoke` calls into grouped frontend APIs for:

- activity and diary data
- chat sessions and streaming messages
- dashboard cards and AI summaries
- settings and API key validation
- storage export/import/clear operations
- music search and playlist persistence
- vault and Brain note operations
- Google Calendar and Tasks operations

### Backend Modules

The Rust backend is organized around `src-tauri/src/intent/`:

- `db.rs` initializes and opens the SQLite database.
- `activity.rs` and `activity_tracker.rs` collect and query app usage.
- `chat.rs` handles chat sessions, messages, provider selection, and AI calls.
- `dashboard.rs` powers dashboard summaries and project/deadline data.
- `diary.rs` handles journal CRUD and generated summaries.
- `file_monitor.rs` watches note vault changes.
- `retrieval.rs` supports vault retrieval/indexing.
- `settings.rs` loads, saves, and validates app settings and provider keys.
- `storage.rs` provides database stats, export/import, cleanup, and clear operations.
- `screen_capture.rs` and `windows_utils.rs` handle Windows-specific integrations.

The query engine in `src-tauri/src/services/query_engine.rs` builds prompts, resolves providers/models, streams responses, and stitches activity or vault context into AI requests.

## Data And Privacy

- Core app data is stored locally through SQLite.
- Some frontend state is persisted in `localStorage`.
- API keys entered in Settings are handled by the backend and keyring support where available.
- Activity tracking, OCR, media tracking, and browser tracking are controlled from Settings.
- Incognito mode temporarily pauses activity tracking.
- Export/import and clear-data controls are available in Settings.
- External AI providers receive the prompts/context you choose to send to them.

## Utilities

| File | Purpose |
| --- | --- |
| `organize_leetcode.py` | Organizes and enriches the LeetCode CSV dataset. |
| `setup.py` | Helper setup script for local tooling. |
| `verify_google_creds.py` | Quick check for Google OAuth credentials. |

## Troubleshooting

### Tauri Dev Window Does Not Open

Run the full desktop command:

```bash
npm run tauri:dev
```

`npm run dev` starts only the browser-facing Vite app and will not launch the desktop shell.

### AI Calls Fail

- Confirm the provider selected in Settings.
- Validate the key in Settings when available.
- For local models, confirm LM Studio is running, the server is enabled, and a model is loaded.
- For environment keys, restart the app after editing `.env` or shell environment variables.

### Google Sync Fails

- Confirm `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
- Make sure the OAuth app has Calendar and Tasks access enabled.
- Reconnect Google from the app after changing credentials.

### Windows-Specific Features Are Missing

Activity tracking, OCR, and media metadata depend on Windows APIs. On non-Windows platforms, expect reduced behavior even if the app compiles.
