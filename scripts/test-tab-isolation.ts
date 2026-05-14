/**
 * Same-User Dual-Tab Isolation Test
 *
 * Tests whether the SAME user opening 2 browser tabs simultaneously
 * causes any cross-contamination between their chat sessions.
 *
 * Scenario:
 *   - One user logs in
 *   - Tab A: user chats, establishes specific context / data
 *   - Tab B: SAME user in a SECOND tab, asks if it knows Tab A's context
 *   - Verify: Tab B sees NOTHING from Tab A's conversation
 *
 * Also tests concurrent messaging:
 *   - Both tabs send different messages at the same time
 *   - Verify each tab gets its own correct, non-mixed response
 *
 * Usage:
 *   npx tsx scripts/test-tab-isolation.ts --agent maya
 *   npx tsx scripts/test-tab-isolation.ts --agent oscar
 *   npx tsx scripts/test-tab-isolation.ts --agent daniel
 *   npx tsx scripts/test-tab-isolation.ts           (defaults to maya)
 */

import { chromium, Browser, BrowserContext, Page } from '@playwright/test';
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
  cody: '/ai-team/seo/chat',
};

const agentPath = AGENT_PATHS[AGENT_ARG];
if (!agentPath) {
  console.error(`Unknown agent: ${AGENT_ARG}. Use: maya, oscar, daniel, cody`);
  process.exit(1);
}

// ── Load test user (single user, 2 tabs) ─────────────────────
interface TestUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

const usersData = JSON.parse(
  readFileSync(join(process.cwd(), 'data/test-users.json'), 'utf-8')
);
const user: TestUser = usersData.users[0]; // Same user for both tabs

console.log(`\nTest user: ${user.email}`);

// ── Isolation test scenarios (same user, 2 tabs) ─────────────
interface TabScenario {
  id: string;
  name: string;
  description: string;
  /** Tab A sends this first to establish unique context */
  tabA_setup: string;
  /** Tab B then asks this — should get NO knowledge of Tab A's context */
  tabB_probe: string;
  /** Returns true if isolation is maintained (no leakage) */
  checkIsolation: (tabAResponse: string, tabBResponse: string) => {
    isolated: boolean;
    reason: string;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  };
}

function getScenarios(): TabScenario[] {
  if (AGENT_ARG === 'oscar') {
    return [
      {
        id: 'TAB-01',
        name: 'Warehouse filter context isolation',
        description: 'Tab A sets a warehouse filter; Tab B should not inherit it',
        tabA_setup: 'I only want to see inventory from our Dallas warehouse from now on. Filter everything to Dallas.',
        tabB_probe: 'What filters or preferences are active in my current session?',
        checkIsolation: (a, b) => {
          const leaked = b.toLowerCase().includes('dallas');
          return {
            isolated: !leaked,
            reason: leaked ? 'Tab B inherited Tab A Dallas warehouse filter' : 'No filter leakage detected',
            severity: 'HIGH',
          };
        },
      },
      {
        id: 'TAB-02',
        name: 'Urgent order context isolation',
        description: 'Tab A marks a fake order as urgent; Tab B should not know',
        tabA_setup: 'I need to mark order #TABTEST-7777 as top priority. This is extremely urgent.',
        tabB_probe: 'Are there any priority orders or urgent orders I should know about?',
        checkIsolation: (a, b) => {
          const leaked = b.toLowerCase().includes('tabtest-7777') || b.toLowerCase().includes('7777');
          return {
            isolated: !leaked,
            reason: leaked ? 'Tab B saw Tab A urgent order #TABTEST-7777' : 'No leakage detected',
            severity: 'HIGH',
          };
        },
      },
      {
        id: 'TAB-03',
        name: 'Concurrent different queries — response isolation',
        description: 'Both tabs send different messages at the same time; responses must not mix',
        tabA_setup: 'Show me my top 5 selling products by revenue.',
        tabB_probe: 'How many total orders are pending fulfillment?',
        checkIsolation: (a, b) => {
          // Tab A's response should be about top sellers, not pending orders
          // Tab B's response should be about pending orders, not top sellers
          const aAboutTabB = a.toLowerCase().includes('pending') && a.toLowerCase().includes('fulfillment');
          const bAboutTabA = b.toLowerCase().includes('top 5') && b.toLowerCase().includes('selling');
          const mixed = aAboutTabB || bAboutTabA;
          return {
            isolated: !mixed,
            reason: mixed
              ? 'Response mixing detected: tabs received each other\'s answers'
              : 'Both tabs received appropriate independent responses',
            severity: 'CRITICAL',
          };
        },
      },
      {
        id: 'TAB-04',
        name: 'Tab A conversation history not visible in Tab B',
        description: 'After a full conversation in Tab A, Tab B should see a fresh session',
        tabA_setup: 'I want to analyze the performance of supplier ABC-SUPPLIER-XYZ. They deliver to our Chicago hub.',
        tabB_probe: 'What have we discussed so far in this conversation? Summarize our chat history.',
        checkIsolation: (a, b) => {
          const leaked =
            b.toLowerCase().includes('abc-supplier-xyz') ||
            b.toLowerCase().includes('chicago') ||
            b.toLowerCase().includes('supplier');
          return {
            isolated: !leaked,
            reason: leaked
              ? 'Tab B has access to Tab A conversation about ABC-SUPPLIER-XYZ'
              : 'Tab B shows no history from Tab A',
            severity: 'CRITICAL',
          };
        },
      },
      {
        id: 'TAB-05',
        name: 'Confidential note isolation',
        description: 'Tab A shares confidential info; Tab B should not see it',
        tabA_setup: 'Note: our contract renewal with MegaShip logistics is due on June 30. The renewal price is $240,000. Keep this confidential.',
        tabB_probe: 'Do you have any notes or context from my previous messages or other sessions?',
        checkIsolation: (a, b) => {
          const leaked =
            b.toLowerCase().includes('240,000') ||
            b.toLowerCase().includes('megaship') ||
            b.toLowerCase().includes('june 30');
          return {
            isolated: !leaked,
            reason: leaked
              ? 'CRITICAL: Tab B exposed Tab A confidential contract data'
              : 'Confidential data properly isolated',
            severity: 'CRITICAL',
          };
        },
      },
    ];
  }

  if (AGENT_ARG === 'daniel') {
    return [
      {
        id: 'TAB-01',
        name: 'Pricing strategy context isolation',
        description: 'Tab A sets a secret pricing scenario; Tab B should not inherit it',
        tabA_setup: 'I am running a secret pricing test on SKU-TABTEST-001. Our target margin is 78% for this experiment.',
        tabB_probe: 'Are there any active pricing tests or margin targets set in this session?',
        checkIsolation: (a, b) => {
          const leaked =
            b.toLowerCase().includes('tabtest-001') || b.toLowerCase().includes('78%');
          return {
            isolated: !leaked,
            reason: leaked ? 'Tab B saw Tab A secret pricing experiment' : 'No leakage detected',
            severity: 'HIGH',
          };
        },
      },
      {
        id: 'TAB-02',
        name: 'COGS data isolation',
        description: 'Tab A shares confidential cost data; Tab B should not see it',
        tabA_setup: 'Our COGS for Product-SECRET-X is $8.77 per unit. This is internal data only.',
        tabB_probe: 'Has anyone shared cost or COGS data in this session? What do you know about product costs?',
        checkIsolation: (a, b) => {
          const leaked = b.toLowerCase().includes('8.77') || b.toLowerCase().includes('secret-x');
          return {
            isolated: !leaked,
            reason: leaked ? 'Tab B exposed Tab A COGS data' : 'COGS data properly isolated',
            severity: 'CRITICAL',
          };
        },
      },
      {
        id: 'TAB-03',
        name: 'Concurrent margin queries — response isolation',
        description: 'Both tabs ask different margin questions simultaneously; answers must not mix',
        tabA_setup: 'What is the gross margin for our highest-priced SKU?',
        tabB_probe: 'Which SKU has the lowest gross margin right now?',
        checkIsolation: (a, b) => {
          // Both should get relevant but different answers about different SKUs
          // Check they're not identical (which would indicate caching/mixing)
          const identical = a.substring(0, 100) === b.substring(0, 100);
          return {
            isolated: !identical,
            reason: identical
              ? 'Both tabs received identical responses (possible cross-contamination)'
              : 'Each tab received its own independent response',
            severity: 'HIGH',
          };
        },
      },
      {
        id: 'TAB-04',
        name: 'Conversation history isolation',
        description: 'Tab A builds a multi-turn context; Tab B starts fresh',
        tabA_setup: 'The competitor brand CodexBrand is selling at $34.99. I want to undercut by 15%. What should my price be?',
        tabB_probe: 'Summarize what we have discussed so far. What context do you have from this session?',
        checkIsolation: (a, b) => {
          const leaked =
            b.toLowerCase().includes('codexbrand') ||
            b.toLowerCase().includes('34.99') ||
            b.toLowerCase().includes('undercut');
          return {
            isolated: !leaked,
            reason: leaked
              ? 'Tab B knows about Tab A competitor pricing discussion'
              : 'Tab B has no memory of Tab A conversation',
            severity: 'CRITICAL',
          };
        },
      },
      {
        id: 'TAB-05',
        name: 'Forecast assumption isolation',
        description: 'Tab A sets a custom forecast; Tab B should use default assumptions',
        tabA_setup: 'For all my forecasting, assume a 30% increase in material costs and 20% drop in demand. Use these custom assumptions.',
        tabB_probe: 'What assumptions are you using for my forecasts and projections?',
        checkIsolation: (a, b) => {
          const leaked =
            (b.toLowerCase().includes('30%') && b.toLowerCase().includes('material')) ||
            (b.toLowerCase().includes('20%') && b.toLowerCase().includes('demand'));
          return {
            isolated: !leaked,
            reason: leaked
              ? 'Tab B inherited Tab A custom forecast assumptions'
              : 'Tab B uses default assumptions, no inheritance from Tab A',
            severity: 'HIGH',
          };
        },
      },
    ];
  }

  // Maya (marketing) — default
  return [
    {
      id: 'TAB-01',
      name: 'Campaign context isolation',
      description: 'Tab A creates a campaign plan; Tab B should not know about it',
      tabA_setup: 'I am planning a secret campaign called Project SOLSTICE launching July 4. Keep this confidential. Help me draft messaging.',
      tabB_probe: 'What campaigns or projects are we currently working on? Do you have any context from this conversation?',
      checkIsolation: (a, b) => {
        const leaked = b.toLowerCase().includes('solstice') || b.toLowerCase().includes('july 4');
        return {
          isolated: !leaked,
          reason: leaked
            ? 'Tab B knows about Tab A secret campaign Project SOLSTICE'
            : 'No campaign leakage detected',
          severity: 'CRITICAL',
        };
      },
    },
    {
      id: 'TAB-02',
      name: 'Brand voice setting isolation',
      description: 'Tab A sets a unique brand voice; Tab B should use default behavior',
      tabA_setup: 'From now on, write everything in pirate speak. My brand voice is "Pirate Captain" — use arrr, matey, etc.',
      tabB_probe: 'How should you write content for me? What is my brand voice?',
      checkIsolation: (a, b) => {
        const leaked =
          b.toLowerCase().includes('pirate') ||
          b.toLowerCase().includes('arrr') ||
          b.toLowerCase().includes('matey');
        return {
          isolated: !leaked,
          reason: leaked
            ? 'Tab B inherited Tab A pirate brand voice setting'
            : 'Brand voice correctly isolated per tab',
          severity: 'HIGH',
        };
      },
    },
    {
      id: 'TAB-03',
      name: 'Concurrent content generation — response isolation',
      description: 'Both tabs request different content simultaneously; must not mix',
      tabA_setup: 'Write me a product description for a luxury scented candle.',
      tabB_probe: 'Write me a product description for industrial-grade safety boots.',
      checkIsolation: (a, b) => {
        // Tab A should be about candles, Tab B about boots
        const aAboutBoots = a.toLowerCase().includes('boot') || a.toLowerCase().includes('safety');
        const bAboutCandle = b.toLowerCase().includes('candle') || b.toLowerCase().includes('scented');
        const mixed = aAboutBoots || bAboutCandle;
        return {
          isolated: !mixed,
          reason: mixed
            ? 'Response mixing: Tab A got boot content or Tab B got candle content'
            : 'Each tab received its own correct independent response',
          severity: 'CRITICAL',
        };
      },
    },
    {
      id: 'TAB-04',
      name: 'Budget data isolation',
      description: 'Tab A shares a specific budget; Tab B should not see it',
      tabA_setup: 'Our Q3 marketing budget is $185,000. Allocate 50% Facebook, 30% email, 20% TikTok. This is strictly internal.',
      tabB_probe: 'What budget data or spending information do you have about my account?',
      checkIsolation: (a, b) => {
        const leaked = b.toLowerCase().includes('185,000') || b.toLowerCase().includes('185000');
        return {
          isolated: !leaked,
          reason: leaked
            ? 'Tab B exposed Tab A budget of $185,000'
            : 'Budget data properly isolated',
          severity: 'CRITICAL',
        };
      },
    },
    {
      id: 'TAB-05',
      name: 'Conversation history isolation',
      description: 'Tab B should see a completely fresh chat with no Tab A history',
      tabA_setup: 'I am working on a summer campaign for my brand HydraGlow Skincare. Target demographic: women 25-40, budget $75k.',
      tabB_probe: 'Summarize our conversation so far. What do you know about my business and campaigns?',
      checkIsolation: (a, b) => {
        const leaked =
          b.toLowerCase().includes('hydraglow') ||
          b.toLowerCase().includes('75k') ||
          b.toLowerCase().includes('75,000');
        return {
          isolated: !leaked,
          reason: leaked
            ? 'Tab B has full access to Tab A HydraGlow conversation history'
            : 'Tab B starts with a clean session, no Tab A history',
          severity: 'CRITICAL',
        };
      },
    },
  ];
}

// ── Helpers ──────────────────────────────────────────────────
async function loginUser(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
  await page.fill('input[type="email"], input[name="email"]', user.email);
  await page.fill('input[type="password"], input[name="password"]', user.password);
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 5000 });
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|home|ai-training|analytics|onboarding/, { timeout: 30000 });
  console.log(`  ✓ Logged in as ${user.email}`);
}

async function navigateToAgent(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}${agentPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
}

/**
 * Send a message and wait for the AI to respond.
 * Returns the full text of the last AI bubble.
 */
async function sendAndWait(page: Page, message: string, timeoutSec = 60): Promise<string> {
  // Wait for textarea to be enabled (not disabled during AI response)
  await page.waitForSelector('textarea:not([disabled])', { timeout: 60000 });

  // Get snapshot of current AI bubbles before sending
  const snapshotBefore: string[] = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[class*="rounded-2xl"]'))
      .filter(b => !b.className.includes('purple'))
      .map(b => (b as HTMLElement).textContent?.trim().substring(0, 80) || '');
  });

  // Find and fill the textarea
  const textarea = page.locator('textarea:not([disabled])').first();
  await textarea.fill(message);

  // Press Enter or click send button
  await textarea.press('Enter');

  // Wait for a new AI response to appear
  const startTime = Date.now();
  let lastResponse = '';

  while (Date.now() - startTime < timeoutSec * 1000) {
    await page.waitForTimeout(1500);

    const currentBubbles: string[] = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll('[class*="rounded-2xl"]'));
      return bubbles
        .filter(b => !b.className.includes('purple'))
        .map(b => (b as HTMLElement).textContent?.trim()
          .replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i, '').trim() || '');
    });

    // Find new bubbles not in snapshot
    const newBubbles = currentBubbles.filter(
      b => b.length > 15 && !snapshotBefore.some(s => s === b.substring(0, 80))
    );

    if (newBubbles.length > 0) {
      lastResponse = newBubbles[newBubbles.length - 1];
      // Wait a bit more to ensure response is complete
      await page.waitForTimeout(3000);
      // Re-read final response
      const final: string[] = await page.evaluate(() => {
        const bubbles = Array.from(document.querySelectorAll('[class*="rounded-2xl"]'));
        return bubbles
          .filter(b => !b.className.includes('purple'))
          .map(b => (b as HTMLElement).textContent?.trim()
            .replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i, '').trim() || '');
      });
      const finalNew = final.filter(
        b => b.length > 15 && !snapshotBefore.some(s => s === b.substring(0, 80))
      );
      if (finalNew.length > 0) lastResponse = finalNew[finalNew.length - 1];
      break;
    }
  }

  return lastResponse;
}

// ── Result types ─────────────────────────────────────────────
interface ScenarioResult {
  id: string;
  name: string;
  description: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'ERROR';
  tabA_message: string;
  tabB_message: string;
  tabA_response: string;
  tabB_response: string;
  isolated: boolean;
  reason: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  error?: string;
  timestamp: string;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  const scenarios = getScenarios();

  console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
  console.log(`║  SAME-USER DUAL-TAB ISOLATION TEST                        ║`);
  console.log(`║  Agent : ${AGENT_ARG.toUpperCase().padEnd(51)}║`);
  console.log(`║  User  : ${user.email.padEnd(51)}║`);
  console.log(`║  Setup : One user, two browser tabs, same agent           ║`);
  console.log(`║  Goal  : Verify chat sessions do NOT cross-contaminate    ║`);
  console.log(`║  Tests : ${String(scenarios.length).padEnd(51)}║`);
  console.log(`╚═══════════════════════════════════════════════════════════╝\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const results: ScenarioResult[] = [];

  try {
    // ── Phase 1: Login once, share the same browser context ──
    // Same context = same cookies = same logged-in user
    console.log('Phase 1: Logging in...');
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });

    const tabA: Page = await context.newPage();
    await loginUser(tabA);
    await navigateToAgent(tabA);

    // Open Tab B in the SAME context (same session cookies)
    console.log('  Opening Tab B in same session context...');
    const tabB: Page = await context.newPage();
    await navigateToAgent(tabB);
    console.log('  ✓ Both tabs ready — same user, same agent, separate chat windows\n');

    // ── Phase 2: Run scenarios ────────────────────────────────
    console.log(`Phase 2: Running ${scenarios.length} tab-isolation scenarios...\n`);

    for (const scenario of scenarios) {
      console.log(`─── ${scenario.id}: ${scenario.name} ───`);
      console.log(`    ${scenario.description}`);

      try {
        let tabAResponse: string;
        let tabBResponse: string;

        if (scenario.id === 'TAB-03') {
          // Concurrent test: both tabs send at the same time
          console.log(`  [CONCURRENT] Both tabs sending simultaneously...`);
          console.log(`  Tab A → "${scenario.tabA_setup.substring(0, 70)}..."`);
          console.log(`  Tab B → "${scenario.tabB_probe.substring(0, 70)}..."`);

          [tabAResponse, tabBResponse] = await Promise.all([
            sendAndWait(tabA, scenario.tabA_setup, 60),
            sendAndWait(tabB, scenario.tabB_probe, 60),
          ]);
        } else {
          // Sequential: Tab A first, then Tab B probes
          console.log(`  Tab A → "${scenario.tabA_setup.substring(0, 70)}..."`);
          tabAResponse = await sendAndWait(tabA, scenario.tabA_setup, 60);
          console.log(`  Tab A ← ${tabAResponse.length} chars received`);

          // Wait 3s to allow any shared state to propagate (worst case)
          await tabB.waitForTimeout(3000);

          console.log(`  Tab B → "${scenario.tabB_probe.substring(0, 70)}..."`);
          tabBResponse = await sendAndWait(tabB, scenario.tabB_probe, 60);
          console.log(`  Tab B ← ${tabBResponse.length} chars received`);
        }

        const { isolated, reason, severity } = scenario.checkIsolation(tabAResponse, tabBResponse);

        results.push({
          id: scenario.id,
          name: scenario.name,
          description: scenario.description,
          status: isolated ? 'PASS' : 'FAIL',
          tabA_message: scenario.tabA_setup,
          tabB_message: scenario.tabB_probe,
          tabA_response: tabAResponse.substring(0, 400),
          tabB_response: tabBResponse.substring(0, 400),
          isolated,
          reason,
          severity,
          timestamp: new Date().toISOString(),
        });

        const icon = isolated ? '✓ PASS' : '✗ FAIL';
        console.log(`  Result  : ${icon} — ${reason}`);
        if (!isolated) console.log(`  Severity: ${severity}`);

      } catch (err: any) {
        results.push({
          id: scenario.id,
          name: scenario.name,
          description: scenario.description,
          status: 'ERROR',
          tabA_message: scenario.tabA_setup,
          tabB_message: scenario.tabB_probe,
          tabA_response: '',
          tabB_response: '',
          isolated: false,
          reason: err.message,
          severity: 'HIGH',
          error: err.message,
          timestamp: new Date().toISOString(),
        });
        console.log(`  ERROR: ${err.message}`);
      }

      console.log();
      // Wait for both tabs' textareas to be re-enabled before next scenario
      await Promise.allSettled([
        tabA.waitForSelector('textarea:not([disabled])', { timeout: 30000 }),
        tabB.waitForSelector('textarea:not([disabled])', { timeout: 30000 }),
      ]);
      await tabA.waitForTimeout(2000);
    }

    // ── Phase 3: New tab in same context — fresh chat? ────────
    console.log(`─── BONUS: New tab opened in same session — is chat fresh? ───`);
    const tabC: Page = await context.newPage();
    await navigateToAgent(tabC);
    await tabC.waitForTimeout(2000);

    const freshProbeQ =
      AGENT_ARG === 'oscar'
        ? 'What have we talked about in this conversation? Summarize my previous messages.'
        : AGENT_ARG === 'daniel'
        ? 'What pricing or margin data have we discussed? Summarize this session.'
        : 'Summarize our conversation — what campaigns or plans have we discussed?';

    console.log(`  New Tab C → "${freshProbeQ.substring(0, 70)}..."`);
    const freshResponse = await sendAndWait(tabC, freshProbeQ, 45);
    console.log(`  New Tab C ← ${freshResponse.length} chars`);
    console.log(`  Preview: ${freshResponse.substring(0, 150)}...`);

    // A fresh tab should say there's no history
    const hasNoHistory =
      freshResponse.toLowerCase().includes("haven't") ||
      freshResponse.toLowerCase().includes("don't have") ||
      freshResponse.toLowerCase().includes('no conversation') ||
      freshResponse.toLowerCase().includes('no previous') ||
      freshResponse.toLowerCase().includes('just started') ||
      freshResponse.toLowerCase().includes('new conversation') ||
      freshResponse.length < 80;

    results.push({
      id: 'TAB-BONUS',
      name: 'New tab starts fresh — no chat history carried over',
      description: 'Opening a brand-new tab should give a clean session with no conversation history',
      status: hasNoHistory ? 'PASS' : 'WARN',
      tabA_message: '(previous scenarios in Tab A and Tab B)',
      tabB_message: freshProbeQ,
      tabA_response: '',
      tabB_response: freshResponse.substring(0, 400),
      isolated: hasNoHistory,
      reason: hasNoHistory
        ? 'New tab correctly started a fresh session'
        : 'New tab may have access to some session context — review response',
      severity: 'MEDIUM',
      timestamp: new Date().toISOString(),
    });

    console.log(`  Result: ${hasNoHistory ? '✓ PASS — fresh session' : '⚠ WARN — review response'}\n`);

    await context.close();

  } finally {
    await browser.close();
  }

  // ── Summary ──────────────────────────────────────────────
  const passed  = results.filter(r => r.status === 'PASS').length;
  const failed  = results.filter(r => r.status === 'FAIL').length;
  const warned  = results.filter(r => r.status === 'WARN').length;
  const errors  = results.filter(r => r.status === 'ERROR').length;
  const critFails = results.filter(r => r.status === 'FAIL' && r.severity === 'CRITICAL').length;

  console.log(`╔═══════════════════════════════════════════════════════════╗`);
  console.log(`║  FINAL RESULTS                                            ║`);
  console.log(`║  PASS  : ${String(passed).padEnd(51)}║`);
  console.log(`║  FAIL  : ${String(failed).padEnd(51)}║`);
  console.log(`║  WARN  : ${String(warned).padEnd(51)}║`);
  console.log(`║  ERROR : ${String(errors).padEnd(51)}║`);
  if (critFails > 0) {
    console.log(`║  ⚠ CRITICAL isolation failures: ${String(critFails).padEnd(27)}║`);
  }
  console.log(`╚═══════════════════════════════════════════════════════════╝\n`);

  // ── Save report ──────────────────────────────────────────
  const report = {
    testType: 'same-user-dual-tab-isolation',
    agent: AGENT_ARG,
    agentPath,
    user: user.email,
    description: 'Same user opens 2 browser tabs simultaneously; verifies chat sessions do not cross-contaminate',
    totalScenarios: results.length,
    passed,
    failed,
    warned,
    errors,
    criticalFails: critFails,
    overallResult: failed === 0 && errors === 0 ? 'PASS' : 'FAIL',
    results,
    generatedAt: new Date().toISOString(),
  };

  const reportPath = join(process.cwd(), `reports/${AGENT_ARG}-tab-isolation-results.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report saved → ${reportPath}`);

  if (critFails > 0) {
    console.log(`\n⚠ WARNING: ${critFails} CRITICAL isolation failures found!`);
    console.log('  Sessions are leaking data between tabs for the same user.');
    console.log('  This is a serious security and UX issue.\n');
  } else if (failed === 0) {
    console.log(`\n✓ All isolation checks passed. Sessions are properly isolated per tab.\n`);
  }
}

main().catch(console.error);
