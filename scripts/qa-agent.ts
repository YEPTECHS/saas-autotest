/**
 * qa-agent.ts — Daily Linear QA scanner + automated test generator
 *
 * Flow:
 *  1. Fetch all "QA" status issues from Linear (team YEP)
 *  2. Load persisted state (data/qa-agent-state.json)
 *  3. For each NEW ticket:
 *     - Ask Claude: should we write automated tests? (confidence score)
 *     - High confidence (>= 0.75) → generate flow YAML → run → report
 *     - Low confidence → post Linear comment asking for approval, wait
 *  4. For PENDING tickets:
 *     - Check if a human replied "approve" to the bot comment → if yes, proceed
 *  5. Save state, generate HTML report, send email
 *
 * Required secrets / env vars:
 *   LINEAR_API_KEY        Linear personal API token
 *   ANTHROPIC_API_KEY     Anthropic API key
 *   YEPAI_BASE_URL        YepAI app base URL
 *   YEPAI_LOGIN_EMAIL
 *   YEPAI_LOGIN_PASSWORD
 *   REPORT_EMAIL_FROM
 *   REPORT_EMAIL_PASS
 *   REPORT_EMAIL_TO
 *
 * Optional:
 *   QA_AGENT_APPROVE      Space-separated ticket IDs to force-approve (e.g. "YEP-364 YEP-365")
 *   QA_TEAM               Linear team key (default: YEP)
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import nodemailer from 'nodemailer';
import 'dotenv/config';

// ── Config ─────────────────────────────────────────────────────

const LINEAR_API_KEY   = process.env.LINEAR_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const LINEAR_TEAM      = process.env.QA_TEAM || 'YEP';
const CONFIDENCE_THRESHOLD = 0.75;
const BOT_MARKER       = '🤖 QA Agent';
const STATE_FILE       = join(process.cwd(), 'data/qa-agent-state.json');
const FLOWS_DIR        = join(process.cwd(), 'src/flows');
const REPORTS_DIR      = join(process.cwd(), 'reports');

// Force-approve specific tickets (from env or CLI)
const FORCE_APPROVE: string[] = (
  process.env.QA_AGENT_APPROVE ||
  process.argv.find(a => a.startsWith('--approve='))?.split('=')[1] || ''
).split(/\s+/).filter(Boolean);

// ── Types ──────────────────────────────────────────────────────

interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  user: { name: string; email: string; isBot: boolean };
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
  comments: LinearComment[];
}

interface TicketState {
  status: 'pending_approval' | 'approved' | 'done' | 'skipped' | 'failed';
  firstSeenAt: string;
  title: string;
  url: string;
  askedAt?: string;
  approvedAt?: string;
  completedAt?: string;
  reportFile?: string;
  flowName?: string;
  passCount?: number;
  failCount?: number;
  error?: string;
}

type AgentState = Record<string, TicketState>;

interface ClaudeAnalysis {
  shouldTest: boolean;
  confidence: number;
  reason: string;
  testType: 'browser_flow' | 'api' | 'skip';
  testPlan: string;
  suggestedFlowName: string;
}

interface RunResult {
  success: boolean;
  output: string;
  durationMs: number;
}

// ── State helpers ───────────────────────────────────────────────

function loadState(): AgentState {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}

function saveState(state: AgentState): void {
  if (!existsSync(join(process.cwd(), 'data'))) mkdirSync(join(process.cwd(), 'data'), { recursive: true });
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
          id identifier title description url
          labels { nodes { name } }
          comments { nodes {
            id body createdAt
            user { name email isBot }
          }}
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
    labels: (n.labels?.nodes || []).map((l: any) => l.name as string),
    comments: (n.comments?.nodes || []).map((c: any) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      user: { name: c.user?.name || '', email: c.user?.email || '', isBot: !!c.user?.isBot },
    })),
  }));
}

async function postLinearComment(issueId: string, body: string): Promise<void> {
  await linearGQL(`
    mutation PostComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }
  `, { issueId, body });
}

// ── Check if human approved the bot comment ─────────────────────

function isApprovedByHuman(issue: LinearIssue): boolean {
  const botCommentIdx = issue.comments.findIndex(
    c => c.user.isBot && c.body.includes(BOT_MARKER)
  );
  if (botCommentIdx === -1) return false;
  // Any subsequent human comment containing "approve" (case-insensitive)
  return issue.comments.slice(botCommentIdx + 1).some(
    c => !c.user.isBot && /\bapprove\b/i.test(c.body)
  );
}

// ── Claude: analyse ticket ──────────────────────────────────────

async function analyzeTicket(issue: LinearIssue): Promise<ClaudeAnalysis> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const prompt = `You are a QA automation engineer reviewing a Linear ticket that is in "QA" status.

Ticket: ${issue.identifier} — ${issue.title}
Labels: ${issue.labels.join(', ') || 'none'}
Description:
${issue.description || '(no description)'}

Decide whether to write an automated E2E test for this ticket.

Rules:
- Write a test if the ticket describes a reproducible UI or API behaviour that can be verified programmatically.
- Skip if it's a design/UX issue, requires human judgement, is already about the test itself, or has no clear pass/fail criteria.
- The test framework is Playwright + TypeScript with YAML flow files (browser automation) or API scripts.

Return ONLY valid JSON with this exact shape:
{
  "shouldTest": true | false,
  "confidence": 0.0–1.0,
  "reason": "one sentence explaining your decision",
  "testType": "browser_flow" | "api" | "skip",
  "testPlan": "step-by-step description of what the test should do (2–5 steps)",
  "suggestedFlowName": "kebab-case-name (e.g. test-yep-364-order-state)"
}`;

  const msg = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (msg.content[0] as any).text as string;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return JSON');
  return JSON.parse(jsonMatch[0]) as ClaudeAnalysis;
}

// ── Claude: generate flow YAML ──────────────────────────────────

async function generateFlowYml(issue: LinearIssue, analysis: ClaudeAnalysis): Promise<string> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const exampleFlow = `name: test-order-example
description: Verify order state transitions are enforced
steps:
  - include: _shared/login.steps.yml
  - id: nav-orders
    action: browser.navigate
    params:
      url: "{{YEPAI_BASE_URL}}/orders"
      waitUntil: networkidle
  - id: wait-load
    action: wait
    params:
      ms: 2000
  - id: check-state
    action: browser.execute
    params:
      script: |
        // example: verify state
        return document.title;
    output: pageTitle
  - id: log-result
    action: log
    params:
      message: "Page title: {{pageTitle.result}}"`;

  const prompt = `You are a QA automation engineer. Write a Playwright YAML flow test for the following ticket.

Ticket: ${issue.identifier} — ${issue.title}
Test Plan:
${analysis.testPlan}

Full description:
${issue.description || '(none)'}

App base URL is injected as {{YEPAI_BASE_URL}}.
The flow must start with:  - include: _shared/login.steps.yml

Available actions:
- browser.navigate  params: { url, waitUntil? }
- browser.click     params: { selector }
- browser.waitForSelector  params: { selector, timeout? }
- browser.execute   params: { script }  output: varName
- browser.screenshot params: { name }
- form.fillSingle   params: { selector, value }
- wait              params: { ms }
- log               params: { message }
- data.saveJson     params: { file, data }

Use continueOnError: true on steps that might fail (assertion steps).
Save a JSON report to reports/${analysis.suggestedFlowName}-result.json.
Return ONLY the complete YAML, no markdown fences, no explanation.

Example structure:
${exampleFlow}`;

  const msg = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  let yaml = (msg.content[0] as any).text as string;
  // Strip any accidental markdown fences
  yaml = yaml.replace(/^```ya?ml\n?/i, '').replace(/\n?```$/i, '').trim();
  return yaml;
}

// ── Run flow ────────────────────────────────────────────────────

function runFlow(flowName: string): RunResult {
  const start = Date.now();
  const result = spawnSync(
    'pnpm',
    ['flow', flowName],
    {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 10 * 60 * 1000, // 10 min
      env: { ...process.env },
    }
  );
  const output = (result.stdout || '') + (result.stderr || '');
  return {
    success: result.status === 0,
    output: output.substring(0, 5000),
    durationMs: Date.now() - start,
  };
}

// ── Count pass/fail in output ───────────────────────────────────

function countResults(output: string): { pass: number; fail: number } {
  const passMatch = output.match(/PASS[:\s]+(\d+)/i);
  const failMatch = output.match(/FAIL[:\s]+(\d+)/i);
  const pass = passMatch ? parseInt(passMatch[1]) : (output.includes('completed successfully') ? 1 : 0);
  const fail = failMatch ? parseInt(failMatch[1]) : (output.includes('FAILED') || output.includes('Error') ? 1 : 0);
  return { pass, fail };
}

// ── Email ───────────────────────────────────────────────────────

async function sendEmail(subject: string, html: string): Promise<void> {
  const from = process.env.REPORT_EMAIL_FROM;
  const pass = process.env.REPORT_EMAIL_PASS;
  const to   = process.env.REPORT_EMAIL_TO;
  if (!from || !pass || !to) { console.log('  [email] skipped — REPORT_EMAIL_* not set'); return; }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: from, pass },
  });
  await transporter.sendMail({ from, to, subject, html });
  console.log(`  [email] sent to ${to}`);
}

// ── HTML report ─────────────────────────────────────────────────

function buildReport(
  results: Array<{ issue: LinearIssue; state: TicketState; runOutput?: string }>
): string {
  const date = new Date().toISOString().split('T')[0];
  const rows = results.map(({ issue, state, runOutput }) => {
    const statusEmoji: Record<string, string> = {
      done: '✅', failed: '❌', pending_approval: '⏳', skipped: '⏭️', approved: '🔄',
    };
    const emoji = statusEmoji[state.status] || '❓';
    const output = runOutput
      ? `<pre style="font-size:11px;max-height:200px;overflow:auto;background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">${runOutput.substring(0, 2000).replace(/</g, '&lt;')}</pre>`
      : '';
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee">
          <a href="${issue.url}" style="font-weight:bold;color:#5e6ad2">${issue.identifier}</a>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee">${issue.title}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${emoji} ${state.status}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">
          ${state.flowName ? `<code>${state.flowName}</code>` : '—'}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">
          ${state.passCount !== undefined ? `✅ ${state.passCount} / ❌ ${state.failCount}` : '—'}
        </td>
      </tr>
      ${output ? `<tr><td colspan="5" style="padding:0 8px 12px">${output}</td></tr>` : ''}`;
  }).join('');

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:900px;margin:auto;padding:20px">
  <h2 style="color:#5e6ad2">🤖 QA Agent Report — ${date}</h2>
  <p>Scanned Linear team <strong>${LINEAR_TEAM}</strong> for QA tickets.</p>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#f5f5f5">
      <th style="padding:8px;text-align:left">Ticket</th>
      <th style="padding:8px;text-align:left">Title</th>
      <th style="padding:8px;text-align:center">Status</th>
      <th style="padding:8px;text-align:left">Flow</th>
      <th style="padding:8px;text-align:center">Pass / Fail</th>
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

  if (!LINEAR_API_KEY) { console.error('ERROR: LINEAR_API_KEY not set'); process.exit(1); }
  if (!ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

  // 1. Fetch QA tickets
  console.log('📋 Fetching QA issues from Linear...');
  const issues = await fetchQAIssues();
  console.log(`   Found ${issues.length} issue(s) in QA status`);

  // 2. Load state
  const state = loadState();
  const reportRows: Array<{ issue: LinearIssue; state: TicketState; runOutput?: string }> = [];

  for (const issue of issues) {
    const id = issue.identifier;
    console.log(`\n── ${id}: ${issue.title}`);

    const forceApproved = FORCE_APPROVE.includes(id);
    const existing = state[id];

    // Already done or skipped → include in report only
    if (existing?.status === 'done' || existing?.status === 'skipped') {
      console.log(`   Status: ${existing.status} (already processed, skipping)`);
      reportRows.push({ issue, state: existing });
      continue;
    }

    // Pending approval → check if human replied "approve" or force-approved
    if (existing?.status === 'pending_approval' && !forceApproved) {
      if (isApprovedByHuman(issue)) {
        console.log('   Approval detected in Linear comments → proceeding');
        state[id] = { ...existing, status: 'approved', approvedAt: new Date().toISOString() };
      } else {
        console.log('   Still pending approval, skipping');
        reportRows.push({ issue, state: existing });
        continue;
      }
    }

    // New ticket or force-approved
    if (!existing) {
      state[id] = {
        status: 'pending_approval',
        firstSeenAt: new Date().toISOString(),
        title: issue.title,
        url: issue.url,
      };
    }

    if (forceApproved && existing?.status === 'pending_approval') {
      console.log('   Force-approved via QA_AGENT_APPROVE');
      state[id] = { ...state[id], status: 'approved', approvedAt: new Date().toISOString() };
    }

    // Analyse with Claude if not yet approved
    if (state[id].status === 'pending_approval' || !state[id].status) {
      console.log('   Analysing with Claude...');
      let analysis: ClaudeAnalysis;
      try {
        analysis = await analyzeTicket(issue);
      } catch (e: any) {
        console.error(`   Claude analysis failed: ${e.message}`);
        state[id].error = e.message;
        reportRows.push({ issue, state: state[id] });
        continue;
      }

      console.log(`   → shouldTest=${analysis.shouldTest}, confidence=${analysis.confidence.toFixed(2)}`);
      console.log(`   → reason: ${analysis.reason}`);

      if (!analysis.shouldTest) {
        console.log('   Skipping (Claude: no test needed)');
        state[id].status = 'skipped';
        reportRows.push({ issue, state: state[id] });
        saveState(state);
        continue;
      }

      if (analysis.confidence < CONFIDENCE_THRESHOLD) {
        // Post comment asking for approval
        console.log(`   Confidence ${analysis.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD} → asking for approval`);
        const commentBody =
          `${BOT_MARKER}: I found this ticket in QA and think it may need automated tests.\n\n` +
          `**My analysis:** ${analysis.reason}\n\n` +
          `**Proposed test plan:**\n${analysis.testPlan}\n\n` +
          `Reply **approve** to this comment to have me generate and run the tests, or ignore to skip.`;
        try {
          await postLinearComment(issue.id, commentBody);
          state[id] = { ...state[id], status: 'pending_approval', askedAt: new Date().toISOString() };
          console.log('   Comment posted on Linear ticket');
        } catch (e: any) {
          console.error(`   Failed to post comment: ${e.message}`);
        }
        reportRows.push({ issue, state: state[id] });
        saveState(state);
        continue;
      }

      // High confidence → auto-approve
      console.log(`   Confidence ${analysis.confidence.toFixed(2)} >= ${CONFIDENCE_THRESHOLD} → auto-generating`);
      state[id] = {
        ...state[id],
        status: 'approved',
        approvedAt: new Date().toISOString(),
      };

      // Store analysis for test generation step below
      (state[id] as any)._analysis = analysis;
    }

    // ── Generate and run test ──────────────────────────────────
    if (state[id].status === 'approved') {
      let analysis = (state[id] as any)._analysis as ClaudeAnalysis | undefined;

      // If we don't have the analysis cached (e.g., came back from pending_approval), re-analyse
      if (!analysis) {
        console.log('   Re-analysing with Claude for test generation...');
        try {
          analysis = await analyzeTicket(issue);
        } catch (e: any) {
          state[id].status = 'failed';
          state[id].error = `Re-analysis failed: ${e.message}`;
          reportRows.push({ issue, state: state[id] });
          saveState(state);
          continue;
        }
      }

      console.log('   Generating flow YAML...');
      let yaml: string;
      try {
        yaml = await generateFlowYml(issue, analysis);
      } catch (e: any) {
        state[id].status = 'failed';
        state[id].error = `Test generation failed: ${e.message}`;
        reportRows.push({ issue, state: state[id] });
        saveState(state);
        continue;
      }

      const flowName = analysis.suggestedFlowName;
      const flowFile = join(FLOWS_DIR, `${flowName}.flow.yml`);
      writeFileSync(flowFile, yaml);
      console.log(`   Flow saved: src/flows/${flowName}.flow.yml`);

      console.log('   Running test...');
      const run = runFlow(flowName);
      console.log(`   Duration: ${(run.durationMs / 1000).toFixed(1)}s | Success: ${run.success}`);

      const { pass, fail } = countResults(run.output);
      state[id] = {
        ...state[id],
        status: run.success ? 'done' : 'failed',
        completedAt: new Date().toISOString(),
        flowName,
        passCount: pass,
        failCount: fail,
        error: run.success ? undefined : 'Non-zero exit code',
      };
      delete (state[id] as any)._analysis;

      // Post result to Linear
      const resultComment =
        `${BOT_MARKER}: Test run complete for ${id}.\n\n` +
        `**Flow:** \`${flowName}\`\n` +
        `**Result:** ${run.success ? '✅ Passed' : '❌ Failed'} (${pass} pass / ${fail} fail)\n` +
        `**Duration:** ${(run.durationMs / 1000).toFixed(1)}s`;
      try {
        await postLinearComment(issue.id, resultComment);
      } catch { /* non-fatal */ }

      reportRows.push({ issue, state: state[id], runOutput: run.output });
      saveState(state);
    }
  }

  // 3. Save final state
  saveState(state);

  // 4. Generate + send report
  if (reportRows.length > 0) {
    const html = buildReport(reportRows);
    const reportFile = join(REPORTS_DIR, `qa-agent-report-${new Date().toISOString().split('T')[0]}.html`);
    writeFileSync(reportFile, html);
    console.log(`\n📄 Report saved: ${reportFile}`);

    const doneCount = reportRows.filter(r => r.state.status === 'done').length;
    const failCount = reportRows.filter(r => r.state.status === 'failed').length;
    const pendingCount = reportRows.filter(r => r.state.status === 'pending_approval').length;
    const subject = `🤖 QA Agent — ${doneCount} done, ${failCount} failed, ${pendingCount} pending approval`;
    await sendEmail(subject, html);
  }

  console.log('\n✅ QA Agent done.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
