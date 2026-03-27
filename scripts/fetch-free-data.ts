/**
 * Free Data Source Discovery & Test Script
 *
 * Tests every free data source we can find for:
 * 1. Token unlocks / emissions
 * 2. BTC options / max pain
 * 3. Bitcoin on-chain metrics (MVRV, SOPR, exchange netflow)
 * 4. Crypto liquidation history
 * 5. Google Trends (crypto)
 * 6. Social sentiment (Reddit, Fear & Greed)
 *
 * Run: npx tsx scripts/fetch-free-data.ts
 */

import fs from 'fs';

const TIMEOUT = 15_000;
const RESULTS_DIR = '/tmp/free-data-samples';

// Ensure output dir exists
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

interface TestResult {
  source: string;
  category: string;
  url: string;
  status: 'OK' | 'FAIL' | 'PARTIAL';
  httpStatus?: number;
  dataPoints?: number;
  historyRange?: string;
  sampleFile?: string;
  notes: string;
  rating?: string; // 1-5 stars as text
  signalPotential?: string;
  error?: string;
}

const results: TestResult[] = [];

async function fetchJSON(url: string, options?: RequestInit): Promise<{ data: any; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const resp = await fetch(url, { signal: controller.signal, ...options });
    const text = await resp.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { data, status: resp.status };
  } finally {
    clearTimeout(timer);
  }
}

function saveSample(name: string, data: any): string {
  const path = `${RESULTS_DIR}/${name}.json`;
  fs.writeFileSync(path, JSON.stringify(data, null, 2).slice(0, 500_000)); // cap at 500KB
  return path;
}

function hr(title: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

// ============================================================================
// 1. TOKEN UNLOCKS / EMISSIONS
// ============================================================================

async function testDefiLlamaUnlocks() {
  // DefiLlama unlocks is behind pro-api ($300/mo), but let's try the free API anyway
  const urls = [
    'https://api.llama.fi/protocols', // free - list all protocols
    'https://api.llama.fi/protocol/optimism', // free - single protocol TVL data
  ];

  // Test if unlocks endpoint exists on free tier
  try {
    const { data, status } = await fetchJSON('https://api.llama.fi/v2/unlocks');
    results.push({
      source: 'DefiLlama Unlocks (free attempt)',
      category: 'Token Unlocks',
      url: 'https://api.llama.fi/v2/unlocks',
      status: status === 200 ? 'OK' : 'FAIL',
      httpStatus: status,
      notes: status === 200 ? `Got data: ${JSON.stringify(data).slice(0, 200)}` : 'Endpoint not available on free tier (needs pro-api @ $300/mo)',
      rating: '0/5 - Paid only',
      signalPotential: 'High if accessible',
    });
  } catch (e: any) {
    results.push({
      source: 'DefiLlama Unlocks',
      category: 'Token Unlocks',
      url: 'https://api.llama.fi/v2/unlocks',
      status: 'FAIL',
      notes: 'Endpoint not available on free tier',
      error: e.message,
      rating: '0/5 - Paid only ($300/mo)',
      signalPotential: 'High if accessible',
    });
  }
}

async function testTokenomist() {
  // Tokenomist has a free tier - try without API key
  const urls = [
    'https://api.tokenomist.ai/v1/tokens',
    'https://api.tokenomist.ai/v1/unlock-events',
  ];
  for (const url of urls) {
    try {
      const { data, status } = await fetchJSON(url);
      const ok = status === 200;
      const sampleFile = ok ? saveSample('tokenomist-' + url.split('/').pop(), data) : undefined;
      results.push({
        source: `Tokenomist (${url.split('/').pop()})`,
        category: 'Token Unlocks',
        url,
        status: ok ? 'OK' : 'FAIL',
        httpStatus: status,
        dataPoints: ok && Array.isArray(data) ? data.length : undefined,
        sampleFile,
        notes: ok ? `Got ${Array.isArray(data) ? data.length : 'unknown'} items` : `HTTP ${status} - likely needs API key`,
        error: !ok ? `Status ${status}` : undefined,
        rating: ok ? '4/5' : '1/5 - Needs API key',
        signalPotential: 'High - token unlocks cause selling pressure',
      });
    } catch (e: any) {
      results.push({
        source: `Tokenomist (${url.split('/').pop()})`,
        category: 'Token Unlocks',
        url,
        status: 'FAIL',
        notes: 'Request failed',
        error: e.message,
      });
    }
  }
}

// ============================================================================
// 2. BTC OPTIONS / MAX PAIN
// ============================================================================

async function testDeribitOptions() {
  // Deribit public API - no auth needed
  const endpoints = [
    {
      name: 'Book Summary (BTC Options)',
      url: 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
    },
    {
      name: 'Instruments (BTC Options)',
      url: 'https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false',
    },
    {
      name: 'Historical Volatility',
      url: 'https://www.deribit.com/api/v2/public/get_historical_volatility?currency=BTC',
    },
    {
      name: 'Index Price',
      url: 'https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd',
    },
  ];

  for (const ep of endpoints) {
    try {
      const { data, status } = await fetchJSON(ep.url);
      const ok = status === 200 && data?.result;
      const resultData = data?.result;
      let dataPoints = 0;
      if (Array.isArray(resultData)) dataPoints = resultData.length;

      const sampleFile = ok ? saveSample(`deribit-${ep.name.replace(/[^a-zA-Z]/g, '-').toLowerCase()}`, resultData) : undefined;

      results.push({
        source: `Deribit: ${ep.name}`,
        category: 'BTC Options',
        url: ep.url,
        status: ok ? 'OK' : 'FAIL',
        httpStatus: status,
        dataPoints,
        sampleFile,
        notes: ok
          ? `Got ${dataPoints || 'single'} items. ${ep.name === 'Book Summary (BTC Options)' ? 'Can compute max pain from OI by strike' : ''}`
          : `Error: ${JSON.stringify(data?.error || data).slice(0, 200)}`,
        rating: ok ? '5/5 - Free, no auth, real-time' : '0/5',
        signalPotential: 'High - max pain is a known price magnet near expiry',
      });
    } catch (e: any) {
      results.push({
        source: `Deribit: ${ep.name}`,
        category: 'BTC Options',
        url: ep.url,
        status: 'FAIL',
        notes: 'Request failed',
        error: e.message,
      });
    }
  }
}

// ============================================================================
// 3. BITCOIN ON-CHAIN METRICS
// ============================================================================

async function testBlockchainInfo() {
  // blockchain.info / blockchain.com charts API - completely free
  const charts = [
    { name: 'market-price', desc: 'BTC Price USD' },
    { name: 'hash-rate', desc: 'Hash Rate' },
    { name: 'n-transactions', desc: 'Daily Transactions' },
    { name: 'n-unique-addresses', desc: 'Unique Addresses' },
    { name: 'estimated-transaction-volume-usd', desc: 'TX Volume USD' },
    { name: 'miners-revenue', desc: 'Miner Revenue' },
    { name: 'mempool-size', desc: 'Mempool Size' },
    { name: 'difficulty', desc: 'Mining Difficulty' },
  ];

  for (const chart of charts) {
    const url = `https://api.blockchain.info/charts/${chart.name}?timespan=1year&format=json&sampled=true`;
    try {
      const { data, status } = await fetchJSON(url);
      const ok = status === 200 && data?.values;
      const points = ok ? data.values.length : 0;
      let range = '';
      if (ok && points > 0) {
        const first = new Date(data.values[0].x * 1000).toISOString().split('T')[0];
        const last = new Date(data.values[points - 1].x * 1000).toISOString().split('T')[0];
        range = `${first} to ${last}`;
      }

      if (ok) saveSample(`blockchain-info-${chart.name}`, data);

      results.push({
        source: `Blockchain.info: ${chart.desc}`,
        category: 'On-Chain Metrics',
        url,
        status: ok ? 'OK' : 'FAIL',
        httpStatus: status,
        dataPoints: points,
        historyRange: range,
        sampleFile: ok ? `${RESULTS_DIR}/blockchain-info-${chart.name}.json` : undefined,
        notes: ok ? `${points} data points, ${range}` : `Error`,
        rating: ok ? '4/5 - Free, no auth, 1yr+ history' : '0/5',
        signalPotential: 'Medium - basic on-chain, no MVRV/SOPR',
      });
    } catch (e: any) {
      results.push({
        source: `Blockchain.info: ${chart.desc}`,
        category: 'On-Chain Metrics',
        url,
        status: 'FAIL',
        notes: 'Request failed',
        error: e.message,
      });
    }
  }
}

async function testBGeometrics() {
  // BGeometrics free Bitcoin on-chain API
  // Try the Swagger endpoint to discover APIs
  const baseUrl = 'https://bitcoin-data.com';

  // Try known endpoint patterns
  const endpoints = [
    '/v1/mvrv-z-score',
    '/v1/sopr',
    '/v1/exchange-netflow',
    '/v1/nupl',
    '/api/mvrv-z-score',
    '/api/sopr',
    '/api/v1/mvrv-z-score',
    '/api/v1/sopr',
    '/api/v1/exchange-netflow',
    '/api/metrics/mvrv-z-score',
    '/api/metrics/sopr',
  ];

  for (const ep of endpoints) {
    const url = `${baseUrl}${ep}`;
    try {
      const { data, status } = await fetchJSON(url);
      const ok = status === 200;
      if (ok) {
        const sampleFile = saveSample(`bgeometrics-${ep.replace(/\//g, '-')}`, data);
        const isArray = Array.isArray(data);
        results.push({
          source: `BGeometrics: ${ep}`,
          category: 'On-Chain Metrics',
          url,
          status: 'OK',
          httpStatus: status,
          dataPoints: isArray ? data.length : undefined,
          sampleFile,
          notes: `Got data: ${JSON.stringify(data).slice(0, 300)}`,
          rating: '5/5 - Free, on-chain data',
          signalPotential: 'Very high - MVRV/SOPR are top BTC signals',
        });
      } else {
        results.push({
          source: `BGeometrics: ${ep}`,
          category: 'On-Chain Metrics',
          url,
          status: 'FAIL',
          httpStatus: status,
          notes: `HTTP ${status}`,
        });
      }
    } catch (e: any) {
      results.push({
        source: `BGeometrics: ${ep}`,
        category: 'On-Chain Metrics',
        url,
        status: 'FAIL',
        notes: e.message?.slice(0, 200),
        error: e.message?.slice(0, 100),
      });
    }
  }

  // Also try the Swagger JSON spec to discover endpoints
  try {
    const { data, status } = await fetchJSON(`${baseUrl}/v3/api-docs`);
    if (status === 200 && data?.paths) {
      const paths = Object.keys(data.paths);
      saveSample('bgeometrics-swagger-paths', paths);
      results.push({
        source: 'BGeometrics: Swagger API Spec',
        category: 'On-Chain Metrics',
        url: `${baseUrl}/v3/api-docs`,
        status: 'OK',
        httpStatus: status,
        dataPoints: paths.length,
        sampleFile: `${RESULTS_DIR}/bgeometrics-swagger-paths.json`,
        notes: `Found ${paths.length} endpoints: ${paths.slice(0, 10).join(', ')}...`,
        rating: '5/5',
        signalPotential: 'Discovery endpoint - lists all available metrics',
      });
    }
  } catch (e: any) {
    // Swagger not at that path, try alternative
    try {
      const { data, status } = await fetchJSON(`${baseUrl}/api/v3/api-docs`);
      if (status === 200 && data?.paths) {
        const paths = Object.keys(data.paths);
        saveSample('bgeometrics-swagger-paths', paths);
        results.push({
          source: 'BGeometrics: Swagger API Spec (alt)',
          category: 'On-Chain Metrics',
          url: `${baseUrl}/api/v3/api-docs`,
          status: 'OK',
          httpStatus: status,
          dataPoints: paths.length,
          notes: `Found ${paths.length} endpoints: ${paths.slice(0, 10).join(', ')}...`,
        });
      }
    } catch {
      // ignore
    }
  }
}

async function testSantiment() {
  // Santiment GraphQL API - free tier: 1000 calls/month, 1yr history
  const query = `{
    getMetric(metric: "mvrv_usd") {
      timeseriesData(
        slug: "bitcoin"
        from: "2025-01-01T00:00:00Z"
        to: "2026-03-27T00:00:00Z"
        interval: "1d"
      ) {
        datetime
        value
      }
    }
  }`;

  try {
    const { data, status } = await fetchJSON('https://api.santiment.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    const ok = status === 200 && data?.data?.getMetric?.timeseriesData;
    const points = ok ? data.data.getMetric.timeseriesData.length : 0;

    if (ok) saveSample('santiment-mvrv', data.data.getMetric.timeseriesData);

    results.push({
      source: 'Santiment: MVRV (GraphQL)',
      category: 'On-Chain Metrics',
      url: 'https://api.santiment.net/graphql',
      status: ok ? 'OK' : status === 200 ? 'PARTIAL' : 'FAIL',
      httpStatus: status,
      dataPoints: points,
      notes: ok
        ? `${points} daily MVRV data points. Free tier: 1000 calls/mo, 1yr history`
        : `Response: ${JSON.stringify(data).slice(0, 300)}`,
      rating: ok ? '4/5 - Free tier with limits' : '2/5 - May need API key',
      signalPotential: 'Very high - MVRV is top BTC cycle indicator',
    });
  } catch (e: any) {
    results.push({
      source: 'Santiment: MVRV (GraphQL)',
      category: 'On-Chain Metrics',
      url: 'https://api.santiment.net/graphql',
      status: 'FAIL',
      notes: 'Request failed',
      error: e.message,
    });
  }

  // Try SOPR
  const soprQuery = `{
    getMetric(metric: "sopr") {
      timeseriesData(
        slug: "bitcoin"
        from: "2025-01-01T00:00:00Z"
        to: "2026-03-27T00:00:00Z"
        interval: "1d"
      ) {
        datetime
        value
      }
    }
  }`;

  try {
    const { data, status } = await fetchJSON('https://api.santiment.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: soprQuery }),
    });

    const ok = status === 200 && data?.data?.getMetric?.timeseriesData;
    const points = ok ? data.data.getMetric.timeseriesData.length : 0;

    if (ok) saveSample('santiment-sopr', data.data.getMetric.timeseriesData);

    results.push({
      source: 'Santiment: SOPR (GraphQL)',
      category: 'On-Chain Metrics',
      url: 'https://api.santiment.net/graphql',
      status: ok ? 'OK' : status === 200 ? 'PARTIAL' : 'FAIL',
      httpStatus: status,
      dataPoints: points,
      notes: ok
        ? `${points} daily SOPR data points`
        : `Response: ${JSON.stringify(data).slice(0, 300)}`,
      rating: ok ? '4/5' : '2/5',
      signalPotential: 'High - SOPR shows profit-taking behavior',
    });
  } catch (e: any) {
    results.push({
      source: 'Santiment: SOPR (GraphQL)',
      category: 'On-Chain Metrics',
      url: 'https://api.santiment.net/graphql',
      status: 'FAIL',
      notes: 'Request failed',
      error: e.message,
    });
  }

  // Try exchange flow
  const flowQuery = `{
    getMetric(metric: "exchange_outflow") {
      timeseriesData(
        slug: "bitcoin"
        from: "2025-01-01T00:00:00Z"
        to: "2026-03-27T00:00:00Z"
        interval: "1d"
      ) {
        datetime
        value
      }
    }
  }`;

  try {
    const { data, status } = await fetchJSON('https://api.santiment.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: flowQuery }),
    });

    const ok = status === 200 && data?.data?.getMetric?.timeseriesData;
    const points = ok ? data.data.getMetric.timeseriesData.length : 0;

    if (ok) saveSample('santiment-exchange-outflow', data.data.getMetric.timeseriesData);

    results.push({
      source: 'Santiment: Exchange Outflow (GraphQL)',
      category: 'On-Chain Metrics',
      url: 'https://api.santiment.net/graphql',
      status: ok ? 'OK' : status === 200 ? 'PARTIAL' : 'FAIL',
      httpStatus: status,
      dataPoints: points,
      notes: ok
        ? `${points} daily exchange outflow data points`
        : `Response: ${JSON.stringify(data).slice(0, 300)}`,
      rating: ok ? '4/5' : '2/5',
      signalPotential: 'High - exchange netflow predicts selling pressure',
    });
  } catch (e: any) {
    results.push({
      source: 'Santiment: Exchange Outflow (GraphQL)',
      category: 'On-Chain Metrics',
      url: 'https://api.santiment.net/graphql',
      status: 'FAIL',
      notes: 'Request failed',
      error: e.message,
    });
  }
}

// ============================================================================
// 4. CRYPTO LIQUIDATION HISTORY
// ============================================================================

async function testCoinglassLiquidations() {
  // CoinGlass requires API key ($29+/mo), but let's check
  const url = 'https://open-api-v3.coinglass.com/api/futures/liquidation/v2/history?symbol=BTC&timeType=all';
  try {
    const { data, status } = await fetchJSON(url);
    results.push({
      source: 'CoinGlass: Liquidation History',
      category: 'Liquidation Data',
      url,
      status: status === 200 && data?.data ? 'OK' : 'FAIL',
      httpStatus: status,
      notes: `HTTP ${status}. CoinGlass requires paid API key ($29+/mo). Response: ${JSON.stringify(data).slice(0, 200)}`,
      rating: '0/5 - Paid only',
      signalPotential: 'High if accessible',
    });
  } catch (e: any) {
    results.push({
      source: 'CoinGlass: Liquidation History',
      category: 'Liquidation Data',
      url,
      status: 'FAIL',
      notes: 'Paid API only ($29+/mo)',
      error: e.message,
      rating: '0/5 - Paid only',
    });
  }
}

async function testHyperliquidLiquidations() {
  // Hyperliquid info API - free, no auth
  // userNonFundingLedgerUpdates shows liquidations for a specific user
  // But we want market-wide liquidations

  // Try clearinghouse meta for general data
  const endpoints = [
    {
      name: 'Meta (exchange info)',
      url: 'https://api.hyperliquid.xyz/info',
      body: { type: 'meta' },
    },
    {
      name: 'All Mids (current prices)',
      url: 'https://api.hyperliquid.xyz/info',
      body: { type: 'allMids' },
    },
    {
      name: 'Funding History (BTC)',
      url: 'https://api.hyperliquid.xyz/info',
      body: { type: 'fundingHistory', coin: 'BTC', startTime: Date.now() - 7 * 86400000 },
    },
    {
      name: 'Recent Trades (BTC)',
      url: 'https://api.hyperliquid.xyz/info',
      body: { type: 'recentTrades', coin: 'BTC' },
    },
  ];

  for (const ep of endpoints) {
    try {
      const { data, status } = await fetchJSON(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ep.body),
      });

      const ok = status === 200;
      if (ok) saveSample(`hyperliquid-${ep.name.replace(/[^a-zA-Z]/g, '-').toLowerCase()}`, data);

      const dataPoints = Array.isArray(data) ? data.length : undefined;

      results.push({
        source: `Hyperliquid: ${ep.name}`,
        category: 'Liquidation Data',
        url: ep.url,
        status: ok ? 'OK' : 'FAIL',
        httpStatus: status,
        dataPoints,
        sampleFile: ok ? `${RESULTS_DIR}/hyperliquid-${ep.name.replace(/[^a-zA-Z]/g, '-').toLowerCase()}.json` : undefined,
        notes: ok
          ? `${dataPoints || 'object'} items. ${ep.name.includes('Funding') ? 'Funding rates = proxy for leverage/liquidation pressure' : ''}`
          : `Error`,
        rating: ok ? '4/5 - Free, no auth' : '0/5',
        signalPotential: ep.name.includes('Funding') ? 'High - funding rate extremes predict liquidation cascades' : 'Medium',
      });
    } catch (e: any) {
      results.push({
        source: `Hyperliquid: ${ep.name}`,
        category: 'Liquidation Data',
        url: ep.url,
        status: 'FAIL',
        notes: 'Request failed',
        error: e.message,
      });
    }
  }
}

// ============================================================================
// 5. GOOGLE TRENDS (CRYPTO)
// ============================================================================

async function testGoogleTrends() {
  // Direct scraping of Google Trends internal API
  // This mimics what pytrends does - may get blocked
  const keywords = ['bitcoin', 'crypto'];

  // Google Trends embeddable widget endpoint (public, no auth)
  // This is the URL that returns the data behind the embeddable charts
  const widgetUrl = `https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=-60&geo=US&ns=15`;

  try {
    const { data, status } = await fetchJSON(widgetUrl);
    const ok = status === 200;

    // Google returns data with a )]}' prefix, strip it
    let parsed = data;
    if (typeof data === 'string') {
      const cleaned = data.replace(/^\)\]\}',?\n?/, '');
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = data;
      }
    }

    if (ok) saveSample('google-trends-daily', parsed);

    results.push({
      source: 'Google Trends: Daily Trends',
      category: 'Google Trends',
      url: widgetUrl,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      notes: ok
        ? `Got daily trending searches. Format: ${typeof parsed === 'object' ? 'JSON object' : typeof parsed}. Can filter for crypto keywords.`
        : `HTTP ${status}`,
      rating: ok ? '3/5 - Trending topics, not keyword history' : '0/5',
      signalPotential: 'Medium - shows when crypto is trending in search',
    });
  } catch (e: any) {
    results.push({
      source: 'Google Trends: Daily Trends',
      category: 'Google Trends',
      url: widgetUrl,
      status: 'FAIL',
      notes: 'Request failed (likely IP blocked)',
      error: e.message,
    });
  }

  // Try the multiline explore endpoint
  const exploreUrl = `https://trends.google.com/trends/api/explore?hl=en-US&tz=-60&req=${encodeURIComponent(JSON.stringify({ comparisonItem: [{ keyword: 'bitcoin', geo: '', time: 'today 12-m' }], category: 0, property: '' }))}&tz=-60`;

  try {
    const { data, status } = await fetchJSON(exploreUrl);
    let parsed = data;
    if (typeof data === 'string') {
      const cleaned = data.replace(/^\)\]\}',?\n?/, '');
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = data;
      }
    }

    if (status === 200) saveSample('google-trends-explore-bitcoin', parsed);

    results.push({
      source: 'Google Trends: Explore (bitcoin)',
      category: 'Google Trends',
      url: 'trends.google.com/trends/api/explore',
      status: status === 200 ? 'OK' : 'FAIL',
      httpStatus: status,
      notes: status === 200
        ? `Got explore widget tokens. These are needed to fetch interest-over-time data.`
        : `HTTP ${status} - May need browser cookies`,
      rating: status === 200 ? '3/5 - Needs 2-step fetch' : '1/5',
      signalPotential: 'High - "bitcoin" search volume spikes = retail FOMO tops',
    });
  } catch (e: any) {
    results.push({
      source: 'Google Trends: Explore (bitcoin)',
      category: 'Google Trends',
      url: 'trends.google.com/trends/api/explore',
      status: 'FAIL',
      notes: 'Request failed',
      error: e.message,
    });
  }
}

// ============================================================================
// 6. SOCIAL SENTIMENT
// ============================================================================

async function testFearGreedIndex() {
  // Alternative.me Fear & Greed Index - completely free, no auth
  const url = 'https://api.alternative.me/fng/?limit=365&format=json';
  try {
    const { data, status } = await fetchJSON(url);
    const ok = status === 200 && data?.data;
    const points = ok ? data.data.length : 0;
    let range = '';
    if (ok && points > 0) {
      const first = new Date(Number(data.data[points - 1].timestamp) * 1000).toISOString().split('T')[0];
      const last = new Date(Number(data.data[0].timestamp) * 1000).toISOString().split('T')[0];
      range = `${first} to ${last}`;
    }

    if (ok) saveSample('fear-greed-index', data);

    results.push({
      source: 'Alternative.me: Fear & Greed Index',
      category: 'Social Sentiment',
      url,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      dataPoints: points,
      historyRange: range,
      sampleFile: ok ? `${RESULTS_DIR}/fear-greed-index.json` : undefined,
      notes: ok
        ? `${points} daily values (0=Extreme Fear, 100=Extreme Greed). Range: ${range}. Use limit=0 for ALL history.`
        : `Error`,
      rating: ok ? '5/5 - Free, no auth, full history' : '0/5',
      signalPotential: 'Very high - extreme fear = buy, extreme greed = sell. Well-known contrarian signal.',
    });
  } catch (e: any) {
    results.push({
      source: 'Alternative.me: Fear & Greed Index',
      category: 'Social Sentiment',
      url,
      status: 'FAIL',
      notes: 'Request failed',
      error: e.message,
    });
  }

  // Also try full history
  const fullUrl = 'https://api.alternative.me/fng/?limit=0&format=json';
  try {
    const { data, status } = await fetchJSON(fullUrl);
    const ok = status === 200 && data?.data;
    const points = ok ? data.data.length : 0;
    let range = '';
    if (ok && points > 0) {
      const first = new Date(Number(data.data[points - 1].timestamp) * 1000).toISOString().split('T')[0];
      const last = new Date(Number(data.data[0].timestamp) * 1000).toISOString().split('T')[0];
      range = `${first} to ${last}`;
    }

    if (ok) saveSample('fear-greed-index-full', data);

    results.push({
      source: 'Alternative.me: Fear & Greed FULL History',
      category: 'Social Sentiment',
      url: fullUrl,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      dataPoints: points,
      historyRange: range,
      sampleFile: ok ? `${RESULTS_DIR}/fear-greed-index-full.json` : undefined,
      notes: ok ? `FULL history: ${points} daily values, ${range}` : 'Error',
      rating: ok ? '5/5' : '0/5',
    });
  } catch (e: any) {
    results.push({
      source: 'Alternative.me: Fear & Greed FULL History',
      category: 'Social Sentiment',
      url: fullUrl,
      status: 'FAIL',
      error: e.message,
    });
  }
}

async function testRedditSentiment() {
  // Reddit public JSON endpoints (no auth needed, rate limited)
  const subreddits = ['cryptocurrency', 'bitcoin'];

  for (const sub of subreddits) {
    const url = `https://www.reddit.com/r/${sub}/hot.json?limit=25`;
    try {
      const { data, status } = await fetchJSON(url, {
        headers: { 'User-Agent': 'TradingBot/1.0 (research)' },
      });
      const ok = status === 200 && data?.data?.children;
      const posts = ok ? data.data.children.length : 0;

      if (ok) saveSample(`reddit-${sub}`, data.data.children.map((c: any) => ({
        title: c.data.title,
        score: c.data.score,
        num_comments: c.data.num_comments,
        created: new Date(c.data.created_utc * 1000).toISOString(),
        upvote_ratio: c.data.upvote_ratio,
      })));

      results.push({
        source: `Reddit: r/${sub} (hot posts)`,
        category: 'Social Sentiment',
        url,
        status: ok ? 'OK' : 'FAIL',
        httpStatus: status,
        dataPoints: posts,
        sampleFile: ok ? `${RESULTS_DIR}/reddit-${sub}.json` : undefined,
        notes: ok
          ? `${posts} hot posts with scores, comments, upvote ratios. Can compute sentiment from title keywords and engagement.`
          : `HTTP ${status} - May be rate limited`,
        rating: ok ? '3/5 - Free but rate limited, no historical' : '1/5',
        signalPotential: 'Medium - high engagement + extreme sentiment = contrarian signal',
      });
    } catch (e: any) {
      results.push({
        source: `Reddit: r/${sub}`,
        category: 'Social Sentiment',
        url,
        status: 'FAIL',
        notes: 'Request failed',
        error: e.message,
      });
    }
  }
}

async function testLunarCrush() {
  // LunarCrush v2 - used to be free, check current status
  const url = 'https://lunarcrush.com/api4/public/coins/list/v2';
  try {
    const { data, status } = await fetchJSON(url);
    const ok = status === 200;
    if (ok) saveSample('lunarcrush-coins', data);

    results.push({
      source: 'LunarCrush: Public Coins List',
      category: 'Social Sentiment',
      url,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      dataPoints: ok && Array.isArray(data?.data) ? data.data.length : undefined,
      notes: ok
        ? `Got coin list with social metrics. ${Array.isArray(data?.data) ? data.data.length + ' coins' : 'Data available'}`
        : `HTTP ${status} - May need API key`,
      rating: ok ? '4/5 - Social metrics included' : '1/5',
      signalPotential: 'High - social volume spikes predict price moves',
    });
  } catch (e: any) {
    results.push({
      source: 'LunarCrush',
      category: 'Social Sentiment',
      url,
      status: 'FAIL',
      notes: 'Request failed',
      error: e.message,
    });
  }
}

// ============================================================================
// BONUS: Additional free sources
// ============================================================================

async function testCoinGecko() {
  // CoinGecko free API - no auth needed
  const url = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily';
  try {
    const { data, status } = await fetchJSON(url);
    const ok = status === 200 && data?.prices;
    const points = ok ? data.prices.length : 0;
    let range = '';
    if (ok && points > 0) {
      const first = new Date(data.prices[0][0]).toISOString().split('T')[0];
      const last = new Date(data.prices[points - 1][0]).toISOString().split('T')[0];
      range = `${first} to ${last}`;
    }

    if (ok) saveSample('coingecko-btc-365d', data);

    results.push({
      source: 'CoinGecko: BTC 365d Price/Vol/MCap',
      category: 'Bonus: Price Data',
      url,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      dataPoints: points,
      historyRange: range,
      sampleFile: ok ? `${RESULTS_DIR}/coingecko-btc-365d.json` : undefined,
      notes: ok
        ? `${points} daily prices + market_caps + total_volumes. Range: ${range}. Free tier: 10-30 calls/min.`
        : `HTTP ${status} - Rate limited`,
      rating: ok ? '4/5 - Free, daily data, rate limited' : '2/5',
      signalPotential: 'Medium - price data useful for correlation analysis',
    });
  } catch (e: any) {
    results.push({
      source: 'CoinGecko: BTC 365d',
      category: 'Bonus: Price Data',
      url,
      status: 'FAIL',
      notes: 'Request failed',
      error: e.message,
    });
  }
}

async function testMempool() {
  // mempool.space - free, no auth, Bitcoin network data
  const endpoints = [
    { name: 'Difficulty Adjustment', url: 'https://mempool.space/api/v1/difficulty-adjustment' },
    { name: 'Hashrate (1m)', url: 'https://mempool.space/api/v1/mining/hashrate/1m' },
    { name: 'Fee Estimates', url: 'https://mempool.space/api/v1/fees/recommended' },
    { name: 'Mempool Stats', url: 'https://mempool.space/api/mempool' },
  ];

  for (const ep of endpoints) {
    try {
      const { data, status } = await fetchJSON(ep.url);
      const ok = status === 200;
      if (ok) saveSample(`mempool-${ep.name.replace(/[^a-zA-Z]/g, '-').toLowerCase()}`, data);

      results.push({
        source: `Mempool.space: ${ep.name}`,
        category: 'Bonus: Bitcoin Network',
        url: ep.url,
        status: ok ? 'OK' : 'FAIL',
        httpStatus: status,
        notes: ok
          ? `Got data. ${JSON.stringify(data).slice(0, 200)}`
          : `Error`,
        rating: ok ? '4/5 - Free, no auth' : '0/5',
        signalPotential: ep.name.includes('Fee') ? 'Medium - high fees = network congestion = activity' : 'Low-Medium',
      });
    } catch (e: any) {
      results.push({
        source: `Mempool.space: ${ep.name}`,
        category: 'Bonus: Bitcoin Network',
        url: ep.url,
        status: 'FAIL',
        notes: 'Request failed',
        error: e.message,
      });
    }
  }
}

async function testBinanceOI() {
  // Binance futures open interest - free, no auth
  const url = 'https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT';
  try {
    const { data, status } = await fetchJSON(url);
    const ok = status === 200 && data?.openInterest;

    results.push({
      source: 'Binance: BTC Open Interest',
      category: 'Bonus: Derivatives',
      url,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      notes: ok
        ? `Current OI: ${data.openInterest} BTC ($${(parseFloat(data.openInterest) * 87000).toLocaleString()} approx). Free, real-time.`
        : `HTTP ${status}`,
      rating: ok ? '4/5 - Free, real-time' : '0/5',
      signalPotential: 'Medium - OI divergence from price = potential reversal',
    });
  } catch (e: any) {
    results.push({
      source: 'Binance: BTC Open Interest',
      category: 'Bonus: Derivatives',
      url,
      status: 'FAIL',
      error: e.message,
    });
  }

  // Binance historical OI klines
  const histUrl = 'https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=30';
  try {
    const { data, status } = await fetchJSON(histUrl);
    const ok = status === 200 && Array.isArray(data);
    if (ok) saveSample('binance-oi-history', data);

    results.push({
      source: 'Binance: BTC OI History (30d)',
      category: 'Bonus: Derivatives',
      url: histUrl,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      dataPoints: ok ? data.length : 0,
      sampleFile: ok ? `${RESULTS_DIR}/binance-oi-history.json` : undefined,
      notes: ok
        ? `${data.length} daily OI snapshots. Free, no auth. Max 30 periods per call.`
        : `HTTP ${status}`,
      rating: ok ? '5/5 - Free historical OI' : '0/5',
      signalPotential: 'High - OI changes predict volatility',
    });
  } catch (e: any) {
    results.push({
      source: 'Binance: BTC OI History',
      category: 'Bonus: Derivatives',
      url: histUrl,
      status: 'FAIL',
      error: e.message,
    });
  }

  // Binance Long/Short ratio
  const lsUrl = 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1d&limit=30';
  try {
    const { data, status } = await fetchJSON(lsUrl);
    const ok = status === 200 && Array.isArray(data);
    if (ok) saveSample('binance-long-short-ratio', data);

    results.push({
      source: 'Binance: BTC Long/Short Ratio (30d)',
      category: 'Bonus: Derivatives',
      url: lsUrl,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      dataPoints: ok ? data.length : 0,
      sampleFile: ok ? `${RESULTS_DIR}/binance-long-short-ratio.json` : undefined,
      notes: ok
        ? `${data.length} daily long/short ratio snapshots. Free, no auth.`
        : `HTTP ${status}`,
      rating: ok ? '5/5 - Free, excellent signal' : '0/5',
      signalPotential: 'Very high - extreme L/S ratios predict liquidation cascades',
    });
  } catch (e: any) {
    results.push({
      source: 'Binance: BTC Long/Short Ratio',
      category: 'Bonus: Derivatives',
      url: lsUrl,
      status: 'FAIL',
      error: e.message,
    });
  }

  // Binance top trader L/S position ratio
  const topUrl = 'https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=1d&limit=30';
  try {
    const { data, status } = await fetchJSON(topUrl);
    const ok = status === 200 && Array.isArray(data);
    if (ok) saveSample('binance-top-trader-ls', data);

    results.push({
      source: 'Binance: Top Trader L/S Position (30d)',
      category: 'Bonus: Derivatives',
      url: topUrl,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      dataPoints: ok ? data.length : 0,
      sampleFile: ok ? `${RESULTS_DIR}/binance-top-trader-ls.json` : undefined,
      notes: ok
        ? `${data.length} daily top trader position ratios. Free, no auth.`
        : `HTTP ${status}`,
      rating: ok ? '5/5 - Free, whale behavior signal' : '0/5',
      signalPotential: 'Very high - top traders are smart money',
    });
  } catch (e: any) {
    results.push({
      source: 'Binance: Top Trader L/S',
      category: 'Bonus: Derivatives',
      url: topUrl,
      status: 'FAIL',
      error: e.message,
    });
  }

  // Binance taker buy/sell volume
  const takerUrl = 'https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1d&limit=30';
  try {
    const { data, status } = await fetchJSON(takerUrl);
    const ok = status === 200 && Array.isArray(data);
    if (ok) saveSample('binance-taker-ls-ratio', data);

    results.push({
      source: 'Binance: Taker Buy/Sell Ratio (30d)',
      category: 'Bonus: Derivatives',
      url: takerUrl,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      dataPoints: ok ? data.length : 0,
      sampleFile: ok ? `${RESULTS_DIR}/binance-taker-ls-ratio.json` : undefined,
      notes: ok
        ? `${data.length} daily taker buy/sell ratios. Free, no auth.`
        : `HTTP ${status}`,
      rating: ok ? '5/5 - Free, excellent aggressor signal' : '0/5',
      signalPotential: 'Very high - taker ratio shows aggressive buying/selling',
    });
  } catch (e: any) {
    results.push({
      source: 'Binance: Taker Buy/Sell',
      category: 'Bonus: Derivatives',
      url: takerUrl,
      status: 'FAIL',
      error: e.message,
    });
  }
}

async function testBinanceFundingRate() {
  // Binance funding rate history - free
  const url = 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=100';
  try {
    const { data, status } = await fetchJSON(url);
    const ok = status === 200 && Array.isArray(data);
    if (ok) saveSample('binance-funding-rate', data);

    let range = '';
    if (ok && data.length > 0) {
      const first = new Date(data[0].fundingTime).toISOString().split('T')[0];
      const last = new Date(data[data.length - 1].fundingTime).toISOString().split('T')[0];
      range = `${first} to ${last}`;
    }

    results.push({
      source: 'Binance: BTC Funding Rate History',
      category: 'Bonus: Derivatives',
      url,
      status: ok ? 'OK' : 'FAIL',
      httpStatus: status,
      dataPoints: ok ? data.length : 0,
      historyRange: range,
      sampleFile: ok ? `${RESULTS_DIR}/binance-funding-rate.json` : undefined,
      notes: ok
        ? `${data.length} funding rate entries (8h intervals). Range: ${range}. Extreme funding = overleveraged market.`
        : `HTTP ${status}`,
      rating: ok ? '5/5 - Free, key derivatives signal' : '0/5',
      signalPotential: 'Very high - extreme funding predicts mean reversion',
    });
  } catch (e: any) {
    results.push({
      source: 'Binance: BTC Funding Rate',
      category: 'Bonus: Derivatives',
      url,
      status: 'FAIL',
      error: e.message,
    });
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('Free Data Source Discovery & Test');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Output dir: ${RESULTS_DIR}\n`);

  // Run all tests
  hr('1. TOKEN UNLOCKS / EMISSIONS');
  console.log('Testing DefiLlama, Tokenomist...');
  await testDefiLlamaUnlocks();
  await testTokenomist();

  hr('2. BTC OPTIONS / MAX PAIN');
  console.log('Testing Deribit public API...');
  await testDeribitOptions();

  hr('3. BITCOIN ON-CHAIN METRICS');
  console.log('Testing Blockchain.info, BGeometrics, Santiment...');
  await testBlockchainInfo();
  await testBGeometrics();
  await testSantiment();

  hr('4. CRYPTO LIQUIDATION HISTORY');
  console.log('Testing CoinGlass, Hyperliquid...');
  await testCoinglassLiquidations();
  await testHyperliquidLiquidations();

  hr('5. GOOGLE TRENDS (CRYPTO)');
  console.log('Testing Google Trends direct endpoints...');
  await testGoogleTrends();

  hr('6. SOCIAL SENTIMENT');
  console.log('Testing Fear & Greed Index, Reddit, LunarCrush...');
  await testFearGreedIndex();
  await testRedditSentiment();
  await testLunarCrush();

  hr('BONUS: ADDITIONAL FREE SOURCES');
  console.log('Testing CoinGecko, Mempool.space, Binance derivatives...');
  await testCoinGecko();
  await testMempool();
  await testBinanceOI();
  await testBinanceFundingRate();

  // ========================================================================
  // SUMMARY
  // ========================================================================
  hr('SUMMARY');

  const ok = results.filter(r => r.status === 'OK');
  const partial = results.filter(r => r.status === 'PARTIAL');
  const fail = results.filter(r => r.status === 'FAIL');

  console.log(`\nTotal tests: ${results.length}`);
  console.log(`  OK:      ${ok.length}`);
  console.log(`  PARTIAL: ${partial.length}`);
  console.log(`  FAIL:    ${fail.length}`);

  // Group by category
  const categories = [...new Set(results.map(r => r.category))];

  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catOk = catResults.filter(r => r.status === 'OK');
    console.log(`\n--- ${cat} (${catOk.length}/${catResults.length} working) ---`);
    for (const r of catResults) {
      const icon = r.status === 'OK' ? '[OK]  ' : r.status === 'PARTIAL' ? '[~]   ' : '[FAIL]';
      console.log(`  ${icon} ${r.source}`);
      if (r.dataPoints) console.log(`         Data points: ${r.dataPoints}`);
      if (r.historyRange) console.log(`         History: ${r.historyRange}`);
      if (r.notes) console.log(`         ${r.notes}`);
      if (r.rating) console.log(`         Rating: ${r.rating}`);
      if (r.signalPotential) console.log(`         Signal: ${r.signalPotential}`);
      if (r.sampleFile) console.log(`         Sample: ${r.sampleFile}`);
      if (r.error) console.log(`         Error: ${r.error}`);
    }
  }

  // Top recommendations
  hr('TOP RECOMMENDATIONS FOR BACKTESTING');
  const topSources = ok
    .filter(r => r.rating && (r.rating.startsWith('5') || r.rating.startsWith('4')))
    .sort((a, b) => (b.rating || '').localeCompare(a.rating || ''));

  console.log('\nBest free data sources (rated 4-5/5 that actually work):');
  for (const r of topSources) {
    console.log(`  ${r.rating} | ${r.source} | ${r.signalPotential || ''}`);
    console.log(`    ${r.url}`);
  }

  // Save full results
  const resultsFile = `${RESULTS_DIR}/all-results.json`;
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to: ${resultsFile}`);
  console.log(`Sample data files in: ${RESULTS_DIR}/`);

  // List all sample files
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'));
  console.log(`\nSample files created (${files.length}):`);
  for (const f of files) {
    const size = fs.statSync(`${RESULTS_DIR}/${f}`).size;
    console.log(`  ${f} (${(size / 1024).toFixed(1)}KB)`);
  }
}

main().catch(console.error);
