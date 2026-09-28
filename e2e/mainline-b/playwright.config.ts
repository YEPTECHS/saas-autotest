// 主线 B（yepairag 走 LiteLLM，用量进 W23）E2E。
// 依据：pm/docs/BDD-主线B-yepairag接LiteLLM.md（第 4 版，49 个 Scenario）。每个 test 标题以 Scenario 编号开头。
// 运行：npx playwright test -c e2e/mainline-b            （全部）
//       npx playwright test -c e2e/mainline-b --list     （只收集，不连环境）
// 环境变量见同目录 .env.example；缺什么，对应用例会 skip 并写明原因，不会静默通过。
import { defineConfig } from '@playwright/test';
import 'dotenv/config';

export default defineConfig({
  testDir: './specs',
  // ponytail: 串行跑。W23 / 日志断言都按「时间窗 + 商家」圈定本轮记录（W23 没有轮次 id），并发会互相污染
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 10 * 60_000,
  reporter: [['list']],
  use: {
    headless: process.env.HEADLESS !== 'false',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
