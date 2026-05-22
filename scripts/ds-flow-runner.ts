/**
 * ds-flow-runner.ts — Digital Staff 全页面自动化测试运行器
 *
 * 功能：
 *  1. 自动发现并运行所有 ds-* flow
 *  2. 收集每个 flow 的结果（通过/失败、耗时、截图）
 *  3. 生成 JSON 报告供 ds-triage-agent 分析
 *  4. 可选：发 Slack 通知
 *
 * 用法：
 *   pnpm ds:run              # 跑所有 ds-* flows
 *   pnpm ds:run --slack      # 跑完后发 Slack 报告
 *   pnpm ds:run --flow ds-login  # 只跑指定 flow
 */

import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import 'dotenv/config';
import { sendSlackBlocks, headerBlock, sectionBlock, dividerBlock, contextBlock } from '../src/lib/slack.js';

const FLOWS_DIR   = join(process.cwd(), 'src', 'flows');
const REPORTS_DIR = join(process.cwd(), 'reports');

const USE_SLACK    = process.argv.includes('--slack');
const SINGLE_FLOW  = process.argv.find(a => a.startsWith('--flow='))?.split('=')[1]
                  || (process.argv.includes('--flow') ? process.argv[process.argv.indexOf('--flow') + 1] : null);
const MULTI_FLOWS  = process.argv.find(a => a.startsWith('--flows='))?.split('=')[1]?.split(',').map(f => f.trim()) || null;

// ── Types ──────────────────────────────────────────────────────

interface FlowResult {
  flowName: string;
  passed: boolean;
  durationMs: number;
  steps: number;
  error?: string;
  screenshotNames: string[];
  timestamp: string;
}

interface DSRunReport {
  generatedAt: string;
  totalFlows: number;
  passed: number;
  failed: number;
  passRate: number;
  durationMs: number;
  results: FlowResult[];
}

// ── Helpers ────────────────────────────────────────────────────

function getFlowList(): string[] {
  if (MULTI_FLOWS) return MULTI_FLOWS;
  if (SINGLE_FLOW) return [SINGLE_FLOW];
  return readdirSync(FLOWS_DIR)
    .filter(f => f.startsWith('ds-') && f.endsWith('.flow.yml'))
    .map(f => f.replace('.flow.yml', ''))
    .sort();
}

function runFlow(flowName: string): FlowResult {
  const start = Date.now();
  console.log(`\n▶ Running: ${flowName}`);

  const result = spawnSync('pnpm', ['flow', flowName], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 1_800_000,
    shell: true,
  });

  const durationMs = Date.now() - start;
  const output = (result.stdout || '') + (result.stderr || '');
  const passed = result.status === 0;

  // Extract step count
  const stepsMatch = output.match(/Steps: (\d+) executed/);
  const steps = stepsMatch ? parseInt(stepsMatch[1], 10) : 0;

  // Extract error
  let error: string | undefined;
  if (!passed) {
    const errMatch = output.match(/Failed at: (\S+)\s+Error: (.+?)(?:\n|$)/s);
    error = errMatch ? `Step "${errMatch[1]}": ${errMatch[2].trim()}` : output.slice(-500);
  }

  const status = passed ? '✅' : '❌';
  console.log(`${status} ${flowName} (${(durationMs / 1000).toFixed(1)}s)${error ? ` — ${error.split('\n')[0]}` : ''}`);

  return {
    flowName,
    passed,
    durationMs,
    steps,
    error,
    screenshotNames: [],
    timestamp: new Date().toISOString(),
  };
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const flows = getFlowList();
  console.log(`\n🤖 Digital Staff Flow Runner`);
  console.log(`📋 Flows to run: ${flows.join(', ')}\n`);
  console.log('='.repeat(60));

  const totalStart = Date.now();
  const results: FlowResult[] = [];

  for (const flow of flows) {
    results.push(runFlow(flow));
  }

  const totalMs = Date.now() - totalStart;
  const passed  = results.filter(r => r.passed).length;
  const failed  = results.filter(r => !r.passed).length;
  const passRate = Math.round((passed / results.length) * 100);

  const report: DSRunReport = {
    generatedAt: new Date().toISOString(),
    totalFlows: results.length,
    passed,
    failed,
    passRate,
    durationMs: totalMs,
    results,
  };

  // Save report
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, `ds-run-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Digital Staff Test Summary`);
  console.log(`   Total:  ${results.length} flows`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   Pass Rate: ${passRate}%`);
  console.log(`   Duration: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`   Report: ${reportPath}\n`);

  if (failed > 0) {
    console.log('Failed flows:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  ❌ ${r.flowName}: ${r.error?.split('\n')[0] || 'Unknown error'}`);
    });
  }

  // Slack notification
  if (USE_SLACK) {
    const emoji = passRate === 100 ? '✅' : passRate >= 80 ? '⚠️' : '❌';
    const blocks = [
      headerBlock(`${emoji} Digital Staff E2E Report — ${passRate}% Pass`),
      sectionBlock(`*Flows:* ${results.length}  |  *✅ Passed:* ${passed}  |  *❌ Failed:* ${failed}  |  *Duration:* ${(totalMs / 1000).toFixed(0)}s`),
      dividerBlock(),
    ];

    if (failed > 0) {
      const failList = results
        .filter(r => !r.passed)
        .map(r => `• \`${r.flowName}\`: ${r.error?.split('\n')[0] || 'Failed'}`)
        .join('\n');
      blocks.push(sectionBlock(`*Failed:*\n${failList}`));
    } else {
      blocks.push(sectionBlock('All Digital Staff flows passed! 🎉'));
    }

    blocks.push(contextBlock(`Generated ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} CST`));
    await sendSlackBlocks('Digital Staff E2E Report', blocks);
    console.log('📨 Slack notification sent.');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
