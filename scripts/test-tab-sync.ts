/**
 * Same-User Dual-Tab Real-Time Sync Test
 *
 * The real question: when the same user has 2 tabs open on the same chat page,
 * does Tab B automatically receive and display the messages/responses from Tab A?
 *
 * This is NOT about context leakage — it's about whether the two tabs
 * share the SAME live conversation stream (WebSocket / SSE / polling).
 *
 * Test logic:
 *   1. Login as one user, open TWO tabs on the same agent chat page
 *   2. Tab B does NOTHING (passive observer)
 *   3. Tab A sends a message, waits for AI response
 *   4. We check Tab B's UI — did it auto-update with Tab A's message + response?
 *
 * Expected behavior (PASS): Tab B stays empty / unchanged — each tab is its own session
 * Bug (FAIL): Tab B shows Tab A's messages without the user doing anything
 *
 * Usage:
 *   npx tsx scripts/test-tab-sync.ts --agent maya
 *   npx tsx scripts/test-tab-sync.ts --agent oscar
 *   npx tsx scripts/test-tab-sync.ts --agent daniel
 */

import { chromium, BrowserContext, Page } from '@playwright/test';
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

// ── Load test user ────────────────────────────────────────────
interface TestUser { email: string; password: string; }
const usersData = JSON.parse(readFileSync(join(process.cwd(), 'data/test-users.json'), 'utf-8'));
const user: TestUser = usersData.users[0];

// ── Messages to send from Tab A ───────────────────────────────
const TAB_A_MESSAGES: Record<string, string[]> = {
  maya: [
    'Write a short tagline for a summer sale campaign.',
    'My brand is called SunBloom. What marketing channels should I use?',
    'Create 3 subject lines for a flash sale email.',
  ],
  oscar: [
    'How many orders are currently pending?',
    'Give me a quick inventory summary.',
    'What is my fulfillment rate this month?',
  ],
  daniel: [
    'What is my average gross margin across all SKUs?',
    'Which product category has the highest profit margin?',
    'Give me a quick profitability overview.',
  ],
};

const messages = TAB_A_MESSAGES[AGENT_ARG];

// ── Helpers ──────────────────────────────────────────────────
async function loginUser(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
  await page.fill('input[type="email"], input[name="email"]', user.email);
  await page.fill('input[type="password"], input[name="password"]', user.password);
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 5000 });
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|home|ai-training|analytics|onboarding/, { timeout: 30000 });
}

async function navigateToAgent(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}${agentPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
}

/** Count all visible chat bubbles (both user and AI) */
async function countBubbles(page: Page): Promise<number> {
  return page.evaluate(() => {
    return document.querySelectorAll('[class*="rounded-2xl"]').length;
  });
}

/** Get all visible text from all chat bubbles */
async function getAllBubbleText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('[class*="rounded-2xl"]'))
      .map(b => (b as HTMLElement).textContent?.trim().replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i, '').trim() || '')
      .filter(t => t.length > 5);
  });
}

/** Send a message from Tab A and wait for AI response */
async function sendFromTabA(page: Page, message: string): Promise<{ userMsg: string; aiResponse: string }> {
  const snapshotBefore = await getAllBubbleText(page);

  await page.waitForSelector('textarea:not([disabled])', { timeout: 30000 });
  const textarea = page.locator('textarea:not([disabled])').first();
  await textarea.fill(message);
  await textarea.press('Enter');

  // Wait for AI response (new bubble appears that wasn't there before)
  const startTime = Date.now();
  let aiResponse = '';

  while (Date.now() - startTime < 60000) {
    await page.waitForTimeout(1500);
    const current = await getAllBubbleText(page);
    const newBubbles = current.filter(t => !snapshotBefore.includes(t) && t.length > 15);
    if (newBubbles.length >= 2) { // at least user message + AI response
      // Wait a bit more for full response
      await page.waitForTimeout(3000);
      const final = await getAllBubbleText(page);
      const finalNew = final.filter(t => !snapshotBefore.includes(t) && t.length > 15);
      // Last new bubble is AI response
      aiResponse = finalNew[finalNew.length - 1] || '';
      break;
    }
  }

  return { userMsg: message, aiResponse };
}

// ── Result type ──────────────────────────────────────────────
interface SyncCheckResult {
  round: number;
  tabA_message: string;
  tabA_aiResponse: string;
  tabA_bubbleCountBefore: number;
  tabA_bubbleCountAfter: number;
  tabB_bubbleCountBefore: number;
  tabB_bubbleCountAfter: number;
  tabB_newBubbles: string[];
  tabB_synced: boolean;         // true = Tab B received Tab A's messages (BAD)
  tabB_newBubbleCount: number;
  status: 'PASS' | 'FAIL';     // PASS = NOT synced (each tab independent)
  severity: 'CRITICAL' | 'INFO';
  timestamp: string;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔═════════════════════════════════════════════════════════════╗`);
  console.log(`║  SAME-USER DUAL-TAB REAL-TIME SYNC TEST                     ║`);
  console.log(`║  Agent  : ${AGENT_ARG.toUpperCase().padEnd(52)}║`);
  console.log(`║  User   : ${user.email.padEnd(52)}║`);
  console.log(`║                                                              ║`);
  console.log(`║  Question: When Tab A sends a message, does Tab B auto-      ║`);
  console.log(`║            update with the same message + AI response?       ║`);
  console.log(`║                                                              ║`);
  console.log(`║  PASS = Each tab is independent (no sync)                   ║`);
  console.log(`║  FAIL = Tab B auto-receives Tab A messages (shared stream)   ║`);
  console.log(`╚═════════════════════════════════════════════════════════════╝\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const results: SyncCheckResult[] = [];

  try {
    // Login and open 2 tabs in the same browser context (same cookies)
    console.log('Setting up: Login + open 2 tabs...');
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });

    const tabA: Page = await context.newPage();
    await loginUser(tabA);
    await navigateToAgent(tabA);
    console.log(`  ✓ Tab A ready (${AGENT_ARG})`);

    const tabB: Page = await context.newPage();
    await navigateToAgent(tabB);
    console.log(`  ✓ Tab B ready (${AGENT_ARG}) — Tab B will be PASSIVE (no typing)\n`);

    // For each message, Tab A sends it and we check if Tab B updates
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      console.log(`─── Round ${i + 1}/${messages.length} ───`);
      console.log(`  Tab A will send: "${msg}"`);
      console.log(`  Tab B is watching passively...\n`);

      // Snapshot Tab B BEFORE Tab A sends anything
      const tabB_before = await countBubbles(tabB);
      const tabB_textBefore = await getAllBubbleText(tabB);
      const tabA_before = await countBubbles(tabA);

      console.log(`  [Before] Tab A bubbles: ${tabA_before}  |  Tab B bubbles: ${tabB_before}`);

      // Tab A sends message and waits for AI reply
      console.log(`  Tab A → sending...`);
      const { aiResponse } = await sendFromTabA(tabA, msg);
      const tabA_after = await countBubbles(tabA);
      console.log(`  Tab A ← AI responded (${aiResponse.length} chars)`);
      console.log(`  [Tab A] bubbles: ${tabA_before} → ${tabA_after} (added ${tabA_after - tabA_before})`);

      // Wait 5 seconds for any real-time sync to propagate to Tab B
      console.log(`  Waiting 5s for Tab B to potentially sync...`);
      await tabB.waitForTimeout(5000);

      // Check Tab B
      const tabB_after = await countBubbles(tabB);
      const tabB_textAfter = await getAllBubbleText(tabB);
      const tabB_newBubbles = tabB_textAfter.filter(t => !tabB_textBefore.includes(t));
      const tabB_newCount = tabB_after - tabB_before;
      const synced = tabB_newCount > 0;

      console.log(`  [Tab B] bubbles: ${tabB_before} → ${tabB_after} (added ${tabB_newCount})`);

      if (synced) {
        console.log(`  ✗ FAIL — Tab B auto-received ${tabB_newCount} new bubble(s)!`);
        console.log(`    Tab B new content: "${tabB_newBubbles[0]?.substring(0, 100)}..."`);
        console.log(`    → This means Tab A and Tab B share the SAME conversation stream.`);
        console.log(`    → Opening 2 tabs = you're in the SAME chat, not two independent ones.`);
      } else {
        console.log(`  ✓ PASS — Tab B unchanged. Two tabs are independent conversations.`);
      }
      console.log();

      results.push({
        round: i + 1,
        tabA_message: msg,
        tabA_aiResponse: aiResponse.substring(0, 300),
        tabA_bubbleCountBefore: tabA_before,
        tabA_bubbleCountAfter: tabA_after,
        tabB_bubbleCountBefore: tabB_before,
        tabB_bubbleCountAfter: tabB_after,
        tabB_newBubbles: tabB_newBubbles.map(t => t.substring(0, 150)),
        tabB_synced: synced,
        tabB_newBubbleCount: tabB_newCount,
        status: synced ? 'FAIL' : 'PASS',
        severity: synced ? 'CRITICAL' : 'INFO',
        timestamp: new Date().toISOString(),
      });
    }

    // ── Bonus: Reverse check — Tab B sends, does Tab A update? ──
    console.log(`─── Bonus: Reverse check — Tab B sends, does Tab A see it? ───`);
    const reverseMsg = AGENT_ARG === 'oscar'
      ? 'What is my stock level for the top product?'
      : AGENT_ARG === 'daniel'
      ? 'What is my best performing SKU by margin?'
      : 'Suggest a headline for a product launch.';

    const tabA_beforeReverse = await countBubbles(tabA);
    const tabA_textBeforeReverse = await getAllBubbleText(tabA);
    const tabB_beforeReverse = await countBubbles(tabB);

    console.log(`  Tab B sends: "${reverseMsg}"`);
    console.log(`  Tab A is watching passively...\n`);

    await sendFromTabA(tabB, reverseMsg); // reuse same helper for Tab B
    const tabB_afterReverse = await countBubbles(tabB);

    await tabA.waitForTimeout(5000);
    const tabA_afterReverse = await countBubbles(tabA);
    const tabA_textAfterReverse = await getAllBubbleText(tabA);
    const tabA_newBubbles = tabA_textAfterReverse.filter(t => !tabA_textBeforeReverse.includes(t));
    const reverseSynced = tabA_afterReverse > tabA_beforeReverse;

    console.log(`  [Tab B] bubbles: ${tabB_beforeReverse} → ${tabB_afterReverse}`);
    console.log(`  [Tab A] bubbles: ${tabA_beforeReverse} → ${tabA_afterReverse} (added ${tabA_afterReverse - tabA_beforeReverse})`);

    if (reverseSynced) {
      console.log(`  ✗ FAIL — Tab A also auto-received Tab B's messages!`);
    } else {
      console.log(`  ✓ PASS — Tab A unchanged when Tab B sent a message.`);
    }

    results.push({
      round: messages.length + 1,
      tabA_message: '(passive)',
      tabA_aiResponse: '',
      tabA_bubbleCountBefore: tabA_beforeReverse,
      tabA_bubbleCountAfter: tabA_afterReverse,
      tabB_bubbleCountBefore: tabB_beforeReverse,
      tabB_bubbleCountAfter: tabB_afterReverse,
      tabB_newBubbles: tabA_newBubbles.map(t => t.substring(0, 150)),
      tabB_synced: reverseSynced,
      tabB_newBubbleCount: tabA_afterReverse - tabA_beforeReverse,
      status: reverseSynced ? 'FAIL' : 'PASS',
      severity: reverseSynced ? 'CRITICAL' : 'INFO',
      timestamp: new Date().toISOString(),
    });

    await context.close();

  } finally {
    await browser.close();
  }

  // ── Summary ──────────────────────────────────────────────
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const anySync = results.some(r => r.tabB_synced);

  console.log(`\n╔═════════════════════════════════════════════════════════════╗`);
  console.log(`║  FINAL RESULTS                                               ║`);
  console.log(`║  PASS (independent tabs): ${String(passed).padEnd(35)}║`);
  console.log(`║  FAIL (shared stream)   : ${String(failed).padEnd(35)}║`);
  console.log(`╚═════════════════════════════════════════════════════════════╝\n`);

  if (anySync) {
    console.log(`⚠ FINDING: Tabs ARE sharing a live conversation stream.`);
    console.log(`  When the same user opens 2 tabs on the same chat page:`);
    console.log(`  → Messages sent in Tab A automatically appear in Tab B`);
    console.log(`  → Both tabs are viewing the SAME conversation`);
    console.log(`  → This is expected behavior if the app designed it this way,`);
    console.log(`    but may surprise users who expected independent chat sessions.\n`);
  } else {
    console.log(`✓ FINDING: Tabs are INDEPENDENT — each tab has its own conversation.`);
    console.log(`  Tab A's messages do NOT appear in Tab B and vice versa.\n`);
  }

  const report = {
    testType: 'same-user-dual-tab-real-time-sync',
    agent: AGENT_ARG,
    agentPath,
    user: user.email,
    question: 'When Tab A sends a message, does Tab B automatically receive it?',
    finding: anySync
      ? 'SHARED_STREAM: both tabs show the same live conversation'
      : 'INDEPENDENT: each tab has its own separate conversation',
    passed,
    failed,
    results,
    generatedAt: new Date().toISOString(),
  };

  const reportPath = join(process.cwd(), `reports/${AGENT_ARG}-tab-sync-results.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report saved → ${reportPath}`);
}

main().catch(console.error);
