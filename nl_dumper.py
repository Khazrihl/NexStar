"""
Nexus Legacy — Map Intelligence Dumper
Pulls galaxy data directly from the game API and writes a clean
nexus-map-clean.json ready for use with the map viewer and discord script.

Usage:
    python nl_dumper.py              Update pull (colonized only, merged with existing)
    python nl_dumper.py --test       Test pull (1 sector only, confirms endpoints)
    python nl_dumper.py --fresh      Delete progress file and start over

    Planet-detail scope (overrides the PULL['all_planets'] default):
    python nl_dumper.py --all-planets     Pull planet detail for ALL systems
                                          (full coverage; ~14,000 extra API calls)
    python nl_dumper.py --colonized-only  Pull planet detail for colonized systems only

    Merge:
    python nl_dumper.py --no-merge   Do NOT backfill from the existing output

Config:
    nl_config.txt must exist in the same directory. Format:
        token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

Output:
    nexus-map-clean.json        Final clean database
    nl_dumper_progress.json     Checkpoint file (safe to delete after success)

Resume:
    If interrupted, just run again. Completed sectors are skipped.
    Use --fresh to start a full new pull from scratch.

Update workflow:
    A colonized-only pull only fetches planet detail for colonized systems. By
    default the run then MERGES with the existing nexus-map-clean.json, backfilling
    planet data for every system it did not re-pull, so uncolonized planet
    geography from an earlier --all-planets pull is preserved. To (re)establish
    that full coverage, run once with --all-planets; after that, plain update
    pulls keep it via merge. Use --no-merge to force a clean rebuild.
"""

import json
import os
import sys
import time
import requests
from datetime import datetime, timezone

# ── PULL CONFIG ───────────────────────────────────────────────────────────────
# Set True/False to enable or disable each data type.
# Disabled pulls are skipped entirely and noted in output meta.
PULL = {
    # Core — always recommended
    'galaxy_map':        True,   # All system names, coords, zones, hasColonies flag
    'sectors':           True,   # Sector metadata per arm (zone, visibility, colony count)

    # Colony intel
    'colonized_planets': True,   # Planets + moons for systems where hasColonies=True
    'asteroid_fields':   True,   # Asteroid fields in colonized systems
    'stations':          True,   # Station ownership, shield status, building levels

    # PvE — disabled until needed
    'wormholes':         False,  # Wormhole locations
    'pirate_camps':      False,  # NPC pirate camp positions
    'system_debris':     False,  # Debris fields
    'market_hubs':       False,  # Public trading hub locations

    # Full detail — expensive, only use when you need uncolonized planet data.
    # Default is colonized-only for fast updates; the merge step (see below)
    # preserves uncolonized planet geography from a prior --all-planets pull.
    # Override per-run with --all-planets / --colonized-only.
    'all_planets':       False,  # Pull planets for ALL systems, not just colonized
                                 # Warning: ~14,000 additional API calls
}

# ── SETTINGS ──────────────────────────────────────────────────────────────────
BASE_URL      = 'https://s0.nexuslegacy.space'
CONFIG_FILE   = 'nl_config.txt'
PROGRESS_FILE = 'nl_dumper_progress.json'
OUTPUT_FILE   = 'nexus-map-clean.json'

# Delay between requests in seconds. Increase if you see 429 errors.
REQUEST_DELAY = 1.0

# ── Load config ───────────────────────────────────────────────────────────────
def load_config():
    if not os.path.exists(CONFIG_FILE):
        print(f'ERROR: {CONFIG_FILE} not found.')
        print('Create it with the following content:')
        print('  token=your_nexus_token_here')
        sys.exit(1)

    config = {}
    with open(CONFIG_FILE) as f:
        for line in f:
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                key, val = line.split('=', 1)
                config[key.strip()] = val.strip()

    if 'token' not in config or not config['token']:
        print(f'ERROR: token not found in {CONFIG_FILE}.')
        sys.exit(1)

    try:
        import base64
        payload = config['token'].split('.')[1]
        payload += '=' * (4 - len(payload) % 4)
        claims  = json.loads(base64.b64decode(payload))
        exp     = datetime.fromtimestamp(claims['exp'], tz=timezone.utc)
        config['username'] = claims.get('username', 'unknown')
        config['userId']   = claims.get('userId')
        print(f'Token: user={config["username"]} (id={config["userId"]}), '
              f'expires={exp.strftime("%Y-%m-%d")}')
    except Exception:
        print('Token loaded (could not decode metadata)')
        config['username'] = 'unknown'
        config['userId']   = None

    return config

# ── HTTP session ──────────────────────────────────────────────────────────────
def make_session(token):
    s = requests.Session()
    s.headers.update({
        'accept':          'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'referer':         f'{BASE_URL}/galaxy',
        'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'sec-fetch-dest':  'empty',
        'sec-fetch-mode':  'cors',
        'sec-fetch-site':  'same-origin',
    })
    s.cookies.set('nexus_token', token, domain='s0.nexuslegacy.space')
    s.cookies.set('nexus_lang',  'en',  domain='s0.nexuslegacy.space')
    return s

def get(session, path, retries=3, silent=False):
    """GET with retry on transient errors. Returns parsed JSON or None."""
    url = f'{BASE_URL}{path}'
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=30)
            if r.status_code == 200:
                return r.json()
            elif r.status_code == 304:
                return None  # Not modified, cached response
            elif r.status_code == 404:
                if not silent:
                    print(f'  404: {path}')
                return None
            elif r.status_code == 429:
                wait = 15 * (attempt + 1)
                print(f'  Rate limited — waiting {wait}s...')
                time.sleep(wait)
            else:
                if not silent:
                    print(f'  HTTP {r.status_code}: {path} (attempt {attempt+1}/{retries})')
                time.sleep(2)
        except requests.RequestException as e:
            if not silent:
                print(f'  Request error: {e} (attempt {attempt+1}/{retries})')
            time.sleep(3)
    return None

# ── Progress checkpoint ───────────────────────────────────────────────────────
def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            p = json.load(f)
            print(f'Resuming from checkpoint '
                  f'({len(p.get("completed_sectors", []))} sectors done)')
            return p
    return {
        'completed_sectors': [],
        'systems_by_id':     {},
        'stations':          [],
        'galaxy_map_done':   False,
        'sectors_done':      False,
        'markers_done':      False,
        'marker_system_ids': [],
        'arms':              [],
        'all_sectors':       [],
    }

def save_progress(progress):
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(progress, f, separators=(',', ':'))

# ── Baseline merge ────────────────────────────────────────────────────────────
def load_baseline():
    """Load the existing output JSON as a baseline, indexed by system id."""
    if not os.path.exists(OUTPUT_FILE):
        print(f'No existing {OUTPUT_FILE} to merge — building fresh.')
        return {}
    try:
        with open(OUTPUT_FILE, encoding='utf-8') as f:
            prev = json.load(f)
        idx = {s['id']: s for s in prev.get('systems', []) if 'id' in s}
        print(f'Baseline: loaded {len(idx):,} systems from {OUTPUT_FILE}')
        return idx
    except Exception as e:
        print(f'  Could not read baseline {OUTPUT_FILE}: {e}')
        return {}

def merge_baseline(systems_by_id, baseline_by_id):
    """Backfill planet/asteroid data for systems not pulled this run.

    A system with an empty planets list was not fetched this run (every game
    system has at least one planet), so if the baseline has planet data for it,
    restore it. This lets a colonized-only update keep the full planet coverage
    captured by an earlier --all-planets pull.

    Planet geography is static; only ownership changes. Colonized systems are
    always re-pulled fresh above, so only a system abandoned since the last full
    pull can carry stale owner data here — self-correcting on the next
    --all-planets run.
    """
    restored = 0
    for sid, s in systems_by_id.items():
        if s['planets']:
            continue
        base = baseline_by_id.get(sid)
        if base and base.get('planets'):
            s['planets']        = base['planets']
            s['asteroidFields'] = base.get('asteroidFields', [])
            restored += 1
    return restored

# ── Cleaning functions ────────────────────────────────────────────────────────
def is_pvp(zone):
    return (zone or '').lower() != 'sentinel'

def clean_system(s):
    return {
        'id':                 s['id'],
        'name':               s.get('name'),
        'armId':              s.get('armId'),
        'sectorId':           s.get('sectorId'),
        'securityZone':       s.get('securityZone'),
        'isPvpZone':          is_pvp(s.get('securityZone')),
        'starType':           s.get('starType'),
        'visibility':         s.get('visibility'),
        'x':                  s.get('x'),
        'y':                  s.get('y'),
        'hasColonies':        s.get('hasColonies', False),
        'colonizedCount':     s.get('colonizedCount', 0),
        'planetCount':        s.get('planetCount', 0),
        'isMarketHub':        s.get('isMarketHub', False),
        'isRiftCore':         s.get('isRiftCore', False),
        'hasAllianceMarker':  False,
        'planets':            [],
        'asteroidFields':     [],
        'stations':           [],
    }

def clean_planet(p, system_zone, system_id=None):
    return {
        'id':                    p['id'],
        'name':                  p.get('name'),
        'systemId':              system_id,           # injected from context, not in API response
        'position':              p.get('position'),
        'planetType':            p.get('planetType'),
        'size':                  p.get('size'),
        'temperature':           p.get('temperature'),
        'securityZone':          system_zone,
        'userId':                p.get('userId'),
        'colonizedAt':           p.get('colonizedAt'),
        'isHomeworld':           p.get('isHomeworld'),
        'ownerName':             p.get('ownerName'),
        'ownerRace':             p.get('ownerRace'),
        'ownerAllianceTag':      p.get('ownerAllianceTag'),
        'ownerIsVacationMode':   p.get('ownerIsVacationMode'),
        'shieldReinforcedUntil': p.get('shieldReinforcedUntil'),
        'moons':                 [],   # populated separately from response['moons']
    }

def clean_moon(m):
    return {
        'id':             m['id'],
        'name':           m.get('name'),
        'parentPlanetId': m.get('planetId'),   # API returns planetId, we store as parentPlanetId
        'moonType':       m.get('moonType'),
        'size':           m.get('size'),
        'position':       m.get('position'),
        'buildingSlots':  m.get('buildingSlots'),
        'userId':         m.get('userId'),
        'ownerName':      m.get('ownerName'),
        'colonizedAt':    m.get('colonizedAt'),
    }

def clean_asteroid(af):
    return {
        'id':               af['id'],
        'name':             af.get('name'),
        'systemId':         af.get('systemId'),
        'fieldType':        af.get('fieldType'),
        'richness':         af.get('richness'),
        'remainingResources': af.get('remainingResources'),
        'totalResources':   af.get('totalResources'),
        'controllerName':   af.get('controllerName'),
        'controllerUserId': af.get('controllerUserId'),
        'allianceId':       af.get('allianceId'),
    }

def clean_station(st):
    buildings = {b['buildingKey']: b['level'] for b in (st.get('buildings') or [])}
    return {
        'id':                   st['id'],
        'name':                 st.get('name'),
        'systemId':             st.get('systemId'),
        'sectorId':             st.get('sectorId'),
        'systemName':           (st.get('system') or {}).get('name'),
        'ownerAllianceId':      st.get('ownerAllianceId'),
        'ownerAllianceTag':     (st.get('ownerAlliance') or {}).get('tag'),
        'ownerAllianceName':    (st.get('ownerAlliance') or {}).get('name'),
        'capturedByUserId':     st.get('capturedByUserId'),
        'capturingAllianceId':  st.get('capturingAllianceId'),
        'capturingAllianceTag': (st.get('capturingAlliance') or {}).get('tag'),
        'captureEndsAt':        st.get('captureEndsAt'),
        'shieldHp':             st.get('shieldHp'),
        'shieldMaxHp':          st.get('shieldMaxHp'),
        'shieldReinforcedUntil':st.get('shieldReinforcedUntil'),
        'garrison':             st.get('garrison') or [],
        'buildings': {
            'dock':    buildings.get('dock',    0),
            'shield':  buildings.get('shield',  0),
            'turret':  buildings.get('turret',  0),
            'storage': buildings.get('storage', 0),
        },
        'createdAt': st.get('createdAt'),
    }

def clean_sector(s):
    return {
        'id':                 s['id'],
        'armId':              s.get('armId'),
        'index':              s.get('index'),
        'name':               s.get('name'),
        'securityZone':       s.get('securityZone'),
        'visibility':         s.get('visibility'),
        'systemCount':        s.get('systemCount', 0),
        'colonizedPlanets':   s.get('colonizedPlanets', 0),
        'controllerAllianceId': s.get('controllerAllianceId'),
        'controlledSince':    s.get('controlledSince'),
    }

# ── Pull functions ────────────────────────────────────────────────────────────
def pull_galaxy_map(session, progress):
    """Phase 1: Pull all systems from galaxy map."""
    if progress['galaxy_map_done']:
        print('[✓] Galaxy map already pulled')
        return {int(k): v for k, v in progress['systems_by_id'].items()}

    print('[1] Pulling galaxy map...')
    data = get(session, '/api/galaxy/map')
    if not data:
        print('  ERROR: Could not fetch galaxy map. Check your token.')
        sys.exit(1)

    raw_systems = data.get('systems', [])
    print(f'  {len(raw_systems):,} systems in galaxy')

    systems_by_id = {}
    for s in raw_systems:
        if s.get('visibility') == 'full' and s.get('name'):
            systems_by_id[s['id']] = clean_system(s)

    print(f'  {len(systems_by_id):,} full-visibility named systems')
    progress['galaxy_map_done'] = True
    progress['systems_by_id']   = systems_by_id
    save_progress(progress)
    time.sleep(REQUEST_DELAY)
    return systems_by_id

def pull_sectors(session, progress, test_mode=False):
    """Phase 2: Pull sector lists for all arms."""
    if progress['sectors_done'] and progress['all_sectors']:
        print('[✓] Sectors already pulled')
        return progress['all_sectors']

    print('[2] Pulling sector lists...')

    # Try to discover arm IDs dynamically, fall back to known 1-6
    arm_ids = list(range(1, 7))  # default: arms 1-6
    arms_data = get(session, '/api/galaxy/arms', silent=True)
    if arms_data:
        # API may return { arms: [...] } or a list directly
        arms_list = arms_data.get('arms') if isinstance(arms_data, dict) else arms_data
        if isinstance(arms_list, list) and arms_list and 'id' in arms_list[0]:
            discovered = [a['id'] for a in arms_list]
            if len(discovered) >= 6:
                arm_ids = discovered
                print(f'  {len(arm_ids)} arms discovered from API')
            else:
                print(f'  API returned {len(discovered)} arms — using default 1-6')
        else:
            print(f'  Could not parse arms response — using default 1-6')
    else:
        print(f'  Arms endpoint unavailable — using default 1-6')

    if test_mode:
        arm_ids = arm_ids[:1]
        print(f'  TEST MODE: limiting to arm {arm_ids[0]}')

    print(f'  Pulling sectors for arms: {arm_ids}')
    all_sectors = []
    for arm_id in arm_ids:
        data = get(session, f'/api/galaxy/arms/{arm_id}/sectors')
        if data:
            sectors = data.get('sectors') or []
            cleaned = [clean_sector(s) for s in sectors]
            all_sectors.extend(cleaned)
            full = sum(1 for s in cleaned if s['visibility'] == 'full')
            print(f'  Arm {arm_id}: {len(sectors)} sectors, {full} visible')
        else:
            print(f'  Arm {arm_id}: no data returned')
        time.sleep(REQUEST_DELAY)

    print(f'  Total sectors: {len(all_sectors)}')
    progress['sectors_done'] = True
    progress['all_sectors']  = all_sectors
    save_progress(progress)
    return all_sectors

def pull_sector_systems(session, systems_by_id, progress,
                        all_sectors, test_mode=False):
    """Phase 3: Pull system lists per sector, update hasColonies flags."""
    completed = set(progress['completed_sectors'])
    stations  = progress['stations']

    # Only pull full-visibility sectors with content
    target_sectors = [
        s for s in all_sectors
        if s['visibility'] == 'full' and s['systemCount'] > 0
    ]

    if test_mode:
        target_sectors = target_sectors[:1]
        print(f'  TEST MODE: pulling 1 sector ({target_sectors[0]["name"]})')

    remaining = [s for s in target_sectors if s['id'] not in completed]
    total     = len(target_sectors)

    print(f'[3] Pulling sector systems...')
    print(f'  Target sectors : {total}')
    print(f'  Already done   : {len(completed)}')
    print(f'  Remaining      : {len(remaining)}')

    for i, sector in enumerate(remaining):
        sid       = sector['id']
        done_count = len(completed) + i
        pct       = (done_count / total) * 100
        print(f'  [{done_count+1:4d}/{total}] {sector["name"]:35s} {pct:5.1f}%',
              end='', flush=True)

        try:
            # Systems in this sector
            sys_data = get(session, f'/api/galaxy/sectors/{sid}/systems')
            if sys_data:
                sector_systems = sys_data.get('systems') or []
                colonized_ids  = []

                for s in sector_systems:
                    if s['id'] in systems_by_id:
                        # Update hasColonies from fresh data
                        systems_by_id[s['id']]['hasColonies']    = s.get('hasColonies', False)
                        systems_by_id[s['id']]['colonizedCount']  = s.get('colonizedCount', 0)
                        systems_by_id[s['id']]['isMarketHub']     = s.get('isMarketHub', False)
                        systems_by_id[s['id']]['isRiftCore']      = s.get('isRiftCore', False)
                    if s.get('hasColonies'):
                        colonized_ids.append(s['id'])

                print(f'  {len(colonized_ids)} colonized', end='', flush=True)
                time.sleep(REQUEST_DELAY * 0.5)

                # Planets for colonized systems only (unless all_planets enabled)
                if PULL['colonized_planets'] or PULL['all_planets']:
                    pull_targets = (
                        sector_systems if PULL['all_planets']
                        else [s for s in sector_systems if s.get('hasColonies')]
                    )
                    for sys in pull_targets:
                        sys_id = sys['id']
                        p_data = get(session, f'/api/galaxy/systems/{sys_id}/planets',
                                     silent=True)
                        if p_data and sys_id in systems_by_id:
                            zone    = systems_by_id[sys_id]['securityZone']
                            planets = p_data.get('planets') or []
                            moons   = p_data.get('moons')   or []
                            asteroids = p_data.get('asteroidFields') or []

                            # Build planet index for moon nesting
                            planet_map = {}
                            cleaned_planets = []
                            for p in planets:
                                cp = clean_planet(p, zone, system_id=sys_id)
                                planet_map[p['id']] = cp
                                cleaned_planets.append(cp)

                            # Nest moons under their parent planet
                            for m in moons:
                                pid = m.get('planetId')
                                if pid in planet_map:
                                    planet_map[pid]['moons'].append(clean_moon(m))

                            systems_by_id[sys_id]['planets'] = cleaned_planets

                            if PULL['asteroid_fields']:
                                systems_by_id[sys_id]['asteroidFields'] = [
                                    clean_asteroid(af) for af in asteroids
                                ]
                        time.sleep(REQUEST_DELAY * 0.3)

            # Stations for this sector
            if PULL['stations']:
                st_data = get(session, f'/api/stations/sector/{sid}', silent=True)
                if st_data:
                    for st in (st_data.get('stations') or []):
                        cleaned = clean_station(st)
                        stations.append(cleaned)
                        st_sys_id = st.get('systemId')
                        if st_sys_id in systems_by_id:
                            systems_by_id[st_sys_id]['stations'].append(cleaned)
                    n_st = len(st_data.get('stations') or [])
                    if n_st:
                        print(f'  {n_st}st', end='', flush=True)

            print()
            completed.add(sid)

        except Exception as e:
            print(f'\n  ERROR on sector {sid}: {e}')
            print('  Saving progress and stopping. Run again to resume.')
            progress['completed_sectors'] = list(completed)
            progress['systems_by_id']     = systems_by_id
            progress['stations']          = stations
            save_progress(progress)
            sys.exit(1)

        # Checkpoint every 25 sectors
        if (i + 1) % 25 == 0:
            progress['completed_sectors'] = list(completed)
            progress['systems_by_id']     = systems_by_id
            progress['stations']          = stations
            save_progress(progress)

        time.sleep(REQUEST_DELAY)

    # Final save
    progress['completed_sectors'] = list(completed)
    progress['systems_by_id']     = systems_by_id
    progress['stations']          = stations
    save_progress(progress)

    return systems_by_id, stations

# ── Optional pulls ────────────────────────────────────────────────────────────
def pull_wormholes(session):
    if not PULL['wormholes']:
        return []
    print('[opt] Pulling wormholes...')
    data = get(session, '/api/fleet/wormholes')
    return data.get('wormholes') or [] if data else []

def pull_market_hubs(session):
    if not PULL['market_hubs']:
        return []
    print('[opt] Pulling market hubs...')
    data = get(session, '/api/market/hubs')
    return data.get('hubs') or [] if data else []

def pull_pirate_camps(session):
    if not PULL['pirate_camps']:
        return []
    print('[opt] Pulling pirate camps...')
    data = get(session, '/api/galaxy/pirate-camps')
    return data.get('pirateCamps') or [] if data else []

def pull_system_debris(session):
    if not PULL['system_debris']:
        return []
    print('[opt] Pulling system debris...')
    data = get(session, '/api/galaxy/system-debris')
    return data.get('debris') or [] if data else []

# ── Assemble output ───────────────────────────────────────────────────────────
def assemble(systems_by_id, stations, all_sectors, config,
             wormholes, market_hubs, pirate_camps, system_debris,
             test_mode=False, merged_count=0):
    systems_list    = list(systems_by_id.values())
    total_planets   = sum(len(s['planets'])       for s in systems_list)
    total_moons     = sum(len(p['moons'])          for s in systems_list
                          for p in s['planets'])
    total_asteroids = sum(len(s['asteroidFields']) for s in systems_list)

    output = {
        'meta': {
            'capturedAt':         datetime.now(tz=timezone.utc).isoformat(),
            'generatedBy':        'nl_dumper.py',
            'testMode':           test_mode,
            'universe':           's0',
            'systemCount':        len(systems_list),
            'sectorCount':        len(all_sectors),
            'planetCount':        total_planets,
            'moonCount':          total_moons,
            'asteroidFieldCount': total_asteroids,
            'stationCount':       len(stations),
            'authUserId':         config['userId'],
            'authUsername':       config['username'],
            'mergedFromBaseline': merged_count,
            'pullConfig':         PULL,
        },
        'sectors':     all_sectors,
        'systems':     systems_list,
        'stations':    stations,
        'wormholes':   wormholes,
        'marketHubs':  market_hubs,
        'pirateCamps': pirate_camps,
        'systemDebris':system_debris,
    }

    fname = 'nexus-map-TEST.json' if test_mode else OUTPUT_FILE
    with open(fname, 'w') as f:
        json.dump(output, f, separators=(',', ':'))

    size_mb = os.path.getsize(fname) / 1024 / 1024
    print(f'\n{"TEST " if test_mode else ""}Output: {fname} ({size_mb:.1f} MB)')
    print(f'  Systems:    {len(systems_list):,}')
    print(f'  Planets:    {total_planets:,}')
    print(f'  Moons:      {total_moons:,}')
    print(f'  Asteroids:  {total_asteroids:,}')
    print(f'  Stations:   {len(stations):,}')
    if wormholes:   print(f'  Wormholes:  {len(wormholes):,}')
    if market_hubs: print(f'  Mkt Hubs:   {len(market_hubs):,}')
    return fname

# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    test_mode = '--test'  in sys.argv
    fresh     = '--fresh' in sys.argv
    no_merge  = '--no-merge' in sys.argv

    # Per-run planet-detail scope override
    if   '--all-planets'    in sys.argv: PULL['all_planets'] = True
    elif '--colonized-only' in sys.argv: PULL['all_planets'] = False

    print('=' * 60)
    print('  NEXUS LEGACY MAP INTELLIGENCE DUMPER')
    if test_mode: print('  *** TEST MODE — 1 sector only ***')
    print(f'  Planet detail: {"ALL systems" if PULL["all_planets"] else "colonized only"}'
          f'{"" if (no_merge or test_mode) else " + merge"}')
    print('=' * 60)

    start_time = time.time()
    start_dt   = datetime.now(tz=timezone.utc)
    print(f'Started: {start_dt.strftime("%Y-%m-%d %H:%M:%S UTC")}')

    config  = load_config()
    session = make_session(config['token'])

    if fresh and os.path.exists(PROGRESS_FILE):
        os.remove(PROGRESS_FILE)
        print('Progress file cleared — starting fresh.')

    progress = load_progress()

    # ── Pulls ─────────────────────────────────────────────────────────────────
    systems_by_id = pull_galaxy_map(session, progress)
    all_sectors   = pull_sectors(session, progress, test_mode=test_mode)
    systems_by_id, stations = pull_sector_systems(
        session, systems_by_id, progress, all_sectors, test_mode=test_mode
    )

    # Optional pulls
    wormholes    = pull_wormholes(session)
    market_hubs  = pull_market_hubs(session)
    pirate_camps = pull_pirate_camps(session)
    system_debris= pull_system_debris(session)

    # ── Merge with existing baseline ────────────────────────────────────────────
    # Backfill planet data for systems not re-pulled this run so a colonized-only
    # update keeps the full coverage from an earlier --all-planets pull.
    merged_count = 0
    if not no_merge and not test_mode:
        print('\nMerging with existing baseline...')
        baseline = load_baseline()
        if baseline:
            merged_count = merge_baseline(systems_by_id, baseline)
            print(f'  Restored planet data for {merged_count:,} systems '
                  f'from {OUTPUT_FILE}')

    # ── Assemble ───────────────────────────────────────────────────────────────
    print('\nAssembling output...')
    fname = assemble(
        systems_by_id, stations, all_sectors, config,
        wormholes, market_hubs, pirate_camps, system_debris,
        test_mode=test_mode, merged_count=merged_count
    )

    elapsed     = time.time() - start_time
    hours, rem  = divmod(int(elapsed), 3600)
    mins, secs  = divmod(rem, 60)
    elapsed_str = (f'{hours}h {mins}m {secs}s' if hours
                   else f'{mins}m {secs}s' if mins
                   else f'{secs}s')

    print(f'\nStarted:  {start_dt.strftime("%Y-%m-%d %H:%M:%S UTC")}')
    print(f'Finished: {datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}')
    print(f'Elapsed:  {elapsed_str}')

    if not test_mode:
        print(f'\nSafe to delete {PROGRESS_FILE} now.')
    else:
        print('\nTest complete. Check nexus-map-TEST.json to verify output.')
        print('Run without --test for full pull.')

if __name__ == '__main__':
    main()
