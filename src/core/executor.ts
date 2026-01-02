/**
 * Flow Executor Engine
 * Parses and executes YAML flow definitions
 */

import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { BrowserManager, getBrowser, closeBrowser } from './browser.js';
import { GmailClient, createGmailClient } from './gmail.js';

// Schema definitions for flow files
const StepParamsSchema = z.record(z.unknown());

const FlowStepSchema = z.object({
  id: z.string(),
  action: z.string(),
  params: StepParamsSchema.optional(),
  waitFor: z.string().optional(),
  output: z.string().optional(),
  capturePopup: z.boolean().optional(),
  continueOnError: z.boolean().optional(),
});

const FlowDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  prerequisites: z.array(z.string()).optional(),
  variables: z.record(z.string()).optional(),
  steps: z.array(FlowStepSchema),
});

export type FlowStep = z.infer<typeof FlowStepSchema>;
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;

export interface ExecutionContext {
  variables: Record<string, unknown>;
  outputs: Record<string, unknown>;
  browser: BrowserManager;
  gmail: GmailClient | null;
}

export interface StepResult {
  stepId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  duration: number;
}

export interface FlowResult {
  flowName: string;
  success: boolean;
  steps: StepResult[];
  totalDuration: number;
  outputs: Record<string, unknown>;
}

type ActionHandler = (ctx: ExecutionContext, params: Record<string, unknown>) => Promise<unknown>;

export class FlowExecutor {
  private actionHandlers: Map<string, ActionHandler> = new Map();

  constructor() {
    this.registerDefaultActions();
  }

  /**
   * Register default action handlers
   */
  private registerDefaultActions(): void {
    // Browser actions
    this.registerAction('browser.navigate', async (ctx, params) => {
      const url = this.interpolate(params.url as string, ctx);
      await ctx.browser.navigate(url);
      return { url };
    });

    this.registerAction('browser.click', async (ctx, params) => {
      const selector = this.interpolate(params.selector as string, ctx);
      await ctx.browser.click(selector, {
        waitForNavigation: params.waitFor === 'navigation',
      });
      return { clicked: selector };
    });

    this.registerAction('browser.type', async (ctx, params) => {
      const selector = this.interpolate(params.selector as string, ctx);
      const text = this.interpolate(params.text as string, ctx);
      await ctx.browser.type(selector, text, { clear: params.clear as boolean });
      return { typed: text };
    });

    this.registerAction('browser.waitForSelector', async (ctx, params) => {
      const selector = this.interpolate(params.selector as string, ctx);
      const page = ctx.browser.getPage();
      // Use .first() to handle multiple matches (e.g., 6 verification code inputs)
      await page.locator(selector).first().waitFor({
        state: (params.state as 'visible' | 'attached' | 'hidden') || 'visible',
        timeout: (params.timeout as number) || 30000,
      });
      return { found: selector };
    });

    this.registerAction('browser.waitForUrl', async (ctx, params) => {
      const pattern = this.interpolate(params.pattern as string, ctx);
      await ctx.browser.waitForUrl(new RegExp(pattern), params.timeout as number);
      return { matched: pattern };
    });

    this.registerAction('browser.screenshot', async (ctx, params) => {
      const path = params.path ? this.interpolate(params.path as string, ctx) : undefined;
      const buffer = await ctx.browser.screenshot(path);
      return { path, size: buffer.length };
    });

    this.registerAction('browser.getText', async (ctx, params) => {
      const selector = this.interpolate(params.selector as string, ctx);
      const text = await ctx.browser.getTextContent(selector);
      return text;
    });

    this.registerAction('browser.getCurrentUrl', async (ctx) => {
      return ctx.browser.getCurrentUrl();
    });

    // Form actions
    this.registerAction('form.fill', async (ctx, params) => {
      const fields = params.fields as Record<string, string>;
      const interpolatedFields: Record<string, string> = {};

      for (const [key, value] of Object.entries(fields)) {
        interpolatedFields[key] = this.interpolate(value, ctx);
      }

      await ctx.browser.fillForm(interpolatedFields);
      return { filled: Object.keys(interpolatedFields) };
    });

    // Fill single field by selector
    this.registerAction('form.fillSingle', async (ctx, params) => {
      const selector = this.interpolate(params.selector as string, ctx);
      const value = this.interpolate(params.value as string, ctx);
      const page = ctx.browser.getPage();
      await page.locator(selector).fill(value);
      return { selector, value };
    });

    // Batch fill form fields (optimized - parallel execution)
    this.registerAction('form.fillBatch', async (ctx, params) => {
      const fields = params.fields as Array<{ selector: string; value: string }>;
      const page = ctx.browser.getPage();

      const promises = fields.map(async (field) => {
        const selector = this.interpolate(field.selector, ctx);
        const value = this.interpolate(field.value, ctx);
        await page.locator(selector).fill(value);
        return { selector, value };
      });

      const results = await Promise.all(promises);
      return { filled: results.length, fields: results };
    });

    // Fill verification code (sequential with input events)
    this.registerAction('form.fillVerificationCode', async (ctx, params) => {
      const selector = this.interpolate(params.selector as string, ctx);
      const code = this.interpolate(params.code as string, ctx);
      const page = ctx.browser.getPage();

      const inputs = page.locator(selector);
      const count = await inputs.count();

      if (count !== code.length) {
        throw new Error(`Code length (${code.length}) doesn't match input count (${count})`);
      }

      // Fill digits sequentially to trigger proper React events
      for (let i = 0; i < code.length; i++) {
        const input = inputs.nth(i);
        await input.click();
        await input.fill(code[i]);
        // Small delay to allow React state updates
        await page.waitForTimeout(50);
      }

      // Trigger change event on last input to ensure form submission
      await inputs.nth(code.length - 1).dispatchEvent('change');

      return { filled: code };
    });

    // Fill Stripe payment form (handles iframe - legacy cardElement)
    this.registerAction('stripe.fillCard', async (ctx, params) => {
      const page = ctx.browser.getPage();
      const cardNumber = params.cardNumber as string || '4242424242424242';
      const expiry = params.expiry as string || '0427';
      const cvc = params.cvc as string || '321';
      const country = params.country as string;

      // Wait for Stripe iframe to be available
      await page.waitForSelector('iframe[name*="__privateStripeFrame"]', { timeout: 30000 });

      // Fill card number
      const cardFrame = page.frameLocator('iframe[name*="__privateStripeFrame"][name*="cardNumber"], iframe[title*="card number"]').first();
      await cardFrame.locator('input').fill(cardNumber);

      // Fill expiry
      const expiryFrame = page.frameLocator('iframe[name*="__privateStripeFrame"][name*="cardExpiry"], iframe[title*="expir"]').first();
      await expiryFrame.locator('input').fill(expiry);

      // Fill CVC
      const cvcFrame = page.frameLocator('iframe[name*="__privateStripeFrame"][name*="cardCvc"], iframe[title*="cvc"], iframe[title*="security"]').first();
      await cvcFrame.locator('input').fill(cvc);

      // Fill country if provided
      if (country) {
        const countrySelect = page.locator('select[name*="country"], select[id*="country"], [data-testid*="country"]').first();
        if (await countrySelect.count() > 0) {
          await countrySelect.selectOption({ label: country });
        }
      }

      return { filled: { cardNumber: '****' + cardNumber.slice(-4), expiry, cvc: '***', country } };
    });

    // Fill Stripe PaymentElement (newer unified payment form)
    this.registerAction('stripe.fillPaymentElement', async (ctx, params) => {
      const page = ctx.browser.getPage();
      const cardNumber = params.cardNumber as string || '4242424242424242';
      const expiry = params.expiry as string || '04/27';
      const cvc = params.cvc as string || '321';

      // Wait for Stripe PaymentElement iframe
      await page.waitForSelector('iframe[name*="__privateStripeFrame"]', { timeout: 30000 });

      // Give time for all iframes to load
      await page.waitForTimeout(2000);

      // Get all Stripe iframes
      const iframes = page.locator('iframe[name*="__privateStripeFrame"]');
      const count = await iframes.count();
      console.log(`Found ${count} Stripe iframes`);

      // If only 1 iframe, it's the unified PaymentElement
      if (count === 1) {
        const iframe = iframes.first();
        const name = await iframe.getAttribute('name') || '';
        console.log(`PaymentElement iframe: ${name}`);

        const frame = page.frameLocator(`iframe[name="${name}"]`);

        // Wait for inputs to be ready with retry
        let inputCount = 0;
        for (let retry = 0; retry < 5; retry++) {
          const inputs = frame.locator('input');
          inputCount = await inputs.count();
          console.log(`Attempt ${retry + 1}: Found ${inputCount} inputs in PaymentElement`);
          if (inputCount > 0) break;
          await page.waitForTimeout(1000);
        }

        if (inputCount === 0) {
          throw new Error('No inputs found in Stripe PaymentElement after retries');
        }

        // Fill each field by name
        try {
          // Fill card number
          const cardInput = frame.locator('input[name="number"]');
          await cardInput.waitFor({ state: 'visible', timeout: 5000 });
          await cardInput.click();
          await cardInput.fill(cardNumber);
          console.log('Filled card number');

          // Fill expiry (format: MM/YY or MMYY)
          const expiryInput = frame.locator('input[name="expiry"]');
          await expiryInput.waitFor({ state: 'visible', timeout: 5000 });
          await expiryInput.click();
          // Format as MM/YY
          const formattedExpiry = expiry.includes('/') ? expiry : `${expiry.slice(0, 2)}/${expiry.slice(2)}`;
          await expiryInput.fill(formattedExpiry);
          console.log('Filled expiry:', formattedExpiry);

          // Fill CVC
          const cvcInput = frame.locator('input[name="cvc"]');
          await cvcInput.waitFor({ state: 'visible', timeout: 5000 });
          await cvcInput.click();
          await cvcInput.fill(cvc);
          console.log('Filled CVC');
        } catch (e) {
          console.log(`PaymentElement fill error: ${e}`);
          throw e;
        }
      } else {
        // Multiple iframes - handle separately (legacy cardElement)
        for (let i = 0; i < count; i++) {
          const iframe = iframes.nth(i);
          const name = await iframe.getAttribute('name') || '';
          const title = await iframe.getAttribute('title') || '';

          try {
            const frame = page.frameLocator(`iframe[name="${name}"]`);

            // Check for card number input
            if (name.includes('cardNumber') || title.toLowerCase().includes('card number')) {
              const input = frame.locator('input').first();
              if (await input.count() > 0) {
                await input.fill(cardNumber);
                console.log('Filled card number');
              }
            }

            // Check for expiry input
            if (name.includes('cardExpiry') || title.toLowerCase().includes('expir')) {
              const input = frame.locator('input').first();
              if (await input.count() > 0) {
                await input.fill(expiry);
                console.log('Filled expiry');
              }
            }

            // Check for CVC input
            if (name.includes('cardCvc') || title.toLowerCase().includes('cvc') || title.toLowerCase().includes('security')) {
              const input = frame.locator('input').first();
              if (await input.count() > 0) {
                await input.fill(cvc);
                console.log('Filled CVC');
              }
            }
          } catch (e) {
            // Continue to next iframe if this one fails
            console.log(`Iframe ${i} (${name}): skipped`);
          }
        }
      }

      return { filled: { cardNumber: '****' + cardNumber.slice(-4), expiry, cvc: '***' } };
    });

    // Execute JavaScript in page context
    this.registerAction('browser.execute', async (ctx, params) => {
      const rawScript = params.script as string;
      // Interpolate variables in the script
      const script = this.interpolate(rawScript, ctx);
      const page = ctx.browser.getPage();
      // Wrap script in an IIFE to support return statements
      const wrappedScript = `(function() { ${script} })()`;
      const result = await page.evaluate(wrappedScript);
      return { executed: true, result };
    });

    // Gmail actions
    this.registerAction('gmail.waitForEmail', async (ctx, params) => {
      if (!ctx.gmail) throw new Error('Gmail client not initialized');

      const email = await ctx.gmail.waitForEmail({
        to: params.to ? this.interpolate(params.to as string, ctx) : undefined,
        from: params.from ? this.interpolate(params.from as string, ctx) : undefined,
        subject: params.subject ? this.interpolate(params.subject as string, ctx) : undefined,
        timeout: params.timeout as number,
      });

      if (!email) throw new Error('Email not received within timeout');
      return email;
    });

    this.registerAction('gmail.extractCode', async (ctx, params) => {
      if (!ctx.gmail) throw new Error('Gmail client not initialized');

      const email = ctx.outputs[params.email as string] as { body: string; subject: string; snippet: string };
      if (!email) throw new Error(`Email output '${params.email}' not found`);

      const pattern = params.pattern ? this.interpolate(params.pattern as string, ctx) : '\\d{6}';
      const regex = new RegExp(pattern);

      // Search in body, subject, snippet
      let code: string | null = null;
      for (const text of [email.body, email.subject, email.snippet]) {
        const match = text.match(regex);
        if (match) {
          code = match[1] || match[0];
          break;
        }
      }

      if (!code) throw new Error('Verification code not found in email');
      return code;
    });

    this.registerAction('gmail.getVerificationCode', async (ctx, params) => {
      if (!ctx.gmail) throw new Error('Gmail client not initialized');

      const result = await ctx.gmail.getVerificationCode({
        to: params.to ? this.interpolate(params.to as string, ctx) : undefined,
        subject: params.subject ? this.interpolate(params.subject as string, ctx) : undefined,
        codePattern: params.codePattern as string,
        timeout: params.timeout as number,
      });

      if (!result) throw new Error('Verification code not received');
      return result;
    });

    // Assert actions
    this.registerAction('assert.url', async (ctx, params) => {
      const pattern = this.interpolate(params.pattern as string, ctx);
      const currentUrl = ctx.browser.getCurrentUrl();
      const regex = new RegExp(pattern);

      if (!regex.test(currentUrl)) {
        throw new Error(`URL assertion failed. Expected: ${pattern}, Got: ${currentUrl}`);
      }
      return { matched: true, url: currentUrl };
    });

    this.registerAction('assert.element', async (ctx, params) => {
      const selector = this.interpolate(params.selector as string, ctx);
      const exists = await ctx.browser.elementExists(selector);

      if (!exists) {
        throw new Error(`Element assertion failed. Selector not found: ${selector}`);
      }
      return { found: true, selector };
    });

    this.registerAction('assert.text', async (ctx, params) => {
      const selector = this.interpolate(params.selector as string, ctx);
      const expected = this.interpolate(params.expected as string, ctx);
      const text = await ctx.browser.getTextContent(selector);

      if (!text?.includes(expected)) {
        throw new Error(`Text assertion failed. Expected: ${expected}, Got: ${text}`);
      }
      return { matched: true, text };
    });

    // Utility actions
    this.registerAction('wait', async (_, params) => {
      const ms = params.ms as number || 1000;
      await new Promise(resolve => setTimeout(resolve, ms));
      return { waited: ms };
    });

    this.registerAction('log', async (ctx, params) => {
      const message = this.interpolate(params.message as string, ctx);
      console.log(`[Flow Log] ${message}`);
      return { logged: message };
    });

    this.registerAction('setVariable', async (ctx, params) => {
      const name = params.name as string;
      const value = this.interpolate(params.value as string, ctx);
      ctx.variables[name] = value;
      return { set: { [name]: value } };
    });
  }

  /**
   * Register custom action handler
   */
  registerAction(name: string, handler: ActionHandler): void {
    this.actionHandlers.set(name, handler);
  }

  /**
   * Interpolate variables in string
   */
  private interpolate(template: string, ctx: ExecutionContext): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
      const parts = path.split('.');
      let value: unknown = { ...ctx.variables, ...ctx.outputs };

      for (const part of parts) {
        if (value && typeof value === 'object' && part in value) {
          value = (value as Record<string, unknown>)[part];
        } else {
          return `{{${path}}}`; // Keep original if not found
        }
      }

      return String(value);
    });
  }

  /**
   * Load flow from YAML file
   */
  loadFlow(filePath: string): FlowDefinition {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(content);
    return FlowDefinitionSchema.parse(parsed);
  }

  /**
   * Execute a flow
   */
  async execute(
    flow: FlowDefinition | string,
    variables: Record<string, unknown> = {},
    options: { initGmail?: boolean } = {}
  ): Promise<FlowResult> {
    const flowDef = typeof flow === 'string' ? this.loadFlow(flow) : flow;
    const startTime = Date.now();
    const stepResults: StepResult[] = [];

    // Initialize context
    const browser = await getBrowser();
    let gmail: GmailClient | null = null;

    if (options.initGmail) {
      try {
        gmail = createGmailClient();
      } catch (error) {
        console.warn('Gmail client not initialized:', error);
      }
    }

    const ctx: ExecutionContext = {
      variables: { ...flowDef.variables, ...variables },
      outputs: {},
      browser,
      gmail,
    };

    console.log(`\n=== Executing Flow: ${flowDef.name} ===\n`);

    let flowSuccess = true;

    for (const step of flowDef.steps) {
      const stepStart = Date.now();
      console.log(`[Step ${step.id}] ${step.action}...`);

      try {
        const handler = this.actionHandlers.get(step.action);
        if (!handler) {
          throw new Error(`Unknown action: ${step.action}`);
        }

        const params = step.params || {};
        const result = await handler(ctx, params);

        // Store output if specified
        if (step.output) {
          ctx.outputs[step.output] = result;
        }

        const duration = Date.now() - stepStart;
        stepResults.push({
          stepId: step.id,
          success: true,
          output: result,
          duration,
        });

        console.log(`[Step ${step.id}] Success (${duration}ms)`);

        // Handle waitFor
        if (step.waitFor && step.waitFor !== 'navigation') {
          await ctx.browser.waitFor(step.waitFor);
        }
      } catch (error) {
        const duration = Date.now() - stepStart;
        const errorMessage = error instanceof Error ? error.message : String(error);

        stepResults.push({
          stepId: step.id,
          success: false,
          error: errorMessage,
          duration,
        });

        console.error(`[Step ${step.id}] Failed: ${errorMessage}`);

        if (!step.continueOnError) {
          flowSuccess = false;
          break;
        }
      }
    }

    const totalDuration = Date.now() - startTime;

    console.log(`\n=== Flow ${flowSuccess ? 'Completed' : 'Failed'} (${totalDuration}ms) ===\n`);

    return {
      flowName: flowDef.name,
      success: flowSuccess,
      steps: stepResults,
      totalDuration,
      outputs: ctx.outputs,
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    await closeBrowser();
  }
}

// Singleton executor
let defaultExecutor: FlowExecutor | null = null;

export function getExecutor(): FlowExecutor {
  if (!defaultExecutor) {
    defaultExecutor = new FlowExecutor();
  }
  return defaultExecutor;
}
