import fs from 'node:fs';

const SERPAPI_KEY  = process.env.SERPAPI_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const LEAGUE_KGMID = process.env.LEAGUE_KGMID || '/m/02_tc';
const SPORT        = process.env.SPORT || 'ft';
const MAX_TEAMS    = parseInt(process.env.MAX_TEAMS || '10', 10);
const TYPE_LEAGUE  = process.env.TYPE_LEAGUE || '';
const TYPE_TEAM    = process.env.TYPE_TEAM || '';
const TEAMS_KGMIDS = (process.env.TEAMS_KGMIDS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(pair => { const [kgmid, name] = pair.split(':'); return [kgmid, name || kgmid]; });

const LEAGUE_TYPE_CANDIDATES = ['game', 'league', 'fixtures'];
const TEAM_TYPE_CANDIDATES   = ['game', 'team', 'fixtures'];

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

/* ---------- permissive game detection ---------- */
function sideOf(node, which) {
  const arr = Array.isArray(node.teams) ? node.teams : null;
  const cand = arr ? arr[which] :
    which === 0 ? (node.home_team ?? node.home ?? node.homeTeam ?? node.team_home)
                : (node.away_team ?? node.away ?? node.awayTeam ?? node.team_away);
  if (cand == null) return null;
  if (typeof cand === 'string') return { name: cand, kgmid: null };
  if (typeof cand === 'object') {
    return { name: cand.name || cand.short_name || cand.title || null, kgmid: cand.kgmid || null };
  }
  return null;
}

function scoresOf(node) {
  let hs = node.homeGoals ?? node.home_score ?? node.homeScore ?? null;
  let as = node.awayGoals ?? node.away_score ?? node.awayScore ?? null;

  const s = node.score ?? node.score_original ?? node.result ?? null;
  if ((hs == null || as == null) && typeof s === 'string') {
    const m = s.match(/(\d+)\s*[-:–]\s*(\d+)/);
    if (m) { hs = hs ?? Number(m[1]); as = as ?? Number(m[2]); }
  }

  if (Array.isArray(node.teams) && node.teams.length === 2) {
    hs = hs ?? node.teams[0].score ?? node.teams[0].score_original ?? null;
    as = as ?? node.teams[1].score ?? node.teams[1].score_original ?? null;
  }

  return [hs == null ? null : Number(hs), as == null ? null : Number(as)];
}

function looksLikeGame(node) {
  if (Array.isArray(node.teams) && node.teams.length === 2) return true;
  const h = node.home_team ?? node.home ?? node.homeTeam ?? node.team_home;
  const a = node.away_team ?? node.away ?? node.awayTeam ?? node.team_away;
  if (h && a) return true;
  if ((node.score || node.result) && (h || a)) return true;
  if (node.status && (node.start_time || node.date) && (h || a || node.teams)) return true;
  return false;
}

function collectGames(node, out = [], depth = 0) {
  if (depth > 6 || node == null) return out;
  if (Array.isArray(node)) { node.forEach(v => collectGames(v, out, depth + 1)); return out; }
  if (typeof node === 'object') {
    if (looksLikeGame(node)) out.push(node);
    else Object.values(node).forEach(v => collectGames(v, out, depth + 1));
  }
  return out;
}

function normGame(g) {
  const home = sideOf(g, 0) || {};
  const away = sideOf(g, 1) || {};
  const [hs, as] = scoresOf(g);
  return {
    date: g.start_time || g.date || g.time || g.start_date || null,
    status: g.status || g.status_original || null,
    home: { name: home.name || null, kgmid: home.kgmid || null },
    away: { name: away.name || null, kgmid: away.kgmid || null },
    homeGoals: hs, awayGoals: as
  };
}

const isValid  = g => g.home.name && g.away.name;
const isPlayed = g => isValid(g) && g.homeGoals != null && g.awayGoals != null;
const isFuture = g => isValid(g) && g.homeGoals == null && g.date;

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

  /* ---- LEAGUE ---- */
  let leagueRaw = null;
  let games = [];

  for (const type of (TYPE_LEAGUE ? [TYPE_LEAGUE] : LEAGUE_TYPE_CANDIDATES)) {
    try {
      leagueRaw = await serp({ kgmid: LEAGUE_KGMID, sp: SPORT, type });
      meta.searches++;
      const g = dedupe(collectGames(leagueRaw).map(normGame).filter(isValid));
      console.log(`league type=${type} → 200 OK, ${g.length} games found`);
      if (g.length) { games = g; meta.leagueType = type; break; }
      console.warn(`league type=${type} returned 0 games. Payload keys: ${Object.keys(leagueRaw).join(', ')}`);
      console.warn('PAYLOAD SNIPPET: ' + JSON.stringify(leagueRaw).slice(0, 800));
    } catch (e) {
      if (e instanceof Fatal) throw e;
      console.warn(`league type=${type} → ${e.message}`);
    }
  }

  if (leagueRaw) {
    fs.writeFileSync('data/raw-payload.json', JSON.stringify(leagueRaw, null, 2).slice(0, 20000));
  }

  if (!leagueRaw && !TEAMS_KGMIDS.length) {
    throw new Error('League fetch failed for every type candidate and no TEAMS_KGMIDS fallback set.');
  }

  const now = Date.now();
  let upcoming = dedupe(games.filter(g => isFuture(g) && new Date(g.date).getTime() >= now - 3 * 3600e3));
  const finished = dedupe(games.filter(isPlayed));

  /* ---- TEAMS ---- */
  const teamIds = new Map();
  for (const g of upcoming) {
    if (g.home.kgmid) teamIds.set(g.home.kgmid, g.home.name);
    if (g.away.kgmid) teamIds.set(g.away.kgmid, g.away.name);
  }
  for (const [kgmid, name] of TEAMS_KGMIDS) if (!teamIds.has(kgmid)) teamIds.set(kgmid, name);

  const form = {};
  const unplayedFromTeams = [];
  let teamType = TYPE_TEAM || null;
  let teamsDone = 0;

  for (const [kgmid, name] of [...teamIds.entries()].slice(0, MAX_TEAMS)) {
    const handleRaw = (raw) => {
      const all = collectGames(raw).map(normGame);
      const played = all.filter(isPlayed);
      unplayedFromTeams.push(...all.filter(isFuture));
      if (played.length) { form[name] = shapeForm(played, kgmid, name); teamsDone++; }
      return played.length;
    };

    try {
      if (!teamType) {
        for (const t of TEAM_TYPE_CANDIDATES) {
          const raw = await serp({ kgmid, sp: SPORT, type: t });
          meta.searches++;
          const n = handleRaw(raw);
          console.log(`team type=${t} → 200 OK, ${n} played games`);
          if (n) { teamType = t; meta.teamType = t; break; }
          console.warn(`team type=${t} returned 0 played games. Payload keys: ${Object.keys(raw).join(', ')}`);
        }
      } else {
        const raw = await serp({ kgmid, sp: SPORT, type: teamType });
        meta.searches++;
        handleRaw(raw);
      }
      await sleep(400);
    } catch (e) {
      if (e instanceof Fatal) throw e;
      console.warn(`team "${name}" failed: ${e.message}`);
    }
  }

  if (!upcoming.length && unplayedFromTeams.length) {
    upcoming = dedupe(unplayedFromTeams).filter(g => new Date(g.date).getTime() >= now - 3 * 3600e3);
    console.log(`league tab empty → built ${upcoming.length} upcoming fixtures from team pages`);
  }

  /* ---- ODDS ---- */
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
  fs.writeFileSync('data/raw-sample.json', JSON.stringify((leagueRaw ? collectGames(leagueRaw) : []).slice(0, 2), null, 2));

  console.log(`SUMMARY: leagueType=${meta.leagueType} teamType=${meta.teamType} upcoming=${upcoming.length} forms=${teamsDone} odds=${oddsRows.length} searches=${meta.searches}`);
  console.log('TIP: pin discovered types via Settings → Variables → TYPE_LEAGUE / TYPE_TEAM.');
}

main().catch(e => {
  console.error('RUN FAILED:', e.message);
  process.exit(1);
});
