/**
 * coverage-agent.ts — AI agent that finds untested pages and generates stub tests
 *
 * Flow:
 *  1. Reads all existing .flow.yml files
 *  2. Claude analyses which app routes/features each flow covers
 *  3. Compares against the known route map
 *  4. Generates stub test flows for uncovered areas
 *  5. Outputs an HTML coverage report
 *
 * Usage:
 *   pnpm coverage                 find gaps + generate stubs
 *   pnpm coverage --report-only   report only, do not generate new flows
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const FLOWS_DIR         = join(process.cwd(), 'src/flows');
const REPORTS_DIR       = join(process.cwd(), 'reports');
const MAX_STEPS         = 20;

// ── Known app routes ────────────────────────────────────────────

const APP_ROUTES: Array<{ route: string; label: string; priority: 'high' | 'medium' | 'low' }> = [
  { route: '/auth/login',                    label: 'Login',                  priority: 'high'   },
  { route: '/dashboard',                     label: 'Dashboard',              priority: 'high'   },
  { route: '/ai-team/marketing/chat',        label: 'Maya – Marketing AI',    priority: 'high'   },
  { route: '/ai-team/operations/chat',       label: 'Oscar – Operations AI',  priority: 'high'   },
  { route: '/ai-team/analytics/chat',        label: 'Daniel – Analytics AI',  priority: 'high'   },
  { route: '/ai-team/seo/chat',              label: 'Cody – SEO AI',          priority: 'high'   },
  { route: '/analytics',                     label: 'Analytics Overview',     priority: 'medium' },
  { route: '/analytics/support-performance', label: 'Support Performance',    priority: 'medium' },
  { route: '/analytics/insights',            label: 'Chat Summary / Insights','priority': 'medium' },
  { route: '/analytics/busiest-time',        label: 'Busiest Time',           priority: 'low'    },
  { route: '/customers',                     label: 'Customers',              priority: 'medium' },
  { route: '/ai-training',                   label: 'AI Training',            priority: 'medium' },
  { route: '/integrations',                  label: 'Integrations',           priority: 'medium' },
  { route: '/settings/subscription',         label: 'Subscription & Billing', priority: 'medium' },
  { route: '/settings/config',               label: 'Live Chat Config',       priority: 'medium' },
  { route: '/customisation',                 label: 'Customisation',          priority: 'low'    },
  { route: '/flow',                          label: 'Flows Module',           priority: 'low'    },
  { route: '/pricing',                       label: 'Pricing',                priority: 'low'    },
];

// ── Types ──────────────────────────────────────────────────────

interface CoverageRoute {
  route: string;
  label: string;
  priority: string;
  covered: boolean;
  coveredBy: string[];
}

interface CoverageReport {
  covered: CoverageRoute[];
  uncovered: CoverageRoute[];
  generatedFlows: string[];
  summary: string;
}

// ── Tools ───────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_flows',
    description: 'List all existing .flow.yml files with their names.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'read_flow',
    description: 'Read the YAML content of a specific flow to understand what it tests.',
    input_schema: {
      type: 'object' as const,
      properties: { flowName: { type: 'string' } },
      required: ['flowName'],
    },
  },
  {
    name: 'generate_stub_test',
    description: 'Generate and save a minimal stub test flow for an uncovered route. The stub navigates to the page, waits for it to load, screenshots it, and checks for basic content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        flowName: { type: 'string', description: 'kebab-case flow name e.g. test-dashboard-basic' },
        route:    { type: 'string', description: 'App route e.g. /dashboard' },
        label:    { type: 'string', description: 'Human-readable page name' },
        yaml:     { type: 'string', description: 'Complete YAML flow content' },
      },
      required: ['flowName', 'route', 'label', 'yaml'],
    },
  },
  {
    name: 'report_coverage',
    description: 'Call when analysis is complete. Provide the coverage mapping and list of generated flows.',
    input_schema: {
      type: 'object' as const,
      properties: {
        coveredRoutes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              route:     { type: 'string' },
              coveredBy: { type: 'array', items: { type: 'string' } },
            },
          },
          description: 'Routes that have at least one test',
        },
        uncoveredRoutes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Routes with no test coverage',
        },
        generatedFlows: {
          type: 'array',
          items: { type: 'string' },
          description: 'Flow names generated during this run',
        },
        summary: { type: 'string' },
      },
      required: ['coveredRoutes', 'uncoveredRoutes', 'generatedFlows', 'summary'],
    },
  },
];

// ── Tool executor ───────────────────────────────────────────────

interface CoverageCtx {
  report?: CoverageReport;
}

function executeTool(name: string, input: Record<string, any>, ctx: CoverageCtx): string {
  switch (name) {
    case 'list_flows': {
      const files = readdirSync(FLOWS_DIR)
        .filter(f => f.endsWith('.flow.yml') && !f.startsWith('_'))
        .map(f => f.replace('.flow.yml', ''))
        .sort();
      return files.join('\n');
    }
    case 'read_flow': {
      const p = join(FLOWS_DIR, `${input.flowName}.flow.yml`);
      if (!existsSync(p)) return `Not found: ${input.flowName}`;
      const content = readFileSync(p, 'utf-8');
      return content.length > 5000 ? content.substring(0, 5000) + '\n…(truncated)' : content;
    }
    case 'generate_stub_test': {
      const yaml = (input.yaml as string).replace(/^```ya?ml\n?/i, '').replace(/\n?```$/i, '').trim();
      writeFileSync(join(FLOWS_DIR, `${input.flowName}.flow.yml`), yaml);
      return `Generated: src/flows/${input.flowName}.flow.yml`;
    }
    case 'report_coverage': {
      const routeMap = new Map<string, string[]>(
        (input.coveredRoutes as any[]).map((r: any) => [r.route, r.coveredBy])
      );
      const covered = APP_ROUTES
        .filter(r => routeMap.has(r.route))
        .map(r => ({ ...r, covered: true, coveredBy: routeMap.get(r.route) ?? [] }));
      const uncovered = APP_ROUTES
        .filter(r => (input.uncoveredRoutes as string[]).includes(r.route))
        .map(r => ({ ...r, covered: false, coveredBy: [] }));
      ctx.report = {
        covered,
        uncovered,
        generatedFlows: input.generatedFlows as string[],
        summary: input.summary as string,
      };
      return 'Coverage report recorded.';
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Agent loop ──────────────────────────────────────────────────

const SYSTEM = `You are a QA coverage analyst for a web application.

Your job:
1. List all existing test flows (list_flows)
2. Read a sample of flows to understand what pages/features they cover — focus on the URLs they navigate to
3. Compare against the provided route list (it will be in the user message)
4. For each uncovered HIGH priority route: generate a stub test (generate_stub_test)
5. Call report_coverage with the complete mapping

Stub tests should:
- Include _shared/login.steps.yml first
- Navigate to the route
- Wait for main content to load (browser.waitForSelector with a generic selector like 'main', 'h1', or '[class*="content"]')
- Take a screenshot
- Be minimal — stubs, not full tests

Do NOT generate stubs for medium/low priority routes unless they have zero coverage at all.`;

async function runCoverageAgent(reportOnly: boolean): Promise<CoverageReport> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const ctx: CoverageCtx = {};

  const routeList = APP_ROUTES.map(r => `${r.priority.toUpperCase().padEnd(6)} ${r.route.padEnd(40)} ${r.label}`).join('\n');

  const messages: Anthropic.MessageParam[] = [{
    role: 'user',
    content: `Analyse test coverage for the YepAI app.

Known routes to check:
\`\`\`
${routeList}
\`\`\`

${reportOnly ? 'Report only — do NOT generate any new test stubs.' : 'Generate stub tests for any uncovered HIGH priority routes.'}

Start by listing all flows, then read a selection to understand coverage. Call report_coverage when done.`,
  }];

  let step = 0;
  while (step < MAX_STEPS && !ctx.report) {
    step++;
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        console.log(`   [coverage] ${block.text.substring(0, 140).replace(/\n/g, ' ')}`);
      }
    }

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        console.log(`   [coverage] step ${step}: ${block.name}(${JSON.stringify(block.input).substring(0, 60)})`);
        const result = executeTool(block.name, block.input as Record<string, any>, ctx);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  return ctx.report ?? {
    covered: [], uncovered: APP_ROUTES.map(r => ({ ...r, covered: false, coveredBy: [] })),
    generatedFlows: [], summary: 'Agent did not complete',
  };
}

// ── HTML report ─────────────────────────────────────────────────

function buildHtmlReport(report: CoverageReport): string {
  const date = new Date().toISOString().split('T')[0];
  const total = APP_ROUTES.length;
  const pct = Math.round((report.covered.length / total) * 100);

  const rows = APP_ROUTES.map(r => {
    const cov = report.covered.find(c => c.route === r.route);
    const status = cov ? '✅' : '❌';
    const flows = cov ? cov.coveredBy.map(f => `<code>${f}</code>`).join(', ') : '—';
    const priBadge = `<span style="font-size:11px;padding:2px 6px;border-radius:3px;background:${r.priority === 'high' ? '#fee2e2' : r.priority === 'medium' ? '#fef9c3' : '#f3f4f6'};color:#333">${r.priority}</span>`;
    return `<tr><td style="padding:8px;border-bottom:1px solid #eee">${status}</td><td style="padding:8px;border-bottom:1px solid #eee"><code>${r.route}</code></td><td style="padding:8px;border-bottom:1px solid #eee">${r.label}</td><td style="padding:8px;border-bottom:1px solid #eee">${priBadge}</td><td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${flows}</td></tr>`;
  }).join('');

  const generated = report.generatedFlows.length > 0
    ? `<p>📝 Generated stub tests: ${report.generatedFlows.map(f => `<code>${f}</code>`).join(', ')}</p>` : '';

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:900px;margin:auto;padding:20px">
<h2 style="color:#5e6ad2">📊 Coverage Report — ${date}</h2>
<div style="display:flex;gap:24px;margin:16px 0">
  <div style="background:#f0fdf4;border-radius:8px;padding:16px 24px;text-align:center">
    <div style="font-size:32px;font-weight:bold;color:#16a34a">${pct}%</div>
    <div style="color:#555;font-size:13px">Coverage</div>
  </div>
  <div style="background:#f5f5f5;border-radius:8px;padding:16px 24px;text-align:center">
    <div style="font-size:32px;font-weight:bold">${report.covered.length}/${total}</div>
    <div style="color:#555;font-size:13px">Routes covered</div>
  </div>
  <div style="background:#fef2f2;border-radius:8px;padding:16px 24px;text-align:center">
    <div style="font-size:32px;font-weight:bold;color:#dc2626">${report.uncovered.length}</div>
    <div style="color:#555;font-size:13px">Gaps</div>
  </div>
</div>
<p style="color:#555">${report.summary}</p>
${generated}
<table style="width:100%;border-collapse:collapse">
  <thead><tr style="background:#f5f5f5">
    <th style="padding:8px;text-align:left;width:40px"></th>
    <th style="padding:8px;text-align:left">Route</th>
    <th style="padding:8px;text-align:left">Page</th>
    <th style="padding:8px;text-align:left">Priority</th>
    <th style="padding:8px;text-align:left">Covered by</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<hr style="margin-top:30px">
<p style="color:#888;font-size:12px">Generated by coverage-agent.ts — ${new Date().toISOString()}</p>
</body></html>`;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  if (!ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

  const reportOnly = process.argv.includes('--report-only');
  console.log(`\n📊 Coverage Agent starting${reportOnly ? ' (report only)' : ''}...\n`);

  const report = await runCoverageAgent(reportOnly);

  const html = buildHtmlReport(report);
  const outFile = join(REPORTS_DIR, `coverage-report-${new Date().toISOString().split('T')[0]}.html`);
  writeFileSync(outFile, html);

  console.log(`\n📄 Report: ${outFile}`);
  console.log(`\n${report.summary}`);
  console.log(`   Covered: ${report.covered.length}/${APP_ROUTES.length} routes`);
  if (report.generatedFlows.length > 0) {
    console.log(`   Generated: ${report.generatedFlows.join(', ')}`);
  }
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
