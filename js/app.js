const DPApp = {
  state: {
    live: [],
    upcoming: [],
    fixturesById: {},
    analyses: {},
    watchlist: [],
    backtest: null
  },

  init() {
    document.querySelectorAll('.tab-btn').forEach(button => {
      button.addEventListener('click', () => this.switchTab(button.dataset.tab));
    });

    document.getElementById('refreshBtn').addEventListener('click', () => this.refreshAll());

    document.getElementById('saveKeyBtn').addEventListener('click', () => {
      const key = document.getElementById('apiKeyInput').value.trim();
      if (!key) { alert('Enter an API key first.'); return; }
      DPStorage.saveApiKey(key);
      this.refreshAll();
    });

    document.getElementById('probeOddsBtn').addEventListener('click', async () => {
      const out = document.getElementById('probeOut');
      out.textContent = 'Calling odds feed (can take up to ~50 seconds)...';
      try {
        const rows = await DPOddsFeed.forceSnapshot();
        out.textContent = rows.length
          ? JSON.stringify(rows.slice(0, 2), null, 2)
          : 'Feed returned 0 rows. Check subscription / league keys.';
      } catch (e) {
        out.textContent = 'Probe error: ' + e.message;
      }
    });

    document.getElementById('historyFile').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const rows = file.name.endsWith('.json') ? JSON.parse(text) : DPBacktest.parseCsv(text);

        if (!rows.length) { alert('No valid rows found in the file.'); return; }

        this.state.backtest = DPBacktest.runBacktest(rows);
        this.recalcAnalyses();
        this.renderAll();
        this.switchTab('model');
        alert(`Backtest complete: ${this.state.backtest.matches} matches processed.`);
      } catch (error) {
        alert('Backtest failed: ' + error.message);
      }
    });

    const savedKey = DPStorage.getApiKey();
    if (savedKey) {
      document.getElementById('apiKeyInput').value = savedKey;
      this.refreshAll();
    }

    const savedMetrics = DPStorage.getBacktestMetrics();
    if (savedMetrics) this.state.backtest = savedMetrics;

    this.renderAll();
  },

  switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-active'));
    const active = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    if (active) active.classList.add('tab-active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById(`panel-${tab}`).classList.remove('hidden');
  },

  updateStatus() {
    document.getElementById('requestsLeft').textContent = DPStorage.requestsLeft();
    document.getElementById('calibrationStatus').textContent =
      DPStorage.getCalibration().length ? 'Trained' : 'Not trained';

    const apiStatus = document.getElementById('apiStatus');
    if (!DPStorage.getApiKey()) { apiStatus.textContent = 'No API key'; return; }
    if (DPStorage.requestsLeft() <= 0) { apiStatus.textContent = 'Budget exhausted'; return; }
    apiStatus.textContent = 'Ready';
  },

  registerFixtures(list) {
    list.forEach(f => { this.state.fixturesById[f.fixture.id] = f; });
  },

  updateWatchlist() {
    this.state.watchlist = Object.values(this.state.analyses)
      .filter(a => a.watchlist)
      .map(a => this.state.fixturesById[a.fixtureId])
      .filter(Boolean);
    document.getElementById('watchCount').textContent = this.state.watchlist.length;
  },

  probColor(p) {
    if (p >= 0.80) return '#34d399';
    if (p >= 0.65) return '#fbbf24';
    return '#f87171';
  },

  fmtPct(v) { return (v * 100).toFixed(1) + '%'; },
  fmtOdd(v) { return v == null ? '—' : Number(v).toFixed(2); },

  esc(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  },

  cardHtml(fixture) {
    const id = fixture.fixture.id;
    const analysis = this.state.analyses[id];
    const home = fixture.teams.home;
    const away = fixture.teams.away;

    const isLive = ['1H', '2H', 'HT', 'LIVE', 'ET', 'BT', 'P'].includes(fixture.fixture.status.short);
    const score = fixture.goals.home == null ? 'vs' : `${fixture.goals.home} - ${fixture.goals.away}`;
    const when = new Date(fixture.fixture.date).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

    let analysisBlock = `
      <div class="mt-4">
        <button onclick="analyzeById(${id})" class="btn w-full py-2 rounded-xl font-semibold">Analyze</button>
      </div>`;

    if (analysis) {
      const prediction = analysis.prediction;
      const color = this.probColor(prediction.calibratedProb);

      const oddsBlock = analysis.odds && analysis.value
        ? `<div class="tiny muted mt-2">Best EV: <span class="font-semibold">${this.esc(analysis.value.market)}</span> · Edge ${this.fmtPct(analysis.value.edge)} · EV ${this.fmtPct(analysis.value.ev)}</div>`
        : `<div class="tiny muted mt-2">No positive odds value detected</div>`;

      analysisBlock = `
        <div class="mt-4 p-3 rounded-2xl bg-black/25 border border-white/10">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="tiny muted">AI Pick</div>
              <div class="font-bold" style="color:${color}">${this.esc(prediction.pick)}</div>
            </div>
            <div class="text-right">
              <div class="tiny muted">Calibrated Confidence</div>
              <div class="font-black text-lg" style="color:${color}">${this.fmtPct(prediction.calibratedProb)}</div>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2 mt-3 text-center text-xs">
            <div class="bg-white/5 rounded-xl p-2"><div class="muted tiny">Home</div><div class="font-semibold">${this.fmtPct(prediction.probs.home)}</div></div>
            <div class="bg-white/5 rounded-xl p-2"><div class="muted tiny">Draw</div><div class="font-semibold">${this.fmtPct(prediction.probs.draw)}</div></div>
            <div class="bg-white/5 rounded-xl p-2"><div class="muted tiny">Away</div><div class="font-semibold">${this.fmtPct(prediction.probs.away)}</div></div>
          </div>

          <div class="tiny muted mt-2">Data Quality: ${this.fmtPct(prediction.dataQuality)} · xG ${prediction.lambdaHome.toFixed(2)} - ${prediction.lambdaAway.toFixed(2)}</div>
          ${oddsBlock}

          <button onclick="openDeep(${id})" class="btn w-full py-2 rounded-xl font-semibold mt-3">Deep Analysis</button>
        </div>`;
    }

    return `
      <div class="glass card rounded-3xl p-4 ${analysis?.watchlist ? 'watch' : ''}">
        <div class="flex items-center justify-between mb-3">
          <div class="text-xs muted">${this.esc(fixture.league?.name || '')}</div>
          <div class="text-xs muted">
            ${isLive
              ? `<span class="pill text-red-400">LIVE ${fixture.fixture.status.elapsed || ''}'</span>`
              : `<span class="pill">${when}</span>`}
          </div>
        </div>

        <div class="flex items-center justify-between gap-3">
          <div class="flex-1 text-center">
            <img src="${this.esc(home.logo)}" class="team-logo mx-auto mb-1" onerror="this.style.display='none'" alt="" />
            <div class="text-sm font-semibold leading-tight">${this.esc(home.name)}</div>
          </div>
          <div class="text-2xl font-black">${score}</div>
          <div class="flex-1 text-center">
            <img src="${this.esc(away.logo)}" class="team-logo mx-auto mb-1" onerror="this.style.display='none'" alt="" />
            <div class="text-sm font-semibold leading-tight">${this.esc(away.name)}</div>
          </div>
        </div>

        ${analysisBlock}
      </div>`;
  },

  renderCards(fixtures, selector, emptyMessage) {
    const element = document.querySelector(selector);
    if (!fixtures.length) {
      element.innerHTML = `<div class="glass rounded-3xl p-8 text-center muted">${emptyMessage}</div>`;
      return;
    }
    element.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        ${fixtures.slice(0, 30).map(f => this.cardHtml(f)).join('')}
      </div>`;
  },

  last10Html(list, title) {
    return `
      <div class="glass rounded-3xl p-4">
        <h3 class="font-bold mb-3">${this.esc(title)}</h3>
        <div class="space-y-2">
          ${list.map(row => `
            <div class="flex items-center justify-between bg-black/25 rounded-xl px-3 py-2 text-sm">
              <div class="flex items-center gap-2">
                <span class="font-bold ${row.result === 'W' ? 'text-emerald-400' : row.result === 'D' ? 'text-gray-300' : 'text-red-400'}">${row.result}</span>
                <span class="muted">${row.venue}</span>
                <span>${this.esc(row.opponent)}</span>
              </div>
              <div class="font-semibold">${row.scored}-${row.conceded}</div>
            </div>`).join('')}
        </div>
      </div>`;
  },

  renderModelPanel() {
    const element = document.getElementById('panel-model');
    const metrics = this.state.backtest;

    if (!metrics) {
      element.innerHTML = `
        <div class="glass rounded-3xl p-8">
          <h2 class="text-2xl font-bold mb-3">Model / Backtest</h2>
          <p class="muted mb-4">Upload a historical CSV from football-data.co.uk to calibrate the model. Without calibration the engine is much weaker.</p>
          <ul class="list-disc pl-5 muted space-y-2">
            <li>Accuracy</li><li>Brier score</li><li>Log loss</li><li>ROI from value bets</li><li>Calibration bins</li>
          </ul>
        </div>`;
      return;
    }

    const calibrationRows = (metrics.calibration || []).map(item => `
      <div class="grid grid-cols-12 gap-2 items-center">
        <div class="col-span-3 text-xs muted">${Math.round(item.center * 100)}%</div>
        <div class="col-span-7"><div class="bar-track"><div class="bar-fill" style="width:${Math.round(item.actual * 100)}%"></div></div></div>
        <div class="col-span-2 text-xs text-right">${this.fmtPct(item.actual)}</div>
      </div>`).join('');

    element.innerHTML = `
      <div class="glass rounded-3xl p-6 md:p-7">
        <h2 class="text-2xl font-bold mb-4">Backtest Results</h2>

        <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <div class="metric-box"><div class="tiny muted">Matches</div><div class="font-bold">${metrics.matches}</div></div>
          <div class="metric-box"><div class="tiny muted">Accuracy</div><div class="font-bold">${this.fmtPct(metrics.accuracy)}</div></div>
          <div class="metric-box"><div class="tiny muted">Brier</div><div class="font-bold">${metrics.brier.toFixed(3)}</div></div>
          <div class="metric-box"><div class="tiny muted">Log Loss</div><div class="font-bold">${metrics.logLoss.toFixed(3)}</div></div>
          <div class="metric-box"><div class="tiny muted">ROI</div><div class="font-bold">${metrics.roi == null ? 'N/A' : this.fmtPct(metrics.roi)}</div></div>
        </div>

        <div class="grid md:grid-cols-2 gap-6">
          <div>
            <h3 class="font-bold mb-3">Calibration</h3>
            <div class="space-y-2">${calibrationRows || '<div class="muted text-sm">Not enough data.</div>'}</div>
          </div>
          <div>
            <h3 class="font-bold mb-3">Value Betting</h3>
            <div class="space-y-3">
              <div class="metric-box"><div class="tiny muted">Bets Simulated</div><div class="font-bold">${metrics.bets}</div></div>
              <div class="metric-box"><div class="tiny muted">Hit Rate</div><div class="font-bold">${metrics.hitRate == null ? 'N/A' : this.fmtPct(metrics.hitRate)}</div></div>
              <div class="metric-box"><div class="tiny muted">ROI</div><div class="font-bold">${metrics.roi == null ? 'N/A' : this.fmtPct(metrics.roi)}</div></div>
            </div>
          </div>
        </div>
      </div>`;
  },

  renderAll() {
    this.updateWatchlist();
    this.renderCards(this.state.live, '#panel-live', 'No live fixtures found.');
    this.renderCards(this.state.upcoming, '#panel-upcoming', 'No upcoming fixtures found.');
    this.renderCards(this.state.watchlist, '#panel-watchlist', 'No fixtures currently meet the serious watchlist threshold.');
    this.renderModelPanel();
    this.updateStatus();
  },

  async analyzeFixture(fixture, { withOdds = true } = {}) {
    const id = fixture.fixture.id;
    const cacheKey = 'analysis_v3|' + id;

    const cached = DPStorage.cacheGet(cacheKey, 30 * 60 * 1000);
    if (cached) {
      cached.prediction.calibratedProb = DPModel.applyCalibration(cached.prediction.maxProb);
      if (cached.odds) cached.value = DPModel.calculateValue(cached.prediction, cached.odds);
      cached.watchlist = DPModel.isWatchlist(cached);
      this.state.analyses[id] = cached;
      return cached;
    }

    const [homeLast, awayLast] = await Promise.all([
      DPApi.fetchTeamLast(fixture.teams.home.id),
      DPApi.fetchTeamLast(fixture.teams.away.id)
    ]);

    const homeForm = DPModel.formFromApi(homeLast, fixture.teams.home.id);
    const awayForm = DPModel.formFromApi(awayLast, fixture.teams.away.id);
    const prediction = DPModel.predictFromForms(homeForm, awayForm);

    let odds = null;
    let value = null;

    if (withOdds && prediction.calibratedProb >= 0.65) {
      try {
        // 1) Free Sports Betting Odds API daily snapshot (no per-match cost)
        odds = await DPOddsFeed.matchOdds(fixture);

        // 2) Fallback: API-Football odds endpoint
        if (!odds && DPStorage.requestsLeft() > 3) {
          odds = DPModel.parseOdds(await DPApi.fetchOdds(id));
        }

        if (odds) value = DPModel.calculateValue(prediction, odds);
      } catch (error) {
        console.warn('Odds fetch failed', error.message);
      }
    }

    const analysis = {
      fixtureId: id,
      updatedAt: Date.now(),
      homeForm, awayForm, prediction, odds, value,
      homeLast: DPModel.summarizeLast(homeLast, fixture.teams.home.id),
      awayLast: DPModel.summarizeLast(awayLast, fixture.teams.away.id),
      watchlist: false
    };

    analysis.watchlist = DPModel.isWatchlist(analysis);
    this.state.analyses[id] = analysis;
    DPStorage.cacheSet(cacheKey, analysis);
    return analysis;
  },

  recalcAnalyses() {
    Object.values(this.state.analyses).forEach(analysis => {
      analysis.prediction.calibratedProb = DPModel.applyCalibration(analysis.prediction.maxProb);
      if (analysis.odds) analysis.value = DPModel.calculateValue(analysis.prediction, analysis.odds);
      analysis.watchlist = DPModel.isWatchlist(analysis);
    });
  },

  async analyzeById(id) {
    const fixture = this.state.fixturesById[id];
    if (!fixture) return;
    try {
      await this.analyzeFixture(fixture, { withOdds: true });
      this.renderAll();
    } catch (error) {
      alert(error.message);
    }
  },

  async autoAnalyze() {
    const candidates = [...this.state.live, ...this.state.upcoming].slice(0, DP_CONFIG.AUTO_ANALYZE_LIMIT);

    for (const fixture of candidates) {
      if (DPStorage.requestsLeft() < 5) break;
      try {
        await this.analyzeFixture(fixture, { withOdds: true });
      } catch (error) {
        console.warn('Analysis failed', fixture.fixture.id, error.message);
      }
      await new Promise(r => setTimeout(r, 180));
    }
  },

  async refreshAll() {
    if (!DPStorage.getApiKey()) { alert('Add your free RapidAPI key first.'); return; }

    try {
      document.getElementById('apiStatus').textContent = 'Loading...';

      const [live, upcoming] = await Promise.all([
        DPApi.fetchLive().catch(() => []),
        DPApi.fetchUpcoming().catch(() => [])
      ]);

      this.state.live = live;
      this.state.upcoming = upcoming;
      this.registerFixtures([...live, ...upcoming]);
      this.renderAll();

      await this.autoAnalyze();
      this.renderAll();
    } catch (error) {
      document.getElementById('apiStatus').textContent = 'Error';
      alert(error.message);
    }
  },

  async openDeep(id) {
    const modal = document.getElementById('modal');
    const modalContent = document.getElementById('modalContent');
    modal.classList.remove('hidden');
    modalContent.innerHTML = `
      <div class="p-10 text-center">
        <div class="spinner mx-auto"></div>
        <div class="muted mt-4">Running deep analysis...</div>
      </div>`;

    try {
      const fixture = this.state.fixturesById[id];
      if (!this.state.analyses[id]) await this.analyzeFixture(fixture, { withOdds: true });

      const analysis = this.state.analyses[id];
      const prediction = analysis.prediction;
      const o = analysis.odds;

      const oddsHtml = o
        ? `
          <div class="grid grid-cols-3 gap-2 text-sm">
            <div class="metric-box"><div class="tiny muted">Home Avg</div><div class="font-bold">${this.fmtOdd(o.avgH)}</div></div>
            <div class="metric-box"><div class="tiny muted">Draw Avg</div><div class="font-bold">${this.fmtOdd(o.avgD)}</div></div>
            <div class="metric-box"><div class="tiny muted">Away Avg</div><div class="font-bold">${this.fmtOdd(o.avgA)}</div></div>
          </div>
          <div class="tiny muted mt-2">Source: ${this.esc(o.source)}${o.twoWay ? ' (2-way, no draw)' : ''} · Overround ${this.fmtPct(o.overround)}</div>`
        : `<div class="muted">No odds available.</div>`;

      const valueHtml = analysis.value
        ? `
          <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
            <div class="metric-box"><div class="tiny muted">Best Market</div><div class="font-bold">${this.esc(analysis.value.market)}</div></div>
            <div class="metric-box"><div class="tiny muted">Model Prob</div><div class="font-bold">${this.fmtPct(analysis.value.modelProb)}</div></div>
            <div class="metric-box"><div class="tiny muted">Fair Prob</div><div class="font-bold">${this.fmtPct(analysis.value.fairProb)}</div></div>
            <div class="metric-box"><div class="tiny muted">EV</div><div class="font-bold">${this.fmtPct(analysis.value.ev)}</div></div>
          </div>`
        : '';

      modalContent.innerHTML = `
        <h2 class="text-3xl font-black mb-1">${this.esc(fixture.teams.home.name)} vs ${this.esc(fixture.teams.away.name)}</h2>
        <div class="muted mb-5">${this.esc(fixture.league?.name || '')} · ${new Date(fixture.fixture.date).toLocaleString()}</div>

        <div class="glass watch rounded-3xl p-5 mb-5">
          <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div class="tiny muted">Serious Model Pick</div>
              <div class="text-3xl font-black" style="color:${this.probColor(prediction.calibratedProb)}">${this.esc(prediction.pick)}</div>
              <div class="muted mt-1">
                Expected goals: ${prediction.lambdaHome.toFixed(2)} - ${prediction.lambdaAway.toFixed(2)} ·
                Most likely score: ${prediction.mostLikelyScore.h}-${prediction.mostLikelyScore.a}
              </div>
            </div>
            <div class="text-right">
              <div class="tiny muted">Calibrated Confidence</div>
              <div class="text-4xl font-black" style="color:${this.probColor(prediction.calibratedProb)}">${this.fmtPct(prediction.calibratedProb)}</div>
              <div class="tiny muted mt-1">Raw model probability: ${this.fmtPct(prediction.maxProb)}</div>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2 mt-4 text-center">
            <div class="metric-box"><div class="tiny muted">Home</div><div class="font-bold">${this.fmtPct(prediction.probs.home)}</div></div>
            <div class="metric-box"><div class="tiny muted">Draw</div><div class="font-bold">${this.fmtPct(prediction.probs.draw)}</div></div>
            <div class="metric-box"><div class="tiny muted">Away</div><div class="font-bold">${this.fmtPct(prediction.probs.away)}</div></div>
          </div>
        </div>

        <div class="glass rounded-3xl p-5 mb-5">
          <h3 class="font-bold mb-3">Odds</h3>
          ${oddsHtml}
          ${valueHtml}
        </div>

        <div class="grid md:grid-cols-2 gap-4 mb-5">
          ${this.last10Html(analysis.homeLast, `${fixture.teams.home.name} — Last ${analysis.homeLast.length}`)}
          ${this.last10Html(analysis.awayLast, `${fixture.teams.away.name} — Last ${analysis.awayLast.length}`)}
        </div>

        <div class="glass rounded-3xl p-5">
          <h3 class="font-bold mb-2">Method</h3>
          <p class="muted text-sm leading-relaxed">
            Attack/defense strength with recency-weighted last-10 form, shrinkage to league mean,
            xG blending where available, Poisson score matrix with low-score correction, calibration
            from backtests, and dual-source odds value detection (Sports Betting Odds API snapshot,
            API-Football fallback). Watchlist requires ≥80% calibrated confidence plus positive EV.
          </p>
        </div>`;
    } catch (error) {
      modalContent.innerHTML = `<div class="text-red-400 p-6">Error: ${this.esc(error.message)}</div>`;
    }
  },

  closeModal() {
    document.getElementById('modal').classList.add('hidden');
  }
};

window.analyzeById = (id) => DPApp.analyzeById(id);
window.openDeep = (id) => DPApp.openDeep(id);
window.closeModal = () => DPApp.closeModal();

window.addEventListener('DOMContentLoaded', () => DPApp.init());