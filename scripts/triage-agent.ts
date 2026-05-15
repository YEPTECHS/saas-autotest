/**
 * triage-agent.ts — AI-driven test failure triage
 *
 * Flow:
 *  1. Read all report JSON files from reports/ (accuracy + stress + boundary)
 *  2. Extract every failed test case
 *  3. Claude classifies each failure:
 *       FLAKY     — transient / timing / network blip
 *       BUG       — agent gave a wrong/unsafe answer
 *       ENV       — login failed, selector not found, server timeout
 *  4. Print a triage summary with action recommendations
 *  5. Optionally create Linear tickets for BUG-class failures
 *     (set LINEAR_API_KEY in .env and pass --linear flag)
 *
 * Usage:
 *   pnpm triage                  # triage reports from last 1 day
 *   pnpm triage --days 3         # look back 3 days
 *   pnpm triage --linear         # also create Linear tickets for bugs
 *   pnpm triage --slack          # post summary to Slack
 */

import Anthropic from '@anthropic-ai/sdk';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';
import { sendSlackBlocks, headerBlock, sectionBlock, dividerBlock, contextBlock } from '../src/lib/slack.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const LINEAR_API_KEY    = process.env.LINEAR_API_KEY || '';
const LINEAR_TEAM       = process.env.QA_TEAM || 'YEP';
const REPORTS_DIR       = join(process.cwd(), 'reports');
const MAX_AGENT_STEPS   = 20;

const daysArg    = process.argv.find(a => a.startsWith('--days='))?.split('=')[1]
                || (process.argv.includes('--days') ? process.argv[process.argv.indexOf('--days') + 1] : undefined);
const LOOK_BACK_DAYS = parseInt(daysArg || '1', 10);
const USE_LINEAR     = process.argv.includes('--linear');
const USE_SLACK      = process.argv.includes('--slack');

// ── Types ──────────────────────────────────────────────────────

type FailureClass = 'FLAKY' | 'BUG' | 'ENV';

interface RawFailure {
  reportFile: string;
  agent: string;
  testType: string;
  testId?: string;
  category?: string;
  question?: string;
  failReason?: string;
  responseText?: string;
  statusCode?: number;
  latencyMs?: number;
  scenario?: string;
  successRate?: number;
}

interface TriagedFailure extends RawFailure {
  classification: FailureClass;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  recommendation: string;
  linearTicketId?: string;
}

interface TriageReport {
  generatedAt: string;
  lookBackDays: number;
  reportsScanned: number;
  totalFailures: number;
  byClass: Record<FailureClass, number>;
  failures: TriagedFailure[];
  summary: string;
}

// ── Load recent report files ───────────────────────────────────

function loadRecentReports(): RawFailure[] {
  if (!existsSync(REPORTS_DIR)) return [];

  const cutoff = Date.now() - LOOK_BACK_DAYS * 24 * 60 * 60 * 1000;
  const files = readdirSync(REPORTS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('triage'))
    .map(f => ({ file: f, path: join(REPORTS_DIR, f) }))
    .filter(({ path }) => {
      try { return statSync(path).mtimeMs >= cutoff; }
      catch { return false; }
    });

  const failures: RawFailure[] = [];

  for (const { file, path } of files) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      const agent = (raw['agent'] as string) || file.replace(/-.*/, '');
      const testType = (raw['testType'] as string) || 'unknown';

      // ── Accuracy report failures ──
      if (testType === 'accuracy' && Array.isArray(raw['results'])) {
        for (const r of raw['results'] as Record<string, unknown>[]) {
          if (!r['passed']) {
            failures.push({
              reportFile: file,
              agent,
              testType: 'accuracy',
              testId: r['id'] as string,
              category: r['category'] as string,
              question: r['question'] as string,
              failReason: r['failReason'] as string,
              responseText: (r['responseText'] as string)?.substring(0, 300),
              statusCode: r['statusCode'] as number,
              latencyMs: r['latencyMs'] as number,
            });
          }
        }
      }

      // ── Stress report failures ──
      if ((testType === 'api-stress' || testType === 'stress') && Array.isArray(raw['results'])) {
        for (const scenario of raw['results'] as Record<string, unknown>[]) {
          if (scenario['status'] === 'FAIL' || scenario['status'] === 'PARTIAL') {
            failures.push({
              reportFile: file,
              agent,
              testType: 'stress',
              scenario: scenario['name'] as string,
              successRate: scenario['successRate'] as number,
              failReason: `Success rate ${((scenario['successRate'] as number) * 100).toFixed(1)}% — scenario ${scenario['status']}`,
            });
          }
        }
      }
    } catch { /* skip unreadable reports */ }
  }

  return failures;
}

// ── Tool definitions for Claude ────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: 'classify_failure',
    description: 'Classify a single test failure into FLAKY, BUG, or ENV and provide a recommendation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        failure_index: { type: 'number', description: 'Index of the failure in the list (0-based)' },
        classification: { type: 'string', enum: ['FLAKY', 'BUG', 'ENV'], description: 'FLAKY=transient/timing, BUG=wrong agent answer, ENV=infra/login/selector issue' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        reasoning: { type: 'string', description: 'One sentence explaining why' },
        recommendation: { type: 'string', description: 'Concrete next action: re-run, fix prompt, check infra, open ticket, etc.' },
      },
      required: ['failure_index', 'classification', 'confidence', 'reasoning', 'recommendation'],
    },
  },
  {
    name: 'create_linear_ticket',
    description: 'Create a Linear ticket for a BUG-class failure.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        description: { type: 'string', description: 'Markdown body with failure details and steps to reproduce' },
        priority: { type: 'number', description: '1=urgent 2=high 3=medium 4=low' },
        label: { type: 'string', description: 'Label name, e.g. "bug", "ai-accuracy"' },
      },
      required: ['title', 'description', 'priority'],
    },
  },
  {
    name: 'write_triage_summary',
    description: 'Write the final triage summary paragraph (called once at the end).',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: '2-4 sentence summary of findings and recommended actions' },
      },
      required: ['summary'],
    },
  },
];

// ── Create Linear ticket via REST ──────────────────────────────

async function createLinearTicket(
  title: string,
  description: string,
  priority: number,
): Promise<string | null> {
  if (!LINEAR_API_KEY) return null;
  try {
    // Resolve team ID
    const teamRes = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: LINEAR_API_KEY },
      body: JSON.stringify({ query: `{ teams { nodes { id key } } }` }),
    });
    const teamData = await teamRes.json() as { data: { teams: { nodes: Array<{ id: string; key: string }> } } };
    const team = teamData.data?.teams?.nodes?.find((t: { id: string; key: string }) => t.key === LINEAR_TEAM);
    if (!team) { console.error('  Linear team not found:', LINEAR_TEAM); return null; }

    const mutation = `
      mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $priority: Int!) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description, priority: $priority }) {
          success
          issue { id identifier url }
        }
      }
    `;
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: LINEAR_API_KEY },
      body: JSON.stringify({ query: mutation, variables: { teamId: team.id, title, description, priority } }),
    });
    const data = await res.json() as { data: { issueCreate: { success: boolean; issue: { identifier: string; url: string } } } };
    const issue = data.data?.issueCreate?.issue;
    if (issue) {
      console.log(`  ✓ Linear ticket created: ${issue.identifier} — ${issue.url}`);
      return issue.identifier;
    }
  } catch (err) {
    console.error('  ✗ Linear API error:', err);
  }
  return null;
}

// ── Main agent loop ────────────────────────────────────────────

async function runTriageAgent(failures: RawFailure[]): Promise<TriagedFailure[]> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const triaged: TriagedFailure[] = failures.map(f => ({ ...f, classification: 'FLAKY', confidence: 'low', reasoning: '', recommendation: '' }));
  let summary = '';

  const failureList = failures.map((f, i) =>
    `[${i}] agent=${f.agent} type=${f.testType} id=${f.testId || f.scenario || '?'}\n` +
    `    category=${f.category || '-'} status=${f.statusCode || '-'} latency=${f.latencyMs || '-'}ms\n` +
    (f.question ? `    question: ${f.question.substring(0, 120)}\n` : '') +
    (f.failReason ? `    failReason: ${f.failReason.substring(0, 200)}\n` : '') +
    (f.responseText ? `    response: ${f.responseText.substring(0, 150)}\n` : '') +
    (f.successRate !== undefined ? `    successRate: ${(f.successRate * 100).toFixed(1)}%\n` : '')
  ).join('\n');

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `You are a QA triage agent for the YepAI platform.

Below are ${failures.length} test failure(s) from the last ${LOOK_BACK_DAYS} day(s).
Classify each one using the classify_failure tool, then write a summary using write_triage_summary.
${USE_LINEAR ? 'For any BUG-class failures, also call create_linear_ticket.' : ''}

Classification guide:
- FLAKY: status 502/503/504, latency spikes, "No refusal phrase detected" on a clearly safe question, network errors
- BUG: agent gave a wrong answer (wrong number, hallucinated data), failed to refuse an unsafe request, or answered out-of-scope
- ENV: login redirect failed, selector not found, session capture failed, empty response with status 0

Failures:
${failureList}`,
    },
  ];

  let steps = 0;
  while (steps < MAX_AGENT_STEPS) {
    steps++;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
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

      if (block.name === 'classify_failure') {
        const idx = input['failure_index'] as number;
        if (triaged[idx]) {
          triaged[idx].classification = input['classification'] as FailureClass;
          triaged[idx].confidence     = input['confidence'] as 'high' | 'medium' | 'low';
          triaged[idx].reasoning      = input['reasoning'] as string;
          triaged[idx].recommendation = input['recommendation'] as string;
          process.stdout.write(`  [${idx}] ${triaged[idx].classification} (${triaged[idx].confidence}) — ${triaged[idx].reasoning.substring(0, 80)}\n`);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'ok' });
      }

      if (block.name === 'create_linear_ticket' && USE_LINEAR) {
        const ticketId = await createLinearTicket(
          input['title'] as string,
          input['description'] as string,
          input['priority'] as number,
        );
        // Attach ticket ID to the most recent BUG failure
        const latestBug = [...triaged].reverse().find(f => f.classification === 'BUG' && !f.linearTicketId);
        if (latestBug && ticketId) latestBug.linearTicketId = ticketId;
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: ticketId || 'skipped — no LINEAR_API_KEY' });
      }

      if (block.name === 'write_triage_summary') {
        summary = input['summary'] as string;
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'ok' });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Attach summary for output
  (triaged as any).__summary__ = summary;
  return triaged;
}

// ── Print & save ───────────────────────────────────────────────

async function printAndSave(failures: TriagedFailure[], reportsScanned: number) {
  const summary = (failures as any).__summary__ as string || '';

  const byClass: Record<FailureClass, number> = { FLAKY: 0, BUG: 0, ENV: 0 };
  for (const f of failures) byClass[f.classification]++;

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  TRIAGE REPORT — ${new Date().toLocaleDateString()}`);
  console.log(`${'═'.repeat(64)}`);
  console.log(`  Reports scanned : ${reportsScanned}`);
  console.log(`  Failures found  : ${failures.length}`);
  console.log(`  BUG  ${byClass.BUG}  |  FLAKY  ${byClass.FLAKY}  |  ENV  ${byClass.ENV}`);
  console.log(`${'─'.repeat(64)}`);

  for (const f of failures) {
    const icon = f.classification === 'BUG' ? '🐛' : f.classification === 'FLAKY' ? '🌊' : '⚙️';
    console.log(`${icon}  [${f.classification}/${f.confidence}] ${f.agent.toUpperCase()} — ${f.testId || f.scenario || f.testType}`);
    console.log(`   ${f.reasoning}`);
    console.log(`   → ${f.recommendation}`);
    if (f.linearTicketId) console.log(`   Linear: ${f.linearTicketId}`);
    console.log();
  }

  if (summary) {
    console.log(`${'─'.repeat(64)}`);
    console.log(`  Summary: ${summary}`);
  }
  console.log(`${'═'.repeat(64)}`);

  const report: TriageReport = {
    generatedAt: new Date().toISOString(),
    lookBackDays: LOOK_BACK_DAYS,
    reportsScanned,
    totalFailures: failures.length,
    byClass,
    failures,
    summary,
  };

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `triage-${new Date().toISOString().split('T')[0]}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report saved → ${outPath}`);

  if (USE_SLACK) await postTriageToSlack(report);
}

async function postTriageToSlack(report: TriageReport) {
  const { byClass, failures, summary, totalFailures } = report;
  const bugs   = failures.filter(f => f.classification === 'BUG');
  const overall = byClass.BUG > 0 ? '🔴 Bugs found' : byClass.FLAKY > 0 ? '🟡 Flaky tests' : '✅ All clear';

  const blocks: unknown[] = [
    headerBlock(`🔎 Triage Report — ${overall}`),
    sectionBlock(
      `*BUG* ${byClass.BUG}  |  *FLAKY* ${byClass.FLAKY}  |  *ENV* ${byClass.ENV}  |  Total failures: ${totalFailures}`
    ),
  ];

  if (bugs.length) {
    blocks.push(dividerBlock());
    blocks.push(sectionBlock('*🐛 Bugs requiring action:*'));
    for (const b of bugs.slice(0, 5)) {
      const ticket = b.linearTicketId ? ` — <https://linear.app/issue/${b.linearTicketId}|${b.linearTicketId}>` : '';
      blocks.push(sectionBlock(
        `*${b.agent.toUpperCase()}* \`${b.testId || b.testType}\`${ticket}\n${b.reasoning}\n→ _${b.recommendation}_`
      ));
    }
    if (bugs.length > 5) blocks.push(contextBlock(`…and ${bugs.length - 5} more bugs`));
  }

  if (summary) {
    blocks.push(dividerBlock());
    blocks.push(contextBlock(summary));
  }

  await sendSlackBlocks(overall, blocks);
  console.log('  [Slack] Triage report posted');
}

// ── Entry point ────────────────────────────────────────────────

(async () => {
  if (!ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

  console.log(`\n🔍 Triage agent — scanning last ${LOOK_BACK_DAYS} day(s) of reports...`);

  const reportsScanned = existsSync(REPORTS_DIR)
    ? readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('triage')).length
    : 0;

  const failures = loadRecentReports();
  if (failures.length === 0) {
    console.log('  No failures found. All green!');
    process.exit(0);
  }

  console.log(`  Found ${failures.length} failure(s). Sending to Claude for triage...\n`);
  const triaged = await runTriageAgent(failures);
  await printAndSave(triaged, reportsScanned);
})();
