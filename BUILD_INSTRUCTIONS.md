# Build Instructions

## Quick Start

### 1. Create your credentials file

```bash
# Copy the example file
cp .env.build.example .env.build

# Edit with your actual credentials
# The file is gitignored and won't be committed to GitHub
```

### 2. Build the app

```bash
npm run tauri:build
```

The credentials will be embedded in the binary!

## What Changed

### ✅ Removed from UI
- Google Client ID field removed from Settings
- Google Client Secret field removed from Settings
- Cleaner UI for users

### ✅ Added to build system
- `.env.build.example` - Template file
- `.env.build` - Your actual credentials (gitignored)
- `build.rs` - Reads and embeds credentials
- `lib.rs` - Uses embedded credentials

### ✅ How it works now

**Credential Priority:**
1. User settings (if they somehow set them)
2. **Embedded credentials** (from .env.build) ← NEW!
3. Runtime environment variables

**For Users:**
- Download .exe
- Open app
- Click "Connect Google" in Schedule view
- Done! No setup needed!

**For You (Developer):**
- Create `.env.build` with your credentials
- Build the app
- Distribute the .exe
- Credentials are NOT in GitHub!

## Security Notes

### Why This is Safe

1. **Desktop apps are "public clients"** - Google expects this
2. **Credentials are embedded in binary** - Hard to extract
3. **Users still authorize** - They must sign in and grant permissions
4. **You control quota** - Set limits in Google Cloud Console

### Best Practices

- ✅ Keep `.env.build` gitignored
- ✅ Use separate credentials for dev/prod
- ✅ Monitor usage in Google Cloud Console
- ✅ Rotate credentials if compromised

## Distribution

After building, you'll find the installers here:

```
src-tauri/target/release/bundle/
├── msi/
│   └── Atheletia_0.1.0_x64.msi
└── nsis/
    └── Atheletia_0.1.0_x64-setup.exe
```

Users can install and use Google Calendar immediately!

## Development

For development without `.env.build`:

```bash
# Option 1: Create .env.build
echo "ATHELETIA_GOOGLE_CLIENT_ID=your_id" > .env.build
echo "ATHELETIA_GOOGLE_CLIENT_SECRET=your_secret" >> .env.build

# Option 2: Use environment variables
GOOGLE_CLIENT_ID=your_id GOOGLE_CLIENT_SECRET=your_secret npm run tauri:dev

# Option 3: Use .env file (for dev only)
echo "GOOGLE_CLIENT_ID=your_id" > .env
echo "GOOGLE_CLIENT_SECRET=your_secret" >> .env
```

## Troubleshooting

### "Google Calendar integration requires credentials"
- Ensure `.env.build` exists with correct credentials
- Check file format: `KEY=value` (no spaces around `=`)
- Run `cargo clean` and rebuild

### Credentials not working
- Verify credentials in Google Cloud Console
- Check redirect URIs are configured
- Ensure APIs (Calendar, Tasks) are enabled

### Build fails
- Check Rust is installed: `rustc --version`
- Check Node dependencies: `npm install`
- Check Tauri CLI: `npm run tauri:build`
