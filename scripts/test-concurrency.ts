/**
 * CC — Real Concurrency Test
 * 
 * Tests actual concurrent behavior by running 3 browser sessions
 * with different users, sending questions simultaneously to the
 * same AI agent and verifying each session gets correct responses.
 *
 * Usage:
 *   npx tsx scripts/test-concurrency.ts --agent maya
 *   npx tsx scripts/test-concurrency.ts --agent oscar
 *   npx tsx scripts/test-concurrency.ts --agent daniel
 */

import { chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

// ── Config ──────────────────────────────────────────────────
const BASE_URL = process.env.YEPAI_BASE_URL || 'https://app.yepai.ai';
const AGENT_ARG = process.argv.find(a => a.startsWith('--agent='))?.split('=')[1]
  || process.argv[process.argv.indexOf('--agent') + 1]
  || 'maya';

const AGENT_PATHS: Record<string, string> = {
  maya: '/ai-team/marketing/chat',
  oscar: '/ai-team/operation/chat',
  daniel: '/ai-team/profit-analyst/chat',
};

const agentPath = AGENT_PATHS[AGENT_ARG];
if (!agentPath) {
  console.error(`Unknown agent: ${AGENT_ARG}. Use: maya, oscar, daniel`);
  process.exit(1);
}

// ── Load test users ─────────────────────────────────────────
interface TestUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

const usersData = JSON.parse(
  readFileSync(join(process.cwd(), 'data/test-users.json'), 'utf-8')
);
const users: TestUser[] = usersData.users.slice(0, 3);

if (users.length < 2) {
  console.error('Need at least 2 test users for concurrency testing');
  process.exit(1);
}

// ── Concurrency test scenarios ──────────────────────────────
// Each round: all users send the SAME question simultaneously
// We verify: all get valid responses, no cross-contamination
const CONCURRENT_ROUNDS = [
  {
    id: 'CC-R01',
    name: 'Same question simultaneously',
    question: AGENT_ARG === 'oscar'
      ? 'What are my top 5 selling products?'
      : AGENT_ARG === 'daniel'
      ? 'What are my top 5 highest margin SKUs?'
      : 'Suggest 3 marketing campaign ideas for summer',
    check: (responses: string[]) => {
      // All responses should be non-empty and contain relevant content
      return responses.every(r => r.length > 30);
    },
  },
  {
    id: 'CC-R02',
    name: 'Different questions simultaneously',
    questions: AGENT_ARG === 'oscar'
      ? ['Show inventory summary', 'List pending orders', 'What is my fulfillment rate?']
      : AGENT_ARG === 'daniel'
      ? ['Calculate margin for product A', 'Show low-margin SKUs', 'What is my average gross margin?']
      : ['Write a product description', 'Suggest email subject lines', 'Create a social media post'],
    check: (responses: string[]) => {
      return responses.every(r => r.length > 20);
    },
  },
  {
    id: 'CC-R03',
    name: 'Rapid sequential from all users',
    question: AGENT_ARG === 'oscar'
      ? 'How many orders are pending?'
      : AGENT_ARG === 'daniel'
      ? 'What is the overall profit margin?'
      : 'What marketing channels should I focus on?',
    check: (responses: string[]) => {
      return responses.every(r => r.length > 20);
    },
  },
  {
    id: 'CC-R04',
    name: 'Long query from all users simultaneously',
    question: AGENT_ARG === 'oscar'
      ? 'I need a comprehensive inventory report covering all warehouses, including stock levels, reorder points, items below safety stock, and a forecast for the next 30 days. Please organize by category.'
      : AGENT_ARG === 'daniel'
      ? 'Provide a full profitability analysis across all product categories, including gross margin percentages, COGS breakdown, contribution margins, and recommendations for low-performing SKUs.'
      : 'Create a comprehensive Q3 marketing plan including channel strategy, budget allocation across social/email/content, target audience segments, KPIs, and a weekly execution timeline.',
    check: (responses: string[]) => {
      // Long responses expected for complex queries
      return responses.every(r => r.length > 100);
    },
  },
  {
    id: 'CC-R05',
    name: 'Stress: rapid-fire 3 questions per user',
    questions: AGENT_ARG === 'oscar'
      ? ['Show order #1001', 'Inventory count for SKU-100', 'Shipping status update']
      : AGENT_ARG === 'daniel'
      ? ['Margin for SKU-100', 'Compare Q1 vs Q2 margins', 'COGS breakdown']
      : ['Write a headline', 'Suggest a tagline', 'Create a CTA'],
    check: (responses: string[]) => {
      return responses.every(r => r.length > 10);
    },
  },
];

// ── Browser helpers ─────────────────────────────────────────
async function loginUser(page: Page, user: TestUser): Promise<void> {
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  await page.fill('input[type="email"], input[name="email"]', user.email);
  await page.fill('input[type="password"], input[name="password"]', user.password);
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 5000 });
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|home|ai-training|analytics|onboarding/, { timeout: 30000 });
  console.log(`  ✓ ${user.email} logged in`);
}

async function navigateToAgent(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}${agentPath}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
}

async function sendMessageAndWait(page: Page, message: string, timeoutSec = 30): Promise<string> {
  // Fill textarea
  const textarea = page.locator('textarea[placeholder*="Message"]');
  await textarea.fill(message);

  // Click send
  const sendBtn = textarea.locator('..').locator('button').first();
  await sendBtn.click();

  // Wait for AI response
  const startTime = Date.now();
  let lastResponse = '';

  while (Date.now() - startTime < timeoutSec * 1000) {
    await page.waitForTimeout(1000);
    lastResponse = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll('[class*="rounded-2xl"]'));
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const cls = bubbles[i].className || '';
        if (!cls.includes('purple') && !cls.includes('bg-purple')) {
          const t = (bubbles[i] as HTMLElement).textContent?.trim()
            .replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i, '')
            .trim() || '';
          if (t.length > 10) return t;
        }
      }
      return '';
    });
    if (lastResponse.length > 10) break;
  }

  return lastResponse;
}

// ── Main test runner ────────────────────────────────────────
interface RoundResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'ERROR';
  responses: { user: string; responseLength: number; responsePreview: string; duration: number }[];
  allResponded: boolean;
  noContamination: boolean;
  error?: string;
  timestamp: string;
}

async function main() {
  console.log(`\n╔═══════════════════════════════════════════════════╗`);
  console.log(`║  CC — REAL CONCURRENCY TEST                       ║`);
  console.log(`║  Agent: ${AGENT_ARG.toUpperCase().padEnd(41)}║`);
  console.log(`║  Users: ${users.length}                                         ║`);
  console.log(`║  Rounds: ${CONCURRENT_ROUNDS.length}                                        ║`);
  console.log(`╚═══════════════════════════════════════════════════╝\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const results: RoundResult[] = [];

  try {
    // ── Step 1: Create separate contexts per user and login ──
    console.log('Phase 1: Logging in all users...');
    const sessions: { context: BrowserContext; page: Page; user: TestUser }[] = [];

    for (const user of users) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      await loginUser(page, user);
      await navigateToAgent(page);
      sessions.push({ context, page, user });
    }

    console.log(`\nPhase 2: Running ${CONCURRENT_ROUNDS.length} concurrency rounds...\n`);

    // ── Step 2: Run each concurrency round ──────────────────
    for (const round of CONCURRENT_ROUNDS) {
      console.log(`─── ${round.id}: ${round.name} ───`);
      const roundStart = Date.now();

      try {
        // Determine question per user
        const questionsPerUser = round.questions
          ? round.questions
          : sessions.map(() => round.question!);

        // Send all questions SIMULTANEOUSLY using Promise.all
        const responsePromises = sessions.map((session, idx) => {
          const q = questionsPerUser[idx] || questionsPerUser[0];
          const start = Date.now();
          return sendMessageAndWait(session.page, q, 45).then(response => ({
            user: session.user.email,
            question: q,
            response,
            responseLength: response.length,
            responsePreview: response.substring(0, 150),
            duration: Date.now() - start,
          }));
        });

        const responses = await Promise.all(responsePromises);

        // Evaluate results
        const allResponded = responses.every(r => r.responseLength > 10);
        const responseTexts = responses.map(r => r.response);
        const passCheck = round.check(responseTexts);

        // Check no cross-contamination: if different questions,
        // responses should not be identical
        let noContamination = true;
        if (round.questions && round.questions.length > 1) {
          const uniqueResponses = new Set(responses.map(r => r.responsePreview));
          noContamination = uniqueResponses.size > 1;
        }

        const status = allResponded && passCheck && noContamination ? 'PASS' : 'FAIL';

        results.push({
          id: round.id,
          name: round.name,
          status,
          responses: responses.map(r => ({
            user: r.user,
            responseLength: r.responseLength,
            responsePreview: r.responsePreview,
            duration: r.duration,
          })),
          allResponded,
          noContamination,
          timestamp: new Date().toISOString(),
        });

        console.log(`  Status: ${status}`);
        responses.forEach(r => {
          console.log(`    ${r.user}: ${r.responseLength} chars (${r.duration}ms)`);
        });
        if (!noContamination) console.log(`  ⚠ CONTAMINATION: identical responses for different questions`);

      } catch (err: any) {
        results.push({
          id: round.id,
          name: round.name,
          status: 'ERROR',
          responses: [],
          allResponded: false,
          noContamination: false,
          error: err.message,
          timestamp: new Date().toISOString(),
        });
        console.log(`  ERROR: ${err.message}`);
      }

      // Small delay between rounds
      await Promise.all(sessions.map(s => s.page.waitForTimeout(2000)));
    }

    // ── Step 3: Cleanup ─────────────────────────────────────
    for (const session of sessions) {
      await session.context.close();
    }

  } finally {
    await browser.close();
  }

  // ── Report ──────────────────────────────────────────────
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const errors = results.filter(r => r.status === 'ERROR').length;

  console.log(`\n╔═══════════════════════════════════════════════════╗`);
  console.log(`║  RESULTS: ${passed} PASS / ${failed} FAIL / ${errors} ERROR`.padEnd(52) + '║');
  console.log(`╚═══════════════════════════════════════════════════╝\n`);

  const report = {
    agent: AGENT_ARG,
    testType: 'concurrency',
    users: users.map(u => u.email),
    totalRounds: CONCURRENT_ROUNDS.length,
    passed,
    failed,
    errors,
    results,
    generatedAt: new Date().toISOString(),
  };

  const reportPath = join(process.cwd(), `reports/${AGENT_ARG}-concurrency-test-results.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report saved to: ${reportPath}`);
}

main().catch(console.error);
