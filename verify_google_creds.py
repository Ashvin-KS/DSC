import os
import sqlite3


db_path = os.path.join(os.environ["APPDATA"], "com.nexus.os", "allentire_intent.db")
conn = sqlite3.connect(db_path)
cur = conn.cursor()
rows = cur.execute(
    "SELECT key, value FROM app_settings WHERE key IN ('google_client_id','google_client_secret')"
).fetchall()
conn.close()
print(rows)
