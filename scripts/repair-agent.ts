/**
 * repair-agent.ts — AI agent that fixes broken E2E flows
 *
 * When a flow fails (selector changed, URL moved, timing issue), this agent:
 *  1. Runs the flow to capture the current failure
 *  2. Reads the YAML + error output
 *  3. Diagnoses and patches the YAML (selectors, waits, URLs)
 *  4. Runs again to verify the fix (max 2 attempts)
 *  5. Reports what was changed
 *
 * Usage:
 *   pnpm repair <flow-name>        fix a specific flow
 *   pnpm repair --all              repair every failed flow tracked in QA agent state
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import 'dotenv/config';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const FLOWS_DIR         = join(process.cwd(), 'src/flows');
const STATE_FILE        = join(process.cwd(), 'data/qa-agent-state.json');
const MAX_STEPS         = 10;
const MAX_RUNS          = 2;

// ── Types ──────────────────────────────────────────────────────

interface RepairResult {
  fixed: boolean;
  flowName: string;
  description: string;
  passCount: number;
  failCount: number;
}

// ── Tools ───────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_flow',
    description: 'Read the current YAML content of the failing flow.',
    input_schema: {
      type: 'object' as const,
      properties: { flowName: { type: 'string' } },
      required: ['flowName'],
    },
  },
  {
    name: 'write_flow',
    description: 'Save the repaired YAML back to the flow file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        flowName: { type: 'string' },
        yaml: { type: 'string', description: 'Complete updated YAML content' },
      },
      required: ['flowName', 'yaml'],
    },
  },
  {
    name: 'run_test',
    description: `Run the flow and see if it passes. Max ${MAX_RUNS} attempts.`,
    input_schema: {
      type: 'object' as const,
      properties: { flowName: { type: 'string' } },
      required: ['flowName'],
    },
  },
  {
    name: 'report_repair',
    description: 'Call when done — whether the fix worked or not.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fixed:       { type: 'boolean' },
        description: { type: 'string', description: 'What was wrong and what you changed' },
        passCount:   { type: 'number' },
        failCount:   { type: 'number' },
      },
      required: ['fixed', 'description', 'passCount', 'failCount'],
    },
  },
];

// ── Agent loop ──────────────────────────────────────────────────

async function repairFlow(flowName: string, failureOutput: string): Promise<RepairResult> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const system = `You are a QA automation engineer debugging a failing Playwright YAML test flow.

Common failure causes:
- CSS selector no longer matches (class/ID/placeholder changed)
- URL path changed or redirects differently
- Element needs more time (add wait step or increase timeout)
- Element state changed (was visible, now hidden or vice versa)

Your process:
1. Read the failing flow YAML
2. Cross-reference the error output to pinpoint the broken step
3. Fix the YAML — update selectors, URLs, timeouts, or add wait steps
4. Run the test to verify (max ${MAX_RUNS} runs)
5. Call report_repair with the outcome

Be surgical: change only what is necessary to fix the failure.`;

  const messages: Anthropic.MessageParam[] = [{
    role: 'user',
    content: `Flow "${flowName}" is failing. Here is the error output:\n\`\`\`\n${failureOutput.substring(0, 3000)}\n\`\`\`\n\nRead the flow, diagnose the problem, fix it, and verify by running it.`,
  }];

  let result: RepairResult | undefined;
  let runCount = 0;
  let step = 0;

  while (step < MAX_STEPS && !result) {
    step++;
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 3000,
      system,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        console.log(`   [repair] ${block.text.substring(0, 140).replace(/\n/g, ' ')}`);
      }
    }

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        console.log(`   [repair] step ${step}: ${block.name}(${JSON.stringify(block.input).substring(0, 70)})`);

        let content = '';
        const inp = block.input as Record<string, any>;

        switch (block.name) {
          case 'read_flow': {
            const p = join(FLOWS_DIR, `${inp.flowName}.flow.yml`);
            content = existsSync(p) ? readFileSync(p, 'utf-8') : `File not found: ${inp.flowName}.flow.yml`;
            break;
          }
          case 'write_flow': {
            const yaml = (inp.yaml as string).replace(/^```ya?ml\n?/i, '').replace(/\n?```$/i, '').trim();
            writeFileSync(join(FLOWS_DIR, `${inp.flowName}.flow.yml`), yaml);
            content = `Saved: src/flows/${inp.flowName}.flow.yml`;
            break;
          }
          case 'run_test': {
            runCount++;
            if (runCount > MAX_RUNS) {
              content = `Max runs (${MAX_RUNS}) reached. Call report_repair now.`;
              break;
            }
            console.log(`   [repair] running test (attempt ${runCount}/${MAX_RUNS})...`);
            const res = spawnSync('pnpm', ['flow', inp.flowName as string], {
              cwd: process.cwd(), encoding: 'utf-8',
              timeout: 10 * 60 * 1000, env: { ...process.env },
            });
            const out = ((res.stdout || '') + (res.stderr || '')).substring(0, 3000);
            content = `Exit: ${res.status} | Success: ${res.status === 0}\n\n${out}`;
            break;
          }
          case 'report_repair': {
            result = {
              fixed: inp.fixed as boolean,
              flowName,
              description: inp.description as string,
              passCount: inp.passCount as number,
              failCount: inp.failCount as number,
            };
            content = 'Acknowledged.';
            break;
          }
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
      }

      messages.push({ role: 'user', content: toolResults });
      if (result) break;
    }
  }

  return result ?? {
    fixed: false, flowName,
    description: `Agent did not complete within ${MAX_STEPS} steps`,
    passCount: 0, failCount: 1,
  };
}

// ── Discover all failed flows from QA agent state ───────────────

function getFailedFlows(): string[] {
  if (!existsSync(STATE_FILE)) return [];
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return Object.values(state as Record<string, any>)
      .filter((s: any) => s.status === 'failed' && s.flowName)
      .map((s: any) => s.flowName as string);
  } catch { return []; }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  if (!ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }

  const repairAll = process.argv.includes('--all');
  const flowArg   = process.argv.slice(2).find(a => !a.startsWith('--'));

  let targets: string[] = [];

  if (repairAll) {
    targets = getFailedFlows();
    if (targets.length === 0) {
      console.log('No failed flows found in QA agent state.');
      process.exit(0);
    }
    console.log(`\n🔧 Repair Agent — repairing ${targets.length} failed flow(s): ${targets.join(', ')}\n`);
  } else if (flowArg) {
    targets = [flowArg.replace('.flow.yml', '')];
    console.log(`\n🔧 Repair Agent — ${targets[0]}\n`);
  } else {
    console.error('Usage:\n  pnpm repair <flow-name>\n  pnpm repair --all');
    process.exit(1);
  }

  let fixed = 0, failed = 0;

  for (const flowName of targets) {
    console.log(`\n── ${flowName}`);

    // Run once to capture current failure
    console.log('   Running flow to capture failure output...');
    const res = spawnSync('pnpm', ['flow', flowName], {
      cwd: process.cwd(), encoding: 'utf-8',
      timeout: 10 * 60 * 1000, env: { ...process.env },
    });

    if (res.status === 0) {
      console.log('   ✅ Already passing — skipping');
      fixed++;
      continue;
    }

    const failureOutput = (res.stdout || '') + (res.stderr || '');
    console.log('   ❌ Failing. Starting repair loop...');

    const result = await repairFlow(flowName, failureOutput);

    if (result.fixed) {
      console.log(`   ✅ Fixed: ${result.description}`);
      fixed++;
    } else {
      console.log(`   ❌ Could not fix: ${result.description}`);
      failed++;
    }
  }

  console.log(`\n✅ Done — ${fixed} fixed, ${failed} could not repair\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
