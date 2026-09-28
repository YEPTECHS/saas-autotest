// BDD 第 12 节：回归——改造不影响已接入 W23 的数字员工链路。
import { test, expect } from '@playwright/test';
import { merchant, requireSwitch, nowIso } from '../lib/config';
import { adminPage, balance, waitBalance, staffChatSend, waitPageGrows, brandIqAutoSetup, waitFor } from '../lib/web';
import { waitW23, rowsPerRequest, isRagVkey } from '../lib/backend';

test.describe('回归：数字员工', () => {
  test.beforeEach(() => requireSwitch('on'));

  // R-1 开关打开后，新套餐商家和 Oscar 聊天仍然正常扣费（每个 request_id 2 行，设计行为）
  test('R-1 Oscar：先 precheck，有回复，余额减少，每个 request_id 恰好 2 行', async ({ browser }) => {
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    const since = nowIso();
    const precheck = waitFor(admin.waitForRequest((r) => r.url().includes(`/credits/precheck/${m.tenant}`), { timeout: 60_000 }), `Oscar 发送前的 /credits/precheck/${m.tenant}`);
    const before = await staffChatSend(admin, '/ai-team/operation/chat', 'How many orders did we get this week?');
    await precheck;
    await waitPageGrows(admin, before);
    const rows = await waitW23(m.tenant, since, (r) => r.length >= 2, false);
    expect(rowsPerRequest(rows).every((n) => n === 2)).toBe(true);
    expect(rows.some(isRagVkey), '数字员工不是 rag vkey').toBe(false);
    expect(await waitBalance(admin, m.tenant, (v) => v < A)).toBeLessThan(A);
  });

  // R-2 开关打开后，Brand IQ 一键设置（由 Maya 完成）照常完成并在 W23 计费（原 B5-2 改成的回归）
  test('R-2 Brand IQ Auto Set Up → request-analysis，余额减少，每个 request_id 2 行', async ({ browser }) => {
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    const since = nowIso();
    await brandIqAutoSetup(admin, m.tenant);
    const rows = await waitW23(m.tenant, since, (r) => r.length >= 2, false);
    expect(rows.some(isRagVkey)).toBe(false);
    expect(rowsPerRequest(rows).every((n) => n === 2)).toBe(true);
    expect(await waitBalance(admin, m.tenant, (v) => v < A)).toBeLessThan(A);
  });
});
