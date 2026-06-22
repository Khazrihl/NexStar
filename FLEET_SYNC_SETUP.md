# Fleet sync setup (one-time)

The viewer expects `map/fleet_all.json`, which is published hourly by
`.github/workflows/sync-fleet-data.yml`. That workflow pulls the file from a
**private** companion repo (`tmfink10/nextar-fleet-data`) and commits it here.

This is a one-time setup to give the workflow read access to that repo.

## 1. Get a read PAT from the data-repo owner
The token must be issued by the **owner** of `tmfink10/nextar-fleet-data`.
That person creates it at:

> GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens** → Generate new token

With these settings:

| Field | Value |
|---|---|
| Resource owner | `tmfink10` |
| Repository access | **Only select repositories** → `tmfink10/nextar-fleet-data` |
| Repository permissions | **Contents: Read-only** (everything else default) |
| Expiration | Pick a reasonable lifetime; the workflow will fail loudly when it expires |

Copy the token (`github_pat_…`) — it's shown only once.

## 2. Add it as a NexStar repo secret
In **this** repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Field | Value |
|---|---|
| Name | `FLEET_DATA_READ_TOKEN` |
| Secret | the token from step 1 |

## 3. Smoke-test
Go to **Actions → Sync fleet data → Run workflow** and trigger it manually.

It should:
1. Fetch `fleet_all.json` from the private repo.
2. Commit it to `map/fleet_all.json` here (only if changed).

After that the schedule (`cron: '15 * * * *'`) takes over and the file refreshes
automatically. The viewer (`map/nexus-map-viewer.html`) loads it on open.

## Rotating / revoking
- Replace the secret value with a fresh token any time; nothing else changes.
- To stop syncing entirely, delete the workflow file or disable the secret —
  the viewer just won't have fleet data and the rest of the map still works.
