# MENA Displacement Monitor

An interactive dashboard of internal displacement across MENA, built on **IOM DTM**
data. Country + time-period filters, a flow map with click-to-drill (governorate →
district), a by-area bar chart, and a weekly-trend line.

- **Yemen** is fully wired: *new weekly displacement in households* from the Rapid
  Displacement Tracking (RDT) dataset, with origin→destination down to district level.
- **Iraq, Libya, Sudan, Syria, Lebanon** come from the DTM API (*present IDP stock,
  monthly*); their data is pulled by the refresh script and the app's "stock mode"
  is the next build step (see `CLAUDE.md`).

Self-contained: plain HTML/CSS/JS, no build step, no framework. The only runtime
input is `data/data.json`.

## Project structure
```
mena-displacement-monitor/
├── index.html            The app (reads data/data.json). No build step.
├── data/
│   └── data.json         Current data (Yemen live; MENA added by the refresh script)
├── scripts/
│   ├── refresh_dtm.py    Pulls DTM → writes data/data.json  (run this to refresh)
│   └── IOM Yemen … .xlsx  Yemen RDT source workbook (Yemen is built from this)
├── reference/            The static poster (PNG/PDF) for context
├── .env.example          Copy to .env and add your DTM_API_KEY
├── .gitignore            Ignores .env, dtm_key.txt, caches
├── README.md
└── CLAUDE.md             Architecture + TODOs for continuing in Claude Code
```

## Run it locally
The app fetches `data/data.json`, so it must be served over HTTP (opening
`index.html` from disk is blocked by the browser). From the project folder:
```
python -m http.server 8000
```
then open **http://localhost:8000**. Click **Taiz** to drill into its districts;
use **← All governorates** to zoom back out.

## Refresh the data (manual download → one command)

The app ships **two Yemen datasets**, both built from IOM DTM **workbooks** (no API — the
DTM API has no 2026/weekly Yemen data; see `DESIGN.md`):

- **West Coast Escalation** (default) — the *daily* escalation dataset (individuals).
- **Rapid Displacement Tracking** — the *weekly* RDT (households).

To refresh, download the newest workbook(s) from the DTM site and drop them in `scripts/`:

1. Deps (once): `pip install dtmapi pandas geopandas shapely openpyxl requests`
   (Anaconda already has these here.)
2. From [dtm.iom.int/datasets](https://dtm.iom.int/datasets?f%5B0%5D=dataset_country%3A85&f%5B1%5D=dataset_published_date_1%3A2026)
   (Yemen, 2026), download the latest:
   - *"Rapid Displacement Tracking (RDT) Dataset … District Level.xlsx"*, and/or
   - *"Displacement Caused by Escalation in the West Coast … .xlsx"*
   Drop the file(s) into `scripts/`. **Newest file of each kind wins** (by modified time);
   the weekly grid and 2026 window are derived from the data automatically.
3. Build:
   ```
   python scripts/refresh_dtm.py      # writes data/data.json (both datasets)
   npm run build                      # or `npm run dev` auto-reloads
   ```
   Boundaries are fetched from geoBoundaries at build time (cached across both datasets).
   On Windows, prefix with `PYTHONIOENCODING=utf-8` if the console chokes on Unicode.

## Deploy free on GitHub Pages
1. Create a new GitHub repo and push this folder:
   ```
   git init && git add . && git commit -m "MENA Displacement Monitor v0"
   git branch -M main
   git remote add origin https://github.com/<you>/mena-displacement-monitor.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch → Branch: `main` / root → Save**.
3. Your site goes live at `https://<you>.github.io/mena-displacement-monitor/`
   within a minute. To update it, re-run the refresh script, commit the new
   `data/data.json`, and push.

`.env`, `dtm_key.txt` and the discover dump are gitignored, so your key never
ships to the repo or the public site.

## Data & method notes
- **Households vs people**: Yemen RDT records *households*; people shown in the app
  are an indicative estimate (× 6, an assumed average household size — the RDT does
  not record individuals). API countries report *individuals* directly.
- **Flow vs stock**: Yemen = new weekly displacement (additive — you can sum weeks).
  API countries = present IDP stock per round (never summed across rounds; show the
  latest and trend it). The app keeps these distinct.
- **Source**: IOM DTM — Rapid Displacement Tracking & DTM API. Boundaries:
  geoBoundaries (gbOpen). Prepared for UNICEF.
