const DP_CONFIG = Object.freeze({
  // API-Football (fixtures, live, last-10, stats/xG where available)
  API_HOST: 'v3.football.api-sports.io',

  // 39 EPL · 140 La Liga · 135 Serie A · 78 Bundesliga · 61 Ligue 1 · 2 UCL
  DEFAULT_LEAGUES: [39, 140, 135, 78, 61, 2],

  LAST_N: 10,
  PROB_THRESHOLD: 0.80,
  MIN_DATA_QUALITY: 0.65,
  VALUE_EDGE: 0.03,

  // API-Football free tier ≈ 100 req/day → keep a safety margin
  MAX_DAILY_REQUESTS: 85,
  DELAY_MS: 350,
  AUTO_ANALYZE_LIMIT: 10,

  // Sports Betting Odds API (free BASIC: 100 req/MONTH, 60/hour, sync ≤ ~50s)
  // One cached snapshot per day ≈ 30 req/month. Add league keys after probing.
  ODDS_LEAGUE_KEYS: ['epl'],
  ODDS_DAYS_AHEAD: 7,
  ODDS_MAX_ITEMS: 50
});