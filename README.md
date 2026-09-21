# DeepPitch Pro

Free static football prediction dashboard for GitHub Pages.

## Data sources (all free)
- API-Football (RapidAPI Basic): fixtures, live scores, last-10 form, stats/xG where available
- Sports Betting Odds API (RapidAPI BASIC $0): daily odds snapshot, matched by fuzzy team names
- football-data.co.uk CSVs: backtesting + calibration (no account needed)

## Setup
1. RapidAPI account → subscribe (free) to BOTH APIs above.
2. Push this folder to a GitHub repo.
3. Settings → Pages → Branch: main, Folder: / (root) → Save.
4. Open the site, paste your RapidAPI key, click Save Key & Load.
5. Click "Probe Odds Feed" once to verify odds rows (first call can take ~50s).
6. Upload a football-data.co.uk CSV to calibrate the model.

## Budgets
- API-Football: 85 requests/day cap enforced client-side (caching reduces real usage).
- Odds feed: 1 cached snapshot per 24h (~30/month, hard cap 40) under the 100/month plan.

## Disclaimer
Educational analytics. No guaranteed profit. Bet responsibly.