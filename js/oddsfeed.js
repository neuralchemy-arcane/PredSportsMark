/* =========================================================
   DPOddsFeed — Sports Betting Odds API adapter.
   In pipeline mode the Actions workflow injects rows
   (injectRows) so the browser makes ZERO calls.
   Without pipeline it falls back to one cached snapshot/day.
   ========================================================= */

const DPOddsFeed = {
  HOST: 'sports-betting-odds-api.p.rapidapi.com',
  RUN_PATH: '/v1/sports-odds-api/run',
  SNAPSHOT_TTL_MS: 24 * 60 * 60 * 1000,
  MONTHLY_CAP: 40,
  CACHE_KEY: 'dp_odds_snapshot_v1',
  BUDGET_KEY: 'dp_odds_budget_v1',
  injected: null,

  monthKey() { return new Date().toISOString().slice(0, 7); },

  getBudget() {
    try {
      const b = JSON.parse(localStorage.getItem(this.BUDGET_KEY));
      if (b && b.month === this.monthKey()) return b;
    } catch (e) {}
    return { month: this.monthKey(), used: 0 };
  },

  spend() {
    const b = this.getBudget();
    b.used += 1;
    localStorage.setItem(this.BUDGET_KEY, JSON.stringify(b));
  },

  canRequest() { return this.getBudget().used < this.MONTHLY_CAP; },

  injectRows(rows) {
    if (Array.isArray(rows) && rows.length) this.injected = rows;
  },

  async callRun() {
    const key = DPStorage.getApiKey();
    if (!key) throw new Error('Add your RapidAPI key first.');
    if (!this.canRequest()) throw new Error('Odds feed monthly cap reached.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await fetch(`https://${this.HOST}${this.RUN_PATH}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-key': key,
          'x-rapidapi-host': this.HOST
        },
        body: JSON.stringify({
          mode: 'odds',
          leagues: DP_CONFIG.ODDS_LEAGUE_KEYS,
          daysAhead: DP_CONFIG.ODDS_DAYS_AHEAD,
          markets: ['moneyline'],
          maxItems: DP_CONFIG.ODDS_MAX_ITEMS
        })
      });

      if (res.status === 429) throw new Error('Odds feed rate limit (60/hour).');
      if (!res.ok) throw new Error(`Odds feed HTTP ${res.status}`);

      const json = await res.json();
      this.spend();

      return Array.isArray(json) ? json :
             Array.isArray(json?.rows) ? json.rows :
             Array.isArray(json?.data) ? json.data :
             Array.isArray(json?.items) ? json.items :
             Array.isArray(json?.results) ? json.results : [];
    } finally {
      clearTimeout(timer);
    }
  },

  async getSnapshot(force = false) {
    if (this.injected?.length) return this.injected;

    try {
      const cached = JSON.parse(localStorage.getItem(this.CACHE_KEY));
      if (cached && !force) {
        if (Date.now() - cached.ts < this.SNAPSHOT_TTL_MS) return cached.rows;
        if (!this.canRequest()) return cached.rows;
      }
    } catch (e) {}

    const rows = await this.callRun();
    localStorage.setItem(this.CACHE_KEY, JSON.stringify({ ts: Date.now(), rows }));
    return rows;
  },

  forceSnapshot() { return this.getSnapshot(true); },

  normName(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  },

  toDecimal(v) {
    if (v < 0) return 1 + 100 / Math.abs(v);
    if (v > 15) return 1 + v / 100;
    return v;
  },

  extractPrices(row) {
    const prices = { Home: [], Draw: [], Away: [] };
    const homeName = this.normName(row.homeTeam || row.home_team || row.home);
    const awayName = this.normName(row.awayTeam || row.away_team || row.away);

    const push = (bucket, price) => {
      const d = this.toDecimal(parseFloat(price));
      if (Number.isFinite(d) && d > 1.01 && d < 1000) prices[bucket].push(d);
    };

    const pushByName = (name, price) => {
      const n = this.normName(name);
      if (!n) return;
      if (['draw', 'tie', 'x', 'n/a'].includes(n)) { push('Draw', price); return; }
      if (homeName && (n === homeName || n.includes(homeName) || homeName.includes(n))) { push('Home', price); return; }
      if (awayName && (n === awayName || n.includes(awayName) || awayName.includes(n))) { push('Away', price); return; }
    };

    const walk = (obj, depth) => {
      if (depth > 5 || obj == null) return;
      if (Array.isArray(obj)) { obj.forEach(v => walk(v, depth + 1)); return; }
      if (typeof obj !== 'object') return;

      if ('name' in obj && ('price' in obj || 'odds' in obj || 'odd' in obj)) {
        pushByName(obj.name, obj.price ?? obj.odds ?? obj.odd);
      }

      for (const [k, v] of Object.entries(obj)) {
        const key = k.toLowerCase();
        if (typeof v === 'number' && /(odds|price|moneyline|_ml|^ml)$/.test(key)) {
          if (key.includes('home')) push('Home', v);
          else if (key.includes('draw') || key.includes('tie')) push('Draw', v);
          else if (key.includes('away')) push('Away', v);
        } else if (typeof v === 'object') {
          walk(v, depth + 1);
        }
      }
    };

    walk(row, 0);
    return prices;
  },

  toOddsObject(prices) {
    if (!prices.Home.length || !prices.Away.length) return null;

    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

    const odds = {
      source: 'sports-betting-odds-api',
      twoWay: prices.Draw.length === 0,
      avgH: avg(prices.Home),
      avgA: avg(prices.Away),
      avgD: prices.Draw.length ? avg(prices.Draw) : null,
      bestH: Math.max(...prices.Home),
      bestA: Math.max(...prices.Away),
      bestD: prices.Draw.length ? Math.max(...prices.Draw) : null
    };

    const implied = (1 / odds.avgH) + (1 / odds.avgA) + (odds.avgD ? 1 / odds.avgD : 0);
    odds.fairHome = (1 / odds.avgH) / implied;
    odds.fairAway = (1 / odds.avgA) / implied;
    odds.fairDraw = odds.avgD ? (1 / odds.avgD) / implied : 0;
    odds.overround = implied - 1;

    return odds;
  },

  dice(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bg = s => {
      const m = new Map();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        m.set(g, (m.get(g) || 0) + 1);
      }
      return m;
    };
    const A = bg(a), B = bg(b);
    let hits = 0;
    for (const [g, c] of A) if (B.has(g)) hits += Math.min(c, B.get(g));
    return (2 * hits) / ((a.length - 1) + (b.length - 1));
  },

  async matchOdds(fixture) {
    let rows;
    try { rows = await this.getSnapshot(); }
    catch (e) { console.warn('Odds feed unavailable:', e.message); return null; }

    if (!rows?.length) return null;

    const fh = this.normName(fixture.teams.home.name);
    const fa = this.normName(fixture.teams.away.name);
    const fixtureTime = new Date(fixture.fixture.date).getTime();

    let best = null;

    for (const row of rows) {
      const rowTime = new Date(row.startTime || row.commence_time || 0).getTime();
      if (Number.isFinite(rowTime) && Math.abs(rowTime - fixtureTime) > 36 * 60 * 60 * 1000) continue;

      const rh = this.normName(row.homeTeam || row.home_team || row.home);
      const ra = this.normName(row.awayTeam || row.away_team || row.away);
      if (!rh || !ra) continue;

      const direct = this.dice(fh, rh) + this.dice(fa, ra);
      const swapped = this.dice(fh, ra) + this.dice(fa, rh);
      const score = Math.max(direct, swapped);

      if (!best || score > best.score) best = { score, row, swapped: swapped > direct };
    }

    if (!best || best.score < 1.1) return null;

    const prices = this.extractPrices(best.row);
    if (best.swapped) {
      const tmp = prices.Home;
      prices.Home = prices.Away;
      prices.Away = tmp;
    }

    return this.toOddsObject(prices);
  }
};