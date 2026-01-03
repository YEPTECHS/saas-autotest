#!/usr/bin/env node

/**
 * YepAI E2E Automation CLI
 * Command-line interface for running E2E test flows
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { getExecutor, FlowDefinition } from '../core/executor.js';
import { closeBrowser } from '../core/browser.js';
import { executeToolCall } from '../tools/executor.js';
import { addTestUser, getAllTestUsers, TestUser } from '../core/storage.js';

// Load environment variables
config();

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use source flows directory (not dist)
const FLOWS_DIR = resolve(__dirname, '../../src/flows');

const program = new Command();

program
  .name('yepai-e2e')
  .description('YepAI E2E Automation Framework - AI-driven browser testing')
  .version('1.0.0');

// Run flow command
program
  .command('run <flowName>')
  .description('Execute an E2E test flow')
  .option('-e, --email <email>', 'Override test email')
  .option('-h, --headless', 'Run in headless mode', false)
  .option('-s, --slow-mo <ms>', 'Slow down operations', '100')
  .option('-t, --timeout <ms>', 'Default timeout', '30000')
  .option('--var <vars...>', 'Additional variables (key=value)')
  .action(async (flowName: string, options) => {
    console.log(chalk.blue(`\n🚀 YepAI E2E Automation\n`));

    const flowPath = resolve(FLOWS_DIR, `${flowName}.flow.yml`);

    if (!existsSync(flowPath)) {
      console.error(chalk.red(`❌ Flow not found: ${flowName}`));
      console.log(chalk.yellow('\nAvailable flows:'));
      listAvailableFlows();
      process.exit(1);
    }

    // Generate random email suffix
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const baseEmail = process.env.GMAIL_TARGET_EMAIL || 'xmqywx@gmail.com';
    const [emailUser, emailDomain] = baseEmail.split('@');
    const randomEmail = `${emailUser}+test${randomSuffix}@${emailDomain}`;

    // Build variables from environment and options
    const variables: Record<string, string> = {
      // Load from environment - YepAI
      YEPAI_BASE_URL: process.env.YEPAI_BASE_URL || 'https://bot-test.yepai.io',
      // Login credentials (for page testing flows)
      YEPAI_LOGIN_EMAIL: process.env.YEPAI_LOGIN_EMAIL || '',
      YEPAI_LOGIN_PASSWORD: process.env.YEPAI_LOGIN_PASSWORD || '',
      // Registration test credentials
      YEPAI_TEST_EMAIL: randomEmail, // 动态生成随机邮箱
      YEPAI_TEST_PASSWORD: process.env.YEPAI_TEST_PASSWORD || 'Test@12345678',
      YEPAI_TEST_FIRST_NAME: process.env.YEPAI_TEST_FIRST_NAME || 'Test',
      YEPAI_TEST_LAST_NAME: process.env.YEPAI_TEST_LAST_NAME || 'User',
      YEPAI_TEST_ORGANIZATION: process.env.YEPAI_TEST_ORGANIZATION || 'Test Org',
      GMAIL_TARGET_EMAIL: process.env.GMAIL_TARGET_EMAIL || '',
      // Shopify Partner Account
      SHOPIFY_PARTNER_EMAIL: process.env.SHOPIFY_PARTNER_EMAIL || '',
      SHOPIFY_PARTNER_PASSWORD: process.env.SHOPIFY_PARTNER_PASSWORD || '',
      SHOPIFY_ORG_ID: process.env.SHOPIFY_ORG_ID || '155064156',
      YEPAI_CLIENT_ID: process.env.YEPAI_CLIENT_ID || '6f59e94645ee98a1ba5a77d17fc24d77',
    };

    console.log(chalk.cyan(`📧 Test Email: ${randomEmail}`));

    if (options.email) {
      variables.YEPAI_TEST_EMAIL = options.email;
      variables.testEmail = options.email;
    }

    if (options.var) {
      for (const v of options.var) {
        // 只在第一个 = 处分割，保留 URL 中的其他 = 符号
        const eqIndex = v.indexOf('=');
        if (eqIndex > 0) {
          const key = v.substring(0, eqIndex);
          const value = v.substring(eqIndex + 1);
          if (key && value) {
            variables[key] = value;
          }
        }
      }
    }

    // Set runtime options
    process.env.HEADLESS = String(options.headless);
    process.env.SLOWMO = options.slowMo;
    process.env.TIMEOUT = options.timeout;

    console.log(chalk.cyan(`📋 Flow: ${flowName}`));
    console.log(chalk.cyan(`🔧 Headless: ${options.headless}`));
    console.log(chalk.cyan(`⏱️  SlowMo: ${options.slowMo}ms`));

    if (Object.keys(variables).length > 0) {
      console.log(chalk.cyan(`📝 Variables: ${JSON.stringify(variables)}`));
    }

    console.log('');

    try {
      const executor = getExecutor();
      const result = await executor.execute(flowPath, variables, { initGmail: true });

      if (result.success) {
        console.log(chalk.green(`\n✅ Flow completed successfully!`));
        console.log(chalk.gray(`   Duration: ${result.totalDuration}ms`));
        console.log(chalk.gray(`   Steps: ${result.steps.length} executed`));

        // Save user data for registration-related flows
        if (flowName.includes('registration') || flowName.includes('register') || flowName.includes('signup')) {
          const savedUser = addTestUser({
            email: variables.YEPAI_TEST_EMAIL,
            password: variables.YEPAI_TEST_PASSWORD,
            firstName: variables.YEPAI_TEST_FIRST_NAME,
            lastName: variables.YEPAI_TEST_LAST_NAME,
            organization: variables.YEPAI_TEST_ORGANIZATION,
            flowName: flowName,
            plan: 'starter-trial',
            status: 'paid',
          });
          console.log(chalk.cyan(`\n📁 User saved to data/test-users.json`));
          console.log(chalk.gray(`   Email: ${savedUser.email}`));
        }
      } else {
        console.log(chalk.red(`\n❌ Flow failed!`));
        const failedStep = result.steps.find((s) => !s.success);
        if (failedStep) {
          console.log(chalk.red(`   Failed at: ${failedStep.stepId}`));
          console.log(chalk.red(`   Error: ${failedStep.error}`));
        }
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(chalk.red(`\n💥 Execution error:`));
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    } finally {
      await closeBrowser();
    }
  });

// List flows command
program
  .command('list')
  .description('List all available E2E flows')
  .action(() => {
    console.log(chalk.blue(`\n📋 Available E2E Flows\n`));
    listAvailableFlows();
  });

// Flow details command
program
  .command('info <flowName>')
  .description('Show detailed information about a flow')
  .action((flowName: string) => {
    const flowPath = resolve(FLOWS_DIR, `${flowName}.flow.yml`);

    if (!existsSync(flowPath)) {
      console.error(chalk.red(`❌ Flow not found: ${flowName}`));
      process.exit(1);
    }

    const content = readFileSync(flowPath, 'utf-8');
    const flow = parseYaml(content) as FlowDefinition;

    console.log(chalk.blue(`\n📋 Flow: ${flow.name}\n`));

    if (flow.description) {
      console.log(chalk.white(`Description: ${flow.description}\n`));
    }

    if (flow.prerequisites?.length) {
      console.log(chalk.yellow('Prerequisites:'));
      flow.prerequisites.forEach((p) => console.log(`  - ${p}`));
      console.log('');
    }

    if (flow.variables) {
      console.log(chalk.yellow('Variables:'));
      Object.entries(flow.variables).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
      });
      console.log('');
    }

    console.log(chalk.yellow(`Steps (${flow.steps.length}):`));
    flow.steps.forEach((step, i) => {
      console.log(chalk.gray(`  ${i + 1}. [${step.id}] ${step.action}`));
    });
    console.log('');
  });

// Tool execution command (for AI integration)
program
  .command('tool <toolName>')
  .description('Execute an AI tool directly')
  .option('-a, --args <json>', 'Tool arguments as JSON')
  .action(async (toolName: string, options) => {
    const args = options.args ? JSON.parse(options.args) : {};

    console.log(chalk.blue(`\n🔧 Executing tool: ${toolName}\n`));

    try {
      const result = await executeToolCall(toolName, args);
      console.log(chalk.cyan('Result:'));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exitCode = 1;
    } finally {
      await closeBrowser();
    }
  });

// Interactive mode (future)
program
  .command('interactive')
  .description('Start interactive mode for step-by-step execution')
  .action(() => {
    console.log(chalk.yellow('Interactive mode coming soon!'));
    console.log(chalk.gray('For now, use the "run" command with specific flows.'));
  });

// List saved test users
program
  .command('users')
  .description('List all saved test users')
  .option('--json', 'Output as JSON')
  .action((options) => {
    const users = getAllTestUsers();

    if (options.json) {
      console.log(JSON.stringify(users, null, 2));
      return;
    }

    console.log(chalk.blue(`\n👥 Saved Test Users (${users.length})\n`));

    if (users.length === 0) {
      console.log(chalk.yellow('No users saved yet. Run the registration flow to create test users.'));
      return;
    }

    users.forEach((user, index) => {
      console.log(chalk.green(`${index + 1}. ${user.email}`));
      console.log(chalk.gray(`   Name: ${user.firstName} ${user.lastName}`));
      console.log(chalk.gray(`   Organization: ${user.organization}`));
      console.log(chalk.gray(`   Status: ${user.status}`));
      console.log(chalk.gray(`   Plan: ${user.plan || 'N/A'}`));
      console.log(chalk.gray(`   Registered: ${new Date(user.registeredAt).toLocaleString()}`));
      console.log('');
    });
  });

// Helper function to list flows
function listAvailableFlows() {
  const files = readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.flow.yml'));

  if (files.length === 0) {
    console.log(chalk.yellow('No flows found.'));
    return;
  }

  files.forEach((file) => {
    const content = readFileSync(resolve(FLOWS_DIR, file), 'utf-8');
    const flow = parseYaml(content) as FlowDefinition;
    const name = file.replace('.flow.yml', '');

    console.log(chalk.green(`  ${name}`));
    if (flow.description) {
      console.log(chalk.gray(`    ${flow.description}`));
    }
    console.log(chalk.gray(`    Steps: ${flow.steps?.length || 0}`));
    console.log('');
  });
}

// Parse and run
program.parse();

// Handle unhandled rejections
process.on('unhandledRejection', async (error) => {
  console.error(chalk.red('Unhandled error:'), error);
  await closeBrowser();
  process.exit(1);
});
