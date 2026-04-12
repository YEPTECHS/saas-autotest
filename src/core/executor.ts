/**
 * Flow Executor Engine
 * Parses and executes YAML flow definitions
 */

import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'path';
import { z } from 'zod';
import { BrowserManager, getBrowser, closeBrowser } from './browser.js';
import { GmailClient, createGmailClient } from './gmail.js';

// Schema definitions for flow files
const StepParamsSchema = z.record(z.unknown());

const FlowStepSchema = z.object({
  id: z.string().optional(),
  action: z.string().optional(),
  include: z.string().optional(), // Include shared steps from another file
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

    // Special action for OAuth URL navigation
    // Extracts query string from OAuth URL and combines with base URL
    this.registerAction('browser.navigateOAuth', async (ctx, params) => {
      const oauthUrl = this.interpolate(params.oauthUrl as string, ctx);
      const baseUrl = this.interpolate(params.baseUrl as string, ctx);
      const path = this.interpolate((params.path as string) || '/auth/external-register', ctx);

      console.log(`[navigateOAuth] OAuth URL length: ${oauthUrl.length}`);
      console.log(`[navigateOAuth] Base URL: ${baseUrl}`);

      // Extract query string from OAuth URL
      const queryIndex = oauthUrl.indexOf('?');
      if (queryIndex === -1) {
        throw new Error('OAuth URL does not contain query string');
      }

      const queryString = oauthUrl.substring(queryIndex);
      const finalUrl = baseUrl + path + queryString;

      console.log(`[navigateOAuth] Final URL: ${finalUrl}`);

      await ctx.browser.navigate(finalUrl);
      return { url: finalUrl, queryString };
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

    // Fill iframe input (for cross-origin iframes like chatbots)
    this.registerAction('form.fillIframe', async (ctx, params) => {
      const iframeSelector = this.interpolate(params.iframeSelector as string, ctx);
      const elementSelector = this.interpolate(params.elementSelector as string, ctx);
      const value = this.interpolate(params.value as string, ctx);
      const page = ctx.browser.getPage();

      const frameLocator = page.frameLocator(iframeSelector);
      const element = frameLocator.locator(elementSelector).first();
      await element.waitFor({ state: 'visible', timeout: 15000 });
      await element.fill(value);

      return { filled: value };
    });

    // Click element in iframe (supports force: true to bypass interception)
    this.registerAction('browser.clickIframe', async (ctx, params) => {
      const iframeSelector = this.interpolate(params.iframeSelector as string, ctx);
      const elementSelector = this.interpolate(params.elementSelector as string, ctx);
      const force = params.force === true || params.force === 'true';
      const page = ctx.browser.getPage();

      const frameLocator = page.frameLocator(iframeSelector);
      const element = frameLocator.locator(elementSelector).first();
      if (!force) {
        await element.waitFor({ state: 'visible', timeout: 10000 });
      }
      await element.click({ force });

      return { clicked: true };
    });

    // Press key in iframe element
    this.registerAction('browser.pressIframe', async (ctx, params) => {
      const iframeSelector = this.interpolate(params.iframeSelector as string, ctx);
      const elementSelector = this.interpolate(params.elementSelector as string, ctx);
      const key = this.interpolate(params.key as string, ctx);
      const page = ctx.browser.getPage();

      const frameLocator = page.frameLocator(iframeSelector);
      const element = frameLocator.locator(elementSelector).first();
      await element.press(key);

      return { pressed: key };
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

    // Set browser viewport size
    this.registerAction('browser.setViewport', async (ctx, params) => {
      const width = Number(params.width) || 1440;
      const height = Number(params.height) || 900;
      const page = ctx.browser.getPage();
      await page.setViewportSize({ width, height });
      return { viewport: { width, height } };
    });

    // Set page default timeout (ms). Use before long-running batch scripts.
    this.registerAction('browser.setDefaultTimeout', async (ctx, params) => {
      const ms = Number(params.ms) || 300000;
      const page = ctx.browser.getPage();
      page.setDefaultTimeout(ms);
      return { timeoutMs: ms };
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

    // Execute JavaScript inside an iframe context (Playwright has full cross-origin iframe access)
    this.registerAction('browser.executeIframe', async (ctx, params) => {
      const rawScript = params.script as string;
      const script = this.interpolate(rawScript, ctx);
      const iframeSelector = this.interpolate(params.iframeSelector as string, ctx);
      const page = ctx.browser.getPage();
      // Find the iframe element and get its Frame context
      const iframeElement = await page.$(iframeSelector);
      if (!iframeElement) throw new Error(`Iframe not found: ${iframeSelector}`);
      const frame = await iframeElement.contentFrame();
      if (!frame) throw new Error(`Cannot access frame for: ${iframeSelector}`);
      // Evaluate JS inside the iframe context (Playwright bypasses same-origin policy)
      const result = await frame.evaluate(`(function() { ${script} })()`);
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

    // Load a JSON data file and return its parsed contents as the step output.
    // Path is resolved relative to the current working directory (project root).
    // Usage in flow:
    //   - id: load-data
    //     action: data.loadJson
    //     params:
    //       file: "data/marketing-skill-cases.json"
    //     output: skillData
    // Then reference: {{skillData.result.skills.0.input}}
    this.registerAction('data.loadJson', async (ctx, params) => {
      const filePath = this.interpolate(params.file as string, ctx);
      const fullPath = filePath.match(/^([A-Za-z]:|\/|\\)/)
        ? filePath
        : join(process.cwd(), filePath);
      if (!existsSync(fullPath)) {
        throw new Error(`data.loadJson: file not found: ${fullPath}`);
      }
      const content = readFileSync(fullPath, 'utf-8');
      return JSON.parse(content);
    });

    // data.saveJson — write an object to a JSON file on disk.
    // For `data` param: if the value is a string that looks like a template reference
    // (e.g. "{{saResults.result}}"), resolve it directly from ctx.outputs to get the
    // raw object instead of the stringified version that interpolate() would produce.
    this.registerAction('data.saveJson', async (ctx, params) => {
      const { writeFileSync } = await import('fs');
      const { join: pathJoin } = await import('path');
      const filePath = this.interpolate(params.file as string, ctx);
      const fullPath = filePath.match(/^([A-Za-z]:|\/|\\)/)
        ? filePath
        : pathJoin(process.cwd(), filePath);

      let data = params.data !== undefined ? params.data : (params.value !== undefined ? params.value : null);

      // If data is a string template like "{{varName.result}}", resolve directly from outputs
      if (typeof data === 'string') {
        const match = /^\{\{(\w+(?:\.\w+)*)\}\}$/.exec(data.trim());
        if (match) {
          const parts = match[1].split('.');
          let val: unknown = { ...ctx.variables, ...ctx.outputs };
          for (const part of parts) {
            if (val && typeof val === 'object' && part in val) {
              val = (val as Record<string, unknown>)[part];
            } else { val = undefined; break; }
          }
          if (val !== undefined) data = val;
        }
      }

      writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf-8');
      return { saved: fullPath };
    });

    // data.buildBoundaryReport — reads saved batch JSON files, merges them, returns a text report.
    // params: files (array of paths), agent (name string)
    this.registerAction('data.buildBoundaryReport', async (_ctx, params) => {
      const { existsSync: fsExists, readFileSync: fsRead } = await import('fs');
      const { join: pathJoin } = await import('path');
      const fileList = (params.files as string[]).map((f: string) =>
        f.match(/^([A-Za-z]:|\/|\\)/) ? f : pathJoin(process.cwd(), f)
      );
      interface BatchItem { id?: string; category?: string; type?: string; q?: string; question?: string; a?: string; answer?: string; status?: string; }
      const r: { type: string; question: string; answer: string; status: string }[] = [];
      for (const fp of fileList) {
        if (fsExists(fp)) {
          try {
            const arr = JSON.parse(fsRead(fp, 'utf-8')) as BatchItem[];
            if (Array.isArray(arr)) {
              arr.forEach(item => {
                r.push({
                  type: item.category || item.type || '?',
                  question: item.q ? `[${item.id || '?'}] ${item.q}` : (item.question || ''),
                  answer: item.a || item.answer || '',
                  status: item.status || 'WARN',
                });
              });
            }
          } catch { /* skip */ }
        }
      }
      const agent = (params.agent as string) || 'Agent';
      const cats: Record<string, string> = {
        SA: 'Skill Accuracy', CD: 'Cross-domain Rejection', RO: 'Read-only Enforcement',
        DP: 'Data Precision', PV: 'Privacy/Safety', MT: 'Multi-turn Context',
        DI: 'Data Integrity/Hallucination', ME: 'Minimal Input & Edge Cases',
        DS: 'Data Freshness & Scope', AP: 'Answer Precision', IC: 'Instruction Compliance',
        RF: 'Refusal/Out-of-scope', LC: 'Language Consistency', HP: 'Hallucination Prevention',
      };
      const lines: string[] = [
        '',
        '╔══════════════════════════════════════════════════════════╗',
        `║   BOUNDARY TEST REPORT — ${agent.padEnd(31)}║`,
        '╚══════════════════════════════════════════════════════════╝',
        `Total: ${r.length} tests`,
      ];
      Object.keys(cats).forEach(cat => {
        const items = r.filter(x => x.type === cat);
        if (!items.length) return;
        lines.push('', `──── ${cats[cat]} (${items.length} tests) ────`);
        items.forEach(item => {
          const icon = item.status === 'PASS' ? '✓ PASS' : item.status === 'WARN' ? '~ WARN' : '✗ FAIL';
          lines.push(`  ${icon}  Q: ${item.question}`);
          lines.push(`         A: ${item.answer.substring(0, 300)}`);
          lines.push('');
        });
      });
      const pass = r.filter(x => x.status === 'PASS').length;
      const warn = r.filter(x => x.status === 'WARN').length;
      const fail = r.filter(x => x.status === 'FAIL').length;
      const pct = r.length ? Math.round(pass / r.length * 100) : 0;
      lines.push('══════════════════════════════════════════════════════════');
      lines.push(`  PASS: ${pass}  WARN: ${warn}  FAIL: ${fail}  TOTAL: ${r.length}  (${pct}% pass rate)`);
      lines.push('══════════════════════════════════════════════════════════');
      return lines.join('\n');
    });

    // data.mergeJsonArrays — reads multiple JSON array files from disk, concatenates them,
    // injects the merged array into the page as window.__mergedBatch, and returns the array.
    // Usage:
    //   action: data.mergeJsonArrays
    //   params:
    //     files: ["reports/opbnd-sa.json", "reports/opbnd-cd.json", ...]
    //     windowKey: "__mergedBatch"   (optional, defaults to __mergedBatch)
    this.registerAction('data.mergeJsonArrays', async (ctx, params) => {
      const { existsSync: fsExists, readFileSync: fsRead } = await import('fs');
      const { join: pathJoin } = await import('path');
      const fileList = (params.files as string[]).map(f => {
        const fp = this.interpolate(f, ctx);
        return fp.match(/^([A-Za-z]:|\/|\\)/) ? fp : pathJoin(process.cwd(), fp);
      });
      const merged: unknown[] = [];
      for (const fp of fileList) {
        if (fsExists(fp)) {
          try {
            const arr = JSON.parse(fsRead(fp, 'utf-8'));
            if (Array.isArray(arr)) arr.forEach((item: unknown) => merged.push(item));
          } catch { /* skip bad files */ }
        }
      }
      // Inject into browser window for use by generate-report
      const key = (params.windowKey as string) || '__mergedBatch';
      const page = ctx.browser.getPage();
      await page.evaluate(([k, data]: [string, unknown[]]) => {
        (window as unknown as Record<string, unknown>)[k] = data;
      }, [key, merged] as [string, unknown[]]);
      return merged;
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
   * Load shared steps from include file
   */
  private loadInclude(includePath: string, baseDir: string): FlowStep[] {
    // Resolve include path relative to the flow file's directory
    const fullPath = join(baseDir, includePath);

    if (!existsSync(fullPath)) {
      throw new Error(`Include file not found: ${includePath}`);
    }

    const content = readFileSync(fullPath, 'utf-8');
    const parsed = parseYaml(content);

    if (!parsed.steps || !Array.isArray(parsed.steps)) {
      throw new Error(`Include file must have a 'steps' array: ${includePath}`);
    }

    return parsed.steps;
  }

  /**
   * Process steps and expand includes
   */
  private expandIncludes(steps: FlowStep[], baseDir: string): FlowStep[] {
    const expandedSteps: FlowStep[] = [];

    for (const step of steps) {
      if (step.include) {
        // Load and expand included steps
        const includedSteps = this.loadInclude(step.include, baseDir);
        expandedSteps.push(...includedSteps);
      } else {
        expandedSteps.push(step);
      }
    }

    return expandedSteps;
  }

  /**
   * Load flow from YAML file
   */
  loadFlow(filePath: string): FlowDefinition {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(content);
    const flow = FlowDefinitionSchema.parse(parsed);

    // Expand includes in steps
    const baseDir = dirname(filePath);
    flow.steps = this.expandIncludes(flow.steps, baseDir);

    return flow;
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
