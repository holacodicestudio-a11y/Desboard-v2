const research$ = (selector, root = document) => root.querySelector(selector);
const researchFmt = value => Number.isFinite(value) ? value.toLocaleString('es-MX', { maximumFractionDigits: 2 }) : '—';
const percentFmt = value => Number.isFinite(value) ? (value >= 0 ? '+' : '') + value.toFixed(2) + '%' : '—';
const numberFmt = value => Number.isFinite(value) ? value.toLocaleString('es-MX', { maximumFractionDigits: 2 }) : '—';
let researchSymbol = 'BTCUSDT', researchKind = 'crypto', researchInterval = '1h', technicalRequest = 0, fundamentalsRequest = 0, analystRequest = 0, researchBars = [];

function sma(values, period) {
  const out = Array(values.length).fill(null); let sum = 0;
  for (let i = 0; i < values.length; i++) { sum += values[i]; if (i >= period) sum -= values[i - period]; if (i >= period - 1) out[i] = sum / period; }
  return out;
}
function ema(values, period) {
  const out = Array(values.length).fill(null); if (values.length < period) return out;
  const alpha = 2 / (period + 1); let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period; out[period - 1] = current;
  for (let i = period; i < values.length; i++) { current = values[i] * alpha + current * (1 - alpha); out[i] = current; }
  return out;
}
function wma(values, period) {
  const out = Array(values.length).fill(null), denom = period * (period + 1) / 2;
  for (let i = period - 1; i < values.length; i++) { let total = 0; for (let j = 0; j < period; j++) total += values[i - period + 1 + j] * (j + 1); out[i] = total / denom; }
  return out;
}
function rsi(values, period = 14) {
  const out = Array(values.length).fill(null); if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gain += Math.max(0, d); loss += Math.max(0, -d); }
  let ag = gain / period, al = loss / period; out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; ag = (ag * (period - 1) + Math.max(0, d)) / period; al = (al * (period - 1) + Math.max(0, -d)) / period; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  return out;
}
function rollingMeanDeviation(values, period, index) { const slice = values.slice(index - period + 1, index + 1), mean = slice.reduce((a, b) => a + b, 0) / period; return slice.reduce((a, b) => a + Math.abs(b - mean), 0) / period; }
function latest(series) { for (let i = series.length - 1; i >= 0; i--) if (Number.isFinite(series[i])) return series[i]; return null; }
function signalTag(signal) { const cls = signal === 'Alcista' ? 'signal-bull' : signal === 'Bajista' ? 'signal-bear' : signal === 'Neutral' ? 'signal-neutral' : 'signal-warn'; return '<span class="signal-tag ' + cls + '">' + signal + '</span>'; }

function calculateTechnical(bars) {
  if (!Array.isArray(bars) || bars.length < 35) return { error: 'Se requieren al menos 35 velas reales para calcular los indicadores.' };
  const close = bars.map(b => Number(b.close)), high = bars.map(b => Number(b.high)), low = bars.map(b => Number(b.low)), volume = bars.map(b => Number(b.volume) || 0), last = close.length - 1, price = close[last];
  const trend = [];
  for (const period of [21, 50, 100, 200]) {
    for (const [kind, series] of [['SMA', sma(close, period)], ['EMA', ema(close, period)]]) {
      const value = latest(series), old = series[Math.max(0, last - 3)];
      if (value == null) { trend.push({ name: kind + ' ' + period, value: null, dist: null, signal: 'Sin historial' }); continue; }
      const rising = old != null && value > old, falling = old != null && value < old;
      const signal = price > value && rising ? 'Alcista' : price < value && falling ? 'Bajista' : 'Neutral';
      trend.push({ name: kind + ' ' + period, value, dist: (price / value - 1) * 100, signal });
    }
  }
  const half = Math.floor(9 / 2), root = Math.round(Math.sqrt(9)), fastW = wma(close, half), slowW = wma(close, 9), rawHull = close.map((_, i) => fastW[i] != null && slowW[i] != null ? 2 * fastW[i] - slowW[i] : null), hull = wma(rawHull.map(x => x ?? 0), root), hullValue = latest(hull);
  const vwmaBase = sma(close.map((v, i) => v * volume[i]), 20), volAvg = sma(volume, 20), vwma = vwmaBase.map((v, i) => v != null && volAvg[i] ? v / volAvg[i] : null), vwmaValue = latest(vwma);
  const tenkan = (Math.max(...high.slice(-9)) + Math.min(...low.slice(-9))) / 2, kijun = (Math.max(...high.slice(-26)) + Math.min(...low.slice(-26))) / 2, spanB = (Math.max(...high.slice(-52)) + Math.min(...low.slice(-52))) / 2;
  const spanA = (tenkan + kijun) / 2, cloudTop = Math.max(spanA, spanB), cloudBottom = Math.min(spanA, spanB);
  trend.push({ name: 'Hull MA (9)', value: hullValue, dist: hullValue ? (price / hullValue - 1) * 100 : null, signal: hullValue && price > hullValue ? 'Alcista' : hullValue ? 'Bajista' : 'Sin historial' });
  trend.push({ name: 'VWMA (20)', value: vwmaValue, dist: vwmaValue ? (price / vwmaValue - 1) * 100 : null, signal: vwmaValue && price > vwmaValue ? 'Alcista' : vwmaValue ? 'Bajista' : 'Sin historial' });
  trend.push({ name: 'Ichimoku (9,26,52)', value: spanA, dist: price >= cloudTop ? (price / cloudTop - 1) * 100 : price <= cloudBottom ? (price / cloudBottom - 1) * 100 : 0, signal: price > cloudTop && tenkan > kijun ? 'Alcista' : price < cloudBottom && tenkan < kijun ? 'Bajista' : 'Neutral', detail: 'Nube ' + numberFmt(cloudBottom) + '–' + numberFmt(cloudTop) });

  const rsi14 = latest(rsi(close, 14)), stochRaw = bars.map((_, i) => { if (i < 13) return null; const hh = Math.max(...high.slice(i - 13, i + 1)), ll = Math.min(...low.slice(i - 13, i + 1)); return hh === ll ? 50 : (close[i] - ll) / (hh - ll) * 100; }), stochKSeries = sma(stochRaw.map(v => v ?? 0), 3), stochDSeries = sma(stochKSeries.map(v => v ?? 0), 3), stochK = latest(stochKSeries), stochD = latest(stochDSeries);
  const typical = bars.map((_, i) => (high[i] + low[i] + close[i]) / 3), tSma = sma(typical, 20), cci = last >= 19 ? (typical[last] - tSma[last]) / (0.015 * (rollingMeanDeviation(typical, 20, last) || 1)) : null;
  const tr = bars.map((b, i) => i === 0 ? high[i] - low[i] : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  const plusDm = bars.map((_, i) => i === 0 ? 0 : (high[i] - high[i - 1] > low[i - 1] - low[i] ? Math.max(high[i] - high[i - 1], 0) : 0));
  const minusDm = bars.map((_, i) => i === 0 ? 0 : (low[i - 1] - low[i] > high[i] - high[i - 1] ? Math.max(low[i - 1] - low[i], 0) : 0));
  let smTR = tr.slice(1, 15).reduce((a, b) => a + b, 0), smPlus = plusDm.slice(1, 15).reduce((a, b) => a + b, 0), smMinus = minusDm.slice(1, 15).reduce((a, b) => a + b, 0); const dxValues = [];
  for (let i = 14; i < bars.length; i++) { if (i > 14) { smTR = smTR - smTR / 14 + tr[i]; smPlus = smPlus - smPlus / 14 + plusDm[i]; smMinus = smMinus - smMinus / 14 + minusDm[i]; } const p = smTR ? smPlus / smTR * 100 : 0, m = smTR ? smMinus / smTR * 100 : 0; dxValues.push({ dx: p + m ? Math.abs(p - m) / (p + m) * 100 : 0, p, m }); }
  let adx = null; if (dxValues.length >= 14) { adx = dxValues.slice(0, 14).reduce((a, x) => a + x.dx, 0) / 14; for (let i = 14; i < dxValues.length; i++) adx = (adx * 13 + dxValues[i].dx) / 14; } const latestDI = dxValues.at(-1) || { p: null, m: null };
  const median = bars.map((_, i) => (high[i] + low[i]) / 2), median5 = sma(median, 5), median34 = sma(median, 34), ao = latest(median5.map((v, i) => v != null && median34[i] != null ? v - median34[i] : null));
  const fastEma = ema(close, 12), slowEma = ema(close, 26), macdLine = fastEma.map((v, i) => v != null && slowEma[i] != null ? v - slowEma[i] : null), macd = latest(macdLine), macdSignal = latest(ema(macdLine.filter(Number.isFinite), 9));
  const rsiSeries = rsi(close, 14), rsiNums = rsiSeries.map(v => v ?? 0), rsiLow = Math.min(...rsiNums.slice(-14)), rsiHigh = Math.max(...rsiNums.slice(-14)), stochRsi = rsiHigh === rsiLow ? 50 : (rsi14 - rsiLow) / (rsiHigh - rsiLow) * 100;
  const hh14 = Math.max(...high.slice(-14)), ll14 = Math.min(...low.slice(-14)), williams = hh14 === ll14 ? -50 : (hh14 - price) / (hh14 - ll14) * -100;
  const ema13 = latest(ema(close, 13)), bullPower = ema13 == null ? null : high[last] - ema13, bearPower = ema13 == null ? null : low[last] - ema13, bullBear = bullPower == null ? null : bullPower + bearPower;
  const bp = [], trU = []; for (let i = 1; i < bars.length; i++) { const prev = close[i - 1]; bp.push(close[i] - Math.min(low[i], prev)); trU.push(Math.max(high[i], prev) - Math.min(low[i], prev)); }
  const ult = (p1, p2, p3) => { const avg = p => { const b = bp.slice(-p), t = trU.slice(-p); return t.reduce((a, x) => a + x, 0) ? b.reduce((a, x) => a + x, 0) / t.reduce((a, x) => a + x, 0) : null; }; const a = avg(p1), b = avg(p2), c = avg(p3); return a == null || b == null || c == null ? null : (a * 4 + b * 2 + c) / 7 * 100; };
  const momentum = close.length > 10 ? price - close[last - 10] : null;
  const oscillator = [
    { name: 'RSI (14)', value: rsi14, zone: rsi14 > 70 ? 'Sobrecompra' : rsi14 < 30 ? 'Sobreventa' : 'Neutral', signal: rsi14 < 30 ? 'Alcista' : rsi14 > 70 ? 'Bajista' : 'Neutral' },
    { name: 'Estocástico %K (14,3,3)', value: stochK, zone: 'D ' + numberFmt(stochD), signal: stochK < 20 && stochK > stochD ? 'Alcista' : stochK > 80 && stochK < stochD ? 'Bajista' : 'Neutral' },
    { name: 'CCI (20)', value: cci, zone: cci > 100 ? 'Alto' : cci < -100 ? 'Bajo' : 'Neutral', signal: cci > 100 ? 'Alcista' : cci < -100 ? 'Bajista' : 'Neutral' },
    { name: 'ADX (14)', value: adx, zone: adx >= 25 ? 'Tendencia fuerte' : 'Tendencia débil', signal: adx >= 25 ? (latestDI.p > latestDI.m ? 'Alcista' : 'Bajista') : 'Neutral' },
    { name: 'Awesome Oscillator', value: ao, zone: ao > 0 ? 'Sobre cero' : 'Bajo cero', signal: ao > 0 ? 'Alcista' : 'Bajista' },
    { name: 'Momentum (10)', value: momentum, zone: momentum >= 0 ? 'Positivo' : 'Negativo', signal: momentum >= 0 ? 'Alcista' : 'Bajista' },
    { name: 'MACD (12,26,9)', value: macd, zone: 'Señal ' + numberFmt(macdSignal), signal: macd > macdSignal ? 'Alcista' : 'Bajista' },
    { name: 'Stoch RSI (14)', value: stochRsi, zone: stochRsi > 80 ? 'Sobrecompra' : stochRsi < 20 ? 'Sobreventa' : 'Neutral', signal: stochRsi < 20 ? 'Alcista' : stochRsi > 80 ? 'Bajista' : 'Neutral' },
    { name: 'Williams %R (14)', value: williams, zone: williams > -20 ? 'Sobrecompra' : williams < -80 ? 'Sobreventa' : 'Neutral', signal: williams < -80 ? 'Alcista' : williams > -20 ? 'Bajista' : 'Neutral' },
    { name: 'Bull Bear Power (13)', value: bullBear, display: 'B ' + numberFmt(bullPower) + ' · S ' + numberFmt(bearPower), zone: bullBear >= 0 ? 'Positivo' : 'Negativo', signal: bullBear >= 0 ? 'Alcista' : 'Bajista' },
    { name: 'Ultimate Oscillator', value: ult(7, 14, 28), zone: ult(7, 14, 28) > 70 ? 'Sobrecompra' : ult(7, 14, 28) < 30 ? 'Sobreventa' : 'Neutral', signal: ult(7, 14, 28) < 30 ? 'Alcista' : ult(7, 14, 28) > 70 ? 'Bajista' : 'Neutral' }
  ];
  const trendRows = trend.map(row => '<tr><td>' + row.name + (row.detail ? '<small class="indicator-detail">' + row.detail + '</small>' : '') + '</td><td>' + (row.value == null ? '—' : numberFmt(row.value)) + '</td><td>' + percentFmt(row.dist) + '</td><td>' + signalTag(row.signal) + '</td></tr>').join('');
  const oscillatorRows = oscillator.map(row => '<tr><td>' + row.name + '</td><td>' + (row.display || numberFmt(row.value)) + '</td><td>' + (row.zone.includes('Sobre') ? '<span class="signal-tag signal-warn">' + row.zone + '</span>' : row.zone) + '</td><td>' + signalTag(row.signal) + '</td></tr>').join('');
  research$('#tech-trend-rows').innerHTML = trendRows; research$('#tech-oscillator-rows').innerHTML = oscillatorRows;
  const signals = [...trend, ...oscillator], up = signals.filter(x => x.signal === 'Alcista').length, down = signals.filter(x => x.signal === 'Bajista').length;
  research$('#tech-verdict').textContent = up > down ? 'Confluencia alcista · ' + up + ' alcistas / ' + down + ' bajistas' : down > up ? 'Confluencia bajista · ' + down + ' bajistas / ' + up + ' alcistas' : 'Señales mixtas · ' + up + ' alcistas / ' + down + ' bajistas';
  research$('#tech-coverage').textContent = researchSymbol + ' · ' + researchInterval.toUpperCase(); research$('#tech-bar-label').textContent = bars.length + ' velas';
}

const SEC_TAGS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet','SalesRevenueGoodsNet'],
  gross: ['GrossProfit'], operating: ['OperatingIncomeLoss'], net: ['NetIncomeLoss'],
  eps: ['EarningsPerShareDiluted','EarningsPerShareBasic'], assets: ['Assets'], currentAssets: ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'], equity: ['StockholdersEquity'], cash: ['CashAndCashEquivalentsAtCarryingValue','CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  debtCurrent: ['LongTermDebtCurrent'], debtLong: ['LongTermDebtNoncurrent','LongTermDebt'],
  cashflow: ['NetCashProvidedByUsedInOperatingActivities'], capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  da: ['DepreciationDepletionAndAmortization'], shares: ['EntityCommonStockSharesOutstanding'], dividends: ['CommonStockDividendsPerShareDeclared']
};
function factRecords(payload, names, unitHint = /USD|shares/i) {
  for (const name of names) {
    const fact = payload.facts?.[name]; if (!fact) continue;
    const units = fact.units || {}, unit = Object.keys(units).find(u => unitHint.test(u)) || Object.keys(units)[0];
    if (unit && units[unit]?.length) return units[unit].filter(x => Number.isFinite(Number(x.val))).sort((a, b) => (a.end || '').localeCompare(b.end || '') || (a.filed || '').localeCompare(b.filed || ''));
  }
  return [];
}
function annualRecord(payload, names, unitHint = /USD|shares|USD\/sh/i) { const rows = factRecords(payload, names, unitHint); const annual = rows.filter(x => x.form === '10-K' || x.form === '20-F' || x.form === '40-F'); return annual.at(-1) || rows.at(-1) || null; }
function annualSeries(payload, names, unitHint) { const rows = factRecords(payload, names, unitHint).filter(x => ['10-K','20-F','40-F'].includes(x.form)); const dedupe = new Map(); rows.forEach(x => dedupe.set(x.end, x)); return [...dedupe.values()].sort((a,b)=>a.end.localeCompare(b.end)); }
function fundamentalValue(payload, names, unitHint) { const row = annualRecord(payload, names, unitHint); return row ? Number(row.val) : null; }
function fmtFinancial(value, divisor = 1) { if (!Number.isFinite(value)) return '—'; const n = value / divisor; return Math.abs(n) >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function ratio(a, b) { return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null; }
function renderFundamentals(payload, symbol) {
  latestFundamentals = { payload, symbol }; renderFairValue();
  const report = fundamentalValue(payload, SEC_TAGS.revenue), gross = fundamentalValue(payload, SEC_TAGS.gross), op = fundamentalValue(payload, SEC_TAGS.operating), net = fundamentalValue(payload, SEC_TAGS.net), eps = fundamentalValue(payload, SEC_TAGS.eps, /USD.*sh/i), assets = fundamentalValue(payload, SEC_TAGS.assets), currentAssets = fundamentalValue(payload, SEC_TAGS.currentAssets), currentLiab = fundamentalValue(payload, SEC_TAGS.currentLiabilities), equity = fundamentalValue(payload, SEC_TAGS.equity), cash = fundamentalValue(payload, SEC_TAGS.cash), debtCurrent = fundamentalValue(payload, SEC_TAGS.debtCurrent), debtLong = fundamentalValue(payload, SEC_TAGS.debtLong), debt = debtCurrent == null && debtLong == null ? null : (debtCurrent || 0) + (debtLong || 0), cfo = fundamentalValue(payload, SEC_TAGS.cashflow), capexRaw = fundamentalValue(payload, SEC_TAGS.capex), capex = capexRaw == null ? null : Math.abs(capexRaw), da = fundamentalValue(payload, SEC_TAGS.da), shares = fundamentalValue(payload, SEC_TAGS.shares, /shares/i), dividend = fundamentalValue(payload, SEC_TAGS.dividends, /USD.*sh/i);
  const quotePrice = Number(payload.quote?.price), validPrice = Number.isFinite(quotePrice) && quotePrice > 0 ? quotePrice : null, marketCap = validPrice && shares ? validPrice * shares : null, ev = marketCap != null && debt != null && cash != null ? marketCap + debt - cash : null, fcf = cfo != null && capex != null ? cfo - capex : null, ebitda = op != null && da != null ? op + da : null;
  const revenueSeries = annualSeries(payload, SEC_TAGS.revenue), growthBase = revenueSeries.length >= 4 ? revenueSeries.at(-4) : revenueSeries.length >= 2 ? revenueSeries.at(0) : null, growthYears = growthBase ? Math.max(1, Number(revenueSeries.at(-1).end.slice(0, 4)) - Number(growthBase.end.slice(0, 4))) : null, growthValue = growthBase && report != null ? (report / Number(growthBase.val) - 1) * 100 : null;
  const latestRow = annualRecord(payload, SEC_TAGS.revenue), asOf = latestRow?.end ? 'Ejercicio terminado ' + latestRow.end + ' · presentado ' + latestRow.filed : 'Presentación más reciente';
  const groups = [
    ['Identidad y precio', [['Emisor', payload.entityName], ['Símbolo', symbol], ['Cotización IEX en vivo', validPrice == null ? 'No conectada' : '$' + validPrice.toFixed(2)], ['Capitalización', marketCap == null ? null : fmtFinancial(marketCap)], ['Acciones en circulación', shares == null ? null : numberFmt(shares)]]],
    ['Valoración', [['PER (anual)', ratio(validPrice, eps) == null ? null : ratio(validPrice, eps).toFixed(2) + '×'], ['P/Ventas', ratio(marketCap, report) == null ? null : ratio(marketCap, report).toFixed(2) + '×'], ['P/Valor libros', ratio(marketCap, equity) == null ? null : ratio(marketCap, equity).toFixed(2) + '×'], ['EV/Ventas', ratio(ev, report) == null ? null : ratio(ev, report).toFixed(2) + '×'], ['P/FCF', ratio(marketCap, fcf) == null ? null : ratio(marketCap, fcf).toFixed(2) + '×'], ['EV/EBITDA', ratio(ev, ebitda) == null ? null : ratio(ev, ebitda).toFixed(2) + '×']]],
    ['Crecimiento', [['Ingresos anuales', report], ['Ingresos vs. hace ' + (growthYears == null ? 'historial disponible' : growthYears + (growthYears === 1 ? ' año' : ' años')), growthValue == null ? null : percentFmt(growthValue)], ['BPA diluido anual', eps], ['Beneficio neto anual', net]]],
    ['Rentabilidad', [['Margen bruto', ratio(gross, report) == null ? null : percentFmt(ratio(gross, report) * 100)], ['Margen operativo', ratio(op, report) == null ? null : percentFmt(ratio(op, report) * 100)], ['Margen neto', ratio(net, report) == null ? null : percentFmt(ratio(net, report) * 100)], ['ROE', ratio(net, equity) == null ? null : percentFmt(ratio(net, equity) * 100)], ['ROA', ratio(net, assets) == null ? null : percentFmt(ratio(net, assets) * 100)]]],
    ['Balance', [['Activos totales', assets], ['Activos corrientes', currentAssets], ['Pasivos corrientes', currentLiab], ['Patrimonio', equity], ['Efectivo y equivalentes', cash], ['Deuda identificada', debt], ['Deuda neta', debt == null || cash == null ? null : debt - cash], ['Ratio corriente', ratio(currentAssets, currentLiab) == null ? null : ratio(currentAssets, currentLiab).toFixed(2) + '×']]],
    ['Flujo y dividendos', [['Flujo operativo', cfo], ['Inversión en propiedad y equipo', capex], ['Flujo libre calculado', fcf], ['Dividendo declarado por acción', dividend == null ? null : '$' + dividend.toFixed(2)], ['Rendimiento por dividendo', validPrice && dividend ? percentFmt(dividend / validPrice * 100) : null]]]
  ];
  const format = value => typeof value === 'string' ? value : value == null ? '—' : fmtFinancial(value);
  research$('#fundamentals-title').textContent = 'Fundamentales · ' + symbol;
  research$('#fundamentals-source').textContent = 'SEC CompanyFacts · oficial';
  research$('#fundamentals-note').textContent = asOf + '. Importes reportados en USD; ratios derivados del último ejercicio anual disponible.';
  research$('#fundamentals-grid').innerHTML = groups.map(([title, rows]) => '<section class="fundamental-group"><h3>' + title + '</h3>' + rows.map(([name, value]) => '<div class="fundamental-row"><span>' + name + '</span><b>' + format(value) + '</b></div>').join('') + '</section>').join('');
  const revenues = annualSeries(payload, SEC_TAGS.revenue).slice(-6);
  const epsRows = annualSeries(payload, SEC_TAGS.eps, /USD.*sh/i), netRows = annualSeries(payload, SEC_TAGS.net), cashRows = annualSeries(payload, SEC_TAGS.cashflow), capexRows = annualSeries(payload, SEC_TAGS.capex);
  const byYear = rows => new Map(rows.map(row => [row.end, Number(row.val)]));
  const epsByEnd = byYear(epsRows), netByEnd = byYear(netRows), cfoByEnd = byYear(cashRows), capexByEnd = byYear(capexRows);
  const years = revenues.map(row => ({ end: row.end, revenue: Number(row.val) }));
  research$('#annual-trend-rows').innerHTML = years.length ? years.map((row, i) => {
    const prev = years[i - 1], yoy = prev && prev.revenue !== 0 ? (row.revenue / prev.revenue - 1) * 100 : null;
    const net = netByEnd.get(row.end), cfo = cfoByEnd.get(row.end), capex = capexByEnd.get(row.end), fcf = cfo != null && capex != null ? cfo - Math.abs(capex) : null;
    return '<tr><td>' + row.end.slice(0, 4) + '</td><td>' + fmtFinancial(row.revenue) + '</td><td>' + percentFmt(yoy) + '</td><td>' + (epsByEnd.has(row.end) ? '$' + epsByEnd.get(row.end).toFixed(2) : '—') + '</td><td>' + (net != null && row.revenue ? percentFmt(net / row.revenue * 100) : '—') + '</td><td>' + (fcf != null ? fmtFinancial(fcf) : '—') + '</td></tr>';
  }).join('') : '<tr><td colspan="6" class="muted">La SEC no publicó suficiente historial anual para esta tabla.</td></tr>';
  research$('#annual-trend-rows').dataset.source = 'SEC CompanyFacts';
}
async function loadFundamentals(symbol, kind = researchKind) {
  const stock = kind === 'stock', requestId = ++fundamentalsRequest;
  research$('#fundamentals-title').textContent = 'Fundamentales' + (stock ? ' · ' + symbol : '');
  if (!stock) { research$('#fundamentals-source').textContent = 'No aplica'; research$('#fundamentals-note').textContent = 'Los estados financieros SEC son para emisores públicos de EE. UU.; los criptoactivos no publican estos reportes.'; research$('#fundamentals-grid').innerHTML = ''; return; }
  research$('#fundamentals-source').textContent = 'Consultando SEC…'; research$('#fundamentals-note').textContent = 'Cargando la última información XBRL presentada por el emisor.';
  try { const response = await fetch('/api/fundamentals?symbol=' + encodeURIComponent(symbol)), data = await response.json(); if (!response.ok) throw new Error(data.error || 'SEC no disponible'); const quoteResponse = await fetch('/api/quote?symbol=' + encodeURIComponent(symbol)); if (quoteResponse.ok) data.quote = (await quoteResponse.json()).quote; if (requestId === fundamentalsRequest) renderFundamentals(data, symbol); }
  catch (error) { if (requestId === fundamentalsRequest) { research$('#fundamentals-source').textContent = 'Fuente no disponible'; research$('#fundamentals-note').textContent = error.message + ' Los indicadores técnicos calculados con velas siguen disponibles.'; research$('#fundamentals-grid').innerHTML = ''; } }
}
function analystMoney(value) { return Number.isFinite(Number(value)) && Number(value) > 0 ? '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
function renderAnalystMovements(data) {
  const tbody = research$('#analyst-rows'), rows = data.rows || [];
  let upgrades = 0, downgrades = 0;
  rows.forEach(row => { if (row.action === 'subida') upgrades++; if (row.action === 'bajada') downgrades++; });
  research$('#analyst-upgrades').textContent = upgrades + (upgrades === 1 ? ' subida' : ' subidas');
  research$('#analyst-downgrades').textContent = downgrades + (downgrades === 1 ? ' bajada' : ' bajadas');
  tbody.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6; td.className = 'muted'; td.textContent = 'No hay movimientos publicados en este periodo para este símbolo.'; tr.append(td); tbody.append(tr); return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr'), date = document.createElement('td'), action = document.createElement('td'), firm = document.createElement('td'), rating = document.createElement('td'), target = document.createElement('td'), relative = document.createElement('td');
    date.textContent = new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(row.date));
    const actionTag = document.createElement('span'); actionTag.className = 'analyst-action analyst-action-' + (row.action || 'actualización'); actionTag.textContent = ({ subida: 'SUBIDA', bajada: 'BAJADA', inicio: 'INICIO', reitera: 'REITERA', actualización: 'ACTUALIZA' })[row.action] || 'ACTUALIZA'; action.append(actionTag);
    firm.textContent = row.firm || 'No indicada';
    if (row.url) { const link = document.createElement('a'); link.className = 'analyst-source-link'; link.href = row.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = row.title || 'Abrir titular original'; link.setAttribute('aria-label', 'Abrir fuente original: ' + (row.title || '')); link.textContent = '↗'; firm.append(' ', link); }
    rating.textContent = row.rating || 'No indicada';
    target.textContent = row.previousTarget ? analystMoney(row.previousTarget) + ' → ' + analystMoney(row.target) : analystMoney(row.target);
    const upside = Number.isFinite(Number(row.target)) && Number(row.priceWhenPosted) > 0 ? (Number(row.target) / Number(row.priceWhenPosted) - 1) * 100 : null;
    relative.textContent = upside == null ? '—' : (upside >= 0 ? '+' : '') + upside.toFixed(1) + '%';
    if (upside != null) relative.className = upside >= 0 ? 'positive' : 'negative';
    tr.append(date, action, firm, rating, target, relative); tbody.append(tr);
  }
}
async function loadAnalystMovements(symbol, kind = researchKind) {
  const requestId = ++analystRequest, tbody = research$('#analyst-rows');
  research$('#analyst-source').textContent = kind === 'stock' ? 'Consultando fuente…' : 'Solo acciones';
  research$('#analyst-note').textContent = kind === 'stock' ? symbol + ' · últimos ' + research$('#analyst-period').value + ' días.' : 'Las revisiones de analistas aplican a acciones; no hay cobertura equivalente para pares cripto.';
  research$('#analyst-upgrades').textContent = '— subidas'; research$('#analyst-downgrades').textContent = '— bajadas';
  if (kind !== 'stock') { tbody.innerHTML = '<tr><td colspan="6" class="muted">Selecciona una acción para consultar movimientos de analistas.</td></tr>'; return; }
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Consultando movimientos publicados…</td></tr>';
  try {
    const response = await fetch('/api/analyst-movements?symbol=' + encodeURIComponent(symbol) + '&days=' + encodeURIComponent(research$('#analyst-period').value));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Fuente de analistas no disponible.');
    if (requestId !== analystRequest) return;
    research$('#analyst-source').textContent = data.source || 'Fuente externa';
    research$('#analyst-note').textContent = symbol + ' · ' + data.rows.length + ' movimientos publicados en los últimos ' + data.days + ' días. Hasta 100 registros; el proveedor actualiza esta fuente aproximadamente cada 2 h. Consulta al ' + new Date(data.retrievedAt).toLocaleTimeString('es-MX') + '.';
    renderAnalystMovements(data);
  } catch (error) {
    if (requestId !== analystRequest) return;
    research$('#analyst-source').textContent = 'Sin fuente gratuita';
    research$('#analyst-note').textContent = error.message.includes('FMP_API_KEY') ? 'No hay una fuente gratuita de movimientos individuales configurada. El consenso mensual de Finnhub muestra conteos agregados, no cambios por firma ni objetivos.' : error.message;
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Sin datos reales disponibles. No se muestran filas de ejemplo.</td></tr>';
  }
}
let dailyHistory = [], dailySource = '', latestLivePrice = null, latestFundamentals = null, dailyRequest = 0, consensusRequest = 0;
function renderFairValue() {
  const box=research$('#fair-price'); if(!box)return;
  if(researchKind!=='stock'||!latestFundamentals||latestFundamentals.symbol!==researchSymbol||!dailyHistory.length){box.textContent='—';research$('#fair-grade').textContent='Sin datos';research$('#fair-method').textContent='El modelo requiere acción, fundamentales SEC y al menos dos años de barras diarias.';return;}
  const payload=latestFundamentals.payload, getMap=names=>new Map(annualSeries(payload,names).map(r=>[r.end,Number(r.val)]));
  const rev=getMap(SEC_TAGS.revenue), eps=getMap(SEC_TAGS.eps), equity=getMap(SEC_TAGS.equity), shares=getMap(SEC_TAGS.shares), cfo=getMap(SEC_TAGS.cashflow), capex=getMap(SEC_TAGS.capex), op=getMap(SEC_TAGS.operating), da=getMap(SEC_TAGS.da), cash=getMap(SEC_TAGS.cash), debtCurrent=getMap(SEC_TAGS.debtCurrent), debtLong=getMap(SEC_TAGS.debtLong), filedByEnd=new Map(annualSeries(payload,SEC_TAGS.revenue).map(r=>[r.end,r.filed||r.end]));
  const priceAt=date=>{const t=Date.parse(date+'T00:00:00Z')/1000;const bar=dailyHistory.find(b=>Number(b.time)>=t);return bar?Number(bar.close):null;};
  const metrics={pe:[],ps:[],pb:[],pfcf:[],evEbitda:[]};
  for(const end of rev.keys()) { const price=priceAt(filedByEnd.get(end)||end), revenue=rev.get(end), sh=shares.get(end), earnings=eps.get(end), book=equity.get(end), cf=cfo.get(end), cx=capex.get(end), free=cf!=null&&cx!=null?cf-Math.abs(cx):null, operating=op.get(end),depr=da.get(end),ebitda=operating!=null&&depr!=null?operating+depr:null, netDebt=(debtCurrent.get(end)||0)+(debtLong.get(end)||0)-(cash.get(end)||0);
    if(!(price>0))continue; if(earnings>0)metrics.pe.push({multiple:price/earnings,end}); if(revenue>0&&sh>0)metrics.ps.push({multiple:price/(revenue/sh),end}); if(book>0&&sh>0)metrics.pb.push({multiple:price/(book/sh),end}); if(free>0&&sh>0)metrics.pfcf.push({multiple:price/(free/sh),end}); if(ebitda>0&&sh>0)metrics.evEbitda.push({multiple:(price*sh+netDebt)/ebitda,end});
  }
  const current=payload, q=Number(latestLivePrice||current.quote?.price), annual=(tag)=>fundamentalValue(current,tag), currentShares=annual(SEC_TAGS.shares), currentRev=annual(SEC_TAGS.revenue), currentEps=annual(SEC_TAGS.eps,/USD.*sh/i), currentBook=annual(SEC_TAGS.equity), currentCfo=annual(SEC_TAGS.cashflow), currentCapex=annual(SEC_TAGS.capex), currentOp=annual(SEC_TAGS.operating), currentDa=annual(SEC_TAGS.da), currentCash=annual(SEC_TAGS.cash), currentDebt=(annual(SEC_TAGS.debtCurrent)||0)+(annual(SEC_TAGS.debtLong)||0), currentFcf=currentCfo!=null&&currentCapex!=null?currentCfo-Math.abs(currentCapex):null, currentEbitda=currentOp!=null&&currentDa!=null?currentOp+currentDa:null;
  const specs=[['P/E',metrics.pe,m=>m*currentEps],['P/Ventas',metrics.ps,m=>m*(currentRev/currentShares)],['P/Valor libros',metrics.pb,m=>m*(currentBook/currentShares)],['P/FCF',metrics.pfcf,m=>m*(currentFcf/currentShares)],['EV/EBITDA',metrics.evEbitda,m=>(m*currentEbitda-currentDebt+currentCash)/currentShares]];
  const available=specs.filter(([_,rows,formula])=>rows.length>=2&&Number.isFinite(formula(1))&&formula(1)>0).map(([name,rows,formula])=>{const vals=rows.map(x=>x.multiple).sort((a,b)=>a-b),quant=p=>vals[Math.min(vals.length-1,Math.floor((vals.length-1)*p))];return{name,center:formula(quant(.5)),low:formula(quant(.25)),high:formula(quant(.75)),years:rows.length};}).filter(x=>[x.center,x.low,x.high].every(Number.isFinite));
  if(!available.length||!(q>0)){box.textContent='—';research$('#fair-grade').textContent='Sin historial';research$('#fair-method').textContent='No hay suficientes múltiplos positivos e históricos para calcular un rango verificable.';return;}
  const med=a=>{const v=a.slice().sort((x,y)=>x-y),m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;},center=med(available.map(x=>x.center)),low=med(available.map(x=>x.low)),high=med(available.map(x=>x.high)),upside=(center/q-1)*100;
  box.textContent=analystMoney(center);research$('#fair-upside').textContent=percentFmt(upside)+' vs. cotización';research$('#fair-low').textContent='P25 · '+analystMoney(low);research$('#fair-high').textContent='P75 · '+analystMoney(high);
  research$('#fair-grade').textContent=upside>=25?'A':upside>=10?'B':upside>=-10?'C':upside>=-25?'D':'E';research$('#fair-method').textContent=(upside < -12?'Cara':upside > 12?'Barata':'En rango')+' según ±12% · '+available.map(x=>x.name).join(', ')+' · muestra histórica de 2–'+Math.max(...available.map(x=>x.years))+' ejercicios.';
}
function updatePeriodAndRange() {
  const host = research$('#period-returns'); if (!dailyHistory.length) return;
  const crypto = researchKind === 'crypto', periods = crypto ? [['1D',1],['1W',7],['1M',30],['3M',90],['YTD',null],['1A',365],['5A',1825]] : [['1D',1],['1W',5],['1M',21],['3M',63],['YTD',null],['1A',252],['5A',1260]];
  const valid = dailyHistory.filter(row => Number.isFinite(Number(row.close)) && Number(row.close) > 0), current = valid.at(-1), rangePrice = latestLivePrice || Number(current?.close), ytd = new Date().getUTCFullYear();
  const dateInNY = value => new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Number(value)*1000));
  const todayNY = dateInNY(Date.now()/1000), closed = crypto ? valid : valid.filter(row => dateInNY(row.time) < todayNY), closePrice = Number(closed.at(-1)?.close), price = closePrice;
  host.innerHTML = periods.map(([label, offset]) => { const i = offset == null ? closed.findIndex(row => new Date(Number(row.time)*1000).getUTCFullYear() === ytd) : closed.length-1-offset, base = closed[i], value = base && closePrice > 0 ? (closePrice/Number(base.close)-1)*100 : null; return '<div class="period-tile"><small>' + label + '</small><b class="' + (value == null ? '' : value >= 0 ? 'positive' : 'negative') + '">' + percentFmt(value) + '</b><span>' + (base ? new Date(Number(base.time)*1000).toLocaleDateString('es-MX',{timeZone:'UTC'}) : 'Historial insuficiente') + '</span></div>'; }).join('');
  research$('#period-source').textContent = dailySource + ' · ' + valid.length + ' barras';
  const windowBars=valid.slice(-(crypto?365:252)), lowBar=windowBars.reduce((a,b)=>Number(b.low)<Number(a.low)?b:a,windowBars[0]), highBar=windowBars.reduce((a,b)=>Number(b.high)>Number(a.high)?b:a,windowBars[0]);
  if (!lowBar || !highBar || !(Number(highBar.high)>Number(lowBar.low))) return;
  const low=Number(lowBar.low), high=Number(highBar.high), position=Math.max(0,Math.min(100,(rangePrice-low)/(high-low)*100));
  research$('#range-title').textContent=crypto?'Rango de 365 días':'Rango de 52 semanas'; research$('#range-current').textContent=analystMoney(rangePrice); research$('#range-position').textContent=position.toFixed(1)+'% del rango'; research$('#range-marker').style.left=position+'%';
  research$('#range-low').textContent='Mín. '+analystMoney(low)+' · '+new Date(Number(lowBar.time)*1000).toLocaleDateString('es-MX',{timeZone:'UTC'}); research$('#range-high').textContent='Máx. '+analystMoney(high)+' · '+new Date(Number(highBar.time)*1000).toLocaleDateString('es-MX',{timeZone:'UTC'});
  research$('#range-from-high').textContent=percentFmt((rangePrice/high-1)*100); research$('#range-from-low').textContent=percentFmt((rangePrice/low-1)*100); research$('#range-amplitude').textContent=percentFmt((high/low-1)*100); research$('#range-zone').textContent=position>=66?'Zona alta':position<33?'Zona baja':'Zona media'; renderFairValue();
}
async function loadDailyHistory(symbol,kind) { const id=++dailyRequest; dailyHistory=[]; dailySource=''; latestLivePrice=null; research$('#period-source').textContent='Descargando historial'; research$('#period-returns').innerHTML='<div class="period-tile muted">Consultando barras diarias…</div>'; try { const r=await fetch('/api/daily-bars?symbol='+encodeURIComponent(symbol)),d=await r.json(); if(!r.ok) throw new Error(d.error||'Historial no disponible'); if(id!==dailyRequest)return; dailyHistory=d.bars||[]; dailySource=d.source||'Fuente de mercado'; updatePeriodAndRange(); } catch(e) { if(id!==dailyRequest)return; research$('#period-source').textContent='Sin historial'; research$('#period-returns').innerHTML='<div class="period-tile muted">'+e.message+'</div>'; } }
async function loadConsensus(symbol,kind) { const id=++consensusRequest; research$('#consensus-source').textContent=kind==='stock'?'Consultando Finnhub':'Solo acciones'; research$('#consensus-latest').innerHTML=''; research$('#consensus-history').innerHTML=''; if(kind!=='stock'){research$('#consensus-note').textContent='El consenso de analistas cubre acciones; no se publica para cripto.';return;} try { const r=await fetch('/api/analyst-consensus?symbol='+encodeURIComponent(symbol)),d=await r.json(); if(!r.ok)throw new Error(d.error||'Fuente no disponible'); if(id!==consensusRequest)return; const rows=d.trends||[]; research$('#consensus-source').textContent=d.source||'Finnhub'; if(!rows.length){research$('#consensus-note').textContent='Finnhub no reporta recomendaciones mensuales para '+symbol+'.';return;} const a=rows[0],buy=a.strongBuy+a.buy,hold=a.hold,sell=a.sell+a.strongSell; research$('#consensus-note').textContent=symbol+' · datos mensuales agregados · actualizado '+new Date(d.retrievedAt).toLocaleString('es-MX')+'. Sin precio objetivo.'; research$('#consensus-latest').innerHTML='<div class="consensus-count"><span>Compra</span><b>'+buy+'</b></div><div class="consensus-count"><span>Mantener</span><b>'+hold+'</b></div><div class="consensus-count"><span>Venta</span><b>'+sell+'</b></div>'; research$('#consensus-history').innerHTML=rows.slice(0,6).map(x=>{const b=x.strongBuy+x.buy,h=x.hold,s=x.sell+x.strongSell,t=b+h+s||1;return '<div class="consensus-month"><small>'+x.period.slice(0,7)+'</small><div class="consensus-bar"><i style="width:'+(b/t*100)+'%"></i><i style="width:'+(h/t*100)+'%"></i><i style="width:'+(s/t*100)+'%"></i></div><span>'+(b+h+s)+'</span></div>';}).join(''); } catch(e){if(id!==consensusRequest)return;research$('#consensus-source').textContent='Requiere clave gratis';research$('#consensus-note').textContent=e.message;} }

async function loadResearch(symbol, interval, kind = researchKind) {
  const requestId = ++technicalRequest; researchSymbol = symbol; researchKind = kind; researchInterval = interval;
  research$('#tech-verdict').textContent = 'Calculando con velas reales…'; research$('#tech-coverage').textContent = symbol + ' · ' + interval.toUpperCase();
  loadFundamentals(symbol, kind);
  loadAnalystMovements(symbol, kind);
  loadDailyHistory(symbol, kind);
  loadConsensus(symbol, kind);
  try { const response = await fetch('/api/bars?symbol=' + encodeURIComponent(symbol) + '&interval=' + encodeURIComponent(interval)); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'No hay historial disponible'); if (requestId === technicalRequest) { researchBars = result.bars || []; calculateTechnical(researchBars); } }
  catch (error) { if (requestId === technicalRequest) { research$('#tech-verdict').textContent = error.message; research$('#tech-trend-rows').innerHTML = '<tr><td colspan="4" class="muted">No hay datos técnicos disponibles para esta consulta.</td></tr>'; research$('#tech-oscillator-rows').innerHTML = '<tr><td colspan="4" class="muted">Sin historial de fuente.</td></tr>'; } }
}
window.addEventListener('northstar:symbol', event => loadResearch(event.detail.symbol, event.detail.interval || researchInterval, event.detail.kind || 'stock'));
research$('#analyst-period').addEventListener('change', () => loadAnalystMovements(researchSymbol, researchKind));
research$('#chart-range-2').addEventListener('click', event => { const button = event.target.closest('button[data-range]'); if (button) loadResearch(researchSymbol, button.dataset.range); });
research$('#chart-range').addEventListener('click', event => { const button = event.target.closest('button[data-range]'); if (button) loadResearch(researchSymbol, button.dataset.range); });
window.addEventListener('northstar:tick', event => { const tick = event.detail; if (!tick || tick.symbol !== researchSymbol || !Number.isFinite(Number(tick.price))) return; latestLivePrice = Number(tick.price); updatePeriodAndRange(); if (!researchBars.length) return; const current = researchBars.at(-1), close = Number(tick.price); current.high = Math.max(Number(current.high), close); current.low = Math.min(Number(current.low), close); current.close = close; calculateTechnical(researchBars); });
loadResearch(researchSymbol, researchInterval, researchKind);
