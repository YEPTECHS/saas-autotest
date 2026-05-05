/**
 * API Stress Test — Direct HTTP Load Testing
 *
 * Phase 1 (Discovery): Login once via browser, intercept the chat API
 *   request, extract endpoint + auth headers + body format automatically.
 *
 * Phase 2 (Stress):  Fire direct fetch() requests — no browser overhead.
 *   ST-API-01  Sequential baseline   — 20 requests, one by one
 *   ST-API-02  Concurrent burst  5   — 5  simultaneous requests
 *   ST-API-03  Concurrent burst 10   — 10 simultaneous requests
 *   ST-API-04  Concurrent burst 20   — 20 simultaneous requests
 *   ST-API-05  Ramp-up            — 1 → 5 → 10 → 20 → 30, measure degradation
 *   ST-API-06  Sustained load     — 50 requests over 60 seconds
 *
 * Usage:
 *   npx tsx scripts/stress-test-api.ts --agent maya
 *   npx tsx scripts/stress-test-api.ts --agent oscar
 *   npx tsx scripts/stress-test-api.ts --agent daniel
 *   npx tsx scripts/stress-test-api.ts --agent maya --concurrency 30
 */

import { chromium, Request as PwRequest } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

// ── Config ───────────────────────────────────────────────────
const BASE_URL = process.env.YEPAI_BASE_URL || 'https://app.yepai.ai';

const AGENT_ARG =
  process.argv.find(a => a.startsWith('--agent='))?.split('=')[1] ||
  process.argv[process.argv.indexOf('--agent') + 1] ||
  'maya';

const _concurrencyIdx = process.argv.indexOf('--concurrency');
const MAX_CONCURRENCY = parseInt(
  process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ||
  (_concurrencyIdx !== -1 ? process.argv[_concurrencyIdx + 1] : '') ||
  '20'
) || 20;

const AGENT_PATHS: Record<string, string> = {
  maya: '/ai-team/marketing/chat',
  oscar: '/ai-team/operation/chat',
  daniel: '/ai-team/profit/chat',
};

const agentPath = AGENT_PATHS[AGENT_ARG];
if (!agentPath) {
  console.error(`Unknown agent: ${AGENT_ARG}. Use: maya, oscar, daniel`);
  process.exit(1);
}

// ── Test questions per agent ─────────────────────────────────
const QUESTIONS: Record<string, string[]> = {
  maya: [
    'What color scheme works best for a luxury fashion brand?',
    'How do I improve my email open rates?',
    'Suggest 3 Instagram caption ideas for a summer sale',
    'What is A/B testing and how do I use it for my ads?',
    'How do retargeting ads work?',
    'What hashtags should I use for my winter collection?',
    'Write a product description for a handmade candle',
    'How often should I post on social media?',
    'How do I build a referral program?',
    'What is influencer marketing?',
    'What makes a high-converting landing page?',
    'How do I grow my email subscriber list?',
    'What are the best times to send marketing emails?',
    'How do I create a brand voice guide?',
    'What is user-generated content and how do I leverage it?',
    'How do I measure the ROI of social media marketing?',
    'What is the difference between reach and impressions?',
    'How do I create a marketing budget for a small business?',
    'What is content marketing and why is it important?',
    'How do I write compelling ad copy?',
    'What is the ideal Facebook ad frequency?',
    'How do I segment my email list?',
    'What is a marketing funnel?',
    'How do I use customer reviews in marketing?',
    'What is social proof and how do I use it?',
    'How do I create an effective loyalty program?',
    'What is cross-selling and up-selling?',
    'How do I reduce cart abandonment?',
    'What is the best way to announce a new product?',
    'How do I run a successful flash sale?',
  ],
  oscar: [
    'What are my top 5 selling products?',
    'How many orders are pending?',
    'Show me my inventory summary',
    'What is my fulfillment rate?',
    'Which products are below safety stock?',
    'What SKUs need reordering now?',
    'How do I handle backorders?',
    'What is my average order processing time?',
    'How do I improve my inventory turnover?',
    'What quality control checks should I do?',
    'How do I calculate safety stock levels?',
    'What is a good order fulfillment rate?',
    'How do I manage returns efficiently?',
    'What is cycle counting in inventory management?',
    'How do I reduce shipping errors?',
    'What is the difference between FIFO and LIFO?',
    'How do I forecast demand for seasonal products?',
    'What is dead stock and how do I deal with it?',
    'How do I optimize my warehouse layout?',
    'What is a 3PL and when should I use one?',
    'How do I reduce my shipping costs?',
    'What is the best way to track supplier performance?',
    'How do I handle damaged goods?',
    'What is just-in-time inventory?',
    'How do I deal with supply chain disruptions?',
    'What is ABC analysis for inventory?',
    'How do I set reorder points?',
    'What is dropshipping and how does it work?',
    'How do I manage multiple warehouse locations?',
    'What metrics should I track for operations?',
  ],
  daniel: [
    'What is my gross margin percentage?',
    'What is the difference between markup and margin?',
    'How do I calculate the break-even point?',
    'What is contribution margin?',
    'What is COGS and how is it calculated?',
    'How do landed costs affect my margin?',
    'What is a loss leader strategy?',
    'What is my operating margin?',
    'How do I calculate weighted average margin?',
    'What is price elasticity?',
    'How do returns affect my margin?',
    'What is the difference between fixed and variable costs?',
    'How do I improve my net margin?',
    'What is gross profit vs net profit?',
    'How do I analyze profitability by product category?',
    'What is a good gross margin for e-commerce?',
    'How do I factor in shipping costs to calculate true margin?',
    'What is absorption costing vs variable costing?',
    'How do I set prices to hit a target margin?',
    'What is the impact of discounting on annual margin?',
    'How do I calculate margin for bundled products?',
    'What is the difference between margin and EBITDA?',
    'How do I analyze margin trends over time?',
    'What is cost-volume-profit analysis?',
    'How do I improve margins without raising prices?',
    'What is a standard cost system?',
    'How do I account for overhead in product pricing?',
    'What is marginal cost?',
    'How do I evaluate if a product is worth keeping?',
    'What is activity-based costing?',
  ],
};

// ── Types ────────────────────────────────────────────────────
interface CapturedApi {
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  bodyTemplate: Record<string, unknown>;
  isStreaming: boolean;
  cookies: string;
}

interface RequestMetric {
  question: string;
  statusCode: number;
  latencyMs: number;
  ttfbMs: number;           // time to first byte
  responseBytes: number;
  success: boolean;
  error?: string;
}

interface ScenarioResult {
  id: string;
  name: string;
  concurrency: number;
  totalRequests: number;
  successCount: number;
  failCount: number;
  successRate: number;
  latency: {
    min: number;
    avg: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
  ttfb: {
    avg: number;
    p95: number;
  };
  throughputRps: number;    // requests per second
  durationMs: number;
  status: 'PASS' | 'PARTIAL' | 'FAIL' | 'ERROR';
  metrics: RequestMetric[];
  timestamp: string;
}

// ── Load test users ──────────────────────────────────────────
interface TestUser { email: string; password: string; }
const usersData = JSON.parse(readFileSync(join(process.cwd(), 'data/test-users.json'), 'utf-8'));
const user: TestUser = usersData.users[0];

// ── Phase 1: Discover API via browser request interception ───
async function discoverApi(): Promise<CapturedApi> {
  console.log('\n── Phase 1: Discovering API endpoint ──');
  console.log('  Launching browser to intercept chat API request...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  let captured: CapturedApi | null = null;
  let listeningForChat = false;   // only capture after login is done

  // URL segments that indicate this is NOT the chat API
  const EXCLUDED = [
    '/auth/', '/login', '/register', '/logout', '/signup', '/token',
    '/refresh', '/verify', '/password', '/oauth',
  ];

  const startListening = () => {
    listeningForChat = true;
    page.on('request', (req: PwRequest) => {
      if (!listeningForChat) return;
      const url = req.url();
      const method = req.method();

      // Skip non-POST / non-GET (GET is rarely a chat API but include just in case)
      if (method !== 'POST') return;

      // Skip auth-related endpoints
      if (EXCLUDED.some(ex => url.toLowerCase().includes(ex))) return;

      const headers = req.headers();
      let bodyTemplate: Record<string, unknown> = {};
      try {
        const raw = req.postData();
        if (raw) bodyTemplate = JSON.parse(raw);
      } catch { /* not JSON */ }

      // Only capture if body looks like a chat message (has content/message/query field)
      // OR if URL matches typical chat patterns
      const hasMsgField = Object.keys(bodyTemplate).some(k =>
        ['message', 'content', 'text', 'query', 'input', 'prompt', 'userMessage', 'msg', 'messages'].includes(k)
      );
      const isChatUrl =
        url.includes('/chat') ||
        url.includes('/message') ||
        url.includes('/conversation') ||
        url.includes('/stream') ||
        url.includes('/send') ||
        url.includes('/query') ||
        url.includes('/ask') ||
        url.includes('/completions') ||
        url.includes('/v1/') ||
        url.includes('/api/');

      if (!hasMsgField && !isChatUrl) return;

      const isStreaming =
        (headers['accept'] || '').includes('text/event-stream') ||
        url.includes('stream');

      if (!captured) {
        captured = {
          endpoint: url,
          method,
          headers: { ...headers },
          bodyTemplate,
          isStreaming,
          cookies: '',
        };
        console.log(`  ✓ Captured: ${method} ${url}`);
        console.log(`  ✓ Streaming: ${isStreaming}`);
        console.log(`  ✓ Body keys: ${Object.keys(bodyTemplate).join(', ') || '(none — will inject message field)'}`);
      }
    });
  };

  try {
    // Login (do NOT start listening yet)
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    await page.fill('input[type="email"], input[name="email"]', user.email);
    await page.fill('input[type="password"], input[name="password"]', user.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard|home|ai-training|analytics|onboarding/, { timeout: 30000 });
    console.log(`  ✓ Logged in as ${user.email}`);

    // NOW start listening — after login redirect, all requests are app requests
    startListening();

    // Navigate to agent page
    await page.goto(`${BASE_URL}${agentPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Send a probe message to trigger the chat API call
    const probe = QUESTIONS[AGENT_ARG][0];
    console.log(`  → Sending probe: "${probe.substring(0, 60)}"`);

    await page.evaluate((text: string) => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement;
      if (!ta) throw new Error('No textarea found');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, text);
      else ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }, probe);

    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      const btn =
        ta.parentElement?.querySelector('button') ||
        ta.parentElement?.parentElement?.querySelector('button');
      if (btn) (btn as HTMLButtonElement).click();
    });

    // Wait up to 15s for the chat API call to fire
    let waited = 0;
    while (!captured && waited < 15000) {
      await page.waitForTimeout(500);
      waited += 500;
    }

    // Extract session cookies for auth replay
    const cookieArr = await context.cookies();
    const cookieStr = cookieArr.map(c => `${c.name}=${c.value}`).join('; ');

    const cap = captured as CapturedApi | null;
    if (cap) {
      cap.cookies = cookieStr;
      if (!cap.headers['cookie']) {
        cap.headers['cookie'] = cookieStr;
      }
    }

  } finally {
    await browser.close();
  }

  if (!captured) {
    throw new Error(
      'Could not intercept the chat API request after 15 seconds.\n' +
      'Possible causes:\n' +
      '  1. The app uses WebSocket instead of HTTP POST for chat.\n' +
      '  2. The message send button was not found.\n' +
      '  3. The API URL does not match known chat patterns.\n' +
      'Tip: Open DevTools → Network tab, send a message, and check which request carries the message body.'
    );
  }

  return captured;
}

// ── Send one request via fetch ───────────────────────────────
async function sendRequest(
  api: CapturedApi,
  question: string,
  _requestIndex: number,
): Promise<RequestMetric> {
  const start = Date.now();
  let ttfbMs = 0;
  let responseBytes = 0;
  let statusCode = 0;

  try {
    // Build body: replace the question/message field in the captured template
    const body = buildRequestBody(api.bodyTemplate, question);

    // Strip headers that would cause issues with fetch
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(api.headers)) {
      if (['content-length', 'host', 'connection', 'transfer-encoding'].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers['content-type'] = 'application/json';

    const res = await fetch(api.endpoint, {
      method: api.method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });

    statusCode = res.status;
    ttfbMs = Date.now() - start;

    // Read the full response
    if (api.isStreaming) {
      // SSE stream — read all chunks
      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          responseBytes += value.byteLength;
        }
      }
    } else {
      const text = await res.text();
      responseBytes = text.length;
    }

    const latencyMs = Date.now() - start;
    const success = statusCode >= 200 && statusCode < 300;

    return { question: question.substring(0, 60), statusCode, latencyMs, ttfbMs, responseBytes, success };

  } catch (err: any) {
    return {
      question: question.substring(0, 60),
      statusCode,
      latencyMs: Date.now() - start,
      ttfbMs,
      responseBytes: 0,
      success: false,
      error: err.message,
    };
  }
}

// ── UUID v4 generator ────────────────────────────────────────
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Build request body replacing the user message field ──────
function buildRequestBody(template: Record<string, unknown>, question: string): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;

  // Refresh unique-per-request fields to avoid server deduplication
  if ('requestId' in body)       body['requestId']       = uuidv4();
  if ('conversation_id' in body) body['conversation_id'] = uuidv4();
  if ('sessionId' in body)       body['sessionId']       = uuidv4();

  // Common field names for the user message
  const msgFields = ['message', 'content', 'text', 'query', 'input', 'prompt', 'userMessage', 'msg'];

  for (const field of msgFields) {
    if (field in body) {
      body[field] = question;
      return body;
    }
  }

  // Check nested messages array (OpenAI-style)
  if (Array.isArray(body['messages'])) {
    const msgs = body['messages'] as Array<Record<string, unknown>>;
    const last = msgs[msgs.length - 1];
    if (last && 'content' in last) {
      last['content'] = question;
      return body;
    }
    msgs.push({ role: 'user', content: question });
    return body;
  }

  // Fallback: add message field
  body['message'] = question;
  return body;
}

// ── Compute percentile ───────────────────────────────────────
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.ceil(sorted.length * p / 100) - 1] || 0;
}

// ── Build scenario result from raw metrics ───────────────────
function buildResult(
  id: string,
  name: string,
  concurrency: number,
  metrics: RequestMetric[],
  durationMs: number,
): ScenarioResult {
  const successful = metrics.filter(m => m.success);
  const latencies = successful.map(m => m.latencyMs).sort((a, b) => a - b);
  const ttfbs = successful.map(m => m.ttfbMs).sort((a, b) => a - b);
  const successRate = metrics.length ? successful.length / metrics.length : 0;
  const throughputRps = metrics.length ? Math.round((metrics.length / durationMs) * 1000 * 100) / 100 : 0;

  const latencyStats = {
    min: latencies[0] || 0,
    avg: latencies.length ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length) : 0,
    p50: pct(latencies, 50),
    p75: pct(latencies, 75),
    p90: pct(latencies, 90),
    p95: pct(latencies, 95),
    p99: pct(latencies, 99),
    max: latencies[latencies.length - 1] || 0,
  };

  const ttfbStats = {
    avg: ttfbs.length ? Math.round(ttfbs.reduce((s, l) => s + l, 0) / ttfbs.length) : 0,
    p95: pct(ttfbs, 95),
  };

  const status =
    successRate >= 0.95 ? 'PASS' :
    successRate >= 0.75 ? 'PARTIAL' :
    'FAIL';

  return {
    id, name, concurrency,
    totalRequests: metrics.length,
    successCount: successful.length,
    failCount: metrics.length - successful.length,
    successRate,
    latency: latencyStats,
    ttfb: ttfbStats,
    throughputRps,
    durationMs,
    status,
    metrics,
    timestamp: new Date().toISOString(),
  };
}

// ── Print scenario summary ────────────────────────────────────
function printResult(r: ScenarioResult) {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'PARTIAL' ? '~' : '✗';
  console.log(`  ${icon} ${r.id}: ${r.name}`);
  console.log(`     Requests : ${r.totalRequests} total, ${r.successCount} ok, ${r.failCount} failed`);
  console.log(`     Success  : ${(r.successRate * 100).toFixed(1)}%`);
  console.log(`     Latency  : avg ${r.latency.avg}ms | P50 ${r.latency.p50}ms | P95 ${r.latency.p95}ms | P99 ${r.latency.p99}ms | max ${r.latency.max}ms`);
  console.log(`     TTFB     : avg ${r.ttfb.avg}ms | P95 ${r.ttfb.p95}ms`);
  console.log(`     RPS      : ${r.throughputRps}`);
  if (r.failCount > 0) {
    const errors = r.metrics.filter(m => !m.success).slice(0, 3);
    errors.forEach(e => console.log(`     ✗ ${e.statusCode} — ${e.error || 'HTTP error'}`));
  }
}

// ─────────────────────────────────────────────────────────────
//  ST-API-01  Sequential Baseline — 20 requests, one by one
// ─────────────────────────────────────────────────────────────
async function runSequential(api: CapturedApi): Promise<ScenarioResult> {
  console.log('\n── ST-API-01: Sequential Baseline (20 requests) ──');
  const questions = QUESTIONS[AGENT_ARG].slice(0, 20);
  const metrics: RequestMetric[] = [];
  const start = Date.now();

  for (let i = 0; i < questions.length; i++) {
    const m = await sendRequest(api, questions[i], i);
    metrics.push(m);
    process.stdout.write(`  [${i + 1}/20] ${m.success ? '✓' : '✗'} ${m.latencyMs}ms\r`);
  }
  console.log();

  return buildResult('ST-API-01', 'Sequential Baseline (20 requests)', 1, metrics, Date.now() - start);
}

// ─────────────────────────────────────────────────────────────
//  Concurrent burst helper
// ─────────────────────────────────────────────────────────────
async function runConcurrent(
  api: CapturedApi,
  id: string,
  concurrency: number,
): Promise<ScenarioResult> {
  console.log(`\n── ${id}: Concurrent Burst (${concurrency} simultaneous) ──`);
  const questions = QUESTIONS[AGENT_ARG];
  const start = Date.now();

  const promises = Array.from({ length: concurrency }, (_, i) =>
    sendRequest(api, questions[i % questions.length], i)
  );

  const metrics = await Promise.all(promises);
  const durationMs = Date.now() - start;

  const ok = metrics.filter(m => m.success).length;
  console.log(`  Done: ${ok}/${concurrency} ok in ${durationMs}ms`);

  return buildResult(id, `Concurrent Burst (${concurrency} simultaneous)`, concurrency, metrics, durationMs);
}

// ─────────────────────────────────────────────────────────────
//  ST-API-05  Ramp-up: 1 → 5 → 10 → 20 → 30
// ─────────────────────────────────────────────────────────────
async function runRampUp(api: CapturedApi): Promise<ScenarioResult> {
  const levels = [1, 5, 10, 20, 30].filter(l => l <= MAX_CONCURRENCY + 10);
  console.log(`\n── ST-API-05: Ramp-Up (${levels.join(' → ')}) ──`);

  const allMetrics: RequestMetric[] = [];
  const levelStats: { level: number; avgLatency: number; successRate: number }[] = [];
  const start = Date.now();
  const questions = QUESTIONS[AGENT_ARG];

  for (const level of levels) {
    const promises = Array.from({ length: level }, (_, i) =>
      sendRequest(api, questions[i % questions.length], i)
    );
    const metrics = await Promise.all(promises);
    allMetrics.push(...metrics);

    const ok = metrics.filter(m => m.success);
    const avgLat = ok.length ? Math.round(ok.reduce((s, m) => s + m.latencyMs, 0) / ok.length) : -1;
    const sr = metrics.length ? ok.length / metrics.length : 0;
    levelStats.push({ level, avgLatency: avgLat, successRate: sr });

    console.log(`  Level ${String(level).padStart(2)}: ${ok.length}/${level} ok | avg ${avgLat}ms | ${(sr * 100).toFixed(0)}% success`);

    // 2s cooldown between levels
    await new Promise(r => setTimeout(r, 2000));
  }

  // Check for degradation: compare first level avg vs last level avg
  let degradation: string = 'N/A';
  if (levelStats.length >= 2) {
    const firstLat = levelStats[0].avgLatency;
    const lastLat = levelStats[levelStats.length - 1].avgLatency;
    degradation = firstLat > 0 ? (lastLat / firstLat).toFixed(2) + 'x' : 'N/A';
    console.log(`  Latency degradation: ${firstLat}ms → ${lastLat}ms (${degradation})`);
  }

  const maxLevel = levels.length > 0 ? Math.max(...levels) : 0;
  const result = buildResult('ST-API-05', `Ramp-Up (${levels.join('→')})`, maxLevel, allMetrics, Date.now() - start);
  (result as any).levelStats = levelStats;
  (result as any).degradationRatio = degradation;
  return result;
}

// ─────────────────────────────────────────────────────────────
//  ST-API-06  Sustained load — 50 requests over 60 seconds
// ─────────────────────────────────────────────────────────────
async function runSustained(api: CapturedApi): Promise<ScenarioResult> {
  const totalRequests = 50;
  const durationTarget = 60000; // 60 seconds
  const interval = Math.floor(durationTarget / totalRequests);
  console.log(`\n── ST-API-06: Sustained Load (${totalRequests} req over 60s, 1 every ~${interval}ms) ──`);

  const allMetrics: RequestMetric[] = [];
  const questions = QUESTIONS[AGENT_ARG];
  const start = Date.now();

  const promises: Promise<void>[] = [];
  for (let i = 0; i < totalRequests; i++) {
    const delay = i * interval;
    const p = new Promise<void>(resolve => {
      setTimeout(async () => {
        const m = await sendRequest(api, questions[i % questions.length], i);
        allMetrics.push(m);
        process.stdout.write(`  [${allMetrics.length}/${totalRequests}] ${m.success ? '✓' : '✗'} ${m.latencyMs}ms\r`);
        resolve();
      }, delay);
    });
    promises.push(p);
  }

  await Promise.all(promises);
  console.log();

  const durationMs = Date.now() - start;
  return buildResult('ST-API-06', `Sustained Load (${totalRequests} req / 60s)`, 1, allMetrics, durationMs);
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  API STRESS TEST                                         ║`);
  console.log(`║  Agent  : ${AGENT_ARG.toUpperCase().padEnd(49)}║`);
  console.log(`║  Target : ${BASE_URL.padEnd(49)}║`);
  console.log(`║  User   : ${user.email.padEnd(49)}║`);
  console.log(`║  Max concurrency : ${String(MAX_CONCURRENCY).padEnd(40)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  // ── Phase 1: Discover API ────────────────────────────────
  let api: CapturedApi;
  try {
    api = await discoverApi();
  } catch (err: any) {
    console.error(`\n✗ API Discovery failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\n── Phase 2: Running stress scenarios ──');

  const allResults: ScenarioResult[] = [];

  // ST-API-01: Sequential baseline
  allResults.push(await runSequential(api));

  // ST-API-02: 5 concurrent
  allResults.push(await runConcurrent(api, 'ST-API-02', 5));

  // ST-API-03: 10 concurrent
  allResults.push(await runConcurrent(api, 'ST-API-03', 10));

  // ST-API-04: 20 concurrent (or MAX_CONCURRENCY)
  allResults.push(await runConcurrent(api, 'ST-API-04', Math.min(20, MAX_CONCURRENCY)));

  // ST-API-05: Ramp-up
  allResults.push(await runRampUp(api));

  // ST-API-06: Sustained load
  allResults.push(await runSustained(api));

  // ── Final summary ────────────────────────────────────────
  const passed  = allResults.filter(r => r.status === 'PASS').length;
  const partial = allResults.filter(r => r.status === 'PARTIAL').length;
  const failed  = allResults.filter(r => r.status === 'FAIL').length;

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  RESULTS                                                 ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  allResults.forEach(r => printResult(r));
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  PASS: ${passed} | PARTIAL: ${partial} | FAIL: ${failed}`.padEnd(59) + '║');
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  // ── Save report ──────────────────────────────────────────
  const report = {
    testType: 'api-stress',
    agent: AGENT_ARG,
    baseUrl: BASE_URL,
    apiEndpoint: api.endpoint,
    isStreaming: api.isStreaming,
    user: user.email,
    maxConcurrency: MAX_CONCURRENCY,
    scenarios: allResults.length,
    passed, partial, failed,
    results: allResults,
    generatedAt: new Date().toISOString(),
  };

  const reportPath = join(process.cwd(), `reports/${AGENT_ARG}-api-stress-results.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved → ${reportPath}`);
}

main().catch(console.error);
