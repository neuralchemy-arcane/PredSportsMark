const DPModel = {
  defaultForm() {
    return {
      games: 0, ppg: 1.25, avgGoals: 1.25, avgConceded: 1.25, winRate: 0.33,
      xgFor: null, xgAgainst: null, shots: null, shotsOnTarget: null, form: []
    };
  },

  formFromApi(fixtures, teamId) {
    if (!fixtures?.length) return this.defaultForm();

    const sorted = [...fixtures].sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    const weights = sorted.map((_, i) => Math.pow(1.14, i));
    const wSum = weights.reduce((a, b) => a + b, 0);

    let pts = 0, gf = 0, ga = 0, wins = 0;
    let xgf = 0, xga = 0, shots = 0, sot = 0;
    let xgMatches = 0, shotMatches = 0;
    const form = [];

    sorted.forEach((fixture, index) => {
      const isHome = fixture.teams?.home?.id === teamId;
      const scored = isHome ? (fixture.goals?.home ?? 0) : (fixture.goals?.away ?? 0);
      const conceded = isHome ? (fixture.goals?.away ?? 0) : (fixture.goals?.home ?? 0);
      const result = scored > conceded ? 3 : scored === conceded ? 1 : 0;

      pts += result * weights[index];
      gf += scored; ga += conceded;
      if (result === 3) wins++;
      form.push(result === 3 ? 'W' : result === 1 ? 'D' : 'L');

      const stats = Array.isArray(fixture.statistics) ? fixture.statistics : [];
      let matchXg = false, matchShots = false;

      stats.forEach(teamStats => {
        const isTeam = teamStats.team?.id === teamId;
        (teamStats.statistics || []).forEach(stat => {
          const value = parseFloat(stat.value);
          if (!Number.isFinite(value)) return;

          if (stat.type === 'Expected Goals') {
            if (isTeam) xgf += value; else xga += value;
            matchXg = true;
          }
          if (isTeam && (stat.type === 'Total Shots' || stat.type === 'Shots total')) {
            shots += value; matchShots = true;
          }
          if (isTeam && stat.type === 'Shots on Goal') {
            sot += value; matchShots = true;
          }
        });
      });

      if (matchXg) xgMatches++;
      if (matchShots) shotMatches++;
    });

    return {
      games: sorted.length,
      ppg: pts / wSum,
      avgGoals: gf / sorted.length,
      avgConceded: ga / sorted.length,
      winRate: wins / sorted.length,
      xgFor: xgMatches ? xgf / sorted.length : null,
      xgAgainst: xgMatches ? xga / sorted.length : null,
      shots: shotMatches ? shots / sorted.length : null,
      shotsOnTarget: shotMatches ? sot / sorted.length : null,
      form: form.slice(-5).reverse()
    };
  },

  formFromHistory(rows, teamName) {
    if (!rows?.length) return this.defaultForm();

    const weights = rows.map((_, i) => Math.pow(1.14, i));
    const wSum = weights.reduce((a, b) => a + b, 0);

    let pts = 0, gf = 0, ga = 0, wins = 0;
    const form = [];

    rows.forEach((row, index) => {
      const isHome = row.home === teamName;
      const scored = isHome ? row.homeGoals : row.awayGoals;
      const conceded = isHome ? row.awayGoals : row.homeGoals;
      const result = scored > conceded ? 3 : scored === conceded ? 1 : 0;

      pts += result * weights[index];
      gf += scored; ga += conceded;
      if (result === 3) wins++;
      form.push(result === 3 ? 'W' : result === 1 ? 'D' : 'L');
    });

    return {
      games: rows.length,
      ppg: pts / wSum,
      avgGoals: gf / rows.length,
      avgConceded: ga / rows.length,
      winRate: wins / rows.length,
      xgFor: null, xgAgainst: null, shots: null, shotsOnTarget: null,
      form: form.slice(-5).reverse()
    };
  },

  summarizeLast(fixtures, teamId) {
    return [...fixtures]
      .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date))
      .map(fixture => {
        const isHome = fixture.teams?.home?.id === teamId;
        const scored = isHome ? (fixture.goals?.home ?? 0) : (fixture.goals?.away ?? 0);
        const conceded = isHome ? (fixture.goals?.away ?? 0) : (fixture.goals?.home ?? 0);
        return {
          date: fixture.fixture?.date,
          opponent: isHome ? fixture.teams?.away?.name : fixture.teams?.home?.name,
          scored, conceded,
          result: scored > conceded ? 'W' : scored === conceded ? 'D' : 'L',
          venue: isHome ? 'H' : 'A'
        };
      })
      .reverse();
  },

  parseOdds(oddsData) {
    if (!oddsData?.length) return null;

    const values = { Home: [], Draw: [], Away: [] };

    for (const fixtureOdds of oddsData) {
      for (const bookmaker of fixtureOdds.bookmakers || []) {
        for (const bet of bookmaker.bets || []) {
          if (bet.name !== 'Match Winner') continue;
          for (const value of bet.values || []) {
            const odd = parseFloat(value.odd);
            if (!Number.isFinite(odd) || odd <= 1) continue;
            if (value.value === 'Home') values.Home.push(odd);
            if (value.value === 'Draw') values.Draw.push(odd);
            if (value.value === 'Away') values.Away.push(odd);
          }
        }
      }
    }

    if (!values.Home.length || !values.Draw.length || !values.Away.length) return null;

    const average = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const avgH = average(values.Home);
    const avgD = average(values.Draw);
    const avgA = average(values.Away);
    const impliedSum = (1 / avgH) + (1 / avgD) + (1 / avgA);

    return {
      source: 'api-football',
      twoWay: false,
      avgH, avgD, avgA,
      bestH: Math.max(...values.Home),
      bestD: Math.max(...values.Draw),
      bestA: Math.max(...values.Away),
      fairHome: (1 / avgH) / impliedSum,
      fairDraw: (1 / avgD) / impliedSum,
      fairAway: (1 / avgA) / impliedSum,
      overround: impliedSum - 1
    };
  },

  calculateValue(prediction, odds) {
    if (!odds) return null;

    const model = {
      Home: prediction.probs.home,
      Draw: prediction.probs.draw,
      Away: prediction.probs.away
    };
    const fair = { Home: odds.fairHome, Draw: odds.fairDraw, Away: odds.fairAway };
    const bestOdds = { Home: odds.bestH, Draw: odds.bestD, Away: odds.bestA };

    let best = null;

    for (const market of ['Home', 'Draw', 'Away']) {
      if (bestOdds[market] == null) continue;   // 2-way feeds have no Draw

      const ev = model[market] * bestOdds[market] - 1;
      const edge = model[market] - (fair[market] || 0);

      const candidate = { market, modelProb: model[market], fairProb: fair[market] || 0, bestOdds: bestOdds[market], edge, ev };
      if (!best || candidate.ev > best.ev) best = candidate;
    }

    return best;
  },

  shrink(observed, games, k = 8, prior = 1) {
    return (games * observed + k * prior) / (games + k);
  },

  poisson(k, lambda) {
    let fact = 1;
    for (let i = 2; i <= k; i++) fact *= i;
    return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
  },

  scoreMatrix(lambdaHome, lambdaAway) {
    const max = 10;
    const rho = -0.08;
    let total = 0;
    let best = { h: 0, a: 0, p: -1 };
    const matrix = [];

    for (let h = 0; h <= max; h++) {
      matrix[h] = [];
      for (let a = 0; a <= max; a++) {
        let p = this.poisson(h, lambdaHome) * this.poisson(a, lambdaAway);
        if (h === 0 && a === 0) p *= Math.max(0.01, 1 - lambdaHome * lambdaAway * rho);
        if (h === 0 && a === 1) p *= Math.max(0.01, 1 + lambdaAway * rho);
        if (h === 1 && a === 0) p *= Math.max(0.01, 1 + lambdaHome * rho);
        if (h === 1 && a === 1) p *= Math.max(0.01, 1 - rho);

        matrix[h][a] = p;
        total += p;
        if (p > best.p) best = { h, a, p };
      }
    }

    let pHome = 0, pDraw = 0, pAway = 0;
    for (let h = 0; h <= max; h++) {
      for (let a = 0; a <= max; a++) {
        const p = matrix[h][a] / total;
        if (h > a) pHome += p;
        else if (h === a) pDraw += p;
        else pAway += p;
      }
    }

    return { pHome, pDraw, pAway, best };
  },

  applyCalibration(probability) {
    const calibration = DPStorage.getCalibration();
    if (!calibration?.length) return probability;

    let bin = calibration.find(b => probability >= b.min && probability < b.max);
    if (!bin) bin = calibration[calibration.length - 1];
    if (!bin) return probability;

    const weight = Math.min(1, bin.count / 50);
    return Math.min(0.99, Math.max(0.01, probability * (1 - weight) + bin.actual * weight));
  },

  predictFromForms(homeForm, awayForm) {
    const leagueHomeAvg = 1.45;
    const leagueAwayAvg = 1.15;

    let homeAttack = homeForm.avgGoals / leagueHomeAvg;
    let homeDefense = homeForm.avgConceded / leagueAwayAvg;
    let awayAttack = awayForm.avgGoals / leagueAwayAvg;
    let awayDefense = awayForm.avgConceded / leagueHomeAvg;

    if (homeForm.xgFor != null) homeAttack = 0.55 * homeAttack + 0.45 * (homeForm.xgFor / leagueHomeAvg);
    if (homeForm.xgAgainst != null) homeDefense = 0.55 * homeDefense + 0.45 * (homeForm.xgAgainst / leagueAwayAvg);
    if (awayForm.xgFor != null) awayAttack = 0.55 * awayAttack + 0.45 * (awayForm.xgFor / leagueAwayAvg);
    if (awayForm.xgAgainst != null) awayDefense = 0.55 * awayDefense + 0.45 * (awayForm.xgAgainst / leagueHomeAvg);

    homeAttack = this.shrink(homeAttack, homeForm.games);
    homeDefense = this.shrink(homeDefense, homeForm.games);
    awayAttack = this.shrink(awayAttack, awayForm.games);
    awayDefense = this.shrink(awayDefense, awayForm.games);

    let lambdaHome = leagueHomeAvg * homeAttack * awayDefense * 1.10;
    let lambdaAway = leagueAwayAvg * awayAttack * homeDefense * 0.95;

    const ppgDiff = homeForm.ppg - awayForm.ppg;
    lambdaHome *= 1 + Math.min(0.12, Math.max(-0.12, ppgDiff * 0.04));
    lambdaAway *= 1 + Math.min(0.12, Math.max(-0.12, -ppgDiff * 0.04));

    lambdaHome = Math.min(4.5, Math.max(0.15, lambdaHome));
    lambdaAway = Math.min(4.5, Math.max(0.15, lambdaAway));

    const matrix = this.scoreMatrix(lambdaHome, lambdaAway);
    const probs = { home: matrix.pHome, draw: matrix.pDraw, away: matrix.pAway };
    const maxProb = Math.max(probs.home, probs.draw, probs.away);
    const pick = maxProb === probs.home ? 'Home' : maxProb === probs.draw ? 'Draw' : 'Away';

    const gamesFactor = Math.min(1, (homeForm.games + awayForm.games) / (DP_CONFIG.LAST_N * 2));
    const xgFactor = (
      (homeForm.xgFor != null ? 1 : 0) + (homeForm.xgAgainst != null ? 1 : 0) +
      (awayForm.xgFor != null ? 1 : 0) + (awayForm.xgAgainst != null ? 1 : 0)
    ) / 4;
    const dataQuality = Math.min(1, Math.max(0, 0.35 + 0.45 * gamesFactor + 0.20 * xgFactor));

    return {
      pick, probs, maxProb,
      calibratedProb: this.applyCalibration(maxProb),
      lambdaHome, lambdaAway,
      mostLikelyScore: matrix.best,
      dataQuality
    };
  },

  isWatchlist(analysis) {
    const probability = analysis.prediction.calibratedProb;
    const dataQuality = analysis.prediction.dataQuality;

    if (analysis.odds && analysis.value) {
      return probability >= DP_CONFIG.PROB_THRESHOLD &&
             dataQuality >= DP_CONFIG.MIN_DATA_QUALITY &&
             analysis.value.ev > 0 &&
             analysis.value.edge > 0.01;
    }

    return probability >= Math.max(DP_CONFIG.PROB_THRESHOLD, 0.84) && dataQuality >= 0.70;
  }
};