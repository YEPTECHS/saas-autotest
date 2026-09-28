// BDD 第 2 节：上线第 1 步——代码已部署 dev，开关保持关闭，行为必须和现在一样。
import { test, expect } from '@playwright/test';
import { merchant, requireSwitch, requireWhitelistOnlyConcierge, requireEnv, nowIso, sleep } from '../lib/config';
import { adminPage, visitor, visitorRound, balance, previewSend, waitReplyAfter } from '../lib/web';
import { ensureYepairagPath, w23Rows, logsSince, count, TEXT_SENT, expectNoVkeyErrors, rowsPerRequest, isRagVkey, waitW23, LOG, expectNoW23 } from '../lib/backend';

test.describe('上线第 1 步：开关关闭', () => {
  test.beforeEach(() => requireSwitch('off'));

  // R0-1 开关关闭时，新套餐商家的店铺访客照常收到回复，且不产生 LiteLLM 记录
  test('R0-1 新套餐店铺访客照常回复，无 LiteLLM 记录，余额不变', async ({ browser }) => {
    requireWhitelistOnlyConcierge();
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { conv } = await visitorRound(page, w, 'Do you ship to Australia?');
    const log = await ensureYepairagPath(m.tenant, since, conv);
    expect(count(log, TEXT_SENT), '开关关闭时这一轮应有一条 [CreditUsage] sent … "kind": "text"').toBe(1);
    await sleep(90_000);
    expect(w23Rows(m.tenant, since).filter(isRagVkey), '开关关闭时不应有 rag vkey 的 W23 新行').toEqual([]);
    expect(await balance(admin, m.tenant), 'Q26：text 事件被 chatbot 丢弃，余额不变').toBe(A);
    expectNoVkeyErrors(since);
  });

  // R0-2 开关关闭时，老套餐（已发止血额度）商家的店铺客服照常回复，余额不变
  test('R0-2 老套餐店铺客服照常回复，余额不变', async ({ browser }) => {
    requireWhitelistOnlyConcierge();
    const m = merchant('LEGACY');
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { conv } = await visitorRound(page, w, 'Do you ship to Australia?');
    await ensureYepairagPath(m.tenant, since, conv);
    await sleep(90_000);
    expect(await balance(admin, m.tenant)).toBe(A);
  });

  // R0-3 开关关闭时，白名单商家仍走 concierge，每次调用 2 条记录
  test('R0-3 白名单走 concierge，每个 request_id 恰好 2 行', async ({ browser }) => {
    requireWhitelistOnlyConcierge();
    const m = merchant('WHITELIST', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    await visitorRound(page, w, 'Do you ship to Australia?');
    expect(logsSince('CHATBOT_LOGS', since)).toContain(`[Concierge] turn done tenant=${m.tenant}`);
    expect(count(logsSince('YEPAIRAG_LOGS', since), LOG.RESPONSEV3), 'concierge 这一轮不应打 yepairag /responseV3').toBe(0);
    const rows = await waitW23(m.tenant, since, (r) => r.length >= 2, false);
    expect(rowsPerRequest(rows).every((n) => n === 2), '每个 litellm_request_id 应恰好 2 行（digital-staff + chatbot）').toBe(true);
    expect(new Set(rows.map((r) => r.platform))).toEqual(new Set(['digital-staff', 'chatbot']));
  });

  // R0-4 开关关闭时，后台 Anna 预览照常回复
  test('R0-4 Anna 预览照常回复', async ({ browser }) => {
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const since = nowIso();
    const { frame, body, text } = await previewSend(admin, 'What is your return policy?');
    expect(body.isPreview).toBe(true);
    await waitReplyAfter(frame, text);
    expectNoVkeyErrors(since);
  });

  // R0-5 开关关闭时，零余额商家的后台 Anna 预览照常回复（Q32：第 10 项挂在开关后面）
  test('R0-5 零余额商家 Anna 预览照常回复，无 W23 行', async ({ browser }) => {
    requireEnv('E2E_ZERO_TENANT');
    const m = merchant('ZERO');
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    expect(A).toBeLessThanOrEqual(0);
    const since = nowIso();
    const { frame, body, res, text } = await previewSend(admin, 'What is your return policy?');
    expect(body.isPreview).toBe(true);
    expect(res.status(), '开关关闭时预览不过闸门').not.toBe(400);
    await waitReplyAfter(frame, text);
    await expectNoW23(m.tenant, since);
    expect(await balance(admin, m.tenant)).toBe(A);
  });
});
