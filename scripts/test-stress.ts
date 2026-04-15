/**
 * ST — Stress Test
 *
 * Pushes the AI agent to its limits with:
 *   S1: Rapid-fire burst — 10 questions as fast as possible, measure response times
 *   S2: Long conversation marathon — 25+ turns in one session, check quality degradation
 *   S3: Large input stress — extremely long messages (500-2000+ chars)
 *   S4: Concurrent marathon — all users doing 10-turn conversations simultaneously
 *   S5: Recovery test — intentionally trigger edge cases then verify agent recovers
 *   S6: Response latency benchmark — 15 standard questions, measure P50/P95/P99
 *
 * Usage:
 *   npx tsx scripts/test-stress.ts --agent maya
 *   npx tsx scripts/test-stress.ts --agent oscar
 *   npx tsx scripts/test-stress.ts --agent daniel
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
  daniel: '/ai-team/profit/chat',
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
const users: TestUser[] = usersData.users.slice(0, 4);

// ── Agent-specific question banks ───────────────────────────
const QUESTIONS: Record<string, string[]> = {
  maya: [
    'What color scheme works best for a luxury fashion brand?',
    'How do I improve my email open rates?',
    'Suggest 3 Instagram caption ideas for a summer sale',
    'What is A/B testing and how do I use it for my ads?',
    'Help me plan a content calendar for next month',
    'What social media ad strategy should I use for my new product launch?',
    'How do retargeting ads work?',
    'What hashtags should I use for my winter collection?',
    'Write a product description for a handmade candle',
    'How often should I post on social media?',
    'How do I build a referral program?',
    'What is influencer marketing?',
    'Help me design an email newsletter layout',
    'What makes a high-converting landing page?',
    'How do I grow my email subscriber list?',
  ],
  oscar: [
    'What are my top 5 selling products?',
    'How many orders are pending?',
    'Show me my inventory summary',
    'What is my fulfillment rate?',
    'Which products are below safety stock?',
    'How should I optimize my warehouse layout?',
    'What SKUs need reordering now?',
    'Show me last week order trends',
    'How do I reduce my shipping costs?',
    'What is my current return rate?',
    'How do I handle backorders?',
    'What is my average order processing time?',
    'Show me my supplier lead times',
    'How do I improve my inventory turnover?',
    'What quality control checks should I do?',
  ],
  daniel: [
    'What is my gross margin percentage?',
    'What is the difference between markup and margin?',
    'How do I calculate the break-even point?',
    'What is contribution margin?',
    'Show me my top 5 highest margin SKUs',
    'What is COGS and how is it calculated?',
    'How do landed costs affect my margin?',
    'What is a loss leader strategy?',
    'Compare FIFO vs LIFO for my inventory',
    'What is my operating margin?',
    'How do I calculate weighted average margin?',
    'What is price elasticity?',
    'How do returns affect my margin?',
    'What is the difference between fixed and variable costs?',
    'How do I improve my net margin?',
  ],
};

const LONG_INPUTS: Record<string, string[]> = {
  maya: [
    'I have a Shopify store that sells handmade jewelry. My target audience is women aged 25-45 who value sustainable and ethically sourced materials. I currently sell through Instagram and my website but my conversion rate is only 1.2%. My average order value is $65 and I spend about $500/month on Facebook ads with a ROAS of 1.8. I also have an email list of 2,000 subscribers but my open rate is only 12%. My biggest competitor seems to be doing well on Pinterest and TikTok but I have not tried those channels yet. I want to increase my revenue by 50% in the next 6 months. Can you create a comprehensive marketing strategy that covers all channels, budget allocation, content strategy, and specific tactics I should implement week by week? Also suggest KPIs I should track for each channel.',
    'Write me a complete brand story for my organic skincare line. The brand is called "PureGlow" and was founded by a biochemist who struggled with sensitive skin. We use only plant-based ingredients sourced from small farms in Oregon and Vermont. Our hero product is a vitamin C serum that took 3 years to formulate. We are cruelty-free, vegan, and use 100% recyclable packaging. Our customers are health-conscious millennials who read ingredient labels and prefer small batch products over mass-produced alternatives. The brand story should work for our website about page, social media bios, email welcome sequence, and packaging inserts. Make it emotional, authentic, and differentiated from competitors like Drunk Elephant and The Ordinary.',
    'I need you to analyze my current marketing performance and suggest improvements. Here is my data: Last month we had 45,000 website visitors (35% organic, 25% paid, 20% social, 15% email, 5% direct). Our bounce rate is 62%. Average session duration is 1:45. We have 12,000 Instagram followers with 2.1% engagement rate, 3,500 TikTok followers with 8.5% engagement rate, and 8,000 Facebook page likes with 0.8% engagement rate. Email metrics: 18,000 subscribers, 22% open rate, 2.8% click rate, 0.3% unsubscribe rate. Paid ads: $3,000/month on Meta with 2.1 ROAS, $1,500/month on Google with 3.2 ROAS. Average CAC is $28 and customer LTV is $120. How do I optimize each channel?',
  ],
  oscar: [
    'I run a medium-sized e-commerce warehouse with 3,500 SKUs across 6 product categories: electronics (800 SKUs), apparel (1,200 SKUs), home goods (600 SKUs), beauty (400 SKUs), sports equipment (300 SKUs), and books (200 SKUs). My warehouse is 15,000 square feet with 3 zones: bulk storage, pick-and-pack, and a returns processing area. I currently have 8 warehouse staff working two shifts. Last month we processed 4,200 orders with an average of 2.3 items per order. Our pick accuracy is 96.2% and our same-day ship rate is only 78%. I have 234 SKUs below safety stock right now and 89 SKUs with zero inventory. I need a comprehensive operations improvement plan covering warehouse layout optimization, staffing schedules, inventory replenishment strategy, and quality control processes. What should I prioritize?',
    'We are experiencing a significant increase in customer returns. Last quarter our return rate jumped from 8% to 14.5%. The breakdown is: wrong item shipped (3.2%), damaged in transit (2.8%), product not as described (4.1%), changed mind (3.5%), and defective product (0.9%). Our current return processing takes an average of 5.2 business days from when the customer initiates the return to when they receive their refund. This is causing a spike in negative reviews and customer complaints. I need you to help me create a detailed return reduction and processing improvement plan that addresses each category of returns with specific actionable steps, estimated timelines, and expected impact on the return rate.',
    'Please help me create a complete inventory management strategy for the upcoming holiday season (November-December). Last year we had these issues: 32 SKUs stocked out during Black Friday week, 156 SKUs were overstocked by January with $45,000 in excess inventory that we had to markdown at 40% off. Our supplier lead times range from 2 weeks (domestic) to 8 weeks (international). We have 4 main suppliers and our warehouse has capacity for about 20% more inventory than our current levels. I need a detailed plan including demand forecasting approach, reorder point calculations, safety stock recommendations by category, supplier order schedule, and contingency plans for supply chain disruptions. Also include a phased plan for post-holiday inventory wind-down.',
  ],
  daniel: [
    'I operate a DTC brand with 150 SKUs selling through three channels: our Shopify store (55% of revenue), Amazon FBA (35% of revenue), and wholesale to 12 retail partners (10% of revenue). My overall gross margin is 42% but it varies significantly by channel: Shopify margin is 58%, Amazon margin is 31% (after FBA fees, referral fees, and PPC), and wholesale margin is 28%. My top 10 SKUs generate 60% of total revenue but only 45% of total gross profit. COGS has increased 18% over the past year due to raw material inflation and increased shipping from Asia. I also have $200K in slow-moving inventory that has been sitting for over 180 days. Can you provide a comprehensive profitability analysis with specific recommendations for improving margins across each channel, a SKU rationalization strategy, and a plan to deal with the slow-moving inventory?',
    'I need a detailed margin analysis comparing these pricing strategies for my flagship product: Option A - current price $89 with $35 COGS and 60.7% margin, selling 800 units/month. Option B - reduce price to $69 (22% discount) expecting 40% volume increase to 1,120 units/month. Option C - increase price to $109 (22% increase) expecting 25% volume decrease to 600 units/month. Option D - introduce a premium bundle at $149 that includes the main product plus accessories (additional $15 COGS) expecting 200 units/month while maintaining current standalone sales at 700 units. For each option calculate: total revenue, total gross profit, gross margin percentage, contribution margin per unit, break-even volume, and incremental profit vs current. Also factor in that my fixed costs are $15,000/month and my variable costs beyond COGS are $5 per unit for packaging and fulfillment. Which option maximizes total profit?',
    'My business has 3 product lines. Product Line A: 50 SKUs, average price $45, average COGS $22, sells 5,000 units/month, return rate 5%. Product Line B: 60 SKUs, average price $85, average COGS $40, sells 2,000 units/month, return rate 12%. Product Line C: 40 SKUs, average price $25, average COGS $10, sells 10,000 units/month, return rate 3%. My overhead costs are $50,000/month allocated equally across lines. Warehouse costs are $3 per unit stored. I hold an average of 2 months inventory per SKU. Product Line B has the highest margin per unit but also the highest return rate and storage cost. Product Line C has the lowest margin per unit but the highest volume and lowest returns. I am considering discontinuing Product Line B. Should I? Give me a full analysis including true profitability of each line after returns, storage costs, overhead allocation, and opportunity cost. What would happen to overall profitability if I reallocated Product Line B resources to A and C?',
  ],
};

// ── Marathon conversation turns ─────────────────────────────
const MARATHON_TURNS: Record<string, string[]> = {
  maya: [
    'I sell handmade candles online.',
    'My target audience is women aged 25-40.',
    'What social media platform should I focus on?',
    'How often should I post there?',
    'What kind of content works best for candles?',
    'Should I use video or photos?',
    'How much should I spend on ads per month?',
    'What about email marketing?',
    'How do I grow my email list?',
    'What subject lines get the best open rates?',
    'Should I offer discounts or not?',
    'How do I handle negative reviews?',
    'What is a good conversion rate?',
    'How do I improve my SEO?',
    'Should I start a blog?',
    'What about influencer partnerships?',
    'How do I measure ROI on marketing spend?',
    'What tools do you recommend for analytics?',
    'How do I create a marketing budget?',
    'Can you summarize everything we discussed?',
    'What should I prioritize first?',
    'Create a 30-day action plan based on our discussion.',
    'What KPIs should I track weekly?',
    'How do I know when to scale up my ad spend?',
    'Any final tips for a small candle business?',
  ],
  oscar: [
    'I have a warehouse with 2,000 SKUs.',
    'My biggest problem is stockouts.',
    'How do I calculate safety stock?',
    'What data do I need for demand forecasting?',
    'My lead time from suppliers is 3 weeks.',
    'How often should I reorder?',
    'What is an EOQ calculation?',
    'How do I handle seasonal demand spikes?',
    'My pick accuracy is only 94%.',
    'What processes improve pick accuracy?',
    'How do I organize my warehouse zones?',
    'What about FIFO vs LIFO for perishables?',
    'My fulfillment rate is 82%. Is that good?',
    'How do I get it above 95%?',
    'What shipping carriers offer the best rates?',
    'How do I reduce return processing time?',
    'What KPIs should I track daily?',
    'How do I train new warehouse staff?',
    'What about barcode scanning systems?',
    'How do I handle damaged inventory?',
    'What is cycle counting?',
    'Create an inventory audit schedule.',
    'How do I manage multi-warehouse inventory?',
    'Summarize all the improvements we discussed.',
    'What should I implement first?',
  ],
  daniel: [
    'My store has 100 products.',
    'Average gross margin is about 35%.',
    'That feels low. What should I aim for?',
    'How do I identify low-margin SKUs?',
    'What is a good COGS ratio?',
    'My shipping costs are eating into margins.',
    'How do I calculate landed cost per unit?',
    'Should I raise prices or cut costs?',
    'How do I do a break-even analysis?',
    'My fixed costs are $10,000/month.',
    'What is my contribution margin per unit?',
    'How do I compare margins across categories?',
    'My best seller has 50% margin but only 10% of volume.',
    'My worst margin product is 8% but 30% of revenue.',
    'Should I drop the low-margin product?',
    'How do subscription models affect margin?',
    'What is price elasticity in practice?',
    'How do discounts impact my annual margin?',
    'What is margin mix analysis?',
    'How do I factor returns into margin calculations?',
    'What about payment processing fees?',
    'How do I set margin targets by category?',
    'Create a margin improvement roadmap.',
    'What should I focus on this quarter?',
    'Summarize all the profitability advice from this conversation.',
  ],
};

// ── Browser helpers ─────────────────────────────────────────
async function loginUser(page: Page, user: TestUser): Promise<void> {
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
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

/**
 * Snapshot-based send + wait — same reliable pattern used in boundary/comprehensive tests
 */
async function sendAndWait(page: Page, message: string, timeoutSec = 60): Promise<{ response: string; latencyMs: number }> {
  const sendStart = Date.now();

  // Get snapshot before
  const snapBefore: string[] = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[class*="rounded-2xl"]'))
      .filter(b => !(b.className || '').includes('purple'))
      .map(b => (b.textContent || '').trim().substring(0, 60));
  });

  // Fill textarea using native setter (React-safe)
  await page.evaluate((text: string) => {
    const inp = document.querySelector('textarea[placeholder*="Message"]') as HTMLTextAreaElement;
    if (!inp) throw new Error('Textarea not found');
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(inp, text);
    else inp.value = text;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, message);

  // Click send button
  await page.evaluate(() => {
    const inp = document.querySelector('textarea[placeholder*="Message"]');
    if (!inp) return;
    const container = inp.parentElement;
    const btn = container?.querySelector('button')
      || container?.parentElement?.querySelector('button')
      || Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && !b.disabled);
    if (btn) (btn as HTMLButtonElement).click();
  });

  // Wait for new AI response (snapshot diff)
  await page.waitForTimeout(3000);
  const maxTries = Math.floor((timeoutSec * 1000 - 3000) / 500);
  let response = '';

  for (let i = 0; i < maxTries; i++) {
    await page.waitForTimeout(500);
    const result = await page.evaluate((snap: string[]) => {
      const bubbles = Array.from(document.querySelectorAll('[class*="rounded-2xl"]'))
        .filter(b => !(b.className || '').includes('purple'));
      for (let j = bubbles.length - 1; j >= 0; j--) {
        const text = (bubbles[j].textContent || '').trim();
        const sig = text.substring(0, 60);
        if (text.length > 10 && !snap.includes(sig)) return text;
      }
      return '';
    }, snapBefore);
    if (result.length > 10) {
      // Settle for 2 seconds in case the response is still streaming
      await page.waitForTimeout(2000);
      response = await page.evaluate((snap: string[]) => {
        const bubbles = Array.from(document.querySelectorAll('[class*="rounded-2xl"]'))
          .filter(b => !(b.className || '').includes('purple'));
        for (let j = bubbles.length - 1; j >= 0; j--) {
          const text = (bubbles[j].textContent || '').trim();
          const sig = text.substring(0, 60);
          if (text.length > 10 && !snap.includes(sig)) return text;
        }
        return '';
      }, snapBefore);
      break;
    }
  }

  return { response, latencyMs: Date.now() - sendStart };
}

/**
 * Wait until send button is ready
 */
async function waitSendReady(page: Page, maxSec = 60): Promise<boolean> {
  for (let i = 0; i < maxSec * 2; i++) {
    const ready = await page.evaluate(() => {
      const ta = document.querySelector('textarea[placeholder*="Message"]') as HTMLTextAreaElement;
      if (!ta) return false;
      const container = ta.parentElement;
      const btn = container?.querySelector('button') || container?.parentElement?.querySelector('button');
      return btn && !btn.disabled && btn.offsetParent !== null;
    });
    if (ready) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// ── Refresh session (navigate away and back) ────────────────
async function refreshSession(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.goto(`${BASE_URL}${agentPath}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
}

// ── Test scenario interfaces ────────────────────────────────
interface ScenarioResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'PARTIAL' | 'ERROR';
  details: any;
  duration: number;
  timestamp: string;
}

// ══════════════════════════════════════════════════════════════
//  S1: RAPID-FIRE BURST — 10 questions as fast as possible
// ══════════════════════════════════════════════════════════════
async function runRapidFire(page: Page): Promise<ScenarioResult> {
  const start = Date.now();
  console.log('\n── S1: Rapid-Fire Burst (10 questions) ──');

  const questions = QUESTIONS[AGENT_ARG].slice(0, 10);
  const results: { q: string; latencyMs: number; responseLen: number; got: boolean }[] = [];

  for (let i = 0; i < questions.length; i++) {
    const ready = await waitSendReady(page, 30);
    if (!ready) {
      results.push({ q: questions[i], latencyMs: -1, responseLen: 0, got: false });
      console.log(`  Q${i + 1}: TIMEOUT waiting for send ready`);
      continue;
    }
    const { response, latencyMs } = await sendAndWait(page, questions[i], 45);
    const got = response.length > 10;
    results.push({ q: questions[i], latencyMs, responseLen: response.length, got });
    console.log(`  Q${i + 1}: ${got ? '✓' : '✗'} ${latencyMs}ms (${response.length} chars)`);
  }

  const successRate = results.filter(r => r.got).length / results.length;
  const avgLatency = Math.round(results.filter(r => r.got).reduce((s, r) => s + r.latencyMs, 0) / results.filter(r => r.got).length);
  const maxLatency = Math.max(...results.filter(r => r.got).map(r => r.latencyMs));

  console.log(`  → Success: ${Math.round(successRate * 100)}% | Avg latency: ${avgLatency}ms | Max: ${maxLatency}ms`);

  return {
    id: 'S1',
    name: 'Rapid-Fire Burst (10 questions)',
    status: successRate >= 0.9 ? 'PASS' : successRate >= 0.7 ? 'PARTIAL' : 'FAIL',
    details: { successRate, avgLatency, maxLatency, results },
    duration: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
//  S2: LONG CONVERSATION MARATHON — 25 turns
// ══════════════════════════════════════════════════════════════
async function runMarathon(page: Page): Promise<ScenarioResult> {
  const start = Date.now();
  const turns = MARATHON_TURNS[AGENT_ARG];
  console.log(`\n── S2: Conversation Marathon (${turns.length} turns) ──`);

  const results: { turn: number; q: string; latencyMs: number; responseLen: number; got: boolean }[] = [];
  let consecutiveFails = 0;

  for (let i = 0; i < turns.length; i++) {
    const ready = await waitSendReady(page, 30);
    if (!ready) {
      results.push({ turn: i + 1, q: turns[i], latencyMs: -1, responseLen: 0, got: false });
      consecutiveFails++;
      console.log(`  Turn ${i + 1}/${turns.length}: TIMEOUT`);
      if (consecutiveFails >= 3) {
        console.log('  → 3 consecutive failures, aborting marathon');
        break;
      }
      continue;
    }

    const { response, latencyMs } = await sendAndWait(page, turns[i], 60);
    const got = response.length > 10;
    results.push({ turn: i + 1, q: turns[i], latencyMs, responseLen: response.length, got });
    consecutiveFails = got ? 0 : consecutiveFails + 1;

    if ((i + 1) % 5 === 0 || !got) {
      console.log(`  Turn ${i + 1}/${turns.length}: ${got ? '✓' : '✗'} ${latencyMs}ms (${response.length} chars)`);
    }

    if (consecutiveFails >= 3) {
      console.log('  → 3 consecutive failures, aborting marathon');
      break;
    }
  }

  const successRate = results.filter(r => r.got).length / results.length;
  const latencies = results.filter(r => r.got).map(r => r.latencyMs).sort((a, b) => a - b);
  const avgLatency = latencies.length ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length) : -1;

  // Check for quality degradation: compare avg latency of first 5 vs last 5
  const first5 = results.slice(0, 5).filter(r => r.got);
  const last5 = results.filter(r => r.got).slice(-5);
  const first5Avg = first5.length ? Math.round(first5.reduce((s, r) => s + r.latencyMs, 0) / first5.length) : 0;
  const last5Avg = last5.length ? Math.round(last5.reduce((s, r) => s + r.latencyMs, 0) / last5.length) : 0;
  const degradationRatio = first5Avg > 0 ? (last5Avg / first5Avg) : 1;

  console.log(`  → Success: ${Math.round(successRate * 100)}% | Avg: ${avgLatency}ms | Degradation: ${degradationRatio.toFixed(2)}x`);

  return {
    id: 'S2',
    name: `Conversation Marathon (${turns.length} turns)`,
    status: successRate >= 0.9 && degradationRatio < 3 ? 'PASS' : successRate >= 0.7 ? 'PARTIAL' : 'FAIL',
    details: {
      successRate, avgLatency, turnsCompleted: results.length, turnsTotal: turns.length,
      first5AvgLatency: first5Avg, last5AvgLatency: last5Avg, degradationRatio,
      results: results.map(r => ({ turn: r.turn, got: r.got, latencyMs: r.latencyMs, responseLen: r.responseLen })),
    },
    duration: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
//  S3: LARGE INPUT STRESS — extremely long messages
// ══════════════════════════════════════════════════════════════
async function runLargeInput(page: Page): Promise<ScenarioResult> {
  const start = Date.now();
  console.log('\n── S3: Large Input Stress ──');

  const inputs = LONG_INPUTS[AGENT_ARG];
  const results: { inputLen: number; latencyMs: number; responseLen: number; got: boolean }[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const ready = await waitSendReady(page, 30);
    if (!ready) {
      results.push({ inputLen: inputs[i].length, latencyMs: -1, responseLen: 0, got: false });
      console.log(`  Input ${i + 1} (${inputs[i].length} chars): TIMEOUT`);
      continue;
    }

    console.log(`  Input ${i + 1} (${inputs[i].length} chars): sending...`);
    const { response, latencyMs } = await sendAndWait(page, inputs[i], 90);
    const got = response.length > 30; // Long inputs should produce long responses
    results.push({ inputLen: inputs[i].length, latencyMs, responseLen: response.length, got });
    console.log(`    → ${got ? '✓' : '✗'} ${latencyMs}ms (${response.length} chars response)`);
  }

  // Also test with a generated very long repetitive input
  const megaInput = `I need a comprehensive analysis. ${'Please include all details and data points. '.repeat(30)}What is your recommendation?`;
  console.log(`  Mega input (${megaInput.length} chars): sending...`);
  const readyMega = await waitSendReady(page, 30);
  if (readyMega) {
    const { response, latencyMs } = await sendAndWait(page, megaInput, 90);
    const got = response.length > 10;
    results.push({ inputLen: megaInput.length, latencyMs, responseLen: response.length, got });
    console.log(`    → ${got ? '✓' : '✗'} ${latencyMs}ms (${response.length} chars response)`);
  }

  const successRate = results.filter(r => r.got).length / results.length;
  console.log(`  → Success: ${Math.round(successRate * 100)}%`);

  return {
    id: 'S3',
    name: 'Large Input Stress',
    status: successRate >= 0.75 ? 'PASS' : successRate >= 0.5 ? 'PARTIAL' : 'FAIL',
    details: { successRate, results },
    duration: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
//  S4: CONCURRENT MARATHON — all users doing 10 turns simultaneously
// ══════════════════════════════════════════════════════════════
async function runConcurrentMarathon(browser: Browser): Promise<ScenarioResult> {
  const start = Date.now();
  const turnsPerUser = 10;
  const numUsers = Math.min(users.length, 3);
  console.log(`\n── S4: Concurrent Marathon (${numUsers} users × ${turnsPerUser} turns) ──`);

  // Create sessions
  const sessions: { context: BrowserContext; page: Page; user: TestUser }[] = [];
  for (let i = 0; i < numUsers; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await loginUser(page, users[i]);
    await navigateToAgent(page);
    sessions.push({ context, page, user: users[i] });
  }

  // Run marathon simultaneously
  const turns = MARATHON_TURNS[AGENT_ARG].slice(0, turnsPerUser);
  const userResults: { user: string; successCount: number; avgLatency: number; totalTurns: number }[] = [];

  const allPromises = sessions.map(async (session) => {
    const latencies: number[] = [];
    let successes = 0;

    for (let t = 0; t < turns.length; t++) {
      const ready = await waitSendReady(session.page, 30);
      if (!ready) continue;
      const { response, latencyMs } = await sendAndWait(session.page, turns[t], 60);
      if (response.length > 10) {
        successes++;
        latencies.push(latencyMs);
      }
    }

    const avg = latencies.length ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length) : -1;
    return { user: session.user.email, successCount: successes, avgLatency: avg, totalTurns: turns.length };
  });

  const results = await Promise.all(allPromises);

  // Cleanup sessions
  for (const s of sessions) await s.context.close();

  const totalSuccess = results.reduce((s, r) => s + r.successCount, 0);
  const totalPossible = results.reduce((s, r) => s + r.totalTurns, 0);
  const overallRate = totalSuccess / totalPossible;

  results.forEach(r => {
    console.log(`  ${r.user}: ${r.successCount}/${r.totalTurns} (avg ${r.avgLatency}ms)`);
  });
  console.log(`  → Overall: ${Math.round(overallRate * 100)}% success`);

  return {
    id: 'S4',
    name: `Concurrent Marathon (${numUsers} users × ${turnsPerUser} turns)`,
    status: overallRate >= 0.85 ? 'PASS' : overallRate >= 0.6 ? 'PARTIAL' : 'FAIL',
    details: { overallRate, totalSuccess, totalPossible, userResults: results },
    duration: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
//  S5: RECOVERY TEST — edge cases then verify agent recovers
// ══════════════════════════════════════════════════════════════
async function runRecoveryTest(page: Page): Promise<ScenarioResult> {
  const start = Date.now();
  console.log('\n── S5: Recovery Test ──');

  const edgeCases = [
    { id: 'R1', name: 'empty-ish input', input: '...' },
    { id: 'R2', name: 'gibberish', input: 'asdkjhqwpeiu zxcvn,m. qwer' },
    { id: 'R3', name: 'repeated chars', input: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    { id: 'R4', name: 'special chars', input: '!@#$%^&*()_+-=[]{}|;\\:",.<>?/~`' },
    { id: 'R5', name: 'HTML injection', input: '<script>alert("test")</script><img src=x onerror=alert(1)>' },
    { id: 'R6', name: 'SQL injection', input: "'; DROP TABLE users; SELECT * FROM products WHERE '1'='1" },
    { id: 'R7', name: 'very long single word', input: 'margin'.repeat(200) },
    { id: 'R8', name: 'unicode stress', input: '🔥💰📊📈📉💵🏦🧮 利润率是多少？ マージンは？ Какова маржа?' },
  ];

  const results: { id: string; name: string; responded: boolean; latencyMs: number }[] = [];

  for (const tc of edgeCases) {
    const ready = await waitSendReady(page, 20);
    if (!ready) {
      results.push({ id: tc.id, name: tc.name, responded: false, latencyMs: -1 });
      console.log(`  ${tc.id} (${tc.name}): TIMEOUT`);
      continue;
    }
    const { response, latencyMs } = await sendAndWait(page, tc.input, 30);
    const responded = response.length > 5;
    results.push({ id: tc.id, name: tc.name, responded, latencyMs });
    console.log(`  ${tc.id} (${tc.name}): ${responded ? '✓' : '✗'} ${latencyMs}ms`);
  }

  // Now verify agent still works normally after all the abuse
  console.log('  → Recovery check...');
  const normalQ = QUESTIONS[AGENT_ARG][0];
  const ready = await waitSendReady(page, 30);
  let recoveryOk = false;
  if (ready) {
    const { response } = await sendAndWait(page, normalQ, 45);
    recoveryOk = response.length > 30;
    console.log(`  → Recovery: ${recoveryOk ? '✓ Agent responds normally' : '✗ Agent not recovered'}`);
  }

  const edgeCaseRate = results.filter(r => r.responded).length / results.length;

  return {
    id: 'S5',
    name: 'Recovery Test',
    status: recoveryOk && edgeCaseRate >= 0.7 ? 'PASS' : recoveryOk ? 'PARTIAL' : 'FAIL',
    details: { edgeCaseRate, recoveryOk, results },
    duration: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
//  S6: LATENCY BENCHMARK — P50/P95/P99 over 15 standard questions
// ══════════════════════════════════════════════════════════════
async function runLatencyBenchmark(page: Page): Promise<ScenarioResult> {
  const start = Date.now();
  const questions = QUESTIONS[AGENT_ARG];
  console.log(`\n── S6: Latency Benchmark (${questions.length} questions) ──`);

  const latencies: number[] = [];
  let successes = 0;

  for (let i = 0; i < questions.length; i++) {
    const ready = await waitSendReady(page, 30);
    if (!ready) {
      console.log(`  Q${i + 1}: TIMEOUT`);
      continue;
    }
    const { response, latencyMs } = await sendAndWait(page, questions[i], 60);
    if (response.length > 10) {
      latencies.push(latencyMs);
      successes++;
    }
    if ((i + 1) % 5 === 0) {
      console.log(`  Q${i + 1}: ${response.length > 10 ? '✓' : '✗'} ${latencyMs}ms`);
    }
  }

  latencies.sort((a, b) => a - b);
  const percentile = (arr: number[], p: number) => arr[Math.ceil(arr.length * p / 100) - 1] || 0;

  const stats = {
    count: latencies.length,
    min: latencies[0] || 0,
    max: latencies[latencies.length - 1] || 0,
    avg: latencies.length ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length) : 0,
    p50: percentile(latencies, 50),
    p75: percentile(latencies, 75),
    p90: percentile(latencies, 90),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  };

  console.log(`  → P50: ${stats.p50}ms | P95: ${stats.p95}ms | P99: ${stats.p99}ms | Avg: ${stats.avg}ms`);

  const successRate = successes / questions.length;

  return {
    id: 'S6',
    name: `Latency Benchmark (${questions.length} questions)`,
    status: successRate >= 0.9 && stats.p95 < 60000 ? 'PASS' : successRate >= 0.7 ? 'PARTIAL' : 'FAIL',
    details: { successRate, stats },
    duration: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  ST — STRESS TEST SUITE                               ║`);
  console.log(`║  Agent: ${AGENT_ARG.toUpperCase().padEnd(45)}║`);
  console.log(`║  Users: ${users.length}                                             ║`);
  console.log(`║  Scenarios: S1-S6                                     ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const allResults: ScenarioResult[] = [];

  try {
    // ── Primary session for S1, S2, S3, S5, S6 ──
    console.log('\nPhase 0: Setting up primary session...');
    const primaryCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const primaryPage = await primaryCtx.newPage();
    await loginUser(primaryPage, users[0]);
    await navigateToAgent(primaryPage);

    // S1: Rapid-fire
    allResults.push(await runRapidFire(primaryPage));

    // Refresh session before marathon
    await refreshSession(primaryPage);

    // S2: Marathon
    allResults.push(await runMarathon(primaryPage));

    // Refresh session before large input
    await refreshSession(primaryPage);

    // S3: Large input
    allResults.push(await runLargeInput(primaryPage));

    // S4: Concurrent marathon (uses its own sessions)
    allResults.push(await runConcurrentMarathon(browser));

    // Refresh session before recovery
    await refreshSession(primaryPage);

    // S5: Recovery test
    allResults.push(await runRecoveryTest(primaryPage));

    // Refresh session before benchmark
    await refreshSession(primaryPage);

    // S6: Latency benchmark
    allResults.push(await runLatencyBenchmark(primaryPage));

    await primaryCtx.close();

  } catch (err: any) {
    console.error(`\nFATAL ERROR: ${err.message}`);
    allResults.push({
      id: 'FATAL',
      name: 'Uncaught Error',
      status: 'ERROR',
      details: { error: err.message, stack: err.stack },
      duration: 0,
      timestamp: new Date().toISOString(),
    });
  } finally {
    await browser.close();
  }

  // ── Final Report ────────────────────────────────────────
  const passed = allResults.filter(r => r.status === 'PASS').length;
  const partial = allResults.filter(r => r.status === 'PARTIAL').length;
  const failed = allResults.filter(r => r.status === 'FAIL').length;
  const errors = allResults.filter(r => r.status === 'ERROR').length;

  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  STRESS TEST RESULTS                                  ║`);
  console.log(`║  ${`PASS: ${passed} | PARTIAL: ${partial} | FAIL: ${failed} | ERROR: ${errors}`.padEnd(52)}║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  allResults.forEach(r => {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'PARTIAL' ? '~' : r.status === 'FAIL' ? '✗' : '!';
    console.log(`║  ${icon} ${r.id}: ${r.name}`.padEnd(54) + `║`);
  });
  console.log(`╚═══════════════════════════════════════════════════════╝`);

  const report = {
    agent: AGENT_ARG,
    testType: 'stress',
    users: users.map(u => u.email),
    scenarios: allResults.length,
    passed,
    partial,
    failed,
    errors,
    results: allResults,
    generatedAt: new Date().toISOString(),
  };

  const reportPath = join(process.cwd(), `reports/${AGENT_ARG}-stress-test-results.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${reportPath}`);
}

main().catch(console.error);
