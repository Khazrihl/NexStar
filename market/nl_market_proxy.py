"""
NexStar Market Proxy
Reads token from nl_config.txt and proxies requests to the Nexus Legacy
game API, bypassing browser CORS restrictions.

Run this once, then open nexus-market-viewer.html in your browser.
Leave it running while you use the market viewer.
Press Ctrl+C to stop.
"""

import http.server
import urllib.request
import urllib.error
import json
import os
import sys

# ── Config ────────────────────────────────────────────────────────────────
PROXY_PORT  = 8765
GAME_BASE   = 'https://s0.nexuslegacy.space'
CONFIG_FILE = 'nl_config.txt'
ALLOWED_PATHS = [
    '/api/market/orders',
    '/api/market/hubs',
    '/api/market/my-balances',
    '/api/alliance-trade/orders',
    '/api/alliance-trade/hub-status',
]

# ── Load token ────────────────────────────────────────────────────────────
def load_token():
    if not os.path.exists(CONFIG_FILE):
        print(f'ERROR: {CONFIG_FILE} not found.')
        print('Create it with: token=your_nexus_token_here')
        sys.exit(1)
    with open(CONFIG_FILE) as f:
        for line in f:
            line = line.strip()
            if line.startswith('token='):
                token = line.split('=', 1)[1].strip()
                if token:
                    return token
    print(f'ERROR: token not found in {CONFIG_FILE}.')
    sys.exit(1)

TOKEN = load_token()

# ── Token expiry check ────────────────────────────────────────────────────
def check_token_expiry(token):
    try:
        import base64, json as _json
        payload = token.split('.')[1]
        payload += '=' * (4 - len(payload) % 4)
        claims  = _json.loads(base64.b64decode(payload))
        from datetime import datetime, timezone, timedelta
        exp      = datetime.fromtimestamp(claims['exp'], tz=timezone.utc)
        now      = datetime.now(tz=timezone.utc)
        username = claims.get('username', '?')
        days_left = (exp - now).days

        print(f'  User     : {username}')
        print(f'  Expires  : {exp.strftime("%Y-%m-%d")} ({days_left} days)')

        if now > exp:
            print()
            print('  !! TOKEN EXPIRED — requests will fail.')
            print('  !! Get a fresh token from the game and update nl_config.txt')
        elif days_left <= 7:
            print()
            print(f'  !! WARNING: Token expires in {days_left} days.')
            print('  !! Get a fresh token from the game soon.')
        elif days_left <= 14:
            print(f'  (Token expires soon — refresh within {days_left} days)')

    except Exception:
        print('  Token loaded (could not decode expiry)')

check_token_expiry(TOKEN)

# ── Proxy handler ─────────────────────────────────────────────────────────
class ProxyHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        # Clean up logging — just show path and status
        print(f'  {self.path.split("?")[0]}  →  {args[1]}')

    def do_GET(self):
        # Only proxy allowed market endpoints
        base_path = self.path.split('?')[0]
        if not any(self.path.startswith(p) for p in ALLOWED_PATHS):
            self.send_error(404, 'Not a proxied endpoint')
            return

        target_url = GAME_BASE + self.path

        req = urllib.request.Request(target_url)
        req.add_header('accept',          'application/json, text/plain, */*')
        req.add_header('accept-language', 'en-US,en;q=0.9')
        req.add_header('referer',         f'{GAME_BASE}/galaxy')
        req.add_header('user-agent',      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
        req.add_header('cookie',          f'nexus_token={TOKEN}; nexus_lang=en')
        req.add_header('sec-fetch-dest',  'empty')
        req.add_header('sec-fetch-mode',  'cors')
        req.add_header('sec-fetch-site',  'same-origin')

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                origin = self.headers.get('Origin', '*')
                self.send_response(resp.status)
                self.send_header('Content-Type',                'application/json')
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Access-Control-Allow-Credentials', 'true')
                self.send_header('Content-Length',              str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        except urllib.error.HTTPError as e:
            body = e.read()
            print(f'  Game server error: {e.code} — {body[:200]}')
            origin = self.headers.get('Origin', '*')
            self.send_response(e.code)
            self.send_header('Content-Type',                'application/json')
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Credentials', 'true')
            self.end_headers()
            self.wfile.write(body)

        except Exception as e:
            print(f'  Proxy error: {e}')
            self.send_error(502, str(e))

    def do_OPTIONS(self):
        origin = self.headers.get('Origin', '*')
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin',      origin)
        self.send_header('Access-Control-Allow-Credentials', 'true')
        self.send_header('Access-Control-Allow-Methods',     'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers',     'Content-Type')
        self.end_headers()

# ── Main ──────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print('=' * 50)
    print('  NEXSTAR MARKET PROXY')
    print('=' * 50)
    print(f'  Token loaded — ready')
    print(f'  Listening on http://localhost:{PROXY_PORT}')
    print(f'  Open nexus-market-viewer.html in your browser')
    print(f'  Press Ctrl+C to stop')
    print()

    server = http.server.HTTPServer(('localhost', PROXY_PORT), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nProxy stopped.')
