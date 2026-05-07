# Deploying Atheletia Without Google Client Setup

This guide helps you distribute Atheletia as an .exe to users who have not configured Google Calendar/Task integration.

## What Works Out of the Box

- All core features: activity tracking, chat, diary, dashboard, music, notes vault, LeetCode, settings
- AI providers: NVIDIA, OpenAI, Anthropic, Groq, Gemini (if user provides API key)
- Local models via LM Studio
- Data export/import
- Browser windows (http/https only)

## What Requires Setup

### Google Integration (Optional)
Users who want Google Calendar/Tasks must:
1. Go to Settings > API Keys
2. Set Google Client ID and Google Client Secret
3. Click Sign In to authorize
4. The app stores tokens in OS keyring; no manual config needed

### AI Providers (Optional)
Users who want AI summaries/chat must:
1. Go to Settings > API Keys
2. Enter API keys for their preferred provider(s)
3. Keys are stored in OS keyring for security

## Build for Distribution

```bash
# From the repo root
cd src-tauri
cargo tauri build --target x86_64-pc-windows-msvc
```

Output: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Atheletia_0.1.0_x64_en-US.msi`

## Installer Notes

- The MSI includes the built-in LeetCode CSV
- No external config files required
- First run creates app data in `%LOCALAPPDATA%/Atheletia`
- Google OAuth and AI features are gracefully disabled until keys are added

## Privacy/Security

- No keys or credentials are baked into the binary
- All secrets are stored in OS keyring or SQLite with user consent
- CSP is enabled in production builds
- Browser windows only allow http/https schemes
- File operations are sandboxed to user-selected vaults

## User Setup Flow

1. Run the installer
2. Launch Atheletia
3. Core features work immediately
4. (Optional) Add API keys in Settings for AI/Google
5. (Optional) Select a notes vault for Brain features

## Support

- Direct users to Settings > API Keys for any provider setup
- Google OAuth requires a Google Cloud project with Calendar/Task APIs enabled
- For local AI, ensure LM Studio is running on default port 1234
