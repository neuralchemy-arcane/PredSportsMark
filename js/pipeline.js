/* =========================================================
   DPPipeline — reads the static JSON committed by the
   GitHub Actions workflow (data/*.json).
   No API keys, no CORS, zero network API calls from browser.
   ========================================================= */

const DPPipeline = {
  form: null,
  meta: null,

  norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  },

  hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
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

  async tryLoad() {
    const get = async (path) => {
      try {
        const r = await fetch(path, { cache: 'no-store' });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    };

    const [fixtures, form, odds, meta] = await Promise.all([
      get('data/fixtures.json'),
      get('data/form.json'),
      get('data/odds.json'),
      get('data/meta.json')
    ]);

    if (!fixtures || !fixtures.length) return null;

    const mapped = fixtures.map(g => {
      const id = this.hash(`${g.home.name}|${g.away.name}|${g.date}`);
      return {
        fixture: {
          id,
          date: g.date || new Date().toISOString(),
          status: { short: 'NS', elapsed: null }
        },
        league: { name: 'Pipeline feed', id: 0 },
        teams: {
          home: { id: this.hash(g.home.name || ''), name: g.home.name, logo: '' },
          away: { id: this.hash(g.away.name || ''), name: g.away.name, logo: '' }
        },
        goals: { home: g.homeGoals, away: g.awayGoals }
      };
    });

    // Normalize form rows so model + display can use them directly
    const formByName = {};
    for (const [team, games] of Object.entries(form || {})) {
      const key = this.norm(team);
      if (!key) continue;
      formByName[key] = (games || [])
        .map(g => ({
          date: g.date,
          home: this.norm(g.home),
          away: this.norm(g.away),
          homeGoals: g.homeGoals,
          awayGoals: g.awayGoals
        }))
        .reverse(); // chronological (oldest → newest)
    }

    this.form = formByName;
    this.meta = meta;

    return { fixtures: mapped, form: formByName, oddsRows: odds || [], meta };
  },

  /* Exact normalized match first, fuzzy fallback */
  findForm(displayName) {
    if (!this.form) return null;

    const key = this.norm(displayName);
    if (this.form[key]?.length) return { key, rows: this.form[key] };

    let best = null;
    for (const [k, rows] of Object.entries(this.form)) {
      if (!rows?.length) continue;
      const score = this.dice(key, k);
      if (score >= 0.8 && (!best || score > best.score)) best = { key: k, rows, score };
    }

    return best ? { key: best.key, rows: best.rows } : null;
  }
};