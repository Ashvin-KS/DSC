import os
import sqlite3


base = os.environ.get("APPDATA", "")
candidate_dirs = [
    os.path.join(base, "com.atheletia.app"),
    os.path.join(base, "Atheletia"),
    os.path.join(base, "com.nexus.os"),
]
db_path = next(
    (
        os.path.join(folder, name)
        for folder in candidate_dirs
        for name in ("atheletia_intent.db", "allentire_intent.db")
        if os.path.exists(os.path.join(folder, name))
    ),
    os.path.join(candidate_dirs[0], "atheletia_intent.db"),
)
conn = sqlite3.connect(db_path)
cur = conn.cursor()
rows = cur.execute(
    "SELECT key, value FROM app_settings WHERE key IN ('google_client_id','google_client_secret')"
).fetchall()
conn.close()
print(f"Retrieved {len(rows)} credential keys from the database (values hidden for security).")
