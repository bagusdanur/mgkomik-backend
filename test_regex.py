import urllib.request
import json
import re

url = "https://api.ryukomik.web.id/asura/detail/is-it-bad-that-the-main-character-s-a-roleplayer"
req = urllib.request.Request(url, headers={"User-Agent": "RyukomikBot/1.0"})
with urllib.request.urlopen(req, timeout=30) as resp:
    data = json.loads(resp.read().decode())

chapters = data.get("data", {}).get("chapters", [])
print(f"Total chapters in API: {len(chapters)}")

for search_ch in ["1", "10"]:
    print(f"\n--- Mencari chapter {search_ch} ---")
    matched = []
    # Test bug lama (in)
    for ch in chapters:
        title = ch.get("title", "")
        if search_ch in title:
            matched.append(title)
    print(f"Bug Lama ('in' operator) menemukan {len(matched)} match:")
    for m in matched: print(f"  - {m}")
    
    # Test regex baru
    print("---")
    matched_new = []
    for ch in chapters:
        title = ch.get("title", "")
        if re.search(r'\b' + re.escape(search_ch) + r'\b', title):
            matched_new.append(title)
    print(f"Regex Baru menemukan {len(matched_new)} match:")
    for m in matched_new: print(f"  - {m}")

