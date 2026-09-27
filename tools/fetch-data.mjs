import fs from 'node:fs';

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';

const LEAGUE_KGMID = process.env.LEAGUE_KGMID || '/m/02_tc'; // Premier League
const MAX_TEAMS = parseInt(process.env.MAX_TEAMS || '10', 10);
const API_FOOTBALL_LEAGUES = process.env.API_FOOTBALL_LEAGUES || '39';
const DAYS_AHEAD = parseInt(process.env.DAYS_AHEAD || '10', 10);

const SPORT = 'ft';

// Proven SerpApi contract:
// League games: type=league&tab=gm
// Team games: type=team&tab=gm
const LEAGUE_PARAMS = { type: 'league', tab: 'gm' };
const TEAM_PARAMS = { type: 'team', tab: 'gm' };

if (!SERPAPI_KEY) {
  console.error('FATAL: SERPAPI_KEY secret is missing.');
  process.exit(1);
}

fs.mkdirSync('data', { recursive: true });

class Fatal extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toGoalNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const match = String(value).match(/^\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

async function serp(params) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_sports');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('sp', SPORT);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  url.searchParams.set('api_key', SERPAPI_KEY);

  const response = await fetch(url);
  const body = await response.text();

  if (!response.ok) {
    const snippet = body.slice(0, 300);

    if ([401, 403, 429].includes(response.status)) {
      throw new Fatal(`SerpApi HTTP ${response.status}: ${snippet}`);
    }

    throw new Error(`SerpApi HTTP ${response.status}: ${snippet}`);
  }

  const json = JSON.parse(body);

  if (json.error) {
    console.warn(`SerpApi payload warning: ${json.error}`);
  }

  return json;
}

function looksLikeGame(node) {
  if (!node || typeof node !== 'object') return false;

  if (Array.isArray(node.teams) && node.teams.length === 2) return true;

  const home = node.home_team ?? node.home ?? node.homeTeam ?? node.team_home;
  const away = node.away_team ?? node.away ?? node.awayTeam ?? node.team_away;

  if (home && away) return true;

  if ((node.score || node.result) && (home || away)) return true;

  if (node.status && (node.start_time || node.date) && (home || away || node.teams)) {
    return true;
  }

  return false;
}

function collectGames(node, out = [], depth = 0) {
  if (depth > 8 || node == null) return out;

  if (Array.isArray(node)) {
    node.forEach((item) => collectGames(item, out, depth + 1));
    return out;
  }

  if (typeof node === 'object') {
    if (looksLikeGame(node)) {
      out.push(node);
    } else {
      Object.values(node).forEach((value) => collectGames(value, out, depth + 1));
    }
  }

  return out;
}

function sideFromObject(value) {
  if (value == null) return { name: null, kgmid: null, logo: null };

  if (typeof value === 'string') {
    return { name: value, kgmid: null, logo: null };
  }

  if (typeof value === 'object') {
    return {
      name: value.name || value.short_name || value.title || null,
      kgmid: value.kgmid || null,
      logo: value.thumbnail || null
    };
  }

  return { name: null, kgmid: null, logo: null };
}

function sideScore(side) {
  if (!side) return null;

  let score = toGoalNumber(side.score);
  if (score == null) score = toGoalNumber(side.score_original);

  return score;
}

function normGame(game) {
  let home = { name: null, kgmid: null, logo: null };
  let away = { name: null, kgmid: null, logo: null };
  let homeGoals = null;
  let awayGoals = null;

  if (Array.isArray(game.teams) && game.teams.length === 2) {
    home = sideFromObject(game.teams[0]);
    away = sideFromObject(game.teams[1]);
    homeGoals = sideScore(game.teams[0]);
    awayGoals = sideScore(game.teams[1]);
  } else {
    home = sideFromObject(game.home_team ?? game.home ?? game.homeTeam ?? game.team_home);
    away = sideFromObject(game.away_team ?? game.away ?? game.awayTeam ?? game.team_away);

    homeGoals = toGoalNumber(game.homeGoals ?? game.home_score ?? game.homeScore);
    awayGoals = toGoalNumber(game.awayGoals ?? game.away_score ?? game.awayScore);

    const scoreString = game.score ?? game.result ?? null;

    if ((homeGoals == null || awayGoals == null) && typeof scoreString === 'string') {
      const match = scoreString.match(/(\d+)\s*[-:–]\s*(\d+)/);
      if (match) {
        homeGoals = homeGoals ?? Number(match[1]);
        awayGoals = awayGoals ?? Number(match[2]);
      }
    }
  }

  return {
    date: game.start_time || game.date || game.time || game.start_date || null,
    status: game.status || game.status_original || null,
    league:
      typeof game.league === 'string'
        ? game.league
        : game.league?.name || game.league?.short_name || null,
    venue: game.venue?.name || null,
    home,
    away,
    homeGoals,
    awayGoals
  };
}

const isValidGame = (game) => Boolean(game.home.name && game.away.name);

const isPlayedGame = (game) =>
  isValidGame(game) && game.homeGoals != null && game.awayGoals != null;

function isFinishedStatus(status) {
  return /finished|ft|aet|pen|ended|full/i.test(String(status || ''));
}

const isFutureGame = (game) =>
  isValidGame(game) &&
  game.date &&
  game.homeGoals == null &&
  game.awayGoals == null &&
  !isFinishedStatus(game.status);

function dedupeGames(games) {
  const seen = new Set();

  return games.filter((game) => {
    const key = `${game.home.name}|${game.away.name}|${game.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function futureGames(games) {
  const now = Date.now();

  return dedupeGames(games)
    .filter((game) => isFutureGame(game))
    .filter((game) => new Date(game.date).getTime() >= now - 3 * 60 * 60 * 1000)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function playedGames(games) {
  return dedupeGames(games)
    .filter((game) => isPlayedGame(game))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function shapeForm(rows, kgmid, name) {
  return rows
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10)
    .reverse()
    .map((game) => ({
      date: game.date,
      home: game.home.name,
      away: game.away.name,
      homeGoals: game.homeGoals,
      awayGoals: game.awayGoals,
      teamIsHome: game.home.kgmid === kgmid || game.home.name === name
    }));
}

function oddsRowToGame(row) {
  let home = row.homeTeam || row.home_team || row.home || null;
  let away = row.awayTeam || row.away_team || row.away || null;

  if ((!home || !away) && typeof row.game === 'string' && row.game.includes(' vs ')) {
    const parts = row.game.split(' vs ');
    home = home || parts[0];
    away = away || parts[1];
  }

  const date =
    row.startTime ||
    row.commence_time ||
    row.start_time ||
    row.date ||
    null;

  if (!home || !away || !date) return null;

  return {
    date,
    status: 'NS',
    league: row.leagueName || row.league || 'Odds feed',
    venue: null,
    home: { name: home, kgmid: null, logo: null },
    away: { name: away, kgmid: null, logo: null },
    homeGoals: null,
    awayGoals: null
  };
}

async function fetchApiFootballFixtures() {
  if (!RAPIDAPI_KEY) return [];

  const leagues = API_FOOTBALL_LEAGUES.split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!leagues.length) return [];

  const today = new Date();
  const toDate = new Date();
  toDate.setDate(today.getDate() + DAYS_AHEAD);

  const from = today.toISOString().slice(0, 10);
  const to = toDate.toISOString().slice(0, 10);

  const all = [];

  for (const league of leagues) {
    try {
      const url = new URL('https://v3.football.api-sports.io/fixtures');
      url.searchParams.set('league', league);
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': 'v3.football.api-sports.io'
        }
      });

      if (!response.ok) {
        console.warn(`API-Football HTTP ${response.status}`);
        continue;
      }

      const json = await response.json();

      if (json.errors && Object.keys(json.errors).length) {
        console.warn(`API-Football error: ${Object.values(json.errors).flat().join('; ')}`);
        continue;
      }

      const fixtures = Array.isArray(json.response) ? json.response : [];

      const mapped = fixtures.map((fixture) => ({
        date: fixture.fixture?.date || null,
        status: fixture.fixture?.status?.short || 'NS',
        league: fixture.league?.name || null,
        venue: fixture.fixture?.venue?.name || null,
        home: {
          name: fixture.teams?.home?.name || null,
          kgmid: null,
          logo: fixture.teams?.home?.logo || null
        },
        away: {
          name: fixture.teams?.away?.name || null,
          kgmid: null,
          logo: fixture.teams?.away?.logo || null
        },
        homeGoals: fixture.goals?.home ?? null,
        awayGoals: fixture.goals?.away ?? null
      }));

      all.push(...mapped);
      await sleep(350);
    } catch (error) {
      console.warn(`API-Football fetch failed: ${error.message}`);
    }
  }

  return all;
}

async function main() {
  const meta = {
    generatedAt: new Date().toISOString(),
    searches: 0,
    leagueKgmId: LEAGUE_KGMID,
    sources: {
      serpLeague: false,
      serpTeams: 0,
      odds: false,
      apiFootball: false
    }
  };

  let leagueRaw = null;
  let leagueGames = [];

  try {
    leagueRaw = await serp({ kgmid: LEAGUE_KGMID, ...LEAGUE_PARAMS });
    meta.searches += 1;

    leagueGames = dedupeGames(
      collectGames(leagueRaw)
        .map(normGame)
        .filter(isValidGame)
    );

    meta.sources.serpLeague = leagueGames.length > 0;
    console.log(`SerpApi league games: ${leagueGames.length}`);
  } catch (error) {
    if (error instanceof Fatal) throw error;
    console.warn(`SerpApi league fetch failed: ${error.message}`);
  }

  let upcoming = futureGames(leagueGames);
  let finished = playedGames(leagueGames).slice(0, 80);

  const teamIds = new Map();

  for (const game of upcoming) {
    if (game.home.kgmid) teamIds.set(game.home.kgmid, game.home.name);
    if (game.away.kgmid) teamIds.set(game.away.kgmid, game.away.name);
  }

  for (const game of finished) {
    if (teamIds.size >= MAX_TEAMS * 2) break;
    if (game.home.kgmid && !teamIds.has(game.home.kgmid)) {
      teamIds.set(game.home.kgmid, game.home.name);
    }
    if (game.away.kgmid && !teamIds.has(game.away.kgmid)) {
      teamIds.set(game.away.kgmid, game.away.name);
    }
  }

  const form = {};
  const teamFutureGames = [];
  let teamsDone = 0;

  for (const [kgmid, name] of [...teamIds.entries()].slice(0, MAX_TEAMS)) {
    try {
      const raw = await serp({ kgmid, ...TEAM_PARAMS });
      meta.searches += 1;

      const games = collectGames(raw)
        .map(normGame)
        .filter(isValidGame);

      const played = games.filter(isPlayedGame);
      const future = games.filter(isFutureGame);

      teamFutureGames.push(...future);

      if (played.length) {
        form[name] = shapeForm(played, kgmid, name);
        teamsDone += 1;
      }

      meta.sources.serpTeams = teamsDone;
      console.log(`Team ${name}: ${played.length} played games`);

      await sleep(400);
    } catch (error) {
      if (error instanceof Fatal) throw error;
      console.warn(`Team "${name}" fetch failed: ${error.message}`);
    }
  }

  if (upcoming.length === 0 && teamFutureGames.length) {
    upcoming = futureGames(teamFutureGames);
    console.log(`Built ${upcoming.length} upcoming fixtures from team pages.`);
  }

  let oddsRows = [];

  if (RAPIDAPI_KEY) {
    try {
      const response = await fetch(
        'https://sports-betting-odds-api.p.rapidapi.com/v1/sports-odds-api/run',
        {
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
        }
      );

      if (response.ok) {
        const json = await response.json();

        oddsRows = Array.isArray(json)
          ? json
          : json.rows || json.data || json.items || json.results || [];

        meta.sources.odds = oddsRows.length > 0;
        console.log(`Odds rows: ${oddsRows.length}`);

        if (upcoming.length < 3) {
          const oddsFixtures = oddsRows
            .map(oddsRowToGame)
            .filter(Boolean);

          upcoming = futureGames([...upcoming, ...oddsFixtures]);
          console.log(`Added odds-based fixtures. Upcoming now: ${upcoming.length}`);
        }
      } else {
        console.warn(`Odds HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn(`Odds fetch failed: ${error.message}`);
    }
  }

  if (upcoming.length < 3) {
    try {
      const apiFixtures = await fetchApiFootballFixtures();

      if (apiFixtures.length) {
        meta.sources.apiFootball = true;
        upcoming = futureGames([...upcoming, ...apiFixtures]);
        console.log(`Added API-Football fixtures. Upcoming now: ${upcoming.length}`);
      }
    } catch (error) {
      console.warn(`API-Football fallback failed: ${error.message}`);
    }
  }

  upcoming = upcoming.slice(0, 60);

  fs.writeFileSync('data/fixtures.json', JSON.stringify(upcoming, null, 2));
  fs.writeFileSync('data/results.json', JSON.stringify(finished, null, 2));
  fs.writeFileSync('data/form.json', JSON.stringify(form, null, 2));
  fs.writeFileSync('data/odds.json', JSON.stringify(oddsRows, null, 2));
  fs.writeFileSync('data/meta.json', JSON.stringify(meta, null, 2));

  fs.writeFileSync(
    'data/raw-sample.json',
    JSON.stringify(leagueRaw ? collectGames(leagueRaw).slice(0, 2) : [], null, 2)
  );

  console.log(
    `SUMMARY: upcoming=${upcoming.length} finished=${finished.length} forms=${teamsDone} odds=${oddsRows.length} searches=${meta.searches}`
  );
}

main().catch((error) => {
  console.error('RUN FAILED:', error.message);
  process.exit(1);
});
