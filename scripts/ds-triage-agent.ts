/**
 * ds-triage-agent.ts — AI 智能体，自动分析 Digital Staff 测试失败
 *
 * 功能：
 *  1. 读取最新的 ds-run-*.json 报告
 *  2. 用 Claude AI 分析每个失败原因：
 *       BUG   — 平台功能 bug（按 BDD 格式记录到 BUGS.md）
 *       FLAKY — 网络/时序问题（建议重试）
 *       ENV   — 选择器/URL 失效（建议修复 flow）
 *  3. 自动将 BUG 类失败写入 workspace-digital-staff/BUGS.md
 *  4. 可选：发 Slack 告警
 *
 * 用法：
 *   pnpm ds:triage              # 分析最新报告
 *   pnpm ds:triage --slack      # 同时发 Slack
 */

import Anthropic from '@anthropic-ai/sdk';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import 'dotenv/config';
import { sendSlackBlocks, headerBlock, sectionBlock, dividerBlock, contextBlock } from '../src/lib/slack.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const REPORTS_DIR  = join(process.cwd(), 'reports');
const BUGS_FILE    = join(process.cwd(), 'workspace-digital-staff', 'BUGS.md');
const USE_SLACK    = process.argv.includes('--slack');
const AUTO_REPAIR  = process.argv.includes('--repair');

// ── Types ──────────────────────────────────────────────────────

type FailClass = 'BUG' | 'FLAKY' | 'ENV';

interface FlowResult {
  flowName: string;
  passed: boolean;
  durationMs: number;
  steps: number;
  error?: string;
  timestamp: string;
}

interface TriagedFailure {
  flowName: string;
  error: string;
  classification: FailClass;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  bddReport?: string;
  recommendation: string;
}

// ── Load latest DS report ──────────────────────────────────────

function loadLatestReport(): FlowResult[] {
  if (!existsSync(REPORTS_DIR)) return [];
  const files = readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('ds-run-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) {
    console.log('No DS run reports found. Run `pnpm ds:run` first.');
    return [];
  }
  const data = JSON.parse(readFileSync(join(REPORTS_DIR, files[0]), 'utf-8'));
  console.log(`📂 Loaded report: ${files[0]}`);
  return (data.results || []).filter((r: FlowResult) => !r.passed);
}

// ── AI Triage ──────────────────────────────────────────────────

async function triageFailure(failure: FlowResult): Promise<TriagedFailure> {
  if (!ANTHROPIC_API_KEY) {
    return {
      flowName: failure.flowName,
      error: failure.error || 'Unknown',
      classification: 'ENV',
      confidence: 'low',
      reasoning: 'No ANTHROPIC_API_KEY — skipping AI analysis.',
      recommendation: 'Set ANTHROPIC_API_KEY and re-run ds:triage.',
    };
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const prompt = `You are a QA engineer analyzing an E2E test failure for a platform called "Digital Staff" (https://digitalstaff-test.yepai.io).

Flow: ${failure.flowName}
Error: ${failure.error || 'No error message'}

Classify this failure as ONE of:
- BUG: The platform has a real functional bug (wrong behavior, missing feature, incorrect error message)
- FLAKY: Timing/network/transient issue that will likely pass on retry
- ENV: Test setup issue — selector changed, URL moved, element no longer exists

Also:
1. State your confidence: high / medium / low
2. Give a 1-2 sentence reasoning
3. Give a recommendation (e.g. "Fix selector", "Retry flow", "Report BUG to dev team")
4. If BUG: write a BDD bug report in this EXACT format:
   场景：[scene name]
     假设  [precondition]
     当    [action]
     那么  [expected]
     但是  [actual — the bug]

Reply ONLY as valid JSON:
{
  "classification": "BUG|FLAKY|ENV",
  "confidence": "high|medium|low",
  "reasoning": "...",
  "recommendation": "...",
  "bddReport": "..." // only if BUG, else null
}`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const text = (msg.content[0] as Anthropic.TextBlock).text;
    const json = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
    return {
      flowName: failure.flowName,
      error: failure.error || 'Unknown',
      classification: json.classification as FailClass,
      confidence: json.confidence,
      reasoning: json.reasoning,
      recommendation: json.recommendation,
      bddReport: json.bddReport || undefined,
    };
  } catch {
    return {
      flowName: failure.flowName,
      error: failure.error || 'Unknown',
      classification: 'ENV',
      confidence: 'low',
      reasoning: 'Failed to parse AI response.',
      recommendation: 'Check manually.',
    };
  }
}

// ── Write BUG to BUGS.md ────────────────────────────────────────

function appendBug(triaged: TriagedFailure, bugNumber: number) {
  if (!triaged.bddReport) return;

  const today = new Date().toISOString().split('T')[0];
  const entry = `
### BUG-${String(bugNumber).padStart(3, '0')}：${triaged.flowName} 失败

- **严重程度：** 中
- **发现日期：** ${today}
- **模块：** ${triaged.flowName.replace('ds-test-', '').replace('ds-', '').replace(/-/g, ' ')}
- **AI 分析可信度：** ${triaged.confidence}

${triaged.bddReport}

> **推荐操作：** ${triaged.recommendation}

---
`;

  const existing = existsSync(BUGS_FILE) ? readFileSync(BUGS_FILE, 'utf-8') : '';
  if (existing.includes(triaged.bddReport.slice(0, 50))) {
    console.log(`  ⏭ BUG already recorded: ${triaged.flowName}`);
    return;
  }
  writeFileSync(BUGS_FILE, existing + entry);
  console.log(`  📝 Bug written to BUGS.md: ${triaged.flowName}`);
}

// ── Auto-repair ENV failures ────────────────────────────────────

interface RepairOutcome {
  flowName: string;
  fixed: boolean;
  description: string;
}

function autoRepair(flowName: string): RepairOutcome {
  console.log(`\n🔧 Auto-repairing: ${flowName}`);
  const res = spawnSync('pnpm', ['repair', flowName], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 35 * 60 * 1000,
    env: { ...process.env },
    shell: true,
  });
  const output = (res.stdout || '') + (res.stderr || '');
  const fixed = res.status === 0;
  const descMatch = output.match(/✅ Fixed: (.+)/) || output.match(/❌ Could not fix: (.+)/);
  const description = descMatch ? descMatch[1].trim() : (fixed ? 'Repaired successfully' : 'Could not repair automatically');
  console.log(`  ${fixed ? '✅' : '❌'} ${description}`);
  return { flowName, fixed, description };
}

// ── Get next bug number ─────────────────────────────────────────

function getNextBugNumber(): number {
  if (!existsSync(BUGS_FILE)) return 1;
  const content = readFileSync(BUGS_FILE, 'utf-8');
  const matches = content.match(/### BUG-(\d+)/g) || [];
  if (!matches.length) return 1;
  const nums = matches.map(m => parseInt(m.replace('### BUG-', ''), 10));
  return Math.max(...nums) + 1;
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const failures = loadLatestReport();

  if (!failures.length) {
    console.log('\n✅ No failures to triage!');
    return;
  }

  console.log(`\n🤖 DS Triage Agent — analyzing ${failures.length} failure(s)...\n`);

  const triaged: TriagedFailure[] = [];
  let bugNumber = getNextBugNumber();

  for (const failure of failures) {
    console.log(`\n🔍 Triaging: ${failure.flowName}`);
    const result = await triageFailure(failure);
    triaged.push(result);

    const emoji = result.classification === 'BUG' ? '🐛' : result.classification === 'FLAKY' ? '⚡' : '🔧';
    console.log(`  ${emoji} ${result.classification} (${result.confidence}) — ${result.reasoning}`);
    console.log(`  → ${result.recommendation}`);

    if (result.classification === 'BUG') {
      appendBug(result, bugNumber++);
    }
  }

  // Print summary
  const bugs   = triaged.filter(t => t.classification === 'BUG').length;
  const flaky  = triaged.filter(t => t.classification === 'FLAKY').length;
  const env    = triaged.filter(t => t.classification === 'ENV').length;

  console.log('\n' + '='.repeat(60));
  console.log('\n📊 Triage Summary:');
  console.log(`   🐛 BUG:   ${bugs}  (written to BUGS.md)`);
  console.log(`   ⚡ FLAKY: ${flaky} (retry recommended)`);
  console.log(`   🔧 ENV:   ${env}  (fix flow selectors)`);

  // Auto-repair ENV failures
  const repairs: RepairOutcome[] = [];
  if (AUTO_REPAIR && env > 0) {
    console.log(`\n🔧 Auto-repair triggered for ${env} ENV failure(s)...`);
    const envFailures = triaged.filter(t => t.classification === 'ENV');
    for (const t of envFailures) {
      repairs.push(autoRepair(t.flowName));
    }
    const repaired = repairs.filter(r => r.fixed).length;
    console.log(`\n🔧 Repair complete: ${repaired}/${repairs.length} fixed`);
  }

  // Slack
  if (USE_SLACK && triaged.length > 0) {
    const blocks = [
      headerBlock(`🔍 DS Triage — ${failures.length} failure(s) analyzed`),
      sectionBlock(`*🐛 BUG:* ${bugs}  |  *⚡ FLAKY:* ${flaky}  |  *🔧 ENV:* ${env}`),
      dividerBlock(),
    ];

    for (const t of triaged) {
      const emoji = t.classification === 'BUG' ? '🐛' : t.classification === 'FLAKY' ? '⚡' : '🔧';
      blocks.push(sectionBlock(`${emoji} *${t.flowName}* — ${t.classification}\n${t.reasoning}\n_→ ${t.recommendation}_`));
    }

    if (repairs.length > 0) {
      const repaired = repairs.filter(r => r.fixed).length;
      const repairLines = repairs.map(r => `${r.fixed ? '✅' : '❌'} \`${r.flowName}\`: ${r.description}`).join('\n');
      blocks.push(sectionBlock(`*🔧 Auto-repair: ${repaired}/${repairs.length} fixed*\n${repairLines}`));
    }

    if (bugs > 0) {
      blocks.push(sectionBlock(`📝 ${bugs} bug(s) written to BUGS.md`));
    }

    blocks.push(contextBlock(`DS Triage · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} CST`));
    await sendSlackBlocks('DS Triage Report', blocks);
    console.log('\n📨 Slack notification sent.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
