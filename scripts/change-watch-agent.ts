/**
 * change-watch-agent.ts — Agent UI change detector + auto-test trigger
 *
 * Builds on detect-agent-update.ts:
 *  1. Fingerprint each agent's chat page (SHA-256 of visible text)
 *  2. Compare against stored baseline in data/agent-fingerprints.json
 *  3. If any agent changed AND --run-tests is passed:
 *       - Run accuracy tests for changed agents
 *       - Compare pass-rate against stored baseline (data/agent-baselines.json)
 *       - Classify change as REGRESSION / IMPROVEMENT / NEUTRAL
 *  4. Claude writes a change analysis report
 *  5. Optionally create Linear ticket for regressions (--linear flag)
 *
 * Usage:
 *   pnpm watch:agents                  # fingerprint check only
 *   pnpm watch:agents --run-tests      # check + run accuracy for changed agents
 *   pnpm watch:agents --run-tests --linear  # + create Linear ticket on regression
 *   pnpm watch:agents --reset          # reset stored fingerprints (new baseline)
 *   pnpm watch:agents --set-baseline   # run accuracy for all agents and save as baseline (no change detection)
 *   pnpm watch:agents --slack          # post change summary to Slack
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium } from '@playwright/test';
import { createHash } from 'crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import 'dotenv/config';
import { sendSlackBlocks, headerBlock, sectionBlock, dividerBlock, contextBlock } from '../src/lib/slack.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const LINEAR_API_KEY    = process.env.LINEAR_API_KEY || '';
const LINEAR_TEAM       = process.env.QA_TEAM || 'YEP';
const BASE_URL          = process.env.YEPAI_BASE_URL || 'https://bot-test.yepai.io';
const EMAIL             = process.env.YEPAI_LOGIN_EMAIL || '';
const PASSWORD          = process.env.YEPAI_LOGIN_PASSWORD || '';

const RUN_TESTS    = process.argv.includes('--run-tests');
const USE_LINEAR   = process.argv.includes('--linear');
const USE_SLACK    = process.argv.includes('--slack');
const RESET        = process.argv.includes('--reset');
const SET_BASELINE = process.argv.includes('--set-baseline');

const FINGERPRINT_FILE = join(process.cwd(), 'data/agent-fingerprints.json');
const BASELINE_FILE    = join(process.cwd(), 'data/agent-baselines.json');
const REPORTS_DIR      = join(process.cwd(), 'reports');

const AGENTS: Record<string, string> = {
  maya:   '/ai-team/marketing/chat',
  oscar:  '/ai-team/operation/chat',
  daniel: '/ai-team/profit/chat',
  cody:   '/ai-team/seo/chat',
};

// ── Types ──────────────────────────────────────────────────────

interface AgentChange {
  agent: string;
  path: string;
  oldHash: string | null;
  newHash: string;
  isNew: boolean;
}

interface AccuracyResult {
  agent: string;
  passRate: number;
  passed: number;
  evaluated: number;
}

type ChangeClass = 'REGRESSION' | 'IMPROVEMENT' | 'NEUTRAL' | 'UNKNOWN';

interface AnalysedChange {
  change: AgentChange;
  accuracy?: AccuracyResult;
  baselinePassRate?: number;
  classification: ChangeClass;
  delta?: number;
  notes: string;
  linearTicketId?: string;
}

// ── Fingerprint one agent page ─────────────────────────────────

async function fingerprint(page: import('@playwright/test').Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const text = await page.evaluate(() => {
    const tags = ['h1', 'h2', 'h3', 'p', 'span', 'div'];
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const tag of tags) {
      for (const el of Array.from(document.querySelectorAll(tag))) {
        const t = (el as HTMLElement).innerText?.trim() ?? '';
        if (t.length > 8 && t.length < 300 && !seen.has(t)) {
          seen.add(t);
          parts.push(t);
        }
      }
    }
    return parts.slice(0, 60).join('\n');
  });

  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ── Run fingerprint check ──────────────────────────────────────

async function checkFingerprints(): Promise<AgentChange[]> {
  const stored: Record<string, string> = existsSync(FINGERPRINT_FILE)
    ? JSON.parse(readFileSync(FINGERPRINT_FILE, 'utf-8'))
    : {};

  if (RESET) {
    console.log('  --reset flag: clearing stored fingerprints');
    writeFileSync(FINGERPRINT_FILE, JSON.stringify({}, null, 2));
    Object.keys(stored).forEach(k => delete stored[k]);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page    = await context.newPage();

  // Login
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|home|ai-training|analytics|onboarding/, { timeout: 30000 });
  console.log('  ✓ Logged in');

  const current: Record<string, string> = {};
  const changes: AgentChange[] = [];

  for (const [agent, path] of Object.entries(AGENTS)) {
    console.log(`  Checking ${agent}...`);
    try {
      const hash = await fingerprint(page, `${BASE_URL}${path}`);
      current[agent] = hash;

      if (!stored[agent]) {
        console.log(`    📝 First run — storing hash: ${hash}`);
        changes.push({ agent, path, oldHash: null, newHash: hash, isNew: true });
      } else if (stored[agent] !== hash) {
        console.log(`    ⚡ CHANGED  was=${stored[agent]}  now=${hash}`);
        changes.push({ agent, path, oldHash: stored[agent], newHash: hash, isNew: false });
      } else {
        console.log(`    ✓ No change  hash=${hash}`);
      }
    } catch (err) {
      console.error(`    ✗ Error: ${err}`);
    }
  }

  await browser.close();
  writeFileSync(FINGERPRINT_FILE, JSON.stringify({ ...stored, ...current }, null, 2));
  return changes.filter(c => !c.isNew); // only surface real changes, not first runs
}

// ── Run accuracy test for one agent ───────────────────────────

function runAccuracy(agent: string): AccuracyResult | null {
  console.log(`  Running accuracy:${agent}...`);
  const result = spawnSync('npx', ['tsx', 'scripts/accuracy-test-api.ts', '--agent', agent], {
    encoding: 'utf-8',
    timeout: 300_000,
    env: { ...process.env },
  });

  if (result.status !== 0) {
    console.error(`  ✗ accuracy:${agent} failed: ${result.stderr?.substring(0, 200)}`);
    return null;
  }

  // Read saved report
  const reportPath = join(REPORTS_DIR, `${agent}-accuracy-results.json`);
  if (!existsSync(reportPath)) return null;
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      passed: number; evaluatedCases: number; successRate: number;
    };
    return {
      agent,
      passRate: report.successRate / 100,
      passed: report.passed,
      evaluated: report.evaluatedCases,
    };
  } catch { return null; }
}

// ── Load / save accuracy baselines ────────────────────────────

function loadBaselines(): Record<string, number> {
  return existsSync(BASELINE_FILE)
    ? JSON.parse(readFileSync(BASELINE_FILE, 'utf-8'))
    : {};
}

function saveBaseline(agent: string, passRate: number) {
  const baselines = loadBaselines();
  baselines[agent] = passRate;
  writeFileSync(BASELINE_FILE, JSON.stringify(baselines, null, 2));
}

// ── Linear ticket ──────────────────────────────────────────────

async function createLinearTicket(title: string, description: string, priority: number): Promise<string | null> {
  if (!LINEAR_API_KEY) return null;
  try {
    const teamRes = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: LINEAR_API_KEY },
      body: JSON.stringify({ query: `{ teams { nodes { id key } } }` }),
    });
    const teamData = await teamRes.json() as { data: { teams: { nodes: Array<{ id: string; key: string }> } } };
    const team = teamData.data?.teams?.nodes?.find((t: { id: string; key: string }) => t.key === LINEAR_TEAM);
    if (!team) return null;

    const mutation = `
      mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $priority: Int!) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description, priority: $priority }) {
          success
          issue { identifier url }
        }
      }
    `;
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: LINEAR_API_KEY },
      body: JSON.stringify({ query: mutation, variables: { teamId: team.id, title, description, priority } }),
    });
    const data = await res.json() as { data: { issueCreate: { issue: { identifier: string; url: string } } } };
    const issue = data.data?.issueCreate?.issue;
    if (issue) {
      console.log(`  ✓ Linear: ${issue.identifier} — ${issue.url}`);
      return issue.identifier;
    }
  } catch (err) {
    console.error('  ✗ Linear error:', err);
  }
  return null;
}

// ── Claude analysis ────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: 'analyse_change',
    description: 'Classify one agent change as REGRESSION, IMPROVEMENT, or NEUTRAL and write notes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string' },
        classification: { type: 'string', enum: ['REGRESSION', 'IMPROVEMENT', 'NEUTRAL', 'UNKNOWN'] },
        notes: { type: 'string', description: '1-2 sentences describing what likely changed and why it matters' },
        should_create_ticket: { type: 'boolean', description: 'true only for REGRESSION class' },
        ticket_title: { type: 'string' },
        ticket_description: { type: 'string', description: 'Markdown with details of the regression' },
        ticket_priority: { type: 'number', description: '1=urgent 2=high 3=medium 4=low' },
      },
      required: ['agent', 'classification', 'notes'],
    },
  },
];

async function analyseChanges(changes: AgentChange[], accuracyResults: Map<string, AccuracyResult | null>): Promise<AnalysedChange[]> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const baselines = loadBaselines();

  const analysed: AnalysedChange[] = changes.map(c => ({
    change: c,
    accuracy: accuracyResults.get(c.agent) ?? undefined,
    baselinePassRate: baselines[c.agent],
    classification: 'UNKNOWN' as ChangeClass,
    notes: '',
  }));

  const context = changes.map(c => {
    const acc = accuracyResults.get(c.agent);
    const baseline = baselines[c.agent];
    const delta = acc && baseline !== undefined ? ((acc.passRate - baseline) * 100).toFixed(1) : 'N/A';
    return (
      `Agent: ${c.agent} (${c.path})\n` +
      `  Hash: ${c.oldHash} → ${c.newHash}\n` +
      (acc ? `  Accuracy now: ${(acc.passRate * 100).toFixed(1)}% (${acc.passed}/${acc.evaluated})\n` : `  Accuracy: not run\n`) +
      (baseline !== undefined ? `  Baseline: ${(baseline * 100).toFixed(1)}%  delta: ${delta}%\n` : `  Baseline: none stored\n`)
    );
  }).join('\n');

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `You are a QA change analysis agent for YepAI.

The following AI agent page(s) have changed (detected via UI fingerprint diff):

${context}

For each agent:
- If accuracy dropped ≥5 pp vs baseline → REGRESSION
- If accuracy rose ≥5 pp → IMPROVEMENT
- If delta is small or no accuracy data → NEUTRAL
- UNKNOWN only if something is very unclear

Call analyse_change once per agent. ${USE_LINEAR ? 'For REGRESSIONs, set should_create_ticket=true and provide ticket details.' : ''}`,
    },
  ];

  let steps = 0;
  while (steps < 10) {
    steps++;
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      tools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'end_turn') break;
    if (response.stop_reason !== 'tool_use') break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const input = block.input as Record<string, unknown>;

      if (block.name === 'analyse_change') {
        const agent = input['agent'] as string;
        const entry = analysed.find(a => a.change.agent === agent);
        if (entry) {
          entry.classification = input['classification'] as ChangeClass;
          entry.notes = input['notes'] as string;

          const acc = accuracyResults.get(agent);
          const baseline = baselines[agent];
          if (acc !== null && acc !== undefined && baseline !== undefined) {
            entry.delta = (acc.passRate - baseline) * 100;
          }

          const shouldTicket = input['should_create_ticket'] as boolean;
          if (shouldTicket && USE_LINEAR) {
            const ticketId = await createLinearTicket(
              input['ticket_title'] as string || `[Regression] ${agent} accuracy drop`,
              input['ticket_description'] as string || entry.notes,
              input['ticket_priority'] as number || 2,
            );
            if (ticketId) entry.linearTicketId = ticketId;
          }

          // Update baseline for future comparisons
          if (acc && entry.classification !== 'UNKNOWN') {
            saveBaseline(agent, acc.passRate);
          }

          console.log(`  [${entry.classification}] ${agent} — ${entry.notes.substring(0, 80)}`);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'ok' });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return analysed;
}

// ── Print summary ──────────────────────────────────────────────

async function printSummary(analysed: AnalysedChange[], noChanges: boolean) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  CHANGE WATCH REPORT — ${new Date().toLocaleString()}`);
  console.log(`${'═'.repeat(64)}`);

  if (noChanges) {
    console.log('  ✅ No agent changes detected. All fingerprints match.');
    console.log(`${'═'.repeat(64)}`);
    return;
  }

  for (const a of analysed) {
    const icon = a.classification === 'REGRESSION' ? '🔴' : a.classification === 'IMPROVEMENT' ? '🟢' : a.classification === 'NEUTRAL' ? '🟡' : '⚪';
    console.log(`${icon}  ${a.change.agent.toUpperCase()} — ${a.classification}`);
    console.log(`   Hash: ${a.change.oldHash} → ${a.change.newHash}`);
    if (a.accuracy) {
      const deltaStr = a.delta !== undefined ? ` (${a.delta > 0 ? '+' : ''}${a.delta.toFixed(1)}pp vs baseline)` : '';
      console.log(`   Accuracy: ${(a.accuracy.passRate * 100).toFixed(1)}%${deltaStr}`);
    }
    console.log(`   ${a.notes}`);
    if (a.linearTicketId) console.log(`   Linear: ${a.linearTicketId}`);
    console.log();
  }
  console.log(`${'═'.repeat(64)}`);

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `change-watch-${new Date().toISOString().split('T')[0]}.json`);
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), analysed }, null, 2));
  console.log(`  Report saved → ${outPath}`);

  if (USE_SLACK) await postChangeWatchToSlack(analysed);
}

async function postChangeWatchToSlack(analysed: AnalysedChange[]) {
  const regressions  = analysed.filter(a => a.classification === 'REGRESSION');
  const improvements = analysed.filter(a => a.classification === 'IMPROVEMENT');
  const headline = regressions.length
    ? `🔴 ${regressions.length} regression(s) detected`
    : improvements.length
    ? `🟢 ${improvements.length} improvement(s) detected`
    : '🟡 Agent changes detected — no accuracy impact';

  const blocks: unknown[] = [
    headerBlock(`👁 Change Watch — ${headline}`),
  ];

  for (const a of analysed) {
    const icon  = a.classification === 'REGRESSION' ? '🔴' : a.classification === 'IMPROVEMENT' ? '🟢' : '🟡';
    const delta = a.delta !== undefined ? ` (${a.delta > 0 ? '+' : ''}${a.delta.toFixed(1)}pp)` : '';
    const acc   = a.accuracy ? `  Accuracy: ${(a.accuracy.passRate * 100).toFixed(1)}%${delta}` : '';
    const ticket = a.linearTicketId ? `  Linear: <https://linear.app/issue/${a.linearTicketId}|${a.linearTicketId}>` : '';
    blocks.push(dividerBlock());
    blocks.push(sectionBlock(
      `${icon} *${a.change.agent.toUpperCase()}* — ${a.classification}\n${a.notes}${acc}${ticket}`
    ));
  }

  blocks.push(dividerBlock());
  blocks.push(contextBlock(`Run \`/yepai watch\` to re-check • \`/yepai accuracy [agent]\` to re-run tests`));

  await sendSlackBlocks(headline, blocks);
  console.log('  [Slack] Change watch report posted');
}

// ── Entry point ────────────────────────────────────────────────

(async () => {
  if (!EMAIL || !PASSWORD) { console.error('YEPAI_LOGIN_EMAIL / YEPAI_LOGIN_PASSWORD not set'); process.exit(1); }

  // --set-baseline: run accuracy for all agents and persist as baseline, skip change detection
  if (SET_BASELINE) {
    if (!ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }
    console.log('\n📐 Setting accuracy baseline for all agents...\n');
    for (const agent of Object.keys(AGENTS)) {
      const result = runAccuracy(agent);
      if (result) {
        saveBaseline(agent, result.passRate);
        console.log(`  ✓ ${agent}: ${(result.passRate * 100).toFixed(1)}% saved as baseline`);
      } else {
        console.log(`  ✗ ${agent}: accuracy run failed, baseline not updated`);
      }
    }
    console.log('\n  Baselines saved → data/agent-baselines.json');
    process.exit(0);
  }

  console.log(`\n👁  Change watch agent — ${BASE_URL}`);
  console.log(`   run-tests: ${RUN_TESTS}  linear: ${USE_LINEAR}  reset: ${RESET}\n`);

  // Step 1: fingerprint
  const changes = await checkFingerprints();

  if (changes.length === 0) {
    await printSummary([], true);
    process.exit(0);
  }

  console.log(`\n  ${changes.length} agent(s) changed: ${changes.map(c => c.agent).join(', ')}`);

  // Step 2: accuracy tests (optional)
  const accuracyResults = new Map<string, AccuracyResult | null>();
  if (RUN_TESTS && ANTHROPIC_API_KEY) {
    console.log('\n  Running accuracy tests for changed agents...');
    for (const c of changes) {
      const result = runAccuracy(c.agent);
      accuracyResults.set(c.agent, result);
    }
  }

  // Step 3: Claude analysis
  if (!ANTHROPIC_API_KEY) {
    console.log('\n  ANTHROPIC_API_KEY not set — skipping AI analysis');
    await printSummary(changes.map(c => ({ change: c, classification: 'UNKNOWN' as ChangeClass, notes: 'AI analysis skipped' })), false);
    process.exit(0);
  }

  console.log('\n  Sending to Claude for analysis...');
  const analysed = await analyseChanges(changes, accuracyResults);
  await printSummary(analysed, false);

  const regressions = analysed.filter(a => a.classification === 'REGRESSION');
  process.exit(regressions.length > 0 ? 1 : 0); // non-zero exit for CI to catch
})();
