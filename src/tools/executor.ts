/**
 * Tool Executor
 * Executes AI tool calls and returns results
 */

import Anthropic from '@anthropic-ai/sdk';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { getBrowser, closeBrowser } from '../core/browser.js';
import { createGmailClient } from '../core/gmail.js';
import { getExecutor, FlowDefinition } from '../core/executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use source flows directory (not dist)
const FLOWS_DIR = resolve(__dirname, '../../src/flows');

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const toolHandlers: Record<string, ToolHandler> = {
  // Flow execution
  run_e2e_flow: async (args) => {
    try {
      const { flowName, variables = {}, headless = false, slowMo = 100 } = args;
      const flowPath = resolve(FLOWS_DIR, `${flowName}.flow.yml`);

      // Load environment variables into flow variables
      const envVariables: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value) envVariables[key] = value;
      }

      const executor = getExecutor();
      const result = await executor.execute(flowPath, {
        ...envVariables,
        ...(variables as Record<string, unknown>),
        HEADLESS: String(headless),
        SLOWMO: String(slowMo),
      }, { initGmail: true });

      return {
        success: result.success,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Gmail verification code
  get_gmail_verification_code: async (args) => {
    try {
      const { email, subject, codePattern, timeout = 60000 } = args;
      const gmail = createGmailClient();

      const result = await gmail.getVerificationCode({
        to: email as string,
        subject: subject as string,
        codePattern: codePattern as string,
        timeout: timeout as number,
      });

      if (!result) {
        return {
          success: false,
          error: 'Verification code not found within timeout',
        };
      }

      return {
        success: true,
        data: {
          code: result.code,
          emailSubject: result.email.subject,
          receivedAt: result.email.date,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Browser navigation
  browser_navigate: async (args) => {
    try {
      const { url } = args;
      const browser = await getBrowser();
      await browser.navigate(url as string);
      return { success: true, data: { navigated: url } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Browser click
  browser_click: async (args) => {
    try {
      const { selector, waitForNavigation = false } = args;
      const browser = await getBrowser();
      await browser.click(selector as string, {
        waitForNavigation: waitForNavigation as boolean,
      });
      return { success: true, data: { clicked: selector } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Browser type
  browser_type: async (args) => {
    try {
      const { selector, text, clear = true } = args;
      const browser = await getBrowser();
      await browser.type(selector as string, text as string, {
        clear: clear as boolean,
      });
      return { success: true, data: { typed: text } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Fill form
  browser_fill_form: async (args) => {
    try {
      const { fields } = args;
      const browser = await getBrowser();
      await browser.fillForm(fields as Record<string, string>);
      return { success: true, data: { filled: Object.keys(fields as object) } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Screenshot
  browser_screenshot: async (args) => {
    try {
      const { path } = args;
      const browser = await getBrowser();
      const buffer = await browser.screenshot(path as string);
      return {
        success: true,
        data: { path, size: buffer.length },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Wait for selector
  browser_wait_for: async (args) => {
    try {
      const { selector, timeout = 30000, state = 'visible' } = args;
      const browser = await getBrowser();
      await browser.waitFor(selector as string, {
        timeout: timeout as number,
        state: state as 'visible' | 'attached' | 'hidden',
      });
      return { success: true, data: { found: selector } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Wait for URL
  browser_wait_for_url: async (args) => {
    try {
      const { pattern, timeout = 30000 } = args;
      const browser = await getBrowser();
      await browser.waitForUrl(new RegExp(pattern as string), timeout as number);
      return { success: true, data: { matched: pattern } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Get URL
  browser_get_url: async () => {
    try {
      const browser = await getBrowser();
      const url = browser.getCurrentUrl();
      return { success: true, data: { url } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Get text
  browser_get_text: async (args) => {
    try {
      const { selector } = args;
      const browser = await getBrowser();
      const text = await browser.getTextContent(selector as string);
      return { success: true, data: { text } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Close browser
  browser_close: async () => {
    try {
      await closeBrowser();
      return { success: true, data: { closed: true } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // List flows
  list_flows: async () => {
    try {
      const files = readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.flow.yml'));
      const flows = files.map((f) => {
        const content = readFileSync(resolve(FLOWS_DIR, f), 'utf-8');
        const parsed = parseYaml(content) as FlowDefinition;
        return {
          name: f.replace('.flow.yml', ''),
          description: parsed.description,
          stepsCount: parsed.steps?.length || 0,
        };
      });
      return { success: true, data: { flows } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Generate a new flow YAML from a natural language prompt
  generate_flow: async (args) => {
    try {
      const { prompt, flowName } = args;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const system = `You are an expert at writing E2E test flows for the YepAI automation framework.
Flows are YAML files. Every flow MUST start with:
  steps:
    - include: _shared/login.steps.yml

Available actions:
  browser.navigate       params: { url, waitUntil? }
  browser.click          params: { selector }
  browser.type           params: { selector, text, clear? }
  browser.waitForSelector params: { selector, timeout?, state? }
  browser.waitForUrl     params: { pattern, timeout? }
  browser.screenshot     params: { name }
  browser.execute        params: { script }  output: varName
  browser.getText        params: { selector }
  browser.getCurrentUrl  (no params)
  form.fillSingle        params: { selector, value }
  log                    params: { message }
  wait                   params: { ms }
  data.saveJson          params: { file, data }

App routes:
  {{YEPAI_BASE_URL}}/auth/login
  {{YEPAI_BASE_URL}}/ai-team/marketing/chat  (Maya)
  {{YEPAI_BASE_URL}}/ai-team/operations/chat (Oscar)
  {{YEPAI_BASE_URL}}/ai-team/analytics/chat  (Daniel)
  {{YEPAI_BASE_URL}}/ai-team/seo/chat        (Cody)

Return ONLY the YAML content — no markdown fences, no explanation.`;

      const msg = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 3000,
        system,
        messages: [{ role: 'user', content: `Generate a flow named "${flowName}" for: ${prompt}` }],
      });

      let yaml = ((msg.content[0] as any).text as string)
        .replace(/^```ya?ml\n?/i, '').replace(/\n?```$/i, '').trim();

      const flowFile = resolve(FLOWS_DIR, `${flowName}.flow.yml`);
      writeFileSync(flowFile, yaml);

      return { success: true, data: { flowName, path: `src/flows/${flowName}.flow.yml`, preview: yaml.substring(0, 300) } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  // Analyse a screenshot with Claude Vision
  analyze_screenshot: async (args) => {
    try {
      const { path: screenshotPath, description = '' } = args;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const ext = extname(screenshotPath as string).toLowerCase();
      const mediaType: 'image/png' | 'image/jpeg' =
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      const base64 = readFileSync(screenshotPath as string).toString('base64');

      const context = description ? `Page context: ${description}\n\n` : '';
      const msg = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            {
              type: 'text',
              text: `${context}Does this page look correct? Return JSON only:
{"pass": true/false, "issues": ["..."], "summary": "one sentence"}`,
            },
          ],
        }],
      });

      const text = (msg.content[0] as any).text as string;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { pass: false, issues: ['Could not parse response'], summary: text };

      return { success: true, data: { ...result, path: screenshotPath } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  // Get flow details
  get_flow_details: async (args) => {
    try {
      const { flowName } = args;
      const flowPath = resolve(FLOWS_DIR, `${flowName}.flow.yml`);
      const content = readFileSync(flowPath, 'utf-8');
      const parsed = parseYaml(content) as FlowDefinition;
      return {
        success: true,
        data: {
          name: parsed.name,
          description: parsed.description,
          variables: parsed.variables,
          prerequisites: parsed.prerequisites,
          steps: parsed.steps.map((s) => ({
            id: s.id,
            action: s.action,
          })),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * Execute a tool call
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const handler = toolHandlers[toolName];

  if (!handler) {
    return {
      success: false,
      error: `Unknown tool: ${toolName}`,
    };
  }

  return handler(args);
}

/**
 * Register a custom tool handler
 */
export function registerToolHandler(
  name: string,
  handler: ToolHandler
): void {
  toolHandlers[name] = handler;
}

/**
 * Get all registered tool names
 */
export function getRegisteredTools(): string[] {
  return Object.keys(toolHandlers);
}
