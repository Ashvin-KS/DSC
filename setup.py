import os
import subprocess
import sys

ENV_FILE = '.env'

BANNER = """
╔══════════════════════════════════════════════════════════╗
║              ✨ Nexus OS — First-Time Setup ✨             ║
║  This script configures your .env without touching code  ║
╚══════════════════════════════════════════════════════════╝
"""

# All recognised .env keys with friendly descriptions and help links
KEYS = [
    {
        'key': 'GOOGLE_CLIENT_ID',
        'prompt': 'Google OAuth Client ID',
        'help': 'Create at https://console.cloud.google.com → APIs & Services → Credentials',
        'required': False,
    },
    {
        'key': 'GOOGLE_CLIENT_SECRET',
        'prompt': 'Google OAuth Client Secret',
        'help': 'Same credentials page as Client ID above',
        'required': False,
    },
    {
        'key': 'GOOGLE_REDIRECT_URI',
        'prompt': 'Google OAuth Redirect URI',
        'help': 'Use an exact callback URI registered in Google Cloud Console (example: http://127.0.0.1:3000/oauth2callback)',
        'required': False,
    },
    {
        'key': 'VITE_GOOGLE_MAPS_KEY',
        'prompt': 'Google Maps API Key (optional)',
        'help': 'Required only if you use map-based features. Leave blank to skip.',
        'required': False,
    },
    {
        'key': 'VITE_NEWS_API_KEY',
        'prompt': 'NewsAPI Key (optional)',
        'help': 'Get a free key at https://newsapi.org → Get API Key. Leave blank to skip.',
        'required': False,
    },
]


def load_env():
    current = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, 'r') as f:
            for line in f:
                line = line.strip()
                if '=' in line and not line.startswith('#'):
                    key, val = line.split('=', 1)
                    current[key.strip()] = val.strip()
    return current


def save_env(env: dict):
    with open(ENV_FILE, 'w') as f:
        for key, value in env.items():
            f.write(f'{key}={value}\n')


def ask(entry: dict, current_value: str | None) -> str | None:
    required_tag = ' *' if entry['required'] else ''
    print(f"\n  📌 {entry['prompt']}{required_tag}")
    print(f"     {entry['help']}")

    if current_value:
        # Mask all but last 4 chars for display
        masked = ('*' * max(0, len(current_value) - 4)) + current_value[-4:]
        choice = input(f"     Current: {masked}   [Press Enter to keep, or type new value]: ").strip()
        return choice if choice else current_value
    else:
        value = input("     Value: ").strip()
        return value if value else None


def main():
    print(BANNER)

    env = load_env()
    changed = False

    for entry in KEYS:
        current = env.get(entry['key'])
        new_value = ask(entry, current)

        if new_value:
            if new_value != current:
                env[entry['key']] = new_value
                changed = True
        elif entry['required'] and not current:
            print(f"  ⚠️  '{entry['key']}' is required but was left blank. Skipping.")

    if changed:
        save_env(env)
        print(f"\n  ✅ Configuration saved to {ENV_FILE}")
    else:
        print(f"\n  ℹ️  No changes made.")

    print("\n  👉 Run `npm run tauri:dev` to start the app.\n")

    # Optional: offer to start dev server immediately
    launch = input("  Launch the app now? (y/N): ").strip().lower()
    if launch == 'y':
        subprocess.run(['npm', 'run', 'tauri:dev'], shell=True)


if __name__ == '__main__':
    main()
