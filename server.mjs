import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));
function loadLocalEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
loadLocalEnv();

const isRender = process.env.RENDER === 'true';
const isProduction = process.env.NODE_ENV === 'production' || isRender;
const dashboardPassword = process.env.DASHBOARD_PASSWORD || '';
if (isProduction && dashboardPassword.length < 16) {
  throw new Error('Set DASHBOARD_PASSWORD to a strong password with at least 16 characters before starting in production.');
}
const authEnabled = Boolean(dashboardPassword);
const sessionCookieName = 'northstar_session';
const csrfCookieName = 'northstar_login_csrf';
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const host = process.env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT || 4174);
const key = process.env.APCA_API_KEY_ID;
const secret = process.env.APCA_API_SECRET_KEY;
const fmpKey = process.env.FMP_API_KEY;
const finnhubKey = process.env.FINNHUB_API_KEY;
const stocksConfigured = Boolean(key && secret);
const symbols = new Map([
  ['BTCUSDT', { kind: 'crypto', api: 'BTCUSDT', name: 'Bitcoin', quoteAsset: 'USDT' }], ['ETHUSDT', { kind: 'crypto', api: 'ETHUSDT', name: 'Ethereum', quoteAsset: 'USDT' }],
  ['SOLUSDT', { kind: 'crypto', api: 'SOLUSDT', name: 'Solana', quoteAsset: 'USDT' }], ['AAPL', { kind: 'stock', api: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ' }],
  ['MSFT', { kind: 'stock', api: 'MSFT' }], ['NVDA', { kind: 'stock', api: 'NVDA' }],
  ['AMZN', { kind: 'stock', api: 'AMZN' }],
]);
const cryptoSymbols = new Map([['BTCUSDT', 'BTCUSDT'], ['ETHUSDT', 'ETHUSDT'], ['SOLUSDT', 'SOLUSDT']]);
const defaultCryptoSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const defaultStockSymbols = ['AAPL', 'MSFT', 'NVDA', 'AMZN'];
const secCompanies = { AAPL: '0000320193', MSFT: '0000789019', NVDA: '0001045810', AMZN: '0001018724' };
let symbolCatalog = { stocks: defaultStockSymbols.map(symbol => ({ symbol, name: symbols.get(symbol)?.name || symbol, kind: 'stock', exchange: symbols.get(symbol)?.exchange || 'Alpaca IEX' })), crypto: defaultCryptoSymbols.map(symbol => ({ symbol, name: symbols.get(symbol)?.name, kind: 'crypto', exchange: 'Binance Spot', quoteAsset: 'USDT' })) };
let symbolCatalogExpiresAt = 0, secTickerMap, secTickerMapExpiresAt = 0;
let binanceSocket = null, alpacaSocket = null, alpacaAuthenticated = false, nextBinanceRequestId = 1;
const activeBinanceSubscriptions = new Set(), activeAlpacaSubscriptions = new Set();
const secTags = [
  'RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet','SalesRevenueGoodsNet',
  'GrossProfit','OperatingIncomeLoss','NetIncomeLoss','EarningsPerShareDiluted','EarningsPerShareBasic',
  'Assets','AssetsCurrent','LiabilitiesCurrent','StockholdersEquity','CashAndCashEquivalentsAtCarryingValue',
  'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents','LongTermDebtCurrent','LongTermDebtNoncurrent',
  'LongTermDebt','NetCashProvidedByUsedInOperatingActivities','PaymentsToAcquirePropertyPlantAndEquipment',
  'DepreciationDepletionAndAmortization','EntityCommonStockSharesOutstanding','CommonStockDividendsPerShareDeclared'
];
const secDeiTags = ['EntityCommonStockSharesOutstanding'];
const secFactsCache = new Map();
const analystMovementsCache = new Map();
const analystConsensusCache = new Map();
const dailyBarsCache = new Map();
const marketState = {};
const sourceState = {
  crypto: { status: 'connecting', label: 'Conectando' },
  stocks: { status: stocksConfigured ? 'connecting' : 'missing', label: stocksConfigured ? 'Conectando' : 'Falta configurar' },
};
const clients = new Set();

function constantTimeEqual(left, right) {
  const leftDigest = createHash('sha256').update(String(left)).digest();
  const rightDigest = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
function requestCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([name]) => name));
}
function hasActiveSession(req) {
  if (!authEnabled) return true;
  const sessionId = requestCookies(req)[sessionCookieName];
  const expiresAt = sessions.get(sessionId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) { sessions.delete(sessionId); return false; }
  return true;
}
function cookieHeader(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`;
}
function loginHtml(csrf, invalid = false) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Acceso · Northstar</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08111d;color:#e8f0fa;font:16px system-ui,sans-serif}.card{width:min(390px,calc(100% - 40px));box-sizing:border-box;padding:32px;border:1px solid #26374b;border-radius:18px;background:#101a28;box-shadow:0 20px 60px #0005}h1{font-size:24px;margin:0 0 8px}p{color:#9aabc0;line-height:1.5}.error{color:#ff8290}label{display:block;margin:22px 0 8px}input{box-sizing:border-box;width:100%;padding:12px 14px;border:1px solid #354962;border-radius:10px;background:#091321;color:#fff;font:inherit}button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:10px;background:#19c7b0;color:#05221f;font:600 16px system-ui,sans-serif;cursor:pointer}small{display:block;margin-top:18px;color:#7f91a8}</style></head>
<body><main class="card"><h1>Northstar</h1><p>Inicia sesión para abrir tu dashboard de investigación.</p>${invalid ? '<p class="error" role="alert">La contraseña no coincide. Inténtalo de nuevo.</p>' : ''}<form method="post" action="/login"><input type="hidden" name="csrf" value="${csrf}"><label for="password">Contraseña</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Entrar</button></form><small>Acceso personal · conexión cifrada</small></main></body></html>`;
}
function clientAddress(req) {
  const forwarded = isRender ? req.headers['cf-connecting-ip'] : null;
  const candidate = typeof forwarded === 'string' ? forwarded.trim() : req.socket.remoteAddress || '';
  return isIP(candidate) ? candidate : req.socket.remoteAddress || 'unknown';
}
function activeLoginLock(req) {
  const record = loginAttempts.get(clientAddress(req));
  if (!record || record.lockedUntil <= Date.now()) return 0;
  return record.lockedUntil - Date.now();
}
function recordFailedLogin(req) {
  const address = clientAddress(req), now = Date.now(), previous = loginAttempts.get(address);
  const record = previous && previous.windowEndsAt > now ? previous : { failures: 0, windowEndsAt: now + 15 * 60 * 1000, lockedUntil: 0 };
  record.failures += 1;
  if (record.failures >= 5) record.lockedUntil = now + 15 * 60 * 1000;
  loginAttempts.set(address, record);
  return record.lockedUntil > now ? record.lockedUntil - now : 0;
}
async function readForm(req, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Form too large'), { status: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
function renderLoginResponse(res, csrf, invalid = false, status = 200) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'set-cookie': cookieHeader(csrfCookieName, csrf, 600),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(loginHtml(csrf, invalid));
}
function pruneAuthState() {
  const now = Date.now();
  for (const [sessionId, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(sessionId);
  for (const [address, record] of loginAttempts) if (record.windowEndsAt <= now && record.lockedUntil <= now) loginAttempts.delete(address);
}
const authCleanupTimer = setInterval(pruneAuthState, 60 * 60 * 1000);
authCleanupTimer.unref();

function send(client, payload) { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload)); }
function broadcast(payload) { for (const client of clients) send(client, payload); }
function setSource(source, status, label = status) {
  sourceState[source] = { status, label };
  broadcast({ type: 'status', source, status, label });
}
function publishTick(data) { marketState[data.symbol] = data; broadcast({ type: 'tick', data }); }
async function loadSymbolCatalog() {
  if (symbolCatalogExpiresAt > Date.now()) return symbolCatalog;
  const requests = [fetch('https://api.binance.com/api/v3/exchangeInfo', { signal: AbortSignal.timeout(15000) })];
  if (stocksConfigured) {
    const endpoint = new URL('https://paper-api.alpaca.markets/v2/assets');
    endpoint.search = new URLSearchParams({ status: 'active', asset_class: 'us_equity' });
    requests.push(fetch(endpoint, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, signal: AbortSignal.timeout(15000) }));
  }
  const [cryptoResponse, stockResponse] = await Promise.all(requests);
  if (!cryptoResponse.ok) throw Object.assign(new Error('Binance no pudo cargar el catálogo de criptomonedas.'), { status: 502 });
  const exchangeInfo = await cryptoResponse.json();
  const crypto = (exchangeInfo.symbols || []).filter(asset => asset.status === 'TRADING' && asset.isSpotTradingAllowed !== false)
    .map(asset => ({ symbol: asset.symbol, name: asset.baseAsset + ' / ' + asset.quoteAsset, kind: 'crypto', exchange: 'Binance Spot', api: asset.symbol, baseAsset: asset.baseAsset, quoteAsset: asset.quoteAsset }));
  let stocks = symbolCatalog.stocks;
  if (stockResponse) {
    if (!stockResponse.ok) throw Object.assign(new Error('Alpaca no pudo cargar el catálogo de acciones. Revisa la conexión IEX.'), { status: 502 });
    const assets = await stockResponse.json();
    stocks = assets.filter(asset => asset.status === 'active' && asset.class === 'us_equity' && asset.exchange !== 'OTC')
      .map(asset => ({ symbol: asset.symbol, name: asset.name || asset.symbol, kind: 'stock', exchange: asset.exchange || 'Alpaca IEX', api: asset.symbol }));
  }
  symbolCatalog = { stocks, crypto };
  for (const asset of [...stocks, ...crypto]) {
    symbols.set(asset.symbol, asset);
    if (asset.kind === 'crypto') cryptoSymbols.set(asset.api, asset.symbol);
  }
  symbolCatalogExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
  return symbolCatalog;
}
async function loadSecTickerMap() {
  if (secTickerMap && secTickerMapExpiresAt > Date.now()) return secTickerMap;
  const response = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': 'NorthstarMarketResearch/1.0 (local financial research dashboard)', 'Accept-Encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw Object.assign(new Error('SEC no pudo cargar su directorio de emisores.'), { status: 502 });
  const directory = await response.json();
  secTickerMap = new Map(Object.values(directory).map(item => [String(item.ticker).toUpperCase(), String(item.cik_str).padStart(10, '0')]));
  secTickerMapExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
  return secTickerMap;
}
function currentWatchlists() {
  const stocks = new Set(defaultStockSymbols), crypto = new Set(defaultCryptoSymbols);
  for (const client of clients) {
    const asset = symbols.get(client.watchSymbol);
    if (!asset) continue;
    if (asset.kind === 'stock') stocks.add(asset.api);
    else crypto.add(asset.api);
  }
  return { stocks, crypto };
}
function syncMarketSubscriptions() {
  const watchlists = currentWatchlists();
  if (binanceSocket?.readyState === WebSocket.OPEN) {
    const next = new Set([...watchlists.crypto].map(symbol => symbol.toLowerCase() + '@ticker'));
    const subscribe = [...next].filter(stream => !activeBinanceSubscriptions.has(stream));
    const unsubscribe = [...activeBinanceSubscriptions].filter(stream => !next.has(stream));
    if (subscribe.length) binanceSocket.send(JSON.stringify({ method: 'SUBSCRIBE', params: subscribe, id: nextBinanceRequestId++ }));
    if (unsubscribe.length) binanceSocket.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: unsubscribe, id: nextBinanceRequestId++ }));
    activeBinanceSubscriptions.clear(); next.forEach(stream => activeBinanceSubscriptions.add(stream));
  }
  if (alpacaAuthenticated && alpacaSocket?.readyState === WebSocket.OPEN) {
    const next = watchlists.stocks;
    const subscribe = [...next].filter(symbol => !activeAlpacaSubscriptions.has(symbol));
    const unsubscribe = [...activeAlpacaSubscriptions].filter(symbol => !next.has(symbol));
    if (subscribe.length) alpacaSocket.send(JSON.stringify({ action: 'subscribe', trades: subscribe }));
    if (unsubscribe.length) alpacaSocket.send(JSON.stringify({ action: 'unsubscribe', trades: unsubscribe }));
    activeAlpacaSubscriptions.clear(); next.forEach(symbol => activeAlpacaSubscriptions.add(symbol));
  }
}
async function primeMarketSnapshot(asset) {
  try {
    if (asset.kind === 'crypto') {
      const endpoint = new URL('https://api.binance.com/api/v3/ticker/24hr'); endpoint.search = new URLSearchParams({ symbol: asset.api });
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) }); if (!response.ok) return;
      const ticker = await response.json();
      publishTick({ symbol: asset.symbol, price: Number(ticker.lastPrice), change24h: Number(ticker.priceChangePercent), open: Number(ticker.openPrice), volume: Number(ticker.volume), timestamp: Number(ticker.closeTime) || Date.now(), source: 'Binance Spot' });
    } else {
      await updateStockSnapshots([asset.api]);
    }
  } catch {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname === '/login' && authEnabled) {
    if (req.method === 'GET') {
      const csrf = randomBytes(24).toString('base64url');
      renderLoginResponse(res, csrf);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
      res.end('Method not allowed');
      return;
    }
    const blockedFor = activeLoginLock(req);
    if (blockedFor > 0) {
      const csrf = randomBytes(24).toString('base64url');
      res.setHeader('retry-after', String(Math.ceil(blockedFor / 1000)));
      renderLoginResponse(res, csrf, true, 429);
      return;
    }
    try {
      const form = await readForm(req);
      const cookies = requestCookies(req);
      const csrf = form.get('csrf') || '';
      if (!csrf || !cookies[csrfCookieName] || !constantTimeEqual(csrf, cookies[csrfCookieName])) {
        res.writeHead(403, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
        res.end('Vuelve a cargar la pantalla de inicio de sesión.');
        return;
      }
      if (!constantTimeEqual(form.get('password') || '', dashboardPassword)) {
        const retryIn = recordFailedLogin(req);
        const freshCsrf = randomBytes(24).toString('base64url');
        if (retryIn > 0) res.setHeader('retry-after', String(Math.ceil(retryIn / 1000)));
        renderLoginResponse(res, freshCsrf, true, retryIn > 0 ? 429 : 200);
        return;
      }
      loginAttempts.delete(clientAddress(req));
      const sessionId = randomBytes(32).toString('base64url');
      sessions.set(sessionId, Date.now() + sessionLifetimeMs);
      res.writeHead(303, {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': [cookieHeader(sessionCookieName, sessionId, sessionLifetimeMs / 1000), `${csrfCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isProduction ? '; Secure' : ''}`],
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      });
      res.end();
    } catch (error) {
      const csrf = randomBytes(24).toString('base64url');
      renderLoginResponse(res, csrf, true, error.status || 400);
    }
    return;
  }
  if (url.pathname === '/login' && !authEnabled) {
    res.writeHead(404, { 'cache-control': 'no-store' });
    res.end('Not found');
    return;
  }
  if (!hasActiveSession(req)) {
    res.writeHead(303, { location: '/login', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end();
    return;
  }
  res.setHeader('x-content-type-options', 'nosniff');
  if (url.pathname === '/api/symbols') {
    try {
      const query = (url.searchParams.get('q') || '').trim().toUpperCase();
      if (!query) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ results: [] })); return; }
      const catalog = await loadSymbolCatalog();
      const normalized = query.replace(/[\s/._-]/g, '');
      const cryptoBaseQuery = normalized.endsWith('USD') ? normalized.slice(0, -3) : normalized;
      const results = [...catalog.stocks, ...catalog.crypto].map(asset => {
        const ticker = asset.symbol.toUpperCase().replace(/[\s/._-]/g, ''), name = asset.name.toUpperCase();
        let rank = ticker === normalized ? 0 : ticker.startsWith(normalized) ? 1 : name.startsWith(query) ? 2 : ticker.includes(normalized) || name.includes(query) ? 4 : 99;
        if (asset.kind === 'crypto' && cryptoBaseQuery && asset.baseAsset.startsWith(cryptoBaseQuery)) rank = Math.min(rank, 3);
        return { asset, rank };
      }).filter(item => item.rank < 99).sort((a, b) => a.rank - b.rank || a.asset.symbol.localeCompare(b.asset.symbol)).slice(0, 40).map(item => item.asset);
      for (const asset of results) symbols.set(asset.symbol, asset);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ results, totalMatchedAtLeast: results.length }));
    } catch (error) {
      res.writeHead(error.status || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error.message || 'No se pudo cargar el catálogo de activos.' }));
    }
    return;
  }
  if (url.pathname === '/api/fundamentals') {
    try {
      const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
      const knownAsset = symbols.get(symbol);
      if (knownAsset && knownAsset.kind !== 'stock') throw Object.assign(new Error('Los fundamentales SEC solo aplican a acciones.'), { status: 400 });
      let cik = secCompanies[symbol];
      if (!cik) cik = (await loadSecTickerMap()).get(symbol);
      if (!cik) throw Object.assign(new Error('La SEC no encontró un emisor con este símbolo.'), { status: 404 });
      const cached = secFactsCache.get(symbol);
      if (cached && cached.expiresAt > Date.now()) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(cached.value)); return;
      }
      const response = await fetch('https://data.sec.gov/api/xbrl/companyfacts/CIK' + cik + '.json', {
        headers: { 'User-Agent': 'NorthstarMarketResearch/1.0 (local financial research dashboard)', 'Accept-Encoding': 'gzip, deflate' },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw Object.assign(new Error('SEC respondió HTTP ' + response.status + '. Intenta más tarde.'), { status: 502 });
      const company = await response.json(), sourceFacts = company.facts?.['us-gaap'] || {}, deiFacts = company.facts?.dei || {};
      const facts = {};
      for (const tag of secTags) {
        const entry = sourceFacts[tag]; if (!entry) continue;
        facts[tag] = { label: entry.label || tag, units: {} };
        for (const [unit, rows] of Object.entries(entry.units || {})) {
          facts[tag].units[unit] = rows.filter(row => ['10-K','10-Q','20-F','40-F'].includes(row.form)).slice(-40);
        }
      }
      for (const tag of secDeiTags) {
        const entry = deiFacts[tag]; if (!entry) continue;
        facts[tag] = { label: entry.label || tag, units: {} };
        for (const [unit, rows] of Object.entries(entry.units || {})) facts[tag].units[unit] = rows.filter(row => ['10-K','10-Q','20-F','40-F'].includes(row.form)).slice(-40);
      }
      const value = { symbol, cik, entityName: company.entityName, facts, source: 'SEC CompanyFacts', retrievedAt: Date.now() };
      secFactsCache.set(symbol, { value, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(error.status || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error.message || 'No se pudieron cargar los fundamentales SEC.' }));
    }
    return;
  }
  if (url.pathname === '/api/analyst-movements') {
    try {
      const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
      const days = Math.min(365, Math.max(30, Number(url.searchParams.get('days') || 90)));
      if (!/^[A-Z0-9.-]{1,15}$/.test(symbol)) throw Object.assign(new Error('Símbolo no válido.'), { status: 400 });
      const knownAsset = symbols.get(symbol);
      if (knownAsset && knownAsset.kind !== 'stock') throw Object.assign(new Error('Los movimientos de analistas aplican a acciones, no a pares cripto.'), { status: 400 });
      if (!fmpKey) throw Object.assign(new Error('La fuente gratuita configurada no proporciona movimientos individuales de analistas; no hay filas verificables que mostrar.'), { status: 503 });
      const cacheKey = symbol + ':' + days;
      const cached = analystMovementsCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(cached.value)); return;
      }
      const fetchFmpList = async route => {
        const endpoint = new URL('https://financialmodelingprep.com/stable/' + route);
        endpoint.search = new URLSearchParams({ symbol, page: '0', limit: '100', apikey: fmpKey });
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403 ? 'FMP rechazó la clave o el acceso a este símbolo.' : 'FMP respondió HTTP ' + response.status + '.'), { status: 502 });
        const payload = await response.json();
        if (!Array.isArray(payload)) throw Object.assign(new Error(payload['Error Message'] || payload.message || 'FMP no devolvió una lista de movimientos.'), { status: 502 });
        return payload;
      };
      const [targetNews, grades] = await Promise.all([fetchFmpList('price-target-news'), fetchFmpList('grades')]);
      const cutoff = Date.now() - days * 86400000;
      const rows = targetNews.filter(row => row.symbol?.toUpperCase() === symbol && Number.isFinite(Date.parse(row.publishedDate)) && Date.parse(row.publishedDate) >= cutoff)
        .map(row => {
          const title = String(row.newsTitle || '');
          const numbers = [...title.matchAll(/(?:from|de)\s*\$?([\d,]+(?:\.\d+)?)/ig)].map(match => Number(match[1].replace(/,/g, ''))).filter(Number.isFinite);
          const action = /\b(upgrad(?:e|ed|es|ing)|rais(?:e|ed|es|ing)|lift(?:s|ed|ing)?|boost(?:s|ed|ing)?|hik(?:e|es|ed|ing)|increas(?:e|es|ed|ing))\b/i.test(title) ? 'subida'
            : /\b(downgrad(?:e|ed|es|ing)|lower(?:s|ed|ing)?|cut(?:s|ting)?|reduc(?:e|es|ed|ing)|decreas(?:e|es|ed|ing))\b/i.test(title) ? 'bajada'
            : /\b(initiat(?:e|ed|es|ing)|launch(?:es|ed|ing)?|resum(?:e|ed|es|ing))\b/i.test(title) ? 'inicio'
            : /\b(reiterat(?:e|ed|es|ing)|maintain(?:s|ed|ing)?|affirm(?:s|ed|ing)?|reaffirm(?:s|ed|ing)?)\b/i.test(title) ? 'reitera'
            : 'actualización';
          const ratingMatch = title.match(/\b(?:to|at)\s+(strong\s+buy|strong\s+sell|market\s+outperform|market\s+perform|equal[- ]weight|overweight|underweight|outperform|underperform|buy|hold|neutral|sell)\b/i);
          const priceTarget = Number(row.priceTarget);
          const priceWhenPosted = Number(row.priceWhenPosted);
          return {
            date: row.publishedDate,
            action,
            firm: row.analystCompany || row.analystName || row.newsPublisher || 'No indicada',
            rating: ratingMatch?.[1] || null,
            previousTarget: numbers[0] || null,
            target: Number.isFinite(priceTarget) && priceTarget > 0 ? priceTarget : null,
            priceWhenPosted: Number.isFinite(priceWhenPosted) && priceWhenPosted > 0 ? priceWhenPosted : null,
            title,
            url: typeof row.newsURL === 'string' && row.newsURL.startsWith('https://') ? row.newsURL : null,
            publisher: row.newsPublisher || 'FMP'
          };
        });
      const firmKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const gradeRows = grades.filter(row => row.symbol?.toUpperCase() === symbol && Number.isFinite(Date.parse(row.date)) && Date.parse(row.date) >= cutoff);
      for (const grade of gradeRows) {
        const firm = grade.gradingCompany || 'No indicada', key = firmKey(firm), date = String(grade.date).slice(0, 10);
        const matchingTarget = rows.find(row => String(row.date).slice(0, 10) === date && firmKey(row.firm) === key);
        const gradeAction = String(grade.action || '').toLowerCase();
        const normalizedAction = /upgrad/.test(gradeAction) ? 'subida' : /downgrad/.test(gradeAction) ? 'bajada' : /initiat|resum/.test(gradeAction) ? 'inicio' : /maintain|reiterat|hold/.test(gradeAction) ? 'reitera' : null;
        if (matchingTarget) {
          matchingTarget.rating = grade.newGrade || matchingTarget.rating;
          if (normalizedAction) matchingTarget.action = normalizedAction;
          if (!matchingTarget.title && grade.previousGrade) matchingTarget.title = grade.previousGrade + ' → ' + grade.newGrade;
        } else {
          rows.push({ date: grade.date, action: normalizedAction || 'actualización', firm, rating: grade.newGrade || null, previousTarget: null, target: null, priceWhenPosted: null, title: [grade.previousGrade, grade.newGrade].filter(Boolean).join(' → '), url: null, publisher: 'Financial Modeling Prep · Stock Grades' });
        }
      }
      rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      const value = { symbol, days, source: 'Financial Modeling Prep · Price Target News + Stock Grades', retrievedAt: Date.now(), rows };
      analystMovementsCache.set(cacheKey, { value, expiresAt: Date.now() + 2 * 60 * 60 * 1000 });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(error.status || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error.message || 'No se pudieron cargar los movimientos de analistas.' }));
    }
    return;
  }
  if (url.pathname === '/api/analyst-consensus') {
    try {
      const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
      if (!/^[A-Z0-9.-]{1,15}$/.test(symbol)) throw Object.assign(new Error('Símbolo no válido.'), { status: 400 });
      const knownAsset = symbols.get(symbol);
      if (knownAsset && knownAsset.kind !== 'stock') throw Object.assign(new Error('El consenso de analistas aplica a acciones, no a pares cripto.'), { status: 400 });
      if (!finnhubKey) throw Object.assign(new Error('Configura FINNHUB_API_KEY como variable privada del servidor para consultar tendencias mensuales de recomendaciones.'), { status: 503 });
      const cached = analystConsensusCache.get(symbol);
      if (cached && cached.expiresAt > Date.now()) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(cached.value)); return;
      }
      const endpoint = new URL('https://finnhub.io/api/v1/stock/recommendation');
      endpoint.search = new URLSearchParams({ symbol });
      const response = await fetch(endpoint, { headers: { 'X-Finnhub-Token': finnhubKey }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403 ? 'Finnhub rechazó la clave o el acceso al endpoint.' : 'Finnhub respondió HTTP ' + response.status + '.'), { status: 502 });
      const payload = await response.json();
      if (!Array.isArray(payload)) throw Object.assign(new Error('Finnhub no devolvió una lista de tendencias.'), { status: 502 });
      const trends = payload.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.period || '')).map(row => ({
        period: row.period,
        strongBuy: Math.max(0, Number(row.strongBuy) || 0),
        buy: Math.max(0, Number(row.buy) || 0),
        hold: Math.max(0, Number(row.hold) || 0),
        sell: Math.max(0, Number(row.sell) || 0),
        strongSell: Math.max(0, Number(row.strongSell) || 0)
      })).sort((a, b) => b.period.localeCompare(a.period)).slice(0, 12);
      const value = { symbol, source: 'Finnhub · Recommendation Trends', retrievedAt: Date.now(), trends };
      analystConsensusCache.set(symbol, { value, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(error.status || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error.message || 'No se pudo cargar el consenso de analistas.' }));
    }
    return;
  }
  if (url.pathname === '/api/daily-bars') {
    try {
      const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
      if (!/^[A-Z0-9.-]{1,15}$/.test(symbol)) throw Object.assign(new Error('Símbolo no válido.'), { status: 400 });
      let item = symbols.get(symbol);
      if (!item) { await loadSymbolCatalog(); item = symbols.get(symbol); }
      if (!item) throw Object.assign(new Error('Símbolo no soportado.'), { status: 404 });
      const cached = dailyBarsCache.get(symbol);
      if (cached && cached.expiresAt > Date.now()) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(cached.value)); return;
      }
      const startMs = Date.now() - Math.round(5 * 365.25 * 86400000);
      let bars = [], source;
      if (item.kind === 'crypto') {
        let cursor = startMs, guard = 0;
        while (cursor < Date.now() && guard++ < 3) {
          const endpoint = new URL('https://api.binance.com/api/v3/klines');
          endpoint.search = new URLSearchParams({ symbol: item.api, interval: '1d', limit: '1000', startTime: String(cursor), endTime: String(Date.now()) });
          const response = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw Object.assign(new Error('Binance respondió HTTP ' + response.status + ' al consultar historial diario.'), { status: 502 });
          const rows = await response.json();
          if (!rows.length) break;
          bars.push(...rows.map(row => ({ time: Math.floor(row[0] / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) })));
          const next = Number(rows.at(-1)[0]) + 86400000;
          if (next <= cursor || rows.length < 1000) break;
          cursor = next;
        }
        source = 'Binance Spot';
      } else {
        if (!stocksConfigured) throw Object.assign(new Error('Las acciones requieren las claves de Alpaca IEX en las variables privadas del servidor.'), { status: 503 });
        const endpoint = new URL('https://data.alpaca.markets/v2/stocks/' + item.api + '/bars');
        endpoint.search = new URLSearchParams({ timeframe: '1Day', limit: '2000', feed: 'iex', adjustment: 'split', sort: 'asc', start: new Date(startMs).toISOString() });
        const response = await fetch(endpoint, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw Object.assign(new Error('Alpaca respondió HTTP ' + response.status + ' al consultar historial diario IEX.'), { status: 502 });
        const result = await response.json();
        bars = (result.bars || []).map(row => ({ time: Math.floor(Date.parse(row.t) / 1000), open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume: Number(row.v) }));
        source = 'Alpaca IEX';
      }
      bars = bars.filter(bar => bar.time * 1000 >= startMs).sort((a, b) => a.time - b.time);
      const value = { symbol, interval: '1d', period: '5y', source, retrievedAt: Date.now(), bars };
      dailyBarsCache.set(symbol, { value, expiresAt: Date.now() + 15 * 60 * 1000 });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(error.status || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error.message || 'No se pudieron cargar las velas diarias.' }));
    }
    return;
  }
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ sources: sourceState, connectedClients: clients.size }));
    return;
  }
  if (url.pathname === '/api/quote') {
    const symbol = url.searchParams.get('symbol') || '';
    const quote = marketState[symbol] || null;
    res.writeHead(quote ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ quote })); return;
  }
  if (url.pathname === '/api/bars') {
    try {
      const symbol = url.searchParams.get('symbol') || '';
      const interval = url.searchParams.get('interval') || '1h';
      let item = symbols.get(symbol);
      if (!item) { await loadSymbolCatalog(); item = symbols.get(symbol); }
      if (!item) throw Object.assign(new Error('Símbolo no soportado.'), { status: 400 });
      if (!['1m', '5m', '1h', '1d'].includes(interval)) throw Object.assign(new Error('Intervalo no soportado.'), { status: 400 });
      let bars, source;
      if (item.kind === 'crypto') {
        const endpoint = new URL('https://api.binance.com/api/v3/klines');
        endpoint.search = new URLSearchParams({ symbol: item.api, interval, limit: '200' });
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error('Binance respondió HTTP ' + response.status + '.');
        const rows = await response.json();
        bars = rows.map(row => ({ time: Math.floor(row[0] / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }));
        source = 'Binance Spot';
      } else {
        if (!stocksConfigured) throw Object.assign(new Error('Acciones requieren APCA_API_KEY_ID y APCA_API_SECRET_KEY en las variables privadas del servidor.'), { status: 503 });
        const timeframe = { '1m': '1Min', '5m': '5Min', '1h': '1Hour', '1d': '1Day' }[interval];
        const endpoint = new URL('https://data.alpaca.markets/v2/stocks/' + item.api + '/bars');
        const lookbackDays = { '1m': 2, '5m': 14, '1h': 60, '1d': 500 }[interval];
        endpoint.search = new URLSearchParams({ timeframe, limit: '200', feed: 'iex', sort: 'desc', start: new Date(Date.now() - lookbackDays * 86400000).toISOString() });
        const response = await fetch(endpoint, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error('Alpaca respondió HTTP ' + response.status + '. Revisa las claves y permisos de datos IEX.');
        const result = await response.json();
        bars = (result.bars || []).map(row => ({ time: Math.floor(Date.parse(row.t) / 1000), open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume: Number(row.v) })).reverse();
        source = 'Alpaca IEX';
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ symbol, interval, source, bars }));
    } catch (error) {
      res.writeHead(error.status || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error.message || 'No se pudieron obtener las velas.' }));
    }
    return;
  }
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  if (!['index.html', 'styles.css', 'app.js', 'research.js'].includes(requested)) { res.writeHead(404); res.end('Not found'); return; }
  const filename = path.resolve(root, requested);
  if (!filename.startsWith(root + path.sep) || requested.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile()) throw new Error('Not a file');
    const extension = path.extname(filename).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
    res.writeHead(200, { 'content-type': types[extension] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(filename).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
  if (!hasActiveSession(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client));
});
wss.on('connection', client => {
  clients.add(client);
  client.watchSymbol = 'BTCUSDT';
  send(client, { type: 'snapshot', sources: sourceState, markets: marketState });
  syncMarketSubscriptions();
  client.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'watch') return;
      const symbol = String(message.symbol || '').toUpperCase(), asset = symbols.get(symbol);
      if (!asset) { send(client, { type: 'watch-error', message: 'Elige un símbolo de las sugerencias.' }); return; }
      client.watchSymbol = symbol;
      syncMarketSubscriptions();
      primeMarketSnapshot(asset);
    } catch {}
  });
  client.on('close', () => { clients.delete(client); syncMarketSubscriptions(); });
});

function connectBinance() {
  const upstream = new WebSocket('wss://stream.binance.com:9443/ws'); binanceSocket = upstream;
  upstream.on('open', () => { setSource('crypto', 'connected', 'En vivo'); syncMarketSubscriptions(); });
  upstream.on('message', raw => {
    try {
      const ticker = JSON.parse(raw.toString()), symbol = cryptoSymbols.get(ticker.s);
      if (!symbol) return;
      publishTick({ symbol, price: Number(ticker.c), change24h: Number(ticker.P), open: Number(ticker.o), volume: Number(ticker.v), timestamp: Number(ticker.E) || Date.now(), source: 'Binance Spot' });
    } catch {}
  });
  upstream.on('close', () => { if (binanceSocket === upstream) binanceSocket = null; activeBinanceSubscriptions.clear(); setSource('crypto', 'disconnected', 'Reconectando'); setTimeout(connectBinance, 2500); });
  upstream.on('error', () => { try { upstream.close(); } catch {} });
}

let stockSnapshotTimer;
async function updateStockSnapshots(requestedSymbols = [...currentWatchlists().stocks]) {
  if (!stocksConfigured) return;
  try {
    const endpoint = new URL('https://data.alpaca.markets/v2/stocks/snapshots');
    const stockSymbols = [...new Set(requestedSymbols)];
    if (!stockSymbols.length) return;
    endpoint.search = new URLSearchParams({ symbols: stockSymbols.join(','), feed: 'iex' });
    const response = await fetch(endpoint, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('Alpaca HTTP ' + response.status);
    const snapshots = await response.json();
    for (const symbol of stockSymbols) {
      const snapshot = snapshots[symbol], trade = snapshot?.latestTrade, previousClose = Number(snapshot?.prevDailyBar?.c);
      if (!trade?.p) continue;
      publishTick({ symbol, price: Number(trade.p), change24h: previousClose ? (Number(trade.p) / previousClose - 1) * 100 : null, open: Number(snapshot?.dailyBar?.o) || null, volume: Number(snapshot?.dailyBar?.v) || 0, timestamp: Date.parse(trade.t) || Date.now(), source: 'Alpaca IEX' });
    }
  } catch (error) { setSource('stocks', 'error', 'Error de conexión IEX'); console.error('Alpaca snapshot:', error.message); }
}
function connectAlpaca() {
  if (!stocksConfigured) { setSource('stocks', 'missing', 'Falta configurar'); return; }
  const upstream = new WebSocket('wss://stream.data.alpaca.markets/v2/iex'); alpacaSocket = upstream;
  upstream.on('open', () => { setSource('stocks', 'authenticating', 'Autenticando IEX'); upstream.send(JSON.stringify({ action: 'auth', key, secret })); });
  upstream.on('message', raw => {
    try {
      const messages = JSON.parse(raw.toString());
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (message.T === 'success' && message.msg === 'authenticated') {
          setSource('stocks', 'connected', 'En vivo · IEX');
          alpacaAuthenticated = true; activeAlpacaSubscriptions.clear(); syncMarketSubscriptions();
          updateStockSnapshots(); clearInterval(stockSnapshotTimer); stockSnapshotTimer = setInterval(updateStockSnapshots, 60000);
        } else if (message.T === 't' && activeAlpacaSubscriptions.has(message.S)) {
          const previous = marketState[message.S];
          publishTick({ symbol: message.S, price: Number(message.p), change24h: previous?.change24h ?? null, open: previous?.open ?? null, volume: previous?.volume ?? 0, timestamp: Date.parse(message.t) || Date.now(), source: 'Alpaca IEX' });
        } else if (message.T === 'error') { setSource('stocks', 'error', 'Revisa las claves IEX'); console.error('Alpaca stream:', message.msg); }
      }
    } catch {}
  });
  upstream.on('close', () => { if (alpacaSocket === upstream) alpacaSocket = null; alpacaAuthenticated = false; activeAlpacaSubscriptions.clear(); clearInterval(stockSnapshotTimer); setSource('stocks', 'disconnected', 'Reconectando IEX'); setTimeout(connectAlpaca, 5000); });
  upstream.on('error', () => { try { upstream.close(); } catch {} });
}

server.listen(port, host, () => {
  console.log('Northstar Market Research at http://' + host + ':' + port);
  console.log('Binance Spot: public crypto market data; Alpaca IEX: ' + (stocksConfigured ? 'credentials configured on server' : 'waiting for server API keys'));
  connectBinance(); connectAlpaca();
});
