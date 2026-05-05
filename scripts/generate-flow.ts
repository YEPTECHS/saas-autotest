/**
 * AI Flow Generator
 *
 * Generates .flow.yml test files from natural language descriptions.
 *
 * Usage:
 *   pnpm generate:flow --prompt "测试登录功能" --name "test-login"
 *   pnpm generate:flow --prompt "Test the Knowledge Base upload area" --name "test-kb-upload"
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const SYSTEM_PROMPT = `You are an expert at writing E2E test flows for the YepAI automation framework.

Framework overview:
- Flows are YAML files with a "name", optional "description", and a "steps" array
- Each step has an "id", "action", and "params"
- Optional step fields: "output" (capture return value), "continueOnError: true"
- Variable interpolation: {{ENV_VAR}} or {{outputVar.result}} or {{outputVar.result.field}}

Available actions and their params:
  browser.navigate:       url, waitUntil? ("domcontentloaded"|"networkidle"|"load")
  browser.click:          selector
  browser.type:           selector, text, clear? (bool)
  browser.waitForSelector: selector, timeout? (ms), state? ("visible"|"attached"|"hidden")
  browser.waitForUrl:     pattern (regex string), timeout?
  browser.screenshot:     name
  browser.execute:        script (JS string, must return a value; returned as { executed, result })
  browser.getText:        selector
  browser.getCurrentUrl:  (no params)
  form.fill:              fields: { "selector": "value", ... }
  form.fillSingle:        selector, value
  log:                    message
  wait:                   ms
  data.saveJson:          file, data

Environment variables available in flows:
  {{YEPAI_BASE_URL}}       — https://bot-test.yepai.io
  {{YEPAI_LOGIN_EMAIL}}    — test user email
  {{YEPAI_LOGIN_PASSWORD}} — test user password

Login page: {{YEPAI_BASE_URL}}/auth/login
  - Email input: "input[type='email'], input[name='email'], #email"
  - Password input: "input[type='password'], input[name='password'], #password"
  - Submit: "button[type='submit']"
  - After login wait for: "nav, [class*='sidebar']"

Rules:
1. Always start with login steps (navigate, fill email, fill password, click submit, wait for dashboard)
2. Take screenshots at key verification points
3. Use browser.execute for complex DOM checks; return structured objects
4. Prefer continueOnError: true for verification steps that shouldn't block the flow
5. Use log steps to mark phases (e.g., "=== Phase 1: Login ===")
6. Generate ONLY valid YAML — no markdown code fences, no explanation

IMPORTANT: Output ONLY the raw YAML. No markdown. No explanation. Start with "name:" directly.`;

async function generateFlow(
  client: Anthropic,
  prompt: string,
  name: string,
): Promise<string> {
  const exampleFlow = readFileSync(
    join('src', 'flows', 'phase1-tc2-sync-now.flow.yml'),
    'utf-8',
  );

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Generate a flow YAML file with name: "${name}" for the following test:

${prompt}

Reference example (do not copy verbatim, use as style guide):
${exampleFlow}`,
      },
    ],
  });

  let yaml = (response.content[0] as { type: string; text: string }).text.trim();
  yaml = yaml.replace(/^```ya?ml\n?/gi, '').replace(/```\s*$/gi, '').trim();
  return yaml;
}

async function main() {
  const args = process.argv.slice(2);

  const promptIdx = args.indexOf('--prompt');
  const nameIdx = args.indexOf('--name');

  if (promptIdx < 0 || !args[promptIdx + 1]) {
    console.error('Usage: pnpm generate:flow --prompt "description" --name "flow-name"');
    console.error('       --name is optional (defaults to generated-<timestamp>)');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const prompt = args[promptIdx + 1];
  const name =
    nameIdx >= 0 && args[nameIdx + 1]
      ? args[nameIdx + 1]
      : `generated-${Date.now()}`;

  const outputPath = join('src', 'flows', `${name}.flow.yml`);

  if (existsSync(outputPath)) {
    console.error(`❌ File already exists: ${outputPath}\nDelete it first or choose a different --name`);
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`\n🤖 Generating flow "${name}"...`);
  console.log(`📝 Prompt: ${prompt}\n`);

  const yaml = await generateFlow(client, prompt, name);

  writeFileSync(outputPath, yaml, 'utf-8');

  console.log(`✅ Saved to: ${outputPath}\n`);
  console.log('─'.repeat(50));
  console.log(yaml);
  console.log('─'.repeat(50));
  console.log(`\nRun with: pnpm flow ${name}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
