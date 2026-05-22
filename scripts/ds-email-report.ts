/**
 * ds-email-report.ts — Digital Staff 专属 Email 报告
 *
 * 读取最新的 ds-run-*.json，发送 HTML 格式的测试结果邮件。
 *
 * 用法：
 *   pnpm ds:email:report
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import nodemailer from 'nodemailer';
import 'dotenv/config';

const REPORTS_DIR = join(process.cwd(), 'reports');

interface FlowResult {
  flowName: string;
  passed: boolean;
  durationMs: number;
  steps: number;
  error?: string;
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

function loadLatestReport(): DSRunReport | null {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('ds-run-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) return null;
  const raw = readFileSync(join(REPORTS_DIR, files[0]), 'utf-8');
  return JSON.parse(raw) as DSRunReport;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function buildHtml(report: DSRunReport): string {
  const dateStr = new Date(report.generatedAt).toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  const passEmoji = report.passRate === 100 ? '✅' : report.passRate >= 75 ? '⚠️' : '❌';
  const passColor = report.passRate === 100 ? '#16a34a' : report.passRate >= 75 ? '#d97706' : '#dc2626';

  const rows = report.results.map(r => {
    const icon  = r.passed ? '✅' : '❌';
    const color = r.passed ? '#f0fdf4' : '#fef2f2';
    const errorHtml = r.error
      ? `<div style="margin-top:4px;font-size:12px;color:#9ca3af;font-family:monospace">${r.error.split('\n')[0].slice(0, 120)}</div>`
      : '';
    return `
      <tr style="background:${color}">
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb">${icon}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;font-weight:600">${r.flowName}${errorHtml}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#6b7280">${r.steps || '—'} steps</td>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#6b7280">${formatDuration(r.durationMs)}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:24px">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

    <div style="background:#1e293b;padding:24px 32px">
      <h1 style="margin:0;color:#fff;font-size:20px">🤖 Digital Staff Weekly Report</h1>
      <p style="margin:6px 0 0;color:#94a3b8;font-size:14px">${dateStr} (MYT)</p>
    </div>

    <div style="padding:24px 32px;border-bottom:1px solid #e5e7eb">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="text-align:center;padding:12px">
            <div style="font-size:36px;font-weight:700;color:${passColor}">${report.passRate}%</div>
            <div style="font-size:12px;color:#6b7280;margin-top:2px">Pass Rate</div>
          </td>
          <td style="text-align:center;padding:12px">
            <div style="font-size:28px;font-weight:700;color:#16a34a">${report.passed}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:2px">Passed</div>
          </td>
          <td style="text-align:center;padding:12px">
            <div style="font-size:28px;font-weight:700;color:#dc2626">${report.failed}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:2px">Failed</div>
          </td>
          <td style="text-align:center;padding:12px">
            <div style="font-size:28px;font-weight:700;color:#374151">${formatDuration(report.durationMs)}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:2px">Total Duration</div>
          </td>
        </tr>
      </table>
    </div>

    <div style="padding:24px 32px">
      <h2 style="margin:0 0 16px;font-size:15px;color:#374151">Flow Results</h2>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:10px 16px;text-align:left;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb"></th>
            <th style="padding:10px 16px;text-align:left;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb">Flow</th>
            <th style="padding:10px 16px;text-align:left;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb">Steps</th>
            <th style="padding:10px 16px;text-align:left;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb">Duration</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div style="padding:16px 32px 24px;background:#f8fafc;font-size:12px;color:#9ca3af">
      Automated report from <strong>yepai-e2e-automation</strong> · Digital Staff Platform
    </div>
  </div>
</body>
</html>`;
}

async function main() {
  const report = loadLatestReport();
  if (!report) {
    console.error('No DS run report found. Run `pnpm ds:run` first.');
    process.exit(1);
  }

  const from = process.env.REPORT_EMAIL_FROM;
  const pass = process.env.REPORT_EMAIL_PASS;
  const to   = process.env.REPORT_EMAIL_TO || 'kiechee.pau@yepai.io';

  if (!from || !pass) {
    console.error('[DS Email] REPORT_EMAIL_FROM or REPORT_EMAIL_PASS not set in .env');
    process.exit(1);
  }

  const passEmoji = report.passRate === 100 ? '✅' : report.passRate >= 75 ? '⚠️' : '❌';
  const subject = `${passEmoji} [DS Weekly] ${report.passRate}% Pass — ${report.passed}/${report.totalFlows} flows`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: from, pass },
  });

  await transporter.sendMail({ from, to, subject, html: buildHtml(report) });
  console.log(`[DS Email] ✅ Report sent to ${to} — ${subject}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
