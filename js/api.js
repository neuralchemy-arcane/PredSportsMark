const DPApi = {
  lastRequestAt: 0,

  async throttle() {
    const wait = Math.max(0, this.lastRequestAt + DP_CONFIG.DELAY_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  },

  async request(path, params = {}, ttlMs = 15 * 60 * 1000) {
    const apiKey = DPStorage.getApiKey();
    if (!apiKey) throw new Error('Add your RapidAPI key first.');
    if (DPStorage.requestsLeft() <= 0) throw new Error('Daily API budget exhausted.');

    const cacheKey = path + '|' + JSON.stringify(params);
    const cached = DPStorage.cacheGet(cacheKey, ttlMs);
    if (cached) return cached;

    await this.throttle();

    const url = new URL(`https://${DP_CONFIG.API_HOST}/${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': DP_CONFIG.API_HOST
      }
    });

    if (response.status === 429) {
      DPStorage.exhaustBudget();
      throw new Error('API rate limit reached.');
    }
    if (!response.ok) throw new Error(`API HTTP ${response.status}`);

    const json = await response.json();
    if (json.errors && Object.keys(json.errors).length) {
      throw new Error(Object.values(json.errors).flat().join('; '));
    }

    DPStorage.spendRequest();
    const data = json.response || [];
    DPStorage.cacheSet(cacheKey, data);
    return data;
  },

  async fetchLive() {
    return this.request('fixtures', { live: 'all' }, 60 * 1000);
  },

  async fetchUpcoming() {
    const from = new Date().toISOString().slice(0, 10);
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 5);
    const to = toDate.toISOString().slice(0, 10);

    const all = [];
    for (const league of DP_CONFIG.DEFAULT_LEAGUES) {
      try {
        const fixtures = await this.request('fixtures', { league, from, to }, 30 * 60 * 1000);
        all.push(...fixtures);
      } catch (err) {
        console.warn('League fetch failed', league, err.message);
      }
      await new Promise(r => setTimeout(r, 120));
    }
    return all.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
  },

  async fetchTeamLast(teamId) {
    return this.request('fixtures', { team: teamId, last: DP_CONFIG.LAST_N }, 6 * 60 * 60 * 1000);
  },

  async fetchOdds(fixtureId) {
    return this.request('odds', { fixture: fixtureId }, 3 * 60 * 60 * 1000);
  }
};