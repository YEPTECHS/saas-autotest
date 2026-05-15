/**
 * alert-agent.ts — Proactive accuracy threshold alerting
 *
 * Reads the latest accuracy reports and sends a Slack alert
 * if any agent falls below the configured threshold.
 *
 * Usage:
 *   pnpm alert                  # check all agents
 *   pnpm alert --threshold 70   # custom threshold
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { sendSlackBlocks, headerBlock, sectionBlock, dividerBlock, contextBlock } from '../src/lib/slack.js';
import 'dotenv/config';

const REPORTS_DIR = join(process.cwd(), 'reports');
const args        = process.argv.slice(2);
const thresholdArg = args.find(a => a.startsWith('--threshold='))?.split('=')[1]
  || (args.includes('--threshold') ? args[args.indexOf('--threshold') + 1] : null);
const THRESHOLD = parseInt(thresholdArg || process.env.ACCURACY_ALERT_THRESHOLD || '80', 10);

interface AgentStatus {
  agent:        string;
  successRate:  number;
  passed:       number;
  total:        number;
  generatedAt:  string;
  hasReport:    boolean;
}

function loadLatest(agent: string): AgentStatus | null {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith(`${agent}-accuracy`) && f.endsWith('.json'))
    .sort().reverse();
  if (!files.length) return null;
  try {
    const data = JSON.parse(readFileSync(join(REPORTS_DIR, files[0]), 'utf-8')) as {
      successRate: number; passed: number; evaluatedCases: number; generatedAt: string;
    };
    return {
      agent,
      successRate: data.successRate,
      passed:      data.passed,
      total:       data.evaluatedCases,
      generatedAt: data.generatedAt?.slice(0, 10) || '?',
      hasReport:   true,
    };
  } catch { return null; }
}

async function main() {
  const agents  = ['maya', 'oscar', 'daniel', 'cody'];
  const failing: AgentStatus[] = [];
  const passing: AgentStatus[] = [];
  const missing: string[]      = [];

  for (const agent of agents) {
    const status = loadLatest(agent);
    if (!status) { missing.push(agent); continue; }
    (status.successRate < THRESHOLD ? failing : passing).push(status);
  }

  // ── Console output ─────────────────────────────────────────
  if (failing.length === 0) {
    console.log(`✅ All agents above ${THRESHOLD}% threshold`);
    for (const s of passing) {
      console.log(`   ✅ ${s.agent.toUpperCase()}: ${s.successRate.toFixed(1)}% (${s.passed}/${s.total})`);
    }
    return;
  }

  console.log(`⚠️  ${failing.length} agent(s) BELOW ${THRESHOLD}% threshold:`);
  for (const s of failing) {
    console.log(`   ❌ ${s.agent.toUpperCase()}: ${s.successRate.toFixed(1)}% (${s.passed}/${s.total})`);
  }

  // ── Slack alert ────────────────────────────────────────────
  const summary = failing.map(s => s.agent.toUpperCase()).join(', ');
  const blocks: unknown[] = [
    headerBlock(`⚠️ Accuracy Alert — ${failing.length} agent(s) below ${THRESHOLD}%`),
    dividerBlock(),
    sectionBlock('*Needs attention:*'),
    ...failing.map(s => sectionBlock(
      `❌ *${s.agent.toUpperCase()}*: ${s.successRate.toFixed(1)}% (${s.passed}/${s.total}) — ${s.generatedAt}`
    )),
  ];

  if (passing.length > 0) {
    blocks.push(dividerBlock());
    blocks.push(sectionBlock('*Passing:*'));
    for (const s of passing) {
      blocks.push(sectionBlock(
        `✅ *${s.agent.toUpperCase()}*: ${s.successRate.toFixed(1)}% (${s.passed}/${s.total})`
      ));
    }
  }

  if (missing.length > 0) {
    blocks.push(contextBlock(`No report found for: ${missing.join(', ')} — run \`pnpm accuracy\` first`));
  }

  blocks.push(dividerBlock());
  blocks.push(contextBlock(`Threshold: ${THRESHOLD}% | Use \`/yepai triage\` to classify failures | \`/yepai repair\` to auto-fix`));

  await sendSlackBlocks(`⚠️ Accuracy Alert: ${summary} below ${THRESHOLD}%`, blocks);
  console.log('[Slack] Alert sent');

  // Exit with non-zero so CI can detect alert condition
  process.exit(1);
}

main().catch(err => {
  console.error('Alert agent error:', err);
  process.exit(1);
});
