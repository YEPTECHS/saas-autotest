/**
 * visual-regression.ts — AI visual regression testing with Claude Vision
 *
 * Two modes:
 *   --capture   Navigate to each key page and save screenshots as baseline
 *   --compare   Re-capture and compare against baseline with Claude Vision
 *
 * Claude Vision understands SEMANTIC differences (missing nav, broken layout,
 * error messages) rather than pixel-by-pixel diffs — ignores content changes
 * like different numbers or dates.
 *
 * Usage:
 *   pnpm visual:capture          save new baseline
 *   pnpm visual:compare          compare current state vs baseline
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY || '';
const BASE_URL           = process.env.YEPAI_BASE_URL || '';
const LOGIN_EMAIL        = process.env.YEPAI_LOGIN_EMAIL || '';
const LOGIN_PASSWORD     = process.env.YEPAI_LOGIN_PASSWORD || '';
const SCREENSHOTS_DIR    = join(process.cwd(), 'screenshots');
const BASELINE_DIR       = join(SCREENSHOTS_DIR, 'baseline');
const COMPARE_DIR        = join(SCREENSHOTS_DIR, 'compare');
const REPORTS_DIR        = join(process.cwd(), 'reports');

// ── Pages to test ───────────────────────────────────────────────

const PAGES = [
  { name: 'dashboard',            route: '/dashboard',                     label: 'Dashboard'             },
  { name: 'marketing-chat',       route: '/ai-team/marketing/chat',        label: 'Maya – Marketing AI'   },
  { name: 'operations-chat',      route: '/ai-team/operations/chat',       label: 'Oscar – Operations AI' },
  { name: 'analytics-chat',       route: '/ai-team/analytics/chat',        label: 'Daniel – Analytics AI' },
  { name: 'seo-chat',             route: '/ai-team/seo/chat',              label: 'Cody – SEO AI'         },
  { name: 'analytics-overview',   route: '/analytics',                     label: 'Analytics'             },
  { name: 'customers',            route: '/customers',                     label: 'Customers'             },
  { name: 'ai-training',          route: '/ai-training',                   label: 'AI Training'           },
  { name: 'integrations',         route: '/integrations',                  label: 'Integrations'          },
  { name: 'settings-subscription',route: '/settings/subscription',         label: 'Subscription'          },
];

// ── Types ──────────────────────────────────────────────────────

interface PageResult {
  name: string;
  label: string;
  route: string;
  baselinePath: string;
  comparePath?: string;
  hasRegression: boolean;
  severity: 'none' | 'minor' | 'major';
  changes: string[];
  summary: string;
  error?: string;
}

// ── Screenshot capture ──────────────────────────────────────────

async function captureScreenshots(targetDir: string): Promise<Map<string, string>> {
  const paths = new Map<string, string>();

  if (!BASE_URL || !LOGIN_EMAIL || !LOGIN_PASSWORD) {
    throw new Error('YEPAI_BASE_URL, YEPAI_LOGIN_EMAIL, YEPAI_LOGIN_PASSWORD must be set');
  }

  mkdirSync(targetDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await context.newPage();

  try {
    // Login
    console.log('   Logging in...');
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector("input[type='email'], input[name='email'], #email", { timeout: 15000 });
    await page.fill("input[type='email'], input[name='email'], #email", LOGIN_EMAIL);
    await page.fill("input[type='password'], input[name='password'], #password", LOGIN_PASSWORD);
    await page.click("button[type='submit']");
    await page.waitForURL(/dashboard|home|ai-training|analytics|customers|onboarding/, { timeout: 30000 });
    console.log('   ✓ Logged in');

    for (const p of PAGES) {
      try {
        console.log(`   Capturing ${p.label}...`);
        await page.goto(`${BASE_URL}${p.route}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000); // let dynamic content settle

        const screenshotPath = join(targetDir, `${p.name}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        paths.set(p.name, screenshotPath);
        console.log(`   ✓ ${p.label}`);
      } catch (e: any) {
        console.warn(`   ⚠ ${p.label}: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  return paths;
}

// ── Claude Vision comparison ────────────────────────────────────

async function compareWithVision(
  baselinePath: string,
  comparePath: string,
  label: string,
): Promise<{ hasRegression: boolean; severity: 'none' | 'minor' | 'major'; changes: string[]; summary: string }> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const toBase64 = (p: string) => readFileSync(p).toString('base64');

  const msg = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Compare these two screenshots of the "${label}" page. BEFORE (baseline) is first, AFTER (current) is second.` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: toBase64(baselinePath) } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: toBase64(comparePath) } },
        {
          type: 'text',
          text: `Identify STRUCTURAL regressions only:
- Missing navigation elements, headers, or sidebars
- Broken layouts or overlapping elements
- Error messages or blank/empty areas where content should be
- Missing UI components (buttons, charts, tables)

Ignore: different numbers, dates, user content, minor styling, loading spinners.

Return JSON only:
{"hasRegression": true/false, "severity": "none"|"minor"|"major", "changes": ["..."], "summary": "one sentence"}`,
        },
      ],
    }],
  });

  const text = (msg.content[0] as any).text as string;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { hasRegression: false, severity: 'none', changes: [], summary: 'Could not parse response' };

  return JSON.parse(match[0]);
}

// ── HTML report ─────────────────────────────────────────────────

function buildHtmlReport(results: PageResult[]): string {
  const date = new Date().toISOString().split('T')[0];
  const regressions = results.filter(r => r.hasRegression);
  const major = regressions.filter(r => r.severity === 'major').length;
  const minor = regressions.filter(r => r.severity === 'minor').length;

  const rows = results.map(r => {
    const icon = r.error ? '⚠️' : r.severity === 'major' ? '🔴' : r.severity === 'minor' ? '🟡' : '✅';
    const changes = r.changes.length > 0
      ? `<ul style="margin:4px 0;padding-left:16px">${r.changes.map(c => `<li style="font-size:12px">${c}</li>`).join('')}</ul>`
      : '';
    const imgs = r.comparePath
      ? `<div style="display:flex;gap:8px;margin-top:8px">
          <div><div style="font-size:11px;color:#888">Baseline</div><img src="${r.baselinePath}" style="width:300px;border:1px solid #ddd"></div>
          <div><div style="font-size:11px;color:#888">Current</div><img src="${r.comparePath}" style="width:300px;border:1px solid #ddd"></div>
         </div>`
      : '';
    return `<tr>
      <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top">${icon}</td>
      <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top"><strong>${r.label}</strong><br><code style="font-size:11px;color:#888">${r.route}</code></td>
      <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top">${r.summary}${changes}${imgs}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:1000px;margin:auto;padding:20px">
<h2 style="color:#5e6ad2">👁 Visual Regression Report — ${date}</h2>
<div style="display:flex;gap:20px;margin:16px 0">
  <div style="background:${major > 0 ? '#fef2f2' : '#f0fdf4'};border-radius:8px;padding:14px 20px;text-align:center">
    <div style="font-size:28px;font-weight:bold;color:${major > 0 ? '#dc2626' : '#16a34a'}">${major}</div>
    <div style="color:#555;font-size:12px">Major regressions</div>
  </div>
  <div style="background:${minor > 0 ? '#fffbeb' : '#f0fdf4'};border-radius:8px;padding:14px 20px;text-align:center">
    <div style="font-size:28px;font-weight:bold;color:${minor > 0 ? '#d97706' : '#16a34a'}">${minor}</div>
    <div style="color:#555;font-size:12px">Minor regressions</div>
  </div>
  <div style="background:#f0fdf4;border-radius:8px;padding:14px 20px;text-align:center">
    <div style="font-size:28px;font-weight:bold;color:#16a34a">${results.filter(r => !r.hasRegression && !r.error).length}</div>
    <div style="color:#555;font-size:12px">No change</div>
  </div>
</div>
<table style="width:100%;border-collapse:collapse">
  <thead><tr style="background:#f5f5f5">
    <th style="padding:8px;width:40px"></th>
    <th style="padding:8px;text-align:left">Page</th>
    <th style="padding:8px;text-align:left">Analysis</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<hr style="margin-top:30px">
<p style="color:#888;font-size:12px">Generated by visual-regression.ts — ${new Date().toISOString()}</p>
</body></html>`;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv.includes('--compare') ? 'compare'
             : process.argv.includes('--capture')  ? 'capture'
             : null;

  if (!mode) {
    console.error('Usage:\n  pnpm visual:capture\n  pnpm visual:compare');
    process.exit(1);
  }

  if (!BASE_URL || !LOGIN_EMAIL || !LOGIN_PASSWORD) {
    console.error('ERROR: YEPAI_BASE_URL, YEPAI_LOGIN_EMAIL, YEPAI_LOGIN_PASSWORD must be set');
    process.exit(1);
  }

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

  // ── Capture mode ─────────────────────────────────────────────
  if (mode === 'capture') {
    console.log('\n📸 Visual Regression — Capturing baseline...\n');
    const paths = await captureScreenshots(BASELINE_DIR);
    console.log(`\n✅ Baseline saved: ${paths.size} screenshots → ${BASELINE_DIR}\n`);
    return;
  }

  // ── Compare mode ─────────────────────────────────────────────
  console.log('\n👁 Visual Regression — Comparing against baseline...\n');

  if (!existsSync(BASELINE_DIR)) {
    console.error('No baseline found. Run `pnpm visual:capture` first.');
    process.exit(1);
  }

  if (!ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }

  // Capture current state
  console.log('Capturing current state...');
  const comparePaths = await captureScreenshots(COMPARE_DIR);

  // Compare each page with Claude Vision
  console.log('\nAnalysing with Claude Vision...');
  const results: PageResult[] = [];

  for (const p of PAGES) {
    const baselinePath = join(BASELINE_DIR, `${p.name}.png`);
    const comparePath  = comparePaths.get(p.name);

    if (!existsSync(baselinePath)) {
      results.push({ ...p, baselinePath, hasRegression: false, severity: 'none', changes: [], summary: 'No baseline — run capture first', error: 'no_baseline' });
      continue;
    }
    if (!comparePath) {
      results.push({ ...p, baselinePath, hasRegression: false, severity: 'none', changes: [], summary: 'Could not capture current screenshot', error: 'capture_failed' });
      continue;
    }

    try {
      process.stdout.write(`   Comparing ${p.label}...`);
      const analysis = await compareWithVision(baselinePath, comparePath, p.label);
      results.push({ ...p, baselinePath, comparePath, ...analysis });
      console.log(` ${analysis.severity === 'none' ? '✅' : analysis.severity === 'minor' ? '🟡' : '🔴'} ${analysis.summary}`);
    } catch (e: any) {
      results.push({ ...p, baselinePath, comparePath, hasRegression: false, severity: 'none', changes: [], summary: `Analysis failed: ${e.message}`, error: e.message });
      console.log(` ⚠ error`);
    }
  }

  // Save report
  const html = buildHtmlReport(results);
  const reportFile = join(REPORTS_DIR, `visual-regression-${new Date().toISOString().split('T')[0]}.html`);
  writeFileSync(reportFile, html);

  const major = results.filter(r => r.severity === 'major').length;
  const minor = results.filter(r => r.severity === 'minor').length;

  console.log(`\n📄 Report: ${reportFile}`);
  console.log(`   🔴 Major: ${major}  🟡 Minor: ${minor}  ✅ Clean: ${results.filter(r => !r.hasRegression && !r.error).length}\n`);

  process.exit(major > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
