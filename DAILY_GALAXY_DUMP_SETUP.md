# Daily galaxy dump — one-time setup

The `.github/workflows/daily-galaxy-dump.yml` workflow runs `nl_dumper.py`
on a schedule and commits the refreshed `map/nexus-map-clean.json` back to
`main`. It needs one secret to run.

## Add `NEXUS_TOKEN`

1. Grab a live token from the browser cookie:
   - Sign in to https://s0.nexuslegacy.space
   - DevTools → **Application → Cookies → s0.nexuslegacy.space** → copy
     the value of `nexus_token`.
   - It's a JWT (`eyJhbGc…`). Account choice matters — the dump captures
     what *this* account can see, so a leader / scout account with broad
     visibility produces the most complete file.
2. **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: **`NEXUS_TOKEN`**
   - Secret: the token value from step 1.

## Smoke-test

**Actions → Daily galaxy dump → Run workflow**. The run should:

1. Install Python + `requests`.
2. Write `map/nl_config.txt` from the secret (gitignored, never committed).
3. Run `nl_dumper.py` (≈15 min).
4. Commit `map/nexus-map-clean.json` if it changed.

A commit titled `Daily galaxy dump (NN,NNN systems, ISO-timestamp)` on
`main` means it worked.

## Cadence + cost

- Default schedule: **06:00 UTC daily** (quiet hour for most regions).
  Change the cron line in the workflow to taste.
- One run ≈ ~3,000 API requests at the dumper's polite 1 req/s pacing.
  GitHub Actions free tier easily covers this.
- The token expires every ~60 days; **the workflow will fail with a clear
  error** when that happens — refresh the secret and re-run.

## Rotating / disabling

- Rotate the token: regenerate the cookie, replace the secret value.
- Pause the schedule: disable the workflow from the Actions tab.
- Stop entirely: delete the workflow file.
