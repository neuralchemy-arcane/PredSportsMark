import fs from 'node:fs';

const SERPAPI_KEY  = process.env.SERPAPI_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const LEAGUE_KGMID = process.env.LEAGUE_KGMID || '/m/02_tc'; // Premier League
const SPORT        = process.env.SPORT || 'football';
const MAX_TEAMS    = parseInt(process.env.MAX_TEAMS || '10', 10);

if (!SERPAPI_KEY) {
  console.error('FATAL: SERPAPI_KEY secret is missing.');
  process.exit(1);
}

fs.mkdirSync('data', { recursive: true });

async function serp(params) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_sports');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('sp', SPORT);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', SERPAPI_KEY);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/* Defensive walker: finds anything that looks like a game anywhere in the payload */
function collectGames(node, out = [], depth = 0) {
  if (depth > 6 || node == null) return out;

  if (Array.isArray(node)) {
    node.forEach(v => collectGames(v, out, depth + 1));
    return out;
  }

  if (typeof node === 'object') {
    const looksLikeGame =
      (Array.isArray(node.teams) && node.teams.length === 2) ||
      (node.home_team && node.away_team) ||
      (node.status && (node.start_time || node.date) && (node.teams || node.home_team));

    if (looksLikeGame) out.push(node);
    else Object.values(node).forEach(v => collectGames(v, out, depth + 1));
  }

  return out;
}

function normGame(g) {
  let home, away, hs, as;

  if (Array.isArray(g.teams) && g.teams.length === 2) {
    [home, away] = g.teams;
    hs = home.score ?? home.score_original ?? null;
    as = away.score ?? away.score_original ?? null;
  } else {
    home = g.home_team || {};
    away = g.away_team || {};
    hs = g.home_score ?? null;
    as = g.away_score ?? null;
  }

  return {
    date: g.start_time || g.date || null,
    status: g.status || g.status_original || null,
    home: { name: home.name || home.short_name || null, kgmid: home.kgmid || null },
    away: { name: away.name || away.short_name || null, kgmid: away.kgmid || null },
    homeGoals: hs == null ? null : Number(hs),
    awayGoals: as == null ? null : Number(as)
  };
}

async function main() {
  const meta = { generatedAt: new Date().toISOString(), searches: 0 };

  /* 1) League page → schedule + recent results */
  const leagueRaw = await serp({ kgmid: LEAGUE_KGMID });
  meta.searches += 1;

  const leagueGames = collectGames(leagueRaw)
    .map(normGame)
    .filter(g => g.home.name && g.away.name);

  // de-duplicate
  const seen = new Set();
  const games = leagueGames.filter(g => {
    const k = `${g.home.name}|${g.away.name}|${g.date}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const now = Date.now();
  const upcoming = games.filter(g => g.date && new Date(g.date).getTime() >= now - 3 * 3600e3);
  const finished = games.filter(g => g.homeGoals != null && g.awayGoals != null);

  /* 2) Team pages → last-10 form for teams in upcoming fixtures */
  const teamIds = new Map();
  for (const g of upcoming) {
    if (g.home.kgmid) teamIds.set(g.home.kgmid, g.home.name);
    if (g.away.kgmid) teamIds.set(g.away.kgmid, g.away.name);
  }

  const form = {};
  let teamsDone = 0;

  for (const [kgmid, name] of [...teamIds.entries()].slice(0, MAX_TEAMS)) {
    try {
      const teamRaw = await serp({ kgmid });
      meta.searches += 1;
      teamsDone += 1;

      const played = collectGames(teamRaw)
        .map(normGame)
        .filter(g => g.home.name && g.away.name && g.homeGoals != null && g.awayGoals != null)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 10);

      form[name] = played.map(g => ({
        date: g.date,
        home: g.home.name,
        away: g.away.name,
        homeGoals: g.homeGoals,
        awayGoals: g.awayGoals,
        teamIsHome: (g.home.kgmid === kgmid) || (g.home.name === name)
      }));

      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.warn(`team "${name}" failed: ${e.message}`);
    }
  }

  /* 3) Odds snapshot (RapidAPI, server-side → no CORS issue) */
  let oddsRows = [];
  if (RAPIDAPI_KEY) {
    try {
      const res = await fetch('https://sports-betting-odds-api.p.rapidapi.com/v1/sports-odds-api/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': 'sports-betting-odds-api.p.rapidapi.com'
        },
        body: JSON.stringify({
          mode: 'odds',
          leagues: ['epl'],
          daysAhead: 7,
          markets: ['moneyline'],
          maxItems: 50
        })
      });

      if (res.ok) {
        const j = await res.json();
        oddsRows = Array.isArray(j) ? j : (j.rows || j.data || j.items || j.results || []);
      } else {
        console.warn(`odds HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn('odds failed:', e.message);
    }
  }

  /* 4) Write outputs */
  fs.writeFileSync('data/fixtures.json', JSON.stringify(upcoming, null, 2));
  fs.writeFileSync('data/results.json',  JSON.stringify(finished.slice(0, 60), null, 2));
  fs.writeFileSync('data/form.json',     JSON.stringify(form, null, 2));
  fs.writeFileSync('data/odds.json',     JSON.stringify(oddsRows, null, 2));
  fs.writeFileSync('data/meta.json',     JSON.stringify({ ...meta, teamsDone }, null, 2));
  fs.writeFileSync('data/raw-sample.json', JSON.stringify(collectGames(leagueRaw).slice(0, 2), null, 2));

  console.log(`OK: ${upcoming.length} upcoming, ${Object.keys(form).length} team forms, ${oddsRows.length} odds rows, ${meta.searches} SerpApi searches`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});