/**
 * API Advanced Stress Test
 *
 * 补充两个基础测试缺少的场景：
 *
 *   ST-ADV-01  Multi-user concurrent
 *              用 4 个不同用户各自的 session 同时发请求
 *              模拟真实多用户场景，对比单用户并发的差异
 *
 *   ST-ADV-02  Breaking Point
 *              持续加压直到系统开始大量失败
 *              找出每个 agent 的并发极限
 *
 * Usage:
 *   npx tsx scripts/stress-test-api-advanced.ts --agent maya
 *   npx tsx scripts/stress-test-api-advanced.ts --agent oscar
 *   npx tsx scripts/stress-test-api-advanced.ts --agent daniel
 */

import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

// ── Config ───────────────────────────────────────────────────
const BASE_URL = process.env.YEPAI_BASE_URL || 'https://app.yepai.ai';

const AGENT_ARG =
  process.argv.find(a => a.startsWith('--agent='))?.split('=')[1] ||
  process.argv[process.argv.indexOf('--agent') + 1] ||
  'maya';

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

// ── Test users ───────────────────────────────────────────────
interface TestUser { email: string; password: string; }
const usersData = JSON.parse(readFileSync(join(process.cwd(), 'data/test-users.json'), 'utf-8'));
const ALL_USERS: TestUser[] = usersData.users;

// ── Questions ────────────────────────────────────────────────
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
  ],
};

// ── Types ────────────────────────────────────────────────────
interface UserSession {
  user: TestUser;
  endpoint: string;
  headers: Record<string, string>;
  bodyTemplate: Record<string, unknown>;
}

interface RequestMetric {
  user: string;
  question: string;
  statusCode: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}

interface ScenarioResult {
  id: string;
  name: string;
  status: 'PASS' | 'PARTIAL' | 'FAIL';
  totalRequests: number;
  successCount: number;
  failCount: number;
  successRate: number;
  latency: { min: number; avg: number; p50: number; p95: number; p99: number; max: number };
  durationMs: number;
  details: Record<string, unknown>;
  metrics: RequestMetric[];
  timestamp: string;
}

// ── Percentile helper ────────────────────────────────────────
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.ceil(sorted.length * p / 100) - 1] || 0;
}

function latencyStats(metrics: RequestMetric[]) {
  const ok = metrics.filter(m => m.success).map(m => m.latencyMs).sort((a, b) => a - b);
  return {
    min: ok[0] || 0,
    avg: ok.length ? Math.round(ok.reduce((s, l) => s + l, 0) / ok.length) : 0,
    p50: pct(ok, 50),
    p95: pct(ok, 95),
    p99: pct(ok, 99),
    max: ok[ok.length - 1] || 0,
  };
}

// ── Login one user + capture API via browser ─────────────────
async function captureSession(user: TestUser): Promise<UserSession> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  let endpoint = '';
  let headers: Record<string, string> = {};
  let bodyTemplate: Record<string, unknown> = {};

  const EXCLUDED = ['/auth/', '/login', '/register', '/logout', '/signup', '/token', '/refresh'];

  // Start listening AFTER login
  const startListening = () => {
    page.on('request', req => {
      if (endpoint) return;           // already captured
      const url = req.url();
      if (req.method() !== 'POST') return;
      if (EXCLUDED.some(ex => url.toLowerCase().includes(ex))) return;

      const h = req.headers();
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch { /* not JSON */ }

      const hasMsgField = Object.keys(body).some(k =>
        ['message', 'content', 'text', 'query', 'input', 'prompt', 'userMessage', 'msg', 'messages'].includes(k)
      );
      const isChatUrl = url.includes('/chat') || url.includes('/message') || url.includes('/conversation') ||
        url.includes('/stream') || url.includes('/send') || url.includes('/query') ||
        url.includes('/ask') || url.includes('/completions') || url.includes('/v1/') || url.includes('/api/');

      if (!hasMsgField && !isChatUrl) return;

      endpoint = url;
      headers = { ...h };
      bodyTemplate = body;
    });
  };

  try {
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    await page.fill('input[type="email"], input[name="email"]', user.email);
    await page.fill('input[type="password"], input[name="password"]', user.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard|home|ai-training|analytics|onboarding/, { timeout: 30000 });

    startListening();

    await page.goto(`${BASE_URL}${agentPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Send probe message
    const probe = QUESTIONS[AGENT_ARG][0];
    await page.evaluate((text: string) => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement;
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, text); else ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }, probe);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      const btn = ta.parentElement?.querySelector('button') || ta.parentElement?.parentElement?.querySelector('button');
      if (btn) (btn as HTMLButtonElement).click();
    });

    // Wait up to 15s
    let waited = 0;
    while (!endpoint && waited < 15000) {
      await page.waitForTimeout(500);
      waited += 500;
    }

    // Extract cookies
    const cookieArr = await context.cookies();
    const cookieStr = cookieArr.map(c => `${c.name}=${c.value}`).join('; ');
    if (!headers['cookie']) headers['cookie'] = cookieStr;

  } finally {
    await browser.close();
  }

  if (!endpoint) throw new Error(`Could not capture API for user ${user.email}`);
  return { user, endpoint, headers, bodyTemplate };
}

// ── UUID v4 generator ────────────────────────────────────────
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Build request body ───────────────────────────────────────
// Always generates fresh requestId and conversation_id to avoid
// server-side deduplication rejecting replayed requests.
function buildBody(template: Record<string, unknown>, question: string): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;

  // Refresh unique-per-request fields
  if ('requestId' in body)       body['requestId']       = uuidv4();
  if ('conversation_id' in body) body['conversation_id'] = uuidv4();
  if ('sessionId' in body)       body['sessionId']       = uuidv4();

  // Set the message content
  const msgFields = ['message', 'content', 'text', 'query', 'input', 'prompt', 'userMessage', 'msg'];
  for (const f of msgFields) {
    if (f in body) { body[f] = question; return body; }
  }
  if (Array.isArray(body['messages'])) {
    const msgs = body['messages'] as Array<Record<string, unknown>>;
    const last = msgs[msgs.length - 1];
    if (last?.['content'] !== undefined) { last['content'] = question; return body; }
    msgs.push({ role: 'user', content: question });
    return body;
  }
  body['message'] = question;
  return body;
}

// ── Send one request ─────────────────────────────────────────
async function sendRequest(session: UserSession, question: string): Promise<RequestMetric> {
  const start = Date.now();
  let statusCode = 0;
  try {
    const cleanHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(session.headers)) {
      if (['content-length', 'host', 'connection', 'transfer-encoding'].includes(k.toLowerCase())) continue;
      cleanHeaders[k] = v;
    }
    cleanHeaders['content-type'] = 'application/json';

    const res = await fetch(session.endpoint, {
      method: 'POST',
      headers: cleanHeaders,
      body: JSON.stringify(buildBody(session.bodyTemplate, question)),
      signal: AbortSignal.timeout(90000),
    });
    statusCode = res.status;

    // Read body to detect application-level errors (e.g. lead_required returns 209)
    let responseBody = '';
    const reader = res.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) chunks.push(result.value);
      }
      responseBody = new TextDecoder().decode(
        chunks.reduce((acc, c) => { const merged = new Uint8Array(acc.length + c.length); merged.set(acc); merged.set(c, acc.length); return merged; }, new Uint8Array(0))
      );
    }

    // Treat application-level errors as failures even when HTTP status is 2xx
    let appError: string | undefined;
    try {
      const parsed = JSON.parse(responseBody) as Record<string, unknown>;
      if (parsed['subtype'] || parsed['errorMessage']) {
        appError = `${parsed['subtype'] || 'app_error'}: ${String(parsed['errorMessage'] || '').substring(0, 80)}`;
      }
    } catch { /* not JSON or streaming — fine */ }

    const success = statusCode >= 200 && statusCode < 300 && !appError;

    return {
      user: session.user.email,
      question: question.substring(0, 60),
      statusCode,
      latencyMs: Date.now() - start,
      success,
      ...(appError ? { error: appError } : {}),
    };
  } catch (err: any) {
    return {
      user: session.user.email,
      question: question.substring(0, 60),
      statusCode,
      latencyMs: Date.now() - start,
      success: false,
      error: err.message,
    };
  }
}

// ════════════════════════════════════════════════════════════
//  ST-ADV-01  Multi-User Concurrent
//  每个用户各自独立 session，同时发请求
// ════════════════════════════════════════════════════════════
async function runMultiUser(sessions: UserSession[]): Promise<ScenarioResult> {
  const start = Date.now();
  const questions = QUESTIONS[AGENT_ARG];
  const ROUNDS = 3;
  console.log(`\n── ST-ADV-01: Multi-User Concurrent (${sessions.length} users × ${ROUNDS} rounds) ──`);

  const allMetrics: RequestMetric[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    console.log(`  Round ${round + 1}/${ROUNDS}: ${sessions.length} users sending simultaneously...`);

    const promises = sessions.map((session, i) =>
      sendRequest(session, questions[(round * sessions.length + i) % questions.length])
    );
    const metrics = await Promise.all(promises);
    allMetrics.push(...metrics);

    const ok = metrics.filter(m => m.success).length;
    const avgLat = metrics.filter(m => m.success).reduce((s, m) => s + m.latencyMs, 0) / (ok || 1);
    console.log(`    → ${ok}/${metrics.length} ok | avg ${Math.round(avgLat)}ms`);
    metrics.forEach(m => {
      console.log(`      ${m.user.split('@')[0]}: ${m.success ? '✓' : '✗'} ${m.latencyMs}ms${m.error ? ' — ' + m.error : ''}`);
    });

    // 3s between rounds
    if (round < ROUNDS - 1) await new Promise(r => setTimeout(r, 3000));
  }

  const successRate = allMetrics.filter(m => m.success).length / allMetrics.length;
  const stats = latencyStats(allMetrics);

  // Per-user breakdown
  const perUser: Record<string, { ok: number; total: number; avgLat: number }> = {};
  for (const m of allMetrics) {
    if (!perUser[m.user]) perUser[m.user] = { ok: 0, total: 0, avgLat: 0 };
    perUser[m.user].total++;
    if (m.success) { perUser[m.user].ok++; perUser[m.user].avgLat += m.latencyMs; }
  }
  for (const u of Object.keys(perUser)) {
    if (perUser[u].ok > 0) perUser[u].avgLat = Math.round(perUser[u].avgLat / perUser[u].ok);
  }

  console.log('\n  Per-user summary:');
  for (const [u, s] of Object.entries(perUser)) {
    console.log(`    ${u}: ${s.ok}/${s.total} ok | avg ${s.avgLat}ms`);
  }

  return {
    id: 'ST-ADV-01',
    name: `Multi-User Concurrent (${sessions.length} users × ${ROUNDS} rounds)`,
    status: successRate >= 0.95 ? 'PASS' : successRate >= 0.75 ? 'PARTIAL' : 'FAIL',
    totalRequests: allMetrics.length,
    successCount: allMetrics.filter(m => m.success).length,
    failCount: allMetrics.filter(m => !m.success).length,
    successRate,
    latency: stats,
    durationMs: Date.now() - start,
    details: { perUser, rounds: ROUNDS, users: sessions.length },
    metrics: allMetrics,
    timestamp: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════
//  ST-ADV-02  Breaking Point
//  持续加压直到失败率超过阈值
// ════════════════════════════════════════════════════════════
async function runBreakingPoint(session: UserSession): Promise<ScenarioResult> {
  const start = Date.now();
  const questions = QUESTIONS[AGENT_ARG];
  const FAIL_THRESHOLD = 0.20;   // 20% failure rate = approaching limit
  const STOP_THRESHOLD = 0.50;   // 50% failure rate = stop
  const LEVELS = [5, 10, 20, 30, 50, 75, 100];

  console.log(`\n── ST-ADV-02: Breaking Point Test ──`);
  console.log(`  Will stop when failure rate > ${STOP_THRESHOLD * 100}%`);
  console.log(`  Levels: ${LEVELS.join(' → ')}\n`);

  const allMetrics: RequestMetric[] = [];
  const levelResults: {
    level: number;
    ok: number;
    fail: number;
    successRate: number;
    avgLatency: number;
    p95: number;
    status: 'HEALTHY' | 'DEGRADED' | 'FAILING';
  }[] = [];

  let breakingPoint: number | null = null;
  let degradedAt: number | null = null;

  for (const level of LEVELS) {
    console.log(`  Level ${String(level).padStart(3)} concurrent: sending...`);

    const promises = Array.from({ length: level }, (_, i) =>
      sendRequest(session, questions[i % questions.length])
    );
    const metrics = await Promise.all(promises);
    allMetrics.push(...metrics);

    const ok = metrics.filter(m => m.success).length;
    const fail = metrics.length - ok;
    const sr = ok / metrics.length;
    const lats = metrics.filter(m => m.success).map(m => m.latencyMs).sort((a, b) => a - b);
    const avgLat = lats.length ? Math.round(lats.reduce((s, l) => s + l, 0) / lats.length) : -1;
    const p95Lat = pct(lats, 95);

    const levelStatus =
      sr >= (1 - FAIL_THRESHOLD) ? 'HEALTHY' :
      sr >= (1 - STOP_THRESHOLD) ? 'DEGRADED' :
      'FAILING';

    levelResults.push({ level, ok, fail, successRate: sr, avgLatency: avgLat, p95: p95Lat, status: levelStatus });

    const icon = levelStatus === 'HEALTHY' ? '✓' : levelStatus === 'DEGRADED' ? '⚠' : '✗';
    console.log(`  ${icon} Level ${String(level).padStart(3)}: ${ok}/${level} ok (${(sr * 100).toFixed(0)}%) | avg ${avgLat}ms | P95 ${p95Lat}ms — ${levelStatus}`);

    if (levelStatus === 'DEGRADED' && degradedAt === null) {
      degradedAt = level;
      console.log(`  ⚠ System degrading at ${level} concurrent requests`);
    }

    if (levelStatus === 'FAILING') {
      breakingPoint = level;
      console.log(`  ✗ Breaking point reached at ${level} concurrent requests`);
      break;
    }

    // 5s cooldown between levels to let server recover
    if (level < LEVELS[LEVELS.length - 1]) {
      console.log(`    Cooling down 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (breakingPoint === null) {
    console.log(`\n  ✓ System held at all tested levels (max: ${LEVELS[LEVELS.length - 1]} concurrent)`);
    console.log(`    Breaking point is above ${LEVELS[LEVELS.length - 1]} — consider testing higher`);
  }

  const overallSuccessRate = allMetrics.filter(m => m.success).length / allMetrics.length;

  return {
    id: 'ST-ADV-02',
    name: 'Breaking Point Test',
    status: breakingPoint === null ? 'PASS' : breakingPoint <= 20 ? 'FAIL' : 'PARTIAL',
    totalRequests: allMetrics.length,
    successCount: allMetrics.filter(m => m.success).length,
    failCount: allMetrics.filter(m => !m.success).length,
    successRate: overallSuccessRate,
    latency: latencyStats(allMetrics),
    durationMs: Date.now() - start,
    details: {
      breakingPoint: breakingPoint ?? `>${LEVELS[LEVELS.length - 1]}`,
      degradedAt: degradedAt ?? 'not reached',
      failThreshold: `${FAIL_THRESHOLD * 100}%`,
      stopThreshold: `${STOP_THRESHOLD * 100}%`,
      levelResults,
    },
    metrics: allMetrics,
    timestamp: new Date().toISOString(),
  };
}

// ── Print result ──────────────────────────────────────────────
function printResult(r: ScenarioResult) {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'PARTIAL' ? '~' : '✗';
  console.log(`  ${icon} ${r.id}: ${r.name}`);
  console.log(`     Requests : ${r.totalRequests} total, ${r.successCount} ok, ${r.failCount} failed`);
  console.log(`     Success  : ${(r.successRate * 100).toFixed(1)}%`);
  console.log(`     Latency  : avg ${r.latency.avg}ms | P50 ${r.latency.p50}ms | P95 ${r.latency.p95}ms | max ${r.latency.max}ms`);
  if (r.id === 'ST-ADV-02') {
    const d = r.details as any;
    console.log(`     Breaking : ${d.breakingPoint} concurrent`);
    console.log(`     Degraded : ${d.degradedAt} concurrent`);
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  const numUsers = Math.min(ALL_USERS.length, 4);

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  API ADVANCED STRESS TEST                                ║`);
  console.log(`║  Agent   : ${AGENT_ARG.toUpperCase().padEnd(48)}║`);
  console.log(`║  Target  : ${BASE_URL.padEnd(48)}║`);
  console.log(`║  Users   : ${String(numUsers).padEnd(48)}║`);
  console.log(`║  Scenarios: ST-ADV-01 (multi-user) · ST-ADV-02 (breaking)║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  // ── Phase 1: Capture sessions for all users ──────────────
  console.log(`\n── Phase 1: Capturing sessions for ${numUsers} users ──`);
  const sessions: UserSession[] = [];

  for (let i = 0; i < numUsers; i++) {
    const u = ALL_USERS[i];
    process.stdout.write(`  [${i + 1}/${numUsers}] ${u.email} — logging in...`);
    try {
      const session = await captureSession(u);
      sessions.push(session);
      console.log(` ✓ captured (${session.endpoint.split('/').slice(-3).join('/')})`);
    } catch (err: any) {
      console.log(` ✗ failed: ${err.message}`);
    }
    // 2s between logins to avoid session conflicts
    if (i < numUsers - 1) await new Promise(r => setTimeout(r, 2000));
  }

  if (sessions.length < 2) {
    console.error('\n✗ Need at least 2 valid sessions to run multi-user test');
    process.exit(1);
  }

  console.log(`\n  ✓ ${sessions.length} sessions ready\n`);

  // ── Phase 2: Run scenarios ───────────────────────────────
  console.log('── Phase 2: Running advanced scenarios ──');
  const allResults: ScenarioResult[] = [];

  // ST-ADV-01: Multi-user concurrent
  allResults.push(await runMultiUser(sessions));

  // 10s cooldown between scenarios
  console.log('\n  Cooling down 10s before breaking point test...');
  await new Promise(r => setTimeout(r, 10000));

  // ST-ADV-02: Breaking point (use first user's session)
  allResults.push(await runBreakingPoint(sessions[0]));

  // ── Summary ──────────────────────────────────────────────
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
    testType: 'api-stress-advanced',
    agent: AGENT_ARG,
    baseUrl: BASE_URL,
    users: sessions.map(s => s.user.email),
    scenarios: allResults.length,
    passed, partial, failed,
    results: allResults,
    generatedAt: new Date().toISOString(),
  };

  const reportPath = join(process.cwd(), `reports/${AGENT_ARG}-api-stress-advanced-results.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved → ${reportPath}`);
}

main().catch(console.error);
