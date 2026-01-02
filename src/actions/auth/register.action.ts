/**
 * Registration Action - Optimized
 * Fast registration with pre-defined selectors
 */

import { Page } from '@playwright/test';
import { selectors, urls, Environment } from '../../config/selectors.js';

export interface RegisterOptions {
  firstName: string;
  lastName: string;
  organization: string;
  email: string;
  password: string;
  env?: Environment;
}

export interface RegisterResult {
  success: boolean;
  email: string;
  redirectedTo?: string;
  error?: string;
  duration: number;
}

/**
 * Clean browser state before registration
 */
export async function cleanBrowserState(page: Page): Promise<void> {
  await page.evaluate(`
    localStorage.clear();
    sessionStorage.clear();
    document.cookie.split(';').forEach(function(c) {
      document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=' + new Date().toUTCString() + ';path=/');
    });
  `);
}

/**
 * Execute registration flow
 */
export async function executeRegister(
  page: Page,
  options: RegisterOptions
): Promise<RegisterResult> {
  const startTime = Date.now();
  const env = options.env || 'test';

  try {
    // Step 1: Clean state
    await cleanBrowserState(page);

    // Step 2: Navigate to register page
    await page.goto(urls[env].register, { waitUntil: 'domcontentloaded' });

    // Step 3: Wait for form to be ready
    await page.waitForSelector(selectors.register.firstName, { timeout: 10000 });

    // Step 4: Fill all fields in parallel
    await Promise.all([
      page.locator(selectors.register.firstName).fill(options.firstName),
      page.locator(selectors.register.lastName).fill(options.lastName),
      page.locator(selectors.register.organization).fill(options.organization),
      page.locator(selectors.register.email).fill(options.email),
    ]);

    // Step 5: Fill passwords (must be sequential due to validation)
    await page.locator(selectors.register.password).fill(options.password);
    await page.locator(selectors.register.confirmPassword).fill(options.password);

    // Step 6: Wait for "Passwords match!" validation
    await page.waitForSelector(selectors.register.passwordsMatch, { timeout: 3000 }).catch(() => {});

    // Step 7: Submit form
    await Promise.all([
      page.waitForURL(/verify|verification|confirm/, { timeout: 15000 }),
      page.click(selectors.register.submitButton),
    ]);

    const duration = Date.now() - startTime;
    return {
      success: true,
      email: options.email,
      redirectedTo: page.url(),
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      email: options.email,
      error: error instanceof Error ? error.message : String(error),
      duration,
    };
  }
}

/**
 * Fill verification code
 */
export async function fillVerificationCode(page: Page, code: string): Promise<boolean> {
  try {
    const inputs = page.locator(selectors.verification.codeInputs);
    const count = await inputs.count();

    if (count !== 6) {
      throw new Error(`Expected 6 code inputs, found ${count}`);
    }

    // Fill all digits in parallel
    await Promise.all(
      code.split('').map((digit, index) => inputs.nth(index).fill(digit))
    );

    return true;
  } catch (error) {
    console.error('Failed to fill verification code:', error);
    return false;
  }
}

/**
 * Wait for platform selection page after verification
 */
export async function waitForPlatformSelection(page: Page, timeout = 15000): Promise<boolean> {
  try {
    await page.waitForURL(/platform-selection|dashboard|onboarding/, { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Complete full registration flow with email verification
 */
export async function completeRegistration(
  page: Page,
  options: RegisterOptions,
  getVerificationCode: () => Promise<string>
): Promise<RegisterResult> {
  // Step 1: Register
  const registerResult = await executeRegister(page, options);
  if (!registerResult.success) {
    return registerResult;
  }

  // Step 2: Wait for verification page
  await page.waitForSelector(selectors.verification.codeInputs, { timeout: 10000 });

  // Step 3: Get verification code (from Gmail API)
  const code = await getVerificationCode();

  // Step 4: Fill code
  await fillVerificationCode(page, code);

  // Step 5: Wait for redirect
  const success = await waitForPlatformSelection(page);

  return {
    ...registerResult,
    success,
    redirectedTo: page.url(),
    duration: Date.now() - (Date.now() - registerResult.duration),
  };
}
