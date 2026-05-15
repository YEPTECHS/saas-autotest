/**
 * qa-agent.ts — Daily Linear QA scanner + AI-driven test generator
 *
 * True AI agent: Claude drives the full loop with tool calls.
 * Improvements over v1:
 *  - Claude decides whether to test, skip, or request approval (no separate analyzeTicket step)
 *  - Stale-test detection: re-runs if ticket was updated since last test
 *  - Rich app context in system prompt (routes, agents, selectors)
 *  - Posts result comment back to Linear ticket on completion
 *
 * Flow:
 *  1. Fetch QA issues from Linear
 *  2. Load state; check Gmail inbox for approval replies
 *  3. For each ticket:
 *     - If done/failed but ticket was updated → re-run
 *     - If pending approval → skip unless reply detected
 *     - Otherwise → run agent loop (Claude + tools)
 *       Agent decides: write+run test | skip | request_approval
 *  4. Post result to Linear, save state, email HTML report
 *
 * Required env vars:
 *   LINEAR_API_KEY, ANTHROPIC_API_KEY
 *   YEPAI_BASE_URL, YEPAI_LOGIN_EMAIL, YEPAI_LOGIN_PASSWORD
 *   REPORT_EMAIL_FROM, REPORT_EMAIL_PASS, REPORT_EMAIL_TO
 *
 * Optional:
 *   QA_TEAM              Linear team key (default: YEP)
 *   QA_AGENT_APPROVE     Space-separated ticket IDs to force-approve
 */

import Anthropic from '@anthropic-ai/sdk';
import { ImapFlow } from 'imapflow';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync, execSync } from 'child_process';
import nodemailer from 'nodemailer';
import 'dotenv/config';

// ── Config ─────────────────────────────────────────────────────

const LINEAR_API_KEY    = process.env.LINEAR_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const LINEAR_TEAM       = process.env.QA_TEAM || 'YEP';
const APPROVAL_EMAIL    = 'paukiechee96@gmail.com';
const STATE_FILE        = join(process.cwd(), 'data/qa-agent-state.json');
const FLOWS_DIR         = join(process.cwd(), 'src/flows');
const REPORTS_DIR       = join(process.cwd(), 'reports');
const MAX_AGENT_STEPS   = 14;
const MAX_TEST_RUNS     = 3;

const FORCE_APPROVE: string[] = (
  process.env.QA_AGENT_APPROVE ||
  process.argv.find(a => a.startsWith('--approve='))?.split('=')[1] || ''
).split(/\s+/).filter(Boolean);

// ── App context injected into agent system prompt ───────────────

const APP_CONTEXT = `
## YepAI app routes
- Login:                   {{YEPAI_BASE_URL}}/auth/login
- Dashboard:               {{YEPAI_BASE_URL}}/dashboard
- Maya  (Marketing AI):    {{YEPAI_BASE_URL}}/ai-team/marketing/chat
- Oscar (Operations AI):   {{YEPAI_BASE_URL}}/ai-team/operation/chat
- Daniel (Profit AI):      {{YEPAI_BASE_URL}}/ai-team/profit/chat
- Cody  (SEO AI):          {{YEPAI_BASE_URL}}/ai-team/seo/chat
- Analytics overview:      {{YEPAI_BASE_URL}}/analytics/overview
- Customers:               {{YEPAI_BASE_URL}}/customers
- AI Training:             {{YEPAI_BASE_URL}}/ai-training
- Settings:                {{YEPAI_BASE_URL}}/settings
- Integrations:            {{YEPAI_BASE_URL}}/integrations
- Pricing:                 {{YEPAI_BASE_URL}}/pricing

## Key selectors
- Chat input (all agents): textarea
- Send message: press Enter, or button[type="submit"]
- Email input:             input[type='email']
- Password input:          input[type='password']
- Submit button:           button[type='submit']

## Shared step files
- _shared/login.steps.yml — navigates to /auth/login, fills credentials, waits for dashboard.
  Always include this as the first step in every flow.
`;

// ── Types ──────────────────────────────────────────────────────

interface LinearIssue {
  id: string;           // internal UUID — used for mutations (postLinearComment)
  identifier: string;   // human ID e.g. YEP-364
  title: string;
  description: string;
  url: string;
  updatedAt: string;    // ISO timestamp — used for stale detection
  labels: string[];
}

interface TicketState {
  status: 'pending_approval' | 'approved' | 'done' | 'skipped' | 'failed';
  firstSeenAt: string;
  title: string;
  url: string;
  askedAt?: string;
  approvedAt?: string;
  completedAt?: string;
  flowName?: string;
  passCount?: number;
  failCount?: number;
  notes?: string;
  error?: string;
}

type AgentState = Record<string, TicketState>;

interface AgentReport {
  outcome: 'done' | 'failed' | 'skipped' | 'pending_approval';
  flowName: string;
  passCount: number;
  failCount: number;
  notes: string;
  testOutput: string;
}

// ── State helpers ───────────────────────────────────────────────

function loadState(): AgentState {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}

function saveState(state: AgentState): void {
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Linear API ─────────────────────────────────────────────────

async function linearGQL(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  if (!LINEAR_API_KEY) throw new Error('LINEAR_API_KEY not set');
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': LINEAR_API_KEY },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json() as any;
  if (json.errors) throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchQAIssues(): Promise<LinearIssue[]> {
  const data = await linearGQL(`
    query QAIssues($teamKey: String!, $statusName: String!) {
      issues(filter: {
        team: { key: { eq: $teamKey } }
        state: { name: { eq: $statusName } }
      }, first: 50) {
        nodes {
          id identifier title description url updatedAt
          labels { nodes { name } }
        }
      }
    }
  `, { teamKey: LINEAR_TEAM, statusName: 'QA' });

  return (data.issues.nodes as any[]).map((n: any) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description || '',
    url: n.url,
    updatedAt: n.updatedAt,
    labels: (n.labels?.nodes || []).map((l: any) => l.name as string),
  }));
}

async function postLinearComment(issueId: string, body: string): Promise<void> {
  try {
    await linearGQL(`
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `, { issueId, body });
    console.log('  [linear] comment posted');
  } catch (e: any) {
    console.warn(`  [linear] failed to post comment: ${e.message}`);
  }
}

// ── Gmail IMAP: check for approval replies ──────────────────────

async function checkApprovalReplies(pendingIds: string[]): Promise<Set<string>> {
  const approved = new Set<string>();
  const from = process.env.REPORT_EMAIL_FROM;
  const pass = process.env.REPORT_EMAIL_PASS;
  if (!from || !pass || pendingIds.length === 0) return approved;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: from, pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const ticketId of pendingIds) {
        // Search subject AND body separately — handles forwarded/mangled subjects
        const subjectHits = (await client.search({ from: APPROVAL_EMAIL, subject: ticketId })) || [];
        const bodyHits    = (await client.search({ from: APPROVAL_EMAIL, body:    ticketId })) || [];
        if (subjectHits.length > 0 || bodyHits.length > 0) {
          approved.add(ticketId);
          console.log(`  [imap] approval reply found for ${ticketId}`);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e: any) {
    console.warn(`  [imap] inbox check failed: ${e.message}`);
  } finally {
    await client.logout();
  }
  return approved;
}

// ── Email helpers ───────────────────────────────────────────────

async function sendApprovalEmail(
  issue: LinearIssue,
  reason: string,
  testPlan: string,
): Promise<void> {
  const from = process.env.REPORT_EMAIL_FROM;
  const pass = process.env.REPORT_EMAIL_PASS;
  if (!from || !pass) { console.log('  [email] skipped — REPORT_EMAIL_* not set'); return; }

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: from, pass } });
  const html = `
    <h2>🤖 QA Agent — Approval Needed</h2>
    <p>I found a QA ticket I'm not sure about. Should I write automated tests for it?</p>
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:6px;font-weight:bold">Ticket</td><td><a href="${issue.url}">${issue.identifier} — ${issue.title}</a></td></tr>
      <tr><td style="padding:6px;font-weight:bold">Why unsure</td><td>${reason}</td></tr>
      <tr><td style="padding:6px;font-weight:bold;vertical-align:top">Test plan</td><td><pre style="margin:0">${testPlan}</pre></td></tr>
    </table>
    <br>
    <p><strong>To approve:</strong> reply to this email with anything — the QA agent detects your reply on the next daily run.</p>
    <p><strong>To skip:</strong> no action needed.</p>
  `;
  await transporter.sendMail({
    from,
    to: APPROVAL_EMAIL,
    subject: `QA Agent: Approve test for ${issue.identifier}? (${issue.title.substring(0, 50)})`,
    html,
  });
  console.log(`  [email] approval request sent for ${issue.identifier}`);
}

async function sendEmail(subject: string, html: string): Promise<void> {
  const from = process.env.REPORT_EMAIL_FROM;
  const pass = process.env.REPORT_EMAIL_PASS;
  const to   = process.env.REPORT_EMAIL_TO;
  if (!from || !pass || !to) { console.log('  [email] skipped — REPORT_EMAIL_* not set'); return; }

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: from, pass } });
  await transporter.sendMail({ from, to, subject, html });
  console.log(`  [email] report sent to ${to}`);
}

// ── Agent tools ─────────────────────────────────────────────────

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_flows',
    description: 'List all existing .flow.yml test files in src/flows/. Read 1-2 similar ones for context.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'read_file',
    description: 'Read a file in the project. Path relative to project root.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'e.g. src/flows/test-marketing-chat.flow.yml' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_git_context',
    description: 'Get recent git commits mentioning a ticket ID — helps understand what changed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ticketId: { type: 'string', description: 'e.g. YEP-364' },
      },
      required: ['ticketId'],
    },
  },
  {
    name: 'write_flow',
    description: 'Save a YAML flow test file to src/flows/. Overwrites if exists.',
    input_schema: {
      type: 'object' as const,
      properties: {
        flowName: { type: 'string', description: 'kebab-case without .flow.yml (e.g. test-yep-364-order-state)' },
        yaml: { type: 'string', description: 'Complete YAML content' },
      },
      required: ['flowName', 'yaml'],
    },
  },
  {
    name: 'run_test',
    description: `Run a flow test and return full output. Up to ${MAX_TEST_RUNS} attempts — fix failures between runs.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        flowName: { type: 'string' },
      },
      required: ['flowName'],
    },
  },
  {
    name: 'request_approval',
    description: 'Send an approval email to the human and pause this ticket. Use when you are genuinely uncertain whether automated testing is appropriate for this ticket.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason:   { type: 'string', description: 'Why you are uncertain' },
        testPlan: { type: 'string', description: 'What you would test if approved (2-4 steps)' },
      },
      required: ['reason', 'testPlan'],
    },
  },
  {
    name: 'skip_ticket',
    description: 'Mark this ticket as not suitable for automated testing. Use when there is no clear programmatic pass/fail criteria (e.g. purely visual, requires human judgement).',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'Why it cannot be automated' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'report_done',
    description: 'Call this when the test run is finished (pass or fail after retries).',
    input_schema: {
      type: 'object' as const,
      properties: {
        flowName:   { type: 'string', description: 'Flow name that was run, or empty string' },
        passCount:  { type: 'number' },
        failCount:  { type: 'number' },
        notes:      { type: 'string', description: 'One-sentence summary' },
      },
      required: ['flowName', 'passCount', 'failCount', 'notes'],
    },
  },
];

// ── Tool executor ───────────────────────────────────────────────

interface ToolCtx {
  testRunCount: number;
  lastOutput: string;
  report?: AgentReport;       // set when report_done / skip_ticket / request_approval fires
  pendingApprovalData?: { reason: string; testPlan: string };
}

async function executeTool(
  name: string,
  input: Record<string, any>,
  ctx: ToolCtx,
  issue: LinearIssue,
): Promise<string> {
  switch (name) {

    case 'list_flows': {
      if (!existsSync(FLOWS_DIR)) return '(src/flows/ not found)';
      const files = readdirSync(FLOWS_DIR)
        .filter(f => f.endsWith('.flow.yml'))
        .map(f => `src/flows/${f}`)
        .sort();
      return files.join('\n') || '(no flow files yet)';
    }

    case 'read_file': {
      const safePath = join(process.cwd(), (input.path as string).replace(/\.\./g, ''));
      if (!existsSync(safePath)) return `File not found: ${input.path}`;
      try {
        const content = readFileSync(safePath, 'utf-8');
        return content.length > 6000 ? content.substring(0, 6000) + '\n…(truncated)' : content;
      } catch (e: any) {
        return `Error reading file: ${e.message}`;
      }
    }

    case 'get_git_context': {
      try {
        const log = execSync(
          `git log --oneline -20 --grep="${input.ticketId}"`,
          { cwd: process.cwd(), encoding: 'utf-8', timeout: 10000 },
        ).trim();
        return log || '(no commits found for this ticket)';
      } catch {
        return '(git context unavailable)';
      }
    }

    case 'write_flow': {
      if (!existsSync(FLOWS_DIR)) mkdirSync(FLOWS_DIR, { recursive: true });
      const yaml = (input.yaml as string).replace(/^```ya?ml\n?/i, '').replace(/\n?```$/i, '').trim();
      writeFileSync(join(FLOWS_DIR, `${input.flowName}.flow.yml`), yaml);
      return `Written: src/flows/${input.flowName}.flow.yml (${yaml.length} chars)`;
    }

    case 'run_test': {
      ctx.testRunCount++;
      if (ctx.testRunCount > MAX_TEST_RUNS) {
        return `Max test runs (${MAX_TEST_RUNS}) reached. Call report_done to finish.`;
      }
      console.log(`   [agent] run_test: ${input.flowName} (attempt ${ctx.testRunCount}/${MAX_TEST_RUNS})`);
      const start = Date.now();
      const res = spawnSync('pnpm', ['flow', input.flowName as string], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 10 * 60 * 1000,
        env: { ...process.env },
      });
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      const output = ((res.stdout || '') + (res.stderr || '')).substring(0, 4000);
      ctx.lastOutput = output;
      return `Exit: ${res.status} | Duration: ${duration}s | Success: ${res.status === 0}\n\n${output}`;
    }

    case 'request_approval': {
      ctx.pendingApprovalData = { reason: input.reason, testPlan: input.testPlan };
      try {
        await sendApprovalEmail(issue, input.reason as string, input.testPlan as string);
      } catch (e: any) {
        console.warn(`  [email] sendApprovalEmail failed: ${e.message}`);
      }
      ctx.report = {
        outcome: 'pending_approval',
        flowName: '',
        passCount: 0,
        failCount: 0,
        notes: input.reason as string,
        testOutput: '',
      };
      return 'Approval email sent. Ticket paused until human replies.';
    }

    case 'skip_ticket': {
      ctx.report = {
        outcome: 'skipped',
        flowName: '',
        passCount: 0,
        failCount: 0,
        notes: input.reason as string,
        testOutput: '',
      };
      return 'Ticket marked as skipped.';
    }

    case 'report_done': {
      ctx.report = {
        outcome: (input.passCount as number) > 0 || (input.failCount as number) === 0 ? 'done' : 'failed',
        flowName: input.flowName as string,
        passCount: input.passCount as number,
        failCount: input.failCount as number,
        notes: input.notes as string,
        testOutput: ctx.lastOutput,
      };
      return 'Acknowledged. Agent loop complete.';
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Agent system prompt ─────────────────────────────────────────

const AGENT_SYSTEM = `You are an expert QA automation engineer for a Playwright + TypeScript E2E framework.

Tests are defined as YAML "flow" files in src/flows/. Every flow must start with:
  steps:
    - include: _shared/login.steps.yml

Available step actions:
  browser.navigate        params: { url, waitUntil? }
  browser.click           params: { selector }
  browser.waitForSelector params: { selector, timeout? }
  browser.waitForUrl      params: { pattern, timeout? }
  browser.type            params: { selector, text }
  browser.execute         params: { script }  output: varName
  browser.screenshot      params: { name }
  form.fillSingle         params: { selector, value }
  wait                    params: { ms }
  log                     params: { message }
  data.saveJson           params: { file, data }

Add continueOnError: true on assertion steps.
Use CSS selectors; prefer data attributes or visible-text selectors.
${APP_CONTEXT}
## Your process for each ticket
1. Call list_flows, then read_file on 1-2 relevant existing flows for structural context.
2. Optionally call get_git_context to see what changed.
3. Decide:
   - Clear, automatable test → write_flow → run_test → fix if needed → report_done
   - Genuinely uncertain → request_approval (pauses ticket, emails human)
   - Not automatable (visual/UX only, no pass/fail criteria) → skip_ticket
4. If run_test fails: read the error carefully, update the YAML, retry (max ${MAX_TEST_RUNS} runs).
5. Always end with report_done, skip_ticket, or request_approval.`;

// ── Agent loop ──────────────────────────────────────────────────

async function runAgentLoop(issue: LinearIssue, alreadyApproved: boolean): Promise<AgentReport> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const approvalNote = alreadyApproved
    ? '\n\n**Note:** A human has already approved this ticket for testing — proceed directly without calling request_approval.'
    : '';

  const userMessage = `Write and run an automated E2E test for this Linear ticket:

**${issue.identifier} — ${issue.title}**
Labels: ${issue.labels.join(', ') || 'none'}

Description:
${issue.description || '(no description provided)'}
${approvalNote}

Start by listing flows and reading 1-2 relevant ones for context. Then decide what to do and proceed.`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  const ctx: ToolCtx = { testRunCount: 0, lastOutput: '' };
  let step = 0;

  console.log(`   [agent] loop started for ${issue.identifier} (max ${MAX_AGENT_STEPS} steps, ${MAX_TEST_RUNS} runs)`);

  while (step < MAX_AGENT_STEPS && !ctx.report) {
    step++;

    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: AGENT_SYSTEM,
      tools: AGENT_TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        console.log(`   [agent] ${block.text.substring(0, 160).replace(/\n/g, ' ')}`);
      }
    }

    if (response.stop_reason === 'end_turn') {
      console.log('   [agent] end_turn without terminal tool call');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        console.log(`   [agent] step ${step}: ${block.name}(${JSON.stringify(block.input).substring(0, 80)})`);

        const result = await executeTool(block.name, block.input as Record<string, any>, ctx, issue);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  if (!ctx.report) {
    ctx.report = {
      outcome: 'failed',
      flowName: '',
      passCount: 0,
      failCount: 1,
      notes: `Agent did not complete within ${MAX_AGENT_STEPS} steps`,
      testOutput: ctx.lastOutput,
    };
  }

  const r = ctx.report;
  console.log(`   [agent] outcome=${r.outcome} pass=${r.passCount} fail=${r.failCount} — ${r.notes}`);
  return r;
}

// ── Linear comment builder ──────────────────────────────────────

function buildLinearComment(report: AgentReport): string {
  const icon = report.outcome === 'done' ? '✅' : report.outcome === 'failed' ? '❌' : '⏭️';
  const label = report.outcome === 'done' ? 'Auto-test passed'
    : report.outcome === 'failed'         ? 'Auto-test generated but failed'
    : 'Skipped (not automatable)';

  const lines = [`${icon} **QA Agent** — ${label}`, ''];
  if (report.flowName) lines.push(`Flow: \`${report.flowName}.flow.yml\``);
  if (report.passCount !== undefined) lines.push(`Pass: ${report.passCount}  Fail: ${report.failCount}`);
  if (report.notes) lines.push('', report.notes);
  return lines.join('\n');
}

// ── HTML report ─────────────────────────────────────────────────

function buildReport(
  results: Array<{ issue: LinearIssue; state: TicketState; runOutput?: string }>
): string {
  const date = new Date().toISOString().split('T')[0];
  const rows = results.map(({ issue, state, runOutput }) => {
    const emoji: Record<string, string> = {
      done: '✅', failed: '❌', pending_approval: '⏳', skipped: '⏭️', approved: '🔄',
    };
    const output = runOutput
      ? `<pre style="font-size:11px;max-height:200px;overflow:auto;background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">${runOutput.substring(0, 2000).replace(/</g, '&lt;')}</pre>`
      : '';
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee">
          <a href="${issue.url}" style="font-weight:bold;color:#5e6ad2">${issue.identifier}</a>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee">${issue.title}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${emoji[state.status] ?? '❓'} ${state.status}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${state.flowName ? `<code>${state.flowName}</code>` : '—'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">
          ${state.passCount !== undefined ? `✅ ${state.passCount} / ❌ ${state.failCount}` : '—'}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#555">${state.notes ?? ''}</td>
      </tr>
      ${output ? `<tr><td colspan="6" style="padding:0 8px 12px">${output}</td></tr>` : ''}`;
  }).join('');

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:960px;margin:auto;padding:20px">
  <h2 style="color:#5e6ad2">🤖 QA Agent Report — ${date}</h2>
  <p>Scanned Linear team <strong>${LINEAR_TEAM}</strong> for QA tickets.</p>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#f5f5f5">
      <th style="padding:8px;text-align:left">Ticket</th>
      <th style="padding:8px;text-align:left">Title</th>
      <th style="padding:8px;text-align:center">Status</th>
      <th style="padding:8px;text-align:left">Flow</th>
      <th style="padding:8px;text-align:center">Pass/Fail</th>
      <th style="padding:8px;text-align:left">Notes</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <hr style="margin-top:30px">
  <p style="color:#888;font-size:12px">Generated by qa-agent.ts — ${new Date().toISOString()}</p>
  </body></html>`;
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n🤖 QA Agent starting...\n');

  if (!LINEAR_API_KEY)    { console.error('ERROR: LINEAR_API_KEY not set');    process.exit(1); }
  if (!ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

  // 1. Fetch QA tickets
  console.log('📋 Fetching QA issues from Linear...');
  const issues = await fetchQAIssues();
  console.log(`   Found ${issues.length} issue(s) in QA status`);

  // 2. Load state
  const state = loadState();

  // 3. Check Gmail for approval replies on pending tickets
  const pendingIds = Object.entries(state)
    .filter(([, s]) => s.status === 'pending_approval')
    .map(([id]) => id);
  console.log(`\n📬 Checking inbox for approval replies (${pendingIds.length} pending)...`);
  const emailApproved = await checkApprovalReplies(pendingIds);
  if (emailApproved.size > 0) {
    console.log(`   Approved via email: ${[...emailApproved].join(', ')}`);
  }

  const reportRows: Array<{ issue: LinearIssue; state: TicketState; runOutput?: string }> = [];

  // 4. Process each ticket
  for (const issue of issues) {
    const id = issue.identifier;
    console.log(`\n── ${id}: ${issue.title}`);

    const forceApproved = FORCE_APPROVE.includes(id);
    const isApproved    = forceApproved || emailApproved.has(id);
    const existing      = state[id];

    // ── Stale detection ─────────────────────────────────────────
    if ((existing?.status === 'done' || existing?.status === 'failed') && existing.completedAt) {
      const daysSince = (Date.now() - new Date(existing.completedAt).getTime()) / 86_400_000;

      if (issue.updatedAt > existing.completedAt) {
        console.log(`   Ticket updated since last run — re-testing`);
        state[id] = { ...existing, status: 'approved', approvedAt: new Date().toISOString() };
      } else if (existing.status === 'failed' && daysSince >= 3) {
        console.log(`   Failed ${daysSince.toFixed(0)}d ago — auto-retrying`);
        state[id] = { ...existing, status: 'approved', approvedAt: new Date().toISOString() };
      } else {
        console.log(`   Status: ${existing.status} (${daysSince.toFixed(0)}d ago)`);
        reportRows.push({ issue, state: existing });
        continue;
      }
    }

    // ── Skipped tickets stay skipped ────────────────────────────
    if (existing?.status === 'skipped') {
      console.log('   Status: skipped');
      reportRows.push({ issue, state: existing });
      continue;
    }

    // ── Pending approval — skip unless reply detected ───────────
    if (existing?.status === 'pending_approval' && !isApproved) {
      console.log('   Waiting for approval email reply');
      reportRows.push({ issue, state: existing });
      continue;
    }

    // ── Mark approved if reply came in ─────────────────────────
    if (isApproved && existing?.status === 'pending_approval') {
      const source = forceApproved ? 'QA_AGENT_APPROVE flag' : 'email reply';
      console.log(`   Approved via ${source}`);
      state[id] = { ...existing, status: 'approved', approvedAt: new Date().toISOString() };
    }

    // ── Initialise new tickets ──────────────────────────────────
    if (!existing) {
      state[id] = {
        status: 'approved',  // agent decides skip/approval internally
        firstSeenAt: new Date().toISOString(),
        title: issue.title,
        url: issue.url,
      };
    }

    // ── Run agent loop ──────────────────────────────────────────
    const wasAlreadyApproved = isApproved || existing?.status === 'approved';
    console.log('   Running agent loop...');

    let agentResult: AgentReport;
    try {
      agentResult = await runAgentLoop(issue, wasAlreadyApproved);
    } catch (e: any) {
      console.error(`   Agent loop error: ${e.message}`);
      state[id] = { ...state[id], status: 'failed', error: e.message, completedAt: new Date().toISOString() };
      reportRows.push({ issue, state: state[id] });
      saveState(state);
      continue;
    }

    // ── Update state from agent result ──────────────────────────
    state[id] = {
      ...state[id],
      status: agentResult.outcome,
      completedAt: agentResult.outcome !== 'pending_approval' ? new Date().toISOString() : undefined,
      askedAt: agentResult.outcome === 'pending_approval' ? new Date().toISOString() : state[id].askedAt,
      flowName: agentResult.flowName || undefined,
      passCount: agentResult.passCount,
      failCount: agentResult.failCount,
      notes: agentResult.notes,
      error: agentResult.outcome === 'failed' ? agentResult.notes : undefined,
    };

    // ── Post result to Linear ───────────────────────────────────
    if (agentResult.outcome === 'done' || agentResult.outcome === 'failed' || agentResult.outcome === 'skipped') {
      await postLinearComment(issue.id, buildLinearComment(agentResult));
    }

    reportRows.push({ issue, state: state[id], runOutput: agentResult.testOutput });
    saveState(state);
  }

  // 5. Save final state
  saveState(state);

  // 6. Generate + email report
  if (reportRows.length > 0) {
    const html = buildReport(reportRows);
    const reportFile = join(REPORTS_DIR, `qa-agent-report-${new Date().toISOString().split('T')[0]}.html`);
    writeFileSync(reportFile, html);
    console.log(`\n📄 Report: ${reportFile}`);

    const done    = reportRows.filter(r => r.state.status === 'done').length;
    const failed  = reportRows.filter(r => r.state.status === 'failed').length;
    const pending = reportRows.filter(r => r.state.status === 'pending_approval').length;
    await sendEmail(`🤖 QA Agent — ${done} done, ${failed} failed, ${pending} pending`, html);
  }

  console.log('\n✅ QA Agent done.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
