/**
 * Screenshot Analysis using Claude Vision API
 *
 * Analyzes test screenshots and judges whether each page looks correct.
 *
 * Usage:
 *   pnpm analyze:screenshots
 *   pnpm analyze:screenshots --prefix tc2
 *   pnpm analyze:screenshots --dir screenshots/
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import 'dotenv/config';

interface ScreenshotAnalysis {
  file: string;
  pass: boolean;
  issues: string[];
  summary: string;
}

async function analyzeScreenshot(
  client: Anthropic,
  filePath: string,
): Promise<ScreenshotAnalysis> {
  const imageData = readFileSync(filePath);
  const base64 = imageData.toString('base64');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64 },
          },
          {
            type: 'text',
            text: `You are a QA engineer reviewing a web app screenshot.
Determine if the page looks correct: no visible errors, no blank screens, no broken UI, no error modals.

Return ONLY valid JSON (no markdown, no explanation):
{
  "pass": true or false,
  "issues": ["list of problems if any"],
  "summary": "one sentence describing what you see"
}`,
          },
        ],
      },
    ],
  });

  const text = (response.content[0] as { type: string; text: string }).text;
  const cleaned = text.replace(/^```json\n?/i, '').replace(/^```\n?/i, '').replace(/```\s*$/i, '').trim();

  try {
    const json = JSON.parse(cleaned);
    return { file: filePath, ...json };
  } catch {
    return {
      file: filePath,
      pass: false,
      issues: ['Could not parse AI response'],
      summary: text.substring(0, 100),
    };
  }
}

async function main() {
  const args = process.argv.slice(2);

  const prefixIdx = args.indexOf('--prefix');
  const prefix = prefixIdx >= 0 ? args[prefixIdx + 1] : '';

  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : 'screenshots';

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  if (!existsSync(dir)) {
    console.error(`❌ Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = readdirSync(dir)
    .filter(f => extname(f) === '.png' && (!prefix || f.startsWith(prefix)))
    .sort()
    .map(f => join(dir, f));

  if (files.length === 0) {
    console.log(`No PNG files found in "${dir}"${prefix ? ` with prefix "${prefix}"` : ''}`);
    process.exit(0);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  console.log(`\n🔍 Analyzing ${files.length} screenshot(s)...\n`);

  const results: ScreenshotAnalysis[] = [];

  for (const file of files) {
    process.stdout.write(`  ${basename(file)}... `);
    const result = await analyzeScreenshot(client, file);
    results.push(result);
    console.log(result.pass ? '✅' : '❌');
    if (result.issues.length > 0) {
      result.issues.forEach(i => console.log(`    ⚠ ${i}`));
    }
    console.log(`    ${result.summary}`);
  }

  const passCount = results.filter(r => r.pass).length;
  const failCount = results.length - passCount;

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Result: ✅ ${passCount} passed  ❌ ${failCount} failed  (total: ${results.length})`);
  console.log(`${'─'.repeat(50)}\n`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
