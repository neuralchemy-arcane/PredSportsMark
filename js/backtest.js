const DPBacktest = {
  splitCsvLine(line, delimiter = ',') {
    const out = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        out.push(current); current = '';
      } else current += char;
    }
    out.push(current);
    return out.map(s => s.trim());
  },

  parseCsvDate(value) {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return new Date(value);
    const parts = value.split('/');
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10);
      let year = parseInt(parts[2], 10);
      if (year < 100) year += 2000;
      return new Date(year, month - 1, day);
    }
    return new Date(value);
  },

  normalizeTeam(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  },

  parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];

    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    const headers = this.splitCsvLine(lines[0], delimiter).map(h => h.toLowerCase().trim());
    const index = {};
    headers.forEach((h, i) => { index[h] = i; });

    const get = (row, names) => {
      for (const name of names) if (index[name] !== undefined) return row[index[name]] ?? '';
      return '';
    };

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const row = this.splitCsvLine(lines[i], delimiter);

      const dateRaw = get(row, ['date']);
      const home = get(row, ['hometeam', 'home']);
      const away = get(row, ['awayteam', 'away']);
      const homeGoals = parseInt(get(row, ['fthg', 'homegoals', 'hg']), 10);
      const awayGoals = parseInt(get(row, ['ftag', 'awaygoals', 'ag']), 10);

      if (!dateRaw || !home || !away || !Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;

      const oddsHome = parseFloat(get(row, ['b365h', 'avgh', 'psh', 'maxh', 'vwh']));
      const oddsDraw = parseFloat(get(row, ['b365d', 'avgd', 'psd', 'maxd', 'vwd']));
      const oddsAway = parseFloat(get(row, ['b365a', 'avga', 'psa', 'maxa', 'vwa']));

      rows.push({
        date: this.parseCsvDate(dateRaw),
        home: this.normalizeTeam(home),
        away: this.normalizeTeam(away),
        homeGoals, awayGoals,
        oddsHome: Number.isFinite(oddsHome) ? oddsHome : null,
        oddsDraw: Number.isFinite(oddsDraw) ? oddsDraw : null,
        oddsAway: Number.isFinite(oddsAway) ? oddsAway : null
      });
    }

    return rows.sort((a, b) => a.date - b.date);
  },

  runBacktest(rows) {
    const teamHistory = {};
    let correct = 0, brierSum = 0, logSum = 0;
    const calibrationRaw = {};
    const betting = { bets: 0, stake: 0, profit: 0, hits: 0 };

    rows.forEach(row => {
      const homePrev = (teamHistory[row.home] || []).slice(-DP_CONFIG.LAST_N);
      const awayPrev = (teamHistory[row.away] || []).slice(-DP_CONFIG.LAST_N);

      const prediction = DPModel.predictFromForms(
        DPModel.formFromHistory(homePrev, row.home),
        DPModel.formFromHistory(awayPrev, row.away)
      );

      const actual = row.homeGoals > row.awayGoals ? 'Home' : row.homeGoals < row.awayGoals ? 'Away' : 'Draw';
      const actualKey = actual.toLowerCase();
      const actualProb = prediction.probs[actualKey];

      if (prediction.pick === actual) correct++;

      let brier = 0;
      for (const key of ['home', 'draw', 'away']) {
        const indicator = key === actualKey ? 1 : 0;
        brier += Math.pow(prediction.probs[key] - indicator, 2);
      }
      brierSum += brier;
      logSum += -Math.log(Math.max(1e-6, actualProb));

      const bin = Math.floor(prediction.maxProb * 10) / 10;
      if (!calibrationRaw[bin]) calibrationRaw[bin] = { count: 0, hits: 0 };
      calibrationRaw[bin].count++;
      if (prediction.pick === actual) calibrationRaw[bin].hits++;

      if (row.oddsHome && row.oddsDraw && row.oddsAway) {
        const oddsMap = { Home: row.oddsHome, Draw: row.oddsDraw, Away: row.oddsAway };
        let bestBet = null;

        for (const [market, odd] of Object.entries(oddsMap)) {
          const modelProb = prediction.probs[market.toLowerCase()];
          const ev = modelProb * odd - 1;
          if (!bestBet || ev > bestBet.ev) bestBet = { market, odd, modelProb, ev };
        }

        if (bestBet && bestBet.ev > DP_CONFIG.VALUE_EDGE && bestBet.modelProb >= 0.52) {
          betting.bets++;
          betting.stake += 1;
          const won = bestBet.market === actual;
          if (won) betting.hits++;
          betting.profit += won ? bestBet.odd - 1 : -1;
        }
      }

      const record = { date: row.date, home: row.home, away: row.away, homeGoals: row.homeGoals, awayGoals: row.awayGoals };
      if (!teamHistory[row.home]) teamHistory[row.home] = [];
      if (!teamHistory[row.away]) teamHistory[row.away] = [];
      teamHistory[row.home].push(record);
      teamHistory[row.away].push(record);
    });

    const calibration = Object.entries(calibrationRaw)
      .map(([key, value]) => {
        const min = parseFloat(key);
        return { min, max: min + 0.1, center: min + 0.05, count: value.count, actual: value.count ? value.hits / value.count : 0 };
      })
      .sort((a, b) => a.min - b.min);

    const metrics = {
      matches: rows.length,
      accuracy: rows.length ? correct / rows.length : 0,
      brier: rows.length ? brierSum / rows.length : 0,
      logLoss: rows.length ? logSum / rows.length : 0,
      bets: betting.bets,
      hitRate: betting.bets ? betting.hits / betting.bets : null,
      roi: betting.stake ? betting.profit / betting.stake : null,
      calibration
    };

    DPStorage.saveCalibration(calibration);
    DPStorage.saveBacktestMetrics(metrics);
    return metrics;
  }
};