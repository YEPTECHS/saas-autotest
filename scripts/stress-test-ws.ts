/**
 * WebSocket Chat Stress Test
 *
 * Replaces the old HTTP-interception stress test which broke when the app
 * switched from HTTP POST to WebSocket for chat messages.
 *
 * Strategy: Playwright multi-page concurrent testing.
 *   Phase 1 — Login once, save browser storage state
 *   Phase 2 — Run 6 scenarios using real browser tabs (WebSocket handled natively)
 *
 *   ST-WS-01  Sequential baseline   — 5 messages on one page, one by one
 *   ST-WS-02  Concurrent burst  3   — 3 simultaneous pages each sending one message
 *   ST-WS-03  Concurrent burst  5   — 5 simultaneous pages
 *   ST-WS-04  Ramp-up            — 1 → 3 → 5 concurrent, measure degradation
 *   ST-WS-05  Sustained load     — 8 messages over ~3 min on a single page
 *   ST-WS-06  Multi-session      — 3 independent browser contexts (3 separate users)
 *
 * Usage:
 *   pnpm tsx scripts/stress-test-ws.ts --agent maya
 *   pnpm tsx scripts/stress-test-ws.ts --agent oscar
 *   pnpm tsx scripts/stress-test-ws.ts --agent daniel
 *   pnpm tsx scripts/stress-test-ws.ts --agent cody
 */

import { chromium, BrowserContext, Page } from '@playwright/test';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

// ── Config ────────────────────────────────────────────────────
const BASE_URL   = process.env.YEPAI_BASE_URL!;
const EMAIL      = process.env.YEPAI_LOGIN_EMAIL!;
const PASSWORD   = process.env.YEPAI_LOGIN_PASSWORD!;

const AGENT_ARG  =
  process.argv.find(a => a.startsWith('--agent='))?.split('=')[1] ||
  process.argv[process.argv.indexOf('--agent') + 1] ||
  'maya';

const AGENT_PATHS: Record<string, string> = {
  maya:   '/ai-team/marketing/chat',
  oscar:  '/ai-team/operation',       // Oscar's chat is on the operation page directly (no /chat sub-path)
  daniel: '/ai-team/profit/chat',
  cody:   '/ai-team/seo/chat',
};
const AGENT_PATH = AGENT_PATHS[AGENT_ARG];
if (!AGENT_PATH) {
  console.error(`Unknown agent: ${AGENT_ARG}. Use: maya, oscar, daniel, cody`);
  process.exit(1);
}

const CHAT_URL = `${BASE_URL}${AGENT_PATH}`;

// ── Per-agent questions ───────────────────────────────────────
const QUESTIONS: Record<string, string[]> = {
  maya: [
    'What color scheme works best for a luxury fashion brand?',
    'How do I improve my email open rates?',
    'Suggest 3 Instagram caption ideas for a summer sale',
    'What is A/B testing and how do I use it for my ads?',
    'How do retargeting ads work?',
    'What hashtags should I use for my winter collection?',
    'Write a short product description for a handmade candle',
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
    'How do I handle backorders efficiently?',
    'What is my average order processing time?',
    'How do I improve my inventory turnover?',
    'How do I manage returns efficiently?',
    'What is just-in-time inventory?',
  ],
  daniel: [
    'What is my gross margin percentage?',
    'What is the difference between markup and margin?',
    'How do I calculate the break-even point?',
    'What is contribution margin?',
    'How do landed costs affect my margin?',
    'What is a loss leader strategy?',
    'How do I improve my net margin?',
    'What is gross profit vs net profit?',
    'How do I analyze profitability by product category?',
    'What is a good gross margin for e-commerce?',
  ],
  cody: [
    'Analyze my product catalog for SEO gaps.',
    'Write an optimized title for a bamboo cutting board.',
    'Generate meta tags for my running shoes product page.',
    'Suggest long-tail keywords for organic skincare products.',
    'What makes a good SEO product description?',
    'How does keyword density affect product page rankings?',
    'What is the ideal length for a product title for SEO?',
    'How do I optimize product URLs for search engines?',
    'What are schema markup and how do they help product pages?',
    'How do I find the right keywords for my niche products?',
  ],
};
const Q = QUESTIONS[AGENT_ARG];

// ── Types ─────────────────────────────────────────────────────
interface MsgMetric {
  question:   string;
  ttfbMs:     number;   // time to first AI bubble appearing
  totalMs:    number;   // time until response stabilises
  success:    boolean;
  error?:     string;
}

interface ScenarioResult {
  id:            string;
  name:          string;
  concurrency:   number;
  totalMessages: number;
  successCount:  number;
  failCount:     number;
  successRate:   number;
  latency: { min: number; avg: number; p50: number; p90: number; p95: number; max: number };
  ttfb:    { avg: number; p95: number };
  durationMs:    number;
  status:        'PASS' | 'PARTIAL' | 'FAIL' | 'ERROR';
  metrics:       MsgMetric[];
}

// ── Helpers ───────────────────────────────────────────────────
function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.ceil(s.length * p / 100) - 1;
  return s[Math.max(0, i)];
}

function summarise(metrics: MsgMetric[]): ScenarioResult['latency'] {
  const lats = metrics.filter(m => m.success).map(m => m.totalMs);
  if (!lats.length) return { min: 0, avg: 0, p50: 0, p90: 0, p95: 0, max: 0 };
  const avg = lats.reduce((a, b) => a + b, 0) / lats.length;
  return {
    min: Math.min(...lats),
    avg: Math.round(avg),
    p50: pct(lats, 50),
    p90: pct(lats, 90),
    p95: pct(lats, 95),
    max: Math.max(...lats),
  };
}

// Open a fresh page, navigate to chat, wait for input to be ready
async function openChatPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return page;
}

// Install timing helpers on the page
async function installHelpers(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__snapshots = () =>
      Array.from(document.querySelectorAll('[class*="rounded-2xl"]'))
        .filter((b: any) => !b.className.includes('purple'))
        .map((b: any) => b.textContent.trim().substring(0, 60));

    (window as any).__lastAILen = () => {
      const bs = Array.from(document.querySelectorAll('[class*="rounded-2xl"]')) as HTMLElement[];
      for (let i = bs.length - 1; i >= 0; i--) {
        if (!bs[i].className.includes('purple')) return bs[i].textContent?.trim().length ?? 0;
      }
      return 0;
    };
  });
}

// Send one message and measure TTFB + total latency
async function sendAndMeasure(page: Page, question: string): Promise<MsgMetric> {
  await installHelpers(page);

  const snapBefore: string[] = await page.evaluate(() => (window as any).__snapshots());

  const sendStart = Date.now();

  // Fill textarea
  await page.evaluate((text: string) => {
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(ta, text);
    else ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }, question);

  await page.waitForTimeout(300);

  // Click send
  const sent = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    let el: Element | null = ta;
    for (let i = 0; i < 4; i++) {
      el = el?.parentElement ?? null;
      if (!el) break;
      const btn = el.querySelector('button[type="submit"], button') as HTMLButtonElement | null;
      if (btn && !btn.disabled) { btn.click(); return true; }
    }
    // Fallback: Enter key
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  });

  if (!sent) return { question, ttfbMs: 0, totalMs: 0, success: false, error: 'Could not click send' };

  // Wait for first new AI bubble (TTFB)
  let ttfbMs = 0;
  let gotTtfb = false;
  const ttfbTimeout = 30000;
  const ttfbStart = Date.now();

  while (Date.now() - ttfbStart < ttfbTimeout) {
    await page.waitForTimeout(200);
    const current: string[] = await page.evaluate(() => (window as any).__snapshots());
    const hasNew = current.some(s => s.length > 5 && !snapBefore.includes(s));
    if (hasNew && !gotTtfb) {
      ttfbMs = Date.now() - sendStart;
      gotTtfb = true;
      break;
    }
  }

  if (!gotTtfb) {
    return { question, ttfbMs: 0, totalMs: Date.now() - sendStart, success: false, error: 'Timeout waiting for first response token' };
  }

  // Wait for response to stabilise (stop growing)
  let lastLen = 0;
  let stableCount = 0;
  const stableTimeout = 120000;
  const stableStart = Date.now();

  while (Date.now() - stableStart < stableTimeout) {
    await page.waitForTimeout(500);
    const len: number = await page.evaluate(() => (window as any).__lastAILen());
    if (len > 0 && len === lastLen) {
      stableCount++;
      if (stableCount >= 4) break;
    } else {
      stableCount = 0;
      lastLen = len;
    }
  }

  const totalMs = Date.now() - sendStart;
  return { question, ttfbMs, totalMs, success: true };
}

function finalise(
  id: string, name: string, concurrency: number,
  metrics: MsgMetric[], durationMs: number,
): ScenarioResult {
  const ok = metrics.filter(m => m.success);
  const successRate = metrics.length ? (ok.length / metrics.length) * 100 : 0;
  const ttfbs = ok.map(m => m.ttfbMs);
  const status: ScenarioResult['status'] =
    successRate === 100 ? 'PASS' :
    successRate >= 50  ? 'PARTIAL' :
    metrics.length === 0 ? 'ERROR' : 'FAIL';

  return {
    id, name, concurrency,
    totalMessages: metrics.length,
    successCount: ok.length,
    failCount: metrics.length - ok.length,
    successRate: Math.round(successRate),
    latency: summarise(metrics),
    ttfb: {
      avg: ttfbs.length ? Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length) : 0,
      p95: pct(ttfbs, 95),
    },
    durationMs,
    status,
    metrics,
  };
}

// ── Scenario runners ──────────────────────────────────────────

// ST-WS-01: Sequential — 5 messages on one page
async function runSequential(ctx: BrowserContext): Promise<ScenarioResult> {
  console.log('\n── ST-WS-01: Sequential baseline (5 messages) ──');
  const page = await openChatPage(ctx);
  const metrics: MsgMetric[] = [];
  const start = Date.now();

  for (let i = 0; i < 5; i++) {
    const q = Q[i % Q.length];
    console.log(`  [${i + 1}/5] "${q.substring(0, 50)}"`);
    const m = await sendAndMeasure(page, q);
    metrics.push(m);
    console.log(`        TTFB: ${m.ttfbMs}ms  Total: ${m.totalMs}ms  ${m.success ? '✓' : '✗ ' + m.error}`);
  }
  await page.close();
  return finalise('ST-WS-01', 'Sequential baseline (5 messages)', 1, metrics, Date.now() - start);
}

// ST-WS-02: Concurrent burst 3
async function runConcurrent3(ctx: BrowserContext): Promise<ScenarioResult> {
  console.log('\n── ST-WS-02: Concurrent burst 3 ──');
  const N = 3;
  const pages = await Promise.all(Array.from({ length: N }, () => openChatPage(ctx)));
  const start = Date.now();

  const metrics = await Promise.all(pages.map((p, i) => sendAndMeasure(p, Q[i % Q.length])));
  await Promise.all(pages.map(p => p.close()));

  metrics.forEach((m, i) => console.log(`  [${i + 1}] TTFB: ${m.ttfbMs}ms  Total: ${m.totalMs}ms  ${m.success ? '✓' : '✗'}`));
  return finalise('ST-WS-02', 'Concurrent burst 3', 3, metrics, Date.now() - start);
}

// ST-WS-03: Concurrent burst 5
async function runConcurrent5(ctx: BrowserContext): Promise<ScenarioResult> {
  console.log('\n── ST-WS-03: Concurrent burst 5 ──');
  const N = 5;
  const pages = await Promise.all(Array.from({ length: N }, () => openChatPage(ctx)));
  const start = Date.now();

  const metrics = await Promise.all(pages.map((p, i) => sendAndMeasure(p, Q[i % Q.length])));
  await Promise.all(pages.map(p => p.close()));

  metrics.forEach((m, i) => console.log(`  [${i + 1}] TTFB: ${m.ttfbMs}ms  Total: ${m.totalMs}ms  ${m.success ? '✓' : '✗'}`));
  return finalise('ST-WS-03', 'Concurrent burst 5', 5, metrics, Date.now() - start);
}

// ST-WS-04: Ramp-up 1 → 3 → 5
async function runRampUp(ctx: BrowserContext): Promise<ScenarioResult> {
  console.log('\n── ST-WS-04: Ramp-up 1 → 3 → 5 ──');
  const allMetrics: MsgMetric[] = [];
  const start = Date.now();

  for (const n of [1, 3, 5]) {
    console.log(`  → Ramp level ${n} concurrent`);
    const pages = await Promise.all(Array.from({ length: n }, () => openChatPage(ctx)));
    const batch = await Promise.all(pages.map((p, i) => sendAndMeasure(p, Q[(allMetrics.length + i) % Q.length])));
    await Promise.all(pages.map(p => p.close()));
    const avgTotal = batch.filter(m => m.success).reduce((s, m) => s + m.totalMs, 0) / (batch.filter(m => m.success).length || 1);
    console.log(`     avg total: ${Math.round(avgTotal)}ms  success: ${batch.filter(m => m.success).length}/${n}`);
    allMetrics.push(...batch);
    await new Promise(r => setTimeout(r, 3000)); // brief pause between ramp levels
  }

  return finalise('ST-WS-04', 'Ramp-up 1→3→5', 5, allMetrics, Date.now() - start);
}

// ST-WS-05: Sustained load — 8 messages on one page over ~3 min
async function runSustained(ctx: BrowserContext): Promise<ScenarioResult> {
  console.log('\n── ST-WS-05: Sustained load (8 messages) ──');
  const page = await openChatPage(ctx);
  const metrics: MsgMetric[] = [];
  const start = Date.now();

  for (let i = 0; i < 8; i++) {
    const q = Q[(i + 5) % Q.length];
    console.log(`  [${i + 1}/8] "${q.substring(0, 50)}"`);
    const m = await sendAndMeasure(page, q);
    metrics.push(m);
    console.log(`        TTFB: ${m.ttfbMs}ms  Total: ${m.totalMs}ms  ${m.success ? '✓' : '✗ ' + m.error}`);
  }
  await page.close();
  return finalise('ST-WS-05', 'Sustained load (8 messages)', 1, metrics, Date.now() - start);
}

// ST-WS-06: Multi-session — 3 independent browser contexts (separate users)
async function runMultiSession(browser: ReturnType<typeof chromium.launch> extends Promise<infer B> ? B : never): Promise<ScenarioResult> {
  console.log('\n── ST-WS-06: Multi-session (3 independent users) ──');
  const N = 3;
  const start = Date.now();

  // Create 3 separate browser contexts with independent sessions
  const contexts = await Promise.all(Array.from({ length: N }, async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pg = await ctx.newPage();
    // Login each session independently
    await pg.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pg.waitForSelector("input[type='email']", { timeout: 15000 });
    await pg.fill("input[type='email']", EMAIL);
    await pg.fill("input[type='password']", PASSWORD);
    await pg.click("button[type='submit']");
    await pg.waitForTimeout(4000);
    await pg.close();
    return ctx;
  }));

  console.log(`  ✓ Logged in 3 independent sessions`);

  // Open chat page in each session
  const pages = await Promise.all(contexts.map(ctx => openChatPage(ctx)));

  // Send simultaneously
  const metrics = await Promise.all(pages.map((p, i) => sendAndMeasure(p, Q[i % Q.length])));
  await Promise.all(pages.map(p => p.close()));
  await Promise.all(contexts.map(ctx => ctx.close()));

  metrics.forEach((m, i) => console.log(`  [Session ${i + 1}] TTFB: ${m.ttfbMs}ms  Total: ${m.totalMs}ms  ${m.success ? '✓' : '✗'}`));
  return finalise('ST-WS-06', 'Multi-session 3 independent users', 3, metrics, Date.now() - start);
}

// ── Report printer ────────────────────────────────────────────
function printReport(results: ScenarioResult[]): void {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║   WEBSOCKET STRESS TEST REPORT — ${AGENT_ARG.toUpperCase().padEnd(6)} (${new Date().toLocaleString()})  ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'PARTIAL' ? '⚠️ ' : '❌';
    console.log(`${icon}  ${r.id}: ${r.name}`);
    console.log(`     Status:      ${r.status}  (${r.successCount}/${r.totalMessages} messages succeeded)`);
    console.log(`     Latency:     avg=${r.latency.avg}ms  p50=${r.latency.p50}ms  p90=${r.latency.p90}ms  p95=${r.latency.p95}ms  max=${r.latency.max}ms`);
    console.log(`     TTFB:        avg=${r.ttfb.avg}ms  p95=${r.ttfb.p95}ms`);
    console.log(`     Duration:    ${(r.durationMs / 1000).toFixed(1)}s`);
    if (r.failCount > 0) {
      const errors = r.metrics.filter(m => !m.success).map(m => m.error).filter(Boolean);
      console.log(`     Errors:      ${[...new Set(errors)].join('; ')}`);
    }
    console.log('');
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const partial = results.filter(r => r.status === 'PARTIAL').length;
  const fail = results.filter(r => r.status === 'FAIL' || r.status === 'ERROR').length;
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  TOTAL  |  PASS: ${pass}  |  PARTIAL: ${partial}  |  FAIL: ${fail}  |  SCENARIOS: ${results.length}`);
  console.log('══════════════════════════════════════════════════════════════');
}

// ── Main ──────────────────────────────────────────────────────
console.log(`\n🚀 WebSocket Stress Test — Agent: ${AGENT_ARG.toUpperCase()}`);
console.log(`   URL: ${CHAT_URL}`);

const browser = await chromium.launch({ headless: true });
const results: ScenarioResult[] = [];

try {
  // Shared context (single login session for most scenarios)
  console.log('\n── Phase 1: Login ──');
  const sharedCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const loginPage = await sharedCtx.newPage();
  await loginPage.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await loginPage.waitForSelector("input[type='email']");
  await loginPage.fill("input[type='email']", EMAIL);
  await loginPage.fill("input[type='password']", PASSWORD);
  await loginPage.click("button[type='submit']");
  await loginPage.waitForTimeout(4000);
  console.log(`  ✓ Logged in as ${EMAIL}`);
  await loginPage.close();

  console.log('\n── Phase 2: Stress scenarios ──');

  results.push(await runSequential(sharedCtx));
  results.push(await runConcurrent3(sharedCtx));
  results.push(await runConcurrent5(sharedCtx));
  results.push(await runRampUp(sharedCtx));
  results.push(await runSustained(sharedCtx));
  results.push(await runMultiSession(browser));

  await sharedCtx.close();

} catch (err) {
  console.error('\n❌ Fatal error:', err);
} finally {
  await browser.close();
}

printReport(results);

// Save JSON report
const outDir = join(process.cwd(), 'reports', 'stress-ws');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `stress-ws-${AGENT_ARG}-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify({ agent: AGENT_ARG, scenarios: results }, null, 2));
console.log(`\n📄 Report saved: ${outFile}`);
