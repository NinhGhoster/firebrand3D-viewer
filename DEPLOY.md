# Deploying the Firebrand3D viewer

The viewer is served by Caddy on gumnut (`45.113.232.25`) at
`https://firebrand3d.flarewildfire.app/`.

| what | where |
|---|---|
| viewer source | `/var/www/html_firebrand3d` |
| dataset | `/mnt/firebrand3d/level2`, served under `/media/` |
| Caddy site block | `/etc/caddy/Caddyfile` |

`database.json` and `vendor/` are generated, not committed.

## Deploy

```bash
KEY=~/gumnut.pem; HOST=ubuntu@45.113.232.25
scp -i $KEY index.html app.js index.css build_database.py paper.html $HOST:/var/www/html_firebrand3d/
ssh -i $KEY $HOST 'cd /var/www/html_firebrand3d && python3 build_database.py /mnt/firebrand3d/level2 database.json'
```

## Rebuild the catalogue after any change to the release

`build_database.py` reads `firebrand_manifest.csv`, `experiment_media.csv` and
`thermal_acquisition_parameters.csv` — it does **not** walk the tree, so a restructure does
not break it as long as the index files are regenerated first (`tools/build_manifest_v2.py`).

`MEDIA_PREFIX` defaults to `/media/level2/`, matching the Caddy `handle_path` block. Change
it there if the site layout changes.

## Vendored libraries

three.js and the Draco decoder are served from this host, not a CDN, so a CDN outage cannot
blank the page. To refresh them:

```bash
D=/var/www/html_firebrand3d/vendor; B=https://unpkg.com/three@0.160.0
mkdir -p $D/three/addons/controls $D/three/addons/loaders $D/draco
curl -sSfL -o $D/three/three.module.js "$B/build/three.module.js"
curl -sSfL -o $D/three/addons/controls/OrbitControls.js "$B/examples/jsm/controls/OrbitControls.js"
curl -sSfL -o $D/three/addons/loaders/DRACOLoader.js "$B/examples/jsm/loaders/DRACOLoader.js"
for f in draco_decoder.js draco_decoder.wasm draco_wasm_wrapper.js; do
  curl -sSfL -o $D/draco/$f "$B/examples/jsm/libs/draco/$f"; done
```

The importmap in `index.html` points at `./vendor/three/`; keep the version in step with it.

## Caching

Caddy originally sent no `Cache-Control` for this site, only an ETag, so browsers cached
heuristically and never revalidated. A returning visitor could run a cached old `app.js`
against a new `index.html`, which fails on missing elements and surfaces as "Failed to Load
Database" — a stale cache reported as corrupt data.

The site block now sets:

| paths | header | why |
|---|---|---|
| `/`, `/index.html`, `/app.js`, `/index.css`, `/database.json`, `/paper.html`, `/staging.html` | `no-cache` | revalidate every load; unchanged files still cost only a 304 |
| `/vendor/*` | `public, max-age=86400` | pinned by the importmap, but refreshing three.js in place must not serve stale for weeks |

`no-cache` does **not** mean "do not cache" — the copy is reused after revalidation. After
changing the Caddyfile, `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
then `sudo systemctl reload caddy`. Backups are written alongside as `Caddyfile.bak.<stamp>`.

## Not yet done

The site carries no `noindex`. The staging page it replaced did. Add one to `index.html` if
it should stay out of search results until the DOI is public.
