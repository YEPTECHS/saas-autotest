// scripts/ds-quality-eval.ts
import Anthropic from '@anthropic-ai/sdk';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

interface ScoreResult {
  screenshot: string;
  relevance: number;
  completeness: number;
  tone: number;
  avg: number;
  comment: string;
}

interface FlowResult {
  flowName: string;
  screenshotsEvaluated: number;
  avgScore: number;
  scores: ScoreResult[];
}

interface QualityReport {
  generatedAt: string;
  flows: FlowResult[];
}

function getLatestDsReport(reportsDir: string): string[] {
  if (!existsSync(reportsDir)) return [];
  const files = readdirSync(reportsDir)
    .filter(f => f.startsWith('ds-run-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) return [];

  const reportPath = join(reportsDir, files[0]);
  try {
    const raw = readFileSync(reportPath, 'utf-8');
    const data = JSON.parse(raw);
    // Extract flow names from the report
    const flows: string[] = [];
    if (Array.isArray(data.flows)) {
      for (const f of data.flows) {
        if (f.flowName || f.name) {
          flows.push(f.flowName || f.name);
        }
      }
    } else if (Array.isArray(data.results)) {
      for (const r of data.results) {
        if (r.flowName || r.flow) {
          const name = r.flowName || r.flow;
          if (!flows.includes(name)) flows.push(name);
        }
      }
    }
    return flows;
  } catch {
    return [];
  }
}

function flowNameToKeyword(flowName: string): string {
  // ds-chat-marketing -> marketing
  // ds-chat-sales -> sales
  const parts = flowName.split('-');
  return parts[parts.length - 1];
}

function findScreenshots(screenshotsDir: string, keyword: string): string[] {
  if (!existsSync(screenshotsDir)) return [];
  const files = readdirSync(screenshotsDir)
    .filter(f => f.toLowerCase().includes(keyword.toLowerCase()) && f.endsWith('.png'))
    .sort();
  return files;
}

function sampleEvenly<T>(arr: T[], count: number): T[] {
  if (arr.length <= count) return arr;
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.floor((i * arr.length) / count);
    result.push(arr[index]);
  }
  return result;
}

async function evaluateScreenshot(
  client: Anthropic,
  screenshotPath: string,
  screenshotName: string
): Promise<ScoreResult> {
  const imageData = readFileSync(screenshotPath);
  const base64Data = imageData.toString('base64');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are evaluating AI chatbot response quality from screenshots.
Score each dimension from 1 (very poor) to 5 (excellent):
- Relevance: Does the response address the user's question directly?
- Completeness: Is the response thorough and complete without being excessive?
- Tone: Is the tone professional, friendly, and appropriate for a business chatbot?

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{"relevance":N,"completeness":N,"tone":N,"comment":"brief comment"}`,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: base64Data
          }
        },
        {
          type: 'text',
          text: 'Evaluate this AI chatbot response screenshot. Return JSON: {"relevance":N,"completeness":N,"tone":N,"comment":"..."}'
        }
      ]
    }]
  });

  const textContent = response.content.find(c => c.type === 'text');
  const text = textContent && textContent.type === 'text' ? textContent.text.trim() : '';

  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    const relevance = Math.min(5, Math.max(1, Number(parsed.relevance) || 3));
    const completeness = Math.min(5, Math.max(1, Number(parsed.completeness) || 3));
    const tone = Math.min(5, Math.max(1, Number(parsed.tone) || 3));
    const avg = Math.round(((relevance + completeness + tone) / 3) * 10) / 10;
    return {
      screenshot: screenshotName,
      relevance,
      completeness,
      tone,
      avg,
      comment: parsed.comment || ''
    };
  } catch {
    console.warn(`  Warning: Could not parse Claude response for ${screenshotName}. Raw: ${text.slice(0, 100)}`);
    return {
      screenshot: screenshotName,
      relevance: 3,
      completeness: 3,
      tone: 3,
      avg: 3.0,
      comment: 'Parse error — defaulted to 3'
    };
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY is not set.');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const reportsDir = join(process.cwd(), 'reports');
  const screenshotsDir = join(process.cwd(), 'screenshots');

  // 1. Find flow names from latest ds-run report
  let flowNames = getLatestDsReport(reportsDir);
  if (!flowNames.length) {
    // Default to known flows if no report found
    flowNames = ['ds-chat-marketing', 'ds-chat-sales', 'ds-chat-edge', 'ds-chat-longrun'];
    console.log('No ds-run report found — using default flow names:', flowNames.join(', '));
  } else {
    console.log(`Flow names from latest ds-run report: ${flowNames.join(', ')}`);
  }

  if (!existsSync(screenshotsDir)) {
    console.log('\nNo screenshots/ directory found — skipping quality evaluation.');
    console.log('(Screenshots are typically only available in local runs, not CI)');
    process.exit(0);
  }

  const flowResults: FlowResult[] = [];

  for (const flowName of flowNames) {
    const keyword = flowNameToKeyword(flowName);
    const allScreenshots = findScreenshots(screenshotsDir, keyword);

    if (!allScreenshots.length) {
      console.log(`\n[${flowName}] No screenshots found matching keyword "${keyword}" — skipping.`);
      continue;
    }

    const sampled = sampleEvenly(allScreenshots, 3);
    console.log(`\n[${flowName}] Evaluating ${sampled.length}/${allScreenshots.length} screenshot(s)...`);

    const scores: ScoreResult[] = [];
    for (const screenshotName of sampled) {
      const screenshotPath = join(screenshotsDir, screenshotName);
      process.stdout.write(`  ${screenshotName} ... `);
      try {
        const score = await evaluateScreenshot(client, screenshotPath, screenshotName);
        scores.push(score);
        console.log(`R:${score.relevance} C:${score.completeness} T:${score.tone} avg:${score.avg}`);
      } catch (err) {
        console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
        scores.push({
          screenshot: screenshotName,
          relevance: 0,
          completeness: 0,
          tone: 0,
          avg: 0,
          comment: `Evaluation failed: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    }

    const validScores = scores.filter(s => s.avg > 0);
    const avgScore = validScores.length
      ? Math.round((validScores.reduce((sum, s) => sum + s.avg, 0) / validScores.length) * 10) / 10
      : 0;

    flowResults.push({
      flowName,
      screenshotsEvaluated: scores.length,
      avgScore,
      scores
    });
  }

  if (!flowResults.length) {
    console.log('\nNo flows had screenshots to evaluate. Exiting.');
    process.exit(0);
  }

  // Save report
  const report: QualityReport = {
    generatedAt: new Date().toISOString(),
    flows: flowResults
  };

  if (!existsSync(reportsDir)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(reportsDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const reportPath = join(reportsDir, `ds-quality-${dateStr}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  // Print summary
  console.log('\n── DS Quality Evaluation Summary ──────────────────');
  for (const flow of flowResults) {
    console.log(`  ${flow.flowName}: avg ${flow.avgScore}/5 (${flow.screenshotsEvaluated} screenshots)`);
  }
  console.log(`\nReport saved to: ${reportPath}`);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
