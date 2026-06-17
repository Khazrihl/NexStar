# NexStar
### Map Intelligence Tool for Nexus Legacy — Season 0

NexStar is a galaxy intelligence suite for Nexus Legacy. It pulls live data directly from the game API, processes it into a clean database, and serves it through an interactive browser-based map and Discord reporting tools.

Built by **Khazrihl** of the **NAV** alliance.

---

## What It Does

- **Live API dumper** — pulls colony data, stations, asteroid fields, and planet detail directly from the game. Resumable, checkpointed, runs in ~15 minutes.
- **Interactive galaxy map** — browser-based, zero install. Pan, zoom, filter by zone/alliance/player/planet type. Heatmaps, threat assessment, sector highlighting, station rendering.
- **Discord report generator** — CLI tool that queries the database and outputs formatted code blocks ready to paste into Discord.

---

## Files

| File | Purpose |
|------|---------|
| `nl_dumper.py` | Pulls live data from the Nexus Legacy API |
| `nexus-map-viewer.html` | Interactive galaxy map (open in any browser) |
| `nl_discord_summary.py` | CLI filter tool for Discord reports |
| `nexus-map-clean.json` | Current galaxy database (see Releases) |
| `NAV_MAP_FEATURE_OVERVIEW.txt` | Full feature documentation |
| `NAV_MAP_PATCH_NOTES.txt` | Version history |

---

## Quick Start — Map Viewer

1. Download `nexus-map-viewer.html` and `nexus-map-clean.json` from [Releases](../../releases)
2. Open `nexus-map-viewer.html` in any browser
3. Drag and drop `nexus-map-clean.json` onto the load zone
4. Set your home alliance in the **⚙ Alliance Settings** panel

No installation. No internet connection required after download.

---

## Quick Start — API Dumper

Requires Python 3.8+ and the `requests` library.

```bash
pip install requests
```

Create `nl_config.txt` in the same folder as `nl_dumper.py`:
```
token=your_nexus_token_here
```

To get your token: open Edge/Chrome DevTools (F12) → Application tab → Cookies → `s0.nexuslegacy.space` → copy the `nexus_token` value. Token is valid for approximately 60 days.

```bash
python nl_dumper.py           # Full pull (~15 minutes)
python nl_dumper.py --test    # Single sector test
python nl_dumper.py --fresh   # Start over from scratch
```

---

## Quick Start — Discord Summary

```bash
python nl_discord_summary.py nexus-map-clean.json --arm epsilon --sector 47
python nl_discord_summary.py nexus-map-clean.json --pvp --alliance SWORD
python nl_discord_summary.py nexus-map-clean.json --list-alliances
python nl_discord_summary.py nexus-map-clean.json --type terra --min-slots 18 --sort-slots
```

See `NAV_MAP_FEATURE_OVERVIEW.txt` for the full flag reference.

---

## Map Viewer Features

**Zone Colors**
- 🟢 Sentinel — outermost ring, PvP disabled
- 🟠 Open — middle ring, PvP enabled
- 🔴 Dead — inner ring, PvP enabled
- 🟣 Rift — galactic center, PvP enabled

**Stations** appear as diamonds at their system position. Home alliance stations glow in your configured alliance color. Neutral stations show in zone color. Sentinel stations are faint outlines (not contestable).

**Filters** — arm, sector, zone, planet type, min slots, field type, richness, alliance tag, player name, colonized only, unaffiliated only. All live-update the map and results list simultaneously.

**Threat Assessment** — set a proximity radius around home alliance colonies. Rival PvP-zone systems within range are highlighted. Popup shows exact distance to nearest friendly colony.

**Sector Highlight** — click any system to reveal the shape of its sector via soft glow rings on all systems sharing the same sector ID.

**Alliance Settings** — configure your home alliance tag and color without editing code. Saves to browser localStorage. Shareable with allied players — each sets their own alliance.

---

## Security Notes

`nexus-map-clean.json` contains in-game usernames, alliance tags, colony locations, and station data for all players in explored space. It does **not** contain email addresses, Steam IDs, or account credentials.

**Never commit `nl_config.txt`** — it contains your auth token.

---

## Version

Current: **v2.0.0** — see `NAV_MAP_PATCH_NOTES.txt` for full changelog.

---

## Acknowledgements

- **Azrael** — original API extension that started this project
- **Vonrich** — NAV alliance leader and project direction
- **reactormonk** — GitHub guidance
