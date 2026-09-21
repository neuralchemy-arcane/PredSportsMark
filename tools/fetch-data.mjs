import fs from 'node:fs';

const SERPAPI_KEY  = process.env.SERPAPI_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const LEAGUE_KGMID = process.env.LEAGUE_KGMID || '/m/02_tc'; // Premier League
const SPORT        = process.env.SPORT || 'ft';              // proven by your sample
const MAX_TEAMS    = parseInt(process.env.MAX_TEAMS || '10', 10);
const TYPE_LEAGUE  = process.env.TYPE_LEAGUE || '';  // pin once discovered
const TYPE_TEAM    = process.env.TYPE_TEAM || '';    // pin once discovered

const LEAGUE_TYPE_CANDIDATES = ['schedule', 'results', 'standings', 'games'];
const TEAM_TYPE_CANDIDATES   = ['results', 'schedule', 'games'];

if (!SERPAPI_KEY) { console.error('FATAL: SERPAPI_KEY secret is missing.'); process.exit(1); }
fs.mkdirSync('data', { recursive: true });

class Fatal extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function serp(params) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_sports');
  url.searchParams.set('hl', 'en');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', SERPAPI_KEY);

  const res = await fetch(url);
  const body = await res.text();

  if (!res.ok) {
    const snippet = body.slice(0, 200);
    if ([401, 403, 429].includes(res.status)) throw new Fatal(`SerpApi HTTP ${res.status}: ${snippet}`);
    const e = new Error(`SerpApi HTTP ${res.status}: ${snippet}`);
    e.retryable = true;
    throw e;
  }
  return JSON.parse(body);
}

function collectGames(node, out = [], depth = 0) {
  if (depth > 6 || node == null) return out;
  if (Array.isArray(node)) { node.forEach(v => collectGames(v, out, depth + 1)); return out; }
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
    home = g.home_team || {}; away = g.away_team || {};
    hs = g.home_score ?? null; as = g.away_score ?? null;
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

const isValid   = g => g.home.name && g.away.name;
const isPlayed  = g => isValid(g) && g.homeGoals != null && g.awayGoals != null;

function dedupe(games) {
  const seen = new Set();
  return games.filter(g => {
    const k = `${g.home.name}|${g.away.name}|${g.date}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function shapeForm(rows, kgmid, name) {
  return rows.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10).map(g => ({
    date: g.date,
    home: g.home.name, away: g.away.name,
    homeGoals: g.homeGoals, awayGoals: g.awayGoals,
    teamIsHome: (g.home.kgmid === kgmid) || (g.home.name === name)
  }));
}

async function main() {
  const meta = { generatedAt: new Date().toISOString(), searches: 0, leagueType: null, teamType: null };

  /* ---- LEAGUE: discover working `type` ---- */
  let leagueRaw = null;
  let games = [];

  for (const type of (TYPE_LEAGUE ? [TYPE_LEAGUE] : LEAGUE_TYPE_CANDIDATES)) {
    try {
      leagueRaw = await serp({ kgmid: LEAGUE_KGMID, sp: SPORT, type });
      meta.searches++;
      const g = dedupe(collectGames(leagueRaw).map(normGame).filter(isValid));
      console.log(`league type=${type} → 200 OK, ${g.length} games found`);
      if (g.length) { games = g; meta.leagueType = type; break; }
    } catch (e) {
      if (e instanceof Fatal) throw e;
      console.warn(`league type=${type} → ${e.message}`);
    }
  }

  if (!leagueRaw) throw new Error('League fetch failed for every type candidate. Check kgmid/secret.');
  if (!games.length) {
    console.warn('WARNING: league payload contained 0 games. Top-level keys: ' + Object.keys(leagueRaw).join(', '));
    console.warn('Inspect data/raw-sample.json after this run.');
  }

  const now = Date.now();
  const upcoming = games.filter(g => g.date && new Date(g.date).getTime() >= now - 3 * 3600e3);
  const finished = games.filter(isPlayed);

  /* ---- TEAMS: discover team `type` once, reuse ---- */
  const teamIds = new Map();
  for (const g of upcoming) {
    if (g.home.kgmid) teamIds.set(g.home.kgmid, g.home.name);
    if (g.away.kgmid) teamIds.set(g.away.kgmid, g.away.name);
  }

  const form = {};
  let teamType = TYPE_TEAM || null;
  let teamsDone = 0;

  for (const [kgmid, name] of [...teamIds.entries()].slice(0, MAX_TEAMS)) {
    try {
      if (!teamType) {
        for (const t of TEAM_TYPE_CANDIDATES) {
          const raw = await serp({ kgmid, sp: SPORT, type: t });
          meta.searches++;
          const rows = collectGames(raw).map(normGame).filter(isPlayed);
          console.log(`team type=${t} → 200 OK, ${rows.length} played games`);
          if (rows.length) {
            teamType = t;
            meta.teamType = t;
            form[name] = shapeForm(rows, kgmid, name);
            teamsDone++;
            break;
          }
        }
      } else {
        const raw = await serp({ kgmid, sp: SPORT, type: teamType });
        meta.searches++;
        const rows = collectGames(raw).map(normGame).filter(isPlayed);
        if (rows.length) { form[name] = shapeForm(rows, kgmid, name); teamsDone++; }
      }
      await sleep(400);
    } catch (e) {
      if (e instanceof Fatal) throw e;
      console.warn(`team "${name}" failed: ${e.message}`);
    }
  }

  /* ---- ODDS (RapidAPI, optional) ---- */
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
        body: JSON.stringify({ mode: 'odds', leagues: ['epl'], daysAhead: 7, markets: ['moneyline'], maxItems: 50 })
      });
      if (res.ok) {
        const j = await res.json();
        oddsRows = Array.isArray(j) ? j : (j.rows || j.data || j.items || j.results || []);
      } else console.warn(`odds HTTP ${res.status}`);
    } catch (e) { console.warn('odds failed:', e.message); }
  }

  /* ---- WRITE ---- */
  fs.writeFileSync('data/fixtures.json', JSON.stringify(upcoming, null, 2));
  fs.writeFileSync('data/results.json',  JSON.stringify(finished.slice(0, 60), null, 2));
  fs.writeFileSync('data/form.json',     JSON.stringify(form, null, 2));
  fs.writeFileSync('data/odds.json',     JSON.stringify(oddsRows, null, 2));
  fs.writeFileSync('data/meta.json',     JSON.stringify({ ...meta, teamsDone }, null, 2));
  fs.writeFileSync('data/raw-sample.json', JSON.stringify(collectGames(leagueRaw).slice(0, 2), null, 2));

  console.log(`SUMMARY: leagueType=${meta.leagueType} teamType=${meta.teamType} upcoming=${upcoming.length} forms=${teamsDone} odds=${oddsRows.length} searches=${meta.searches}`);
  console.log('TIP: pin the discovered types in Settings → Variables → TYPE_LEAGUE / TYPE_TEAM to skip discovery next run.');
}

main().catch(e => {
  console.error('RUN FAILED:', e.message);
  process.exit(1);
});
