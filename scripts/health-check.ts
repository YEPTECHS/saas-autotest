// scripts/health-check.ts
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

interface TestUser {
  email: string;
  password: string;
}

interface AccountResult {
  email: string;
  role: 'main' | 'test';
  status: 'ok' | 'fail';
  error?: string;
}

interface HealthReport {
  generatedAt: string;
  healthy: number;
  unhealthy: number;
  accounts: AccountResult[];
}

async function checkLogin(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = process.env.YEPAI_BASE_URL || '';
  const loginUrl = `${baseUrl}/auth/login`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(loginUrl, { timeout: 15000 });

    // Fill email field
    await page.fill('input[type="email"], input[name="email"], input[placeholder*="email" i]', email, { timeout: 10000 });

    // Fill password field
    await page.fill('input[type="password"], input[name="password"]', password, { timeout: 10000 });

    // Click submit
    await page.click('button[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")', { timeout: 10000 });

    // Wait up to 2s to see if URL changes away from /auth/login
    const startTime = Date.now();
    let leftLogin = false;
    while (Date.now() - startTime < 2000) {
      const currentUrl = page.url();
      if (!currentUrl.includes('/auth/login')) {
        leftLogin = true;
        break;
      }
      await page.waitForTimeout(100);
    }

    if (leftLogin) {
      return { ok: true };
    } else {
      // Check for error messages on the page
      const errorText = await page.locator('[class*="error"], [class*="alert"], [role="alert"]').first().textContent({ timeout: 500 }).catch(() => '');
      return { ok: false, error: errorText?.trim() || 'Login did not redirect away from /auth/login within 2s' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const accounts: Array<{ email: string; password: string; role: 'main' | 'test' }> = [];

  // Add main account from .env
  const mainEmail = process.env.YEPAI_LOGIN_EMAIL;
  const mainPassword = process.env.YEPAI_LOGIN_PASSWORD;
  if (mainEmail && mainPassword) {
    accounts.push({ email: mainEmail, password: mainPassword, role: 'main' });
  } else {
    console.warn('Warning: YEPAI_LOGIN_EMAIL or YEPAI_LOGIN_PASSWORD not set in environment.');
  }

  // Load test users from data/test-users.json if it exists
  const testUsersPath = join(process.cwd(), 'data', 'test-users.json');
  if (existsSync(testUsersPath)) {
    try {
      const raw = readFileSync(testUsersPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const users: TestUser[] = parsed.users || [];
      for (const u of users) {
        if (u.email && u.password) {
          accounts.push({ email: u.email, password: u.password, role: 'test' });
        }
      }
      console.log(`Loaded ${users.length} test user(s) from data/test-users.json`);
    } catch (err) {
      console.warn('Warning: Could not parse data/test-users.json:', err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log('data/test-users.json not found — checking main account only.');
  }

  if (accounts.length === 0) {
    console.error('No accounts to check. Set YEPAI_LOGIN_EMAIL/YEPAI_LOGIN_PASSWORD or provide data/test-users.json.');
    process.exit(1);
  }

  console.log(`\nChecking ${accounts.length} account(s) against ${process.env.YEPAI_BASE_URL || '(no YEPAI_BASE_URL set)'}...\n`);

  const results: AccountResult[] = [];

  for (const account of accounts) {
    process.stdout.write(`  [${account.role}] ${account.email} ... `);
    const { ok, error } = await checkLogin(account.email, account.password);
    const result: AccountResult = {
      email: account.email,
      role: account.role,
      status: ok ? 'ok' : 'fail',
    };
    if (!ok && error) {
      result.error = error;
    }
    results.push(result);
    console.log(ok ? 'OK' : `FAIL (${error})`);
  }

  const healthy = results.filter(r => r.status === 'ok').length;
  const unhealthy = results.filter(r => r.status === 'fail').length;

  const report: HealthReport = {
    generatedAt: new Date().toISOString(),
    healthy,
    unhealthy,
    accounts: results,
  };

  // Write report
  const reportsDir = join(process.cwd(), 'reports');
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const reportPath = join(reportsDir, `health-check-${dateStr}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\nSummary: ${healthy} healthy, ${unhealthy} unhealthy`);
  console.log(`Report saved to: ${reportPath}`);

  if (unhealthy > 0) {
    console.error(`\nFAIL: ${unhealthy} account(s) could not log in.`);
    process.exit(1);
  } else {
    console.log('\nAll accounts healthy.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
