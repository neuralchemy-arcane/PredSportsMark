const DPStorage = {
  cachePrefix: 'dp_pro_cache_v1:',
  budgetKey: 'dp_pro_budget_v1',
  apiKeyKey: 'dp_pro_api_key_v1',
  calibrationKey: 'dp_pro_calibration_v1',
  backtestMetricsKey: 'dp_pro_backtest_metrics_v1',

  todayKey() {
    return new Date().toISOString().slice(0, 10);
  },

  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); }
    catch { return null; }
  },

  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },

  getApiKey() {
    return localStorage.getItem(this.apiKeyKey) || '';
  },

  saveApiKey(key) {
    localStorage.setItem(this.apiKeyKey, key);
  },

  getBudget() {
    const budget = this.get(this.budgetKey);
    if (budget && budget.date === this.todayKey()) return budget;
    return { date: this.todayKey(), used: 0 };
  },

  saveBudget(budget) { this.set(this.budgetKey, budget); },

  exhaustBudget() {
    const budget = this.getBudget();
    budget.used = DP_CONFIG.MAX_DAILY_REQUESTS;
    this.saveBudget(budget);
  },

  spendRequest() {
    const budget = this.getBudget();
    budget.used += 1;
    this.saveBudget(budget);
  },

  requestsLeft() {
    return Math.max(0, DP_CONFIG.MAX_DAILY_REQUESTS - this.getBudget().used);
  },

  cacheGet(key, ttlMs) {
    try {
      const raw = localStorage.getItem(this.cachePrefix + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts > ttlMs) return null;
      return parsed.data;
    } catch { return null; }
  },

  cacheSet(key, data) {
    try {
      localStorage.setItem(this.cachePrefix + key, JSON.stringify({ ts: Date.now(), data }));
    } catch {}
  },

  getCalibration() { return this.get(this.calibrationKey) || []; },
  saveCalibration(c) { this.set(this.calibrationKey, c); },

  getBacktestMetrics() { return this.get(this.backtestMetricsKey); },
  saveBacktestMetrics(m) { this.set(this.backtestMetricsKey, m); }
};