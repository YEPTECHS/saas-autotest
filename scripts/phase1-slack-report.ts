/**
 * Phase 1 测试 + Slack 报告
 *
 * 运行 TC7 回归测试，把结果发到 Slack。
 *
 * 使用方法:
 *   pnpm phase1:report
 */

import { execSync } from 'child_process';
import 'dotenv/config';

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL
  || 'https://hooks.slack.com/triggers/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';

// ── 运行测试并捕获输出 ─────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  skipped: boolean;
  detail: string;
}

function runTest(script: string, label: string): { output: string; success: boolean } {
  try {
    const output = execSync(`pnpm ${script}`, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 300000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output, success: true };
  } catch (err: any) {
    return { output: err.stdout || err.message || '', success: false };
  }
}

function parseTC7Results(output: string): TestResult[] {
  const results: TestResult[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (!line.includes('[Flow Log]')) continue;

    // 检查点结果行 (e.g. "✅ PASS | TC7-1 知识库上传区域")
    const passMatch = line.match(/✅\s*(PASS)?\s*\|?\s*(TC7-\d+[^|]+)/);
    const failMatch = line.match(/❌\s*(FAIL)?\s*\|?\s*(TC7-\d+[^|]+)/);
    const skipMatch = line.match(/⚠️\s*(SKIP)?\s*\|?\s*(TC7-\d+[^|]+)/);

    // 结果汇总行 (e.g. "✅ PASS | TC7-1 知识库上传区域")
    const resultLine = line.match(/\[Flow Log\]\s*(✅|❌|⚠️)\s+(PASS|FAIL|SKIP)\s*\|\s*(.+)/);
    if (resultLine) {
      const icon = resultLine[1];
      const status = resultLine[2];
      const name = resultLine[3].trim();
      results.push({
        name,
        passed: status === 'PASS',
        skipped: status === 'SKIP',
        detail: line,
      });
    }
  }

  // 如果没解析到结果行，从 Flow Completed / Flow Failed 判断整体结果
  if (results.length === 0) {
    const completed = output.includes('Flow Completed');
    const failed = output.includes('Flow Failed');
    results.push({
      name: 'TC7 回归测试',
      passed: completed && !failed,
      skipped: false,
      detail: completed ? '全部步骤完成' : '流程中止',
    });
  }

  return results;
}

// ── 发送到 Slack ───────────────────────────────────────────────

async function sendToSlack(text: string): Promise<void> {
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    console.warn(`[Slack] 发送失败: ${res.status} ${res.statusText}`);
  } else {
    console.log('[Slack] ✅ 消息已发送');
  }
}

// ── 格式化消息 ─────────────────────────────────────────────────

function formatMessage(results: TestResult[], durationSec: number, success: boolean): string {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const passCount = results.filter(r => r.passed).length;
  const failCount = results.filter(r => !r.passed && !r.skipped).length;
  const skipCount = results.filter(r => r.skipped).length;

  const overall = failCount === 0 ? '✅ 全部通过' : `❌ ${failCount} 项失败`;

  const lines = [
    `*[YepAI E2E] Phase 1 TC7 回归测试报告*`,
    `🕐 ${now}  |  ⏱ 耗时: ${durationSec}s`,
    `${overall}  （✅ ${passCount} 通过 / ❌ ${failCount} 失败 / ⚠️ ${skipCount} 跳过）`,
    '',
    ...results.map(r => {
      if (r.skipped) return `⚠️ ${r.name}`;
      return r.passed ? `✅ ${r.name}` : `❌ ${r.name}`;
    }),
  ];

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('🚀 开始运行 Phase 1 TC7 回归测试...\n');
  const start = Date.now();

  const { output, success } = runTest('phase1:tc7', 'TC7');

  const durationSec = Math.round((Date.now() - start) / 1000);
  const results = parseTC7Results(output);
  const message = formatMessage(results, durationSec, success);

  console.log('\n--- 测试完成，准备发送 Slack 消息 ---');
  console.log(message);
  console.log('---');

  await sendToSlack(message);
}

main().catch(err => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
