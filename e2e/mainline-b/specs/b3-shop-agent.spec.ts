// 改造后。BDD 第 5 节：第 3 项——店铺 agent。
// 用户 09-29 范围变更：老店铺客服（/responseV3，ecommerce_concierge）下周下线，第 3、4 项不上 prod；整条链路保持改造前原样
// （yepairag 0e1380a5 撤回 36fc34b6、6b5791b1 集中在 core/llm/legacy_storefront.py）：不走 LiteLLM、不用商家 vkey、照发 SQS text。
// 所以店铺对话用例断言「和改造前一样」（对照 baseline BL-1b / BL-12）；余额闸门（chatbot 侧）照旧拦，B3-7 不变。
// B3-5、B3-6 早已删除（无开关后不存在对应部署状态）。
import { test, expect } from '@playwright/test';
import { merchant, requireWhitelistOnlyConcierge, nowIso } from '../lib/config';
import { visitor, visitorRound, visitorSend, aiBubbleCount } from '../lib/web';
import { LOG, waitW23, rowsPerRequest, logsSince, count, expectNoW23, gateDeny, expectLegacyStorefrontRound, expectNoVkeyErrors } from '../lib/backend';

test.describe('改造后 第 3 项：店铺对话（老客服保持原样）', () => {
  test.beforeEach(() => requireWhitelistOnlyConcierge());

  // B3-1 新套餐商家的店铺访客对话：和改造前一样
  test('B3-1 [BL-1b → 改造后：老客服保持原样] 店铺对话有回复，yepairag 有这一轮，发 [CreditUsage] kind=text，W23 无该商家 rag vkey 行', async ({ browser }) => {
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { reply, conv } = await visitorRound(page, w, 'Do you ship to Australia?');
    expect(reply.length).toBeGreaterThan(0);
    await expectLegacyStorefrontRound(m.tenant, since, conv);
    expectNoVkeyErrors(since);
  });

  // B3-2 老套餐（已发止血额度）商家的店铺对话：和改造前一样（不开始按 LiteLLM 扣费）
  test('B3-2 [BL-12 → 改造后：老客服保持原样] 老套餐店铺对话有回复，走 yepairag，发 kind=text，W23 无该商家 rag vkey 行', async ({ browser }) => {
    const m = merchant('LEGACY', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { reply, conv } = await visitorRound(page, w, 'Do you ship to Australia?');
    expect(reply.length).toBeGreaterThan(0);
    await expectLegacyStorefrontRound(m.tenant, since, conv);
  });

  // B3-3 不重复计费：老客服只走 SQS text 这一条账（不经 LiteLLM，没有 SpendLog 可双计）
  test('B3-3 [BL-1b → 改造后：老客服保持原样] 不重复计费：这一轮只发 1 条 kind=text、无 text rail retired、W23 无该商家 rag vkey 行', async ({ browser }) => {
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { conv } = await visitorRound(page, w, 'What is your return policy?');
    await expectLegacyStorefrontRound(m.tenant, since, conv);
  });

  // B3-4 白名单商家不被重复计费（concierge，每个 request_id 恰好 2 行，与 BL-1a 一致）
  test('B3-4 [BL-1a → 改造后] 白名单 concierge 不受影响：不打 yepairag /responseV3，每个 request_id 恰好 2 行', async ({ browser }) => {
    const m = merchant('WHITELIST', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    await visitorRound(page, w, 'Do you ship to Australia?');
    expect(logsSince('CHATBOT_LOGS', since)).toContain(`[Concierge] turn done tenant=${m.tenant}`);
    expect(count(logsSince('YEPAIRAG_LOGS', since), LOG.RESPONSEV3)).toBe(0);
    const rows = await waitW23(m.tenant, since, (r) => r.length >= 2, false);
    expect(rowsPerRequest(rows).every((n) => n === 2)).toBe(true);
  });

  // B3-7 零余额商家改造后仍被 chatbot 余额闸门拦下，yepairag 不产生调用
  test('B3-7 [BL-6 → 改造后] 零余额商家被 storefront-forward 闸门拦下，无 AI 回复，无 W23 行', async ({ browser }) => {
    const m = merchant('ZERO', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const before = await aiBubbleCount(w);
    const res = await visitorSend(page, w, 'Do you ship to Australia?');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.subtype).toBe('visit_limits_reached');
    expect(String(body.errorMessage)).toMatch(/^INSUFFICIENT_CREDITS:/);
    expect(logsSince('CHATBOT_LOGS', since)).toContain(gateDeny('storefront-forward', m.tenant));
    await page.waitForTimeout(30_000);
    expect(await aiBubbleCount(w)).toBe(before);
    await expectNoW23(m.tenant, since);
  });

  // B3-8 知识问答（ADK 查知识库）：和改造前一样（查询向量化也走老的直连 OpenAI，legacy_embedding）
  test('B3-8 [BL-1b → 改造后：老客服保持原样] 知识问答有回复，发 kind=text，W23 无该商家 rag vkey 行（含向量化）', async ({ browser }) => {
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { reply, conv } = await visitorRound(page, w, 'Do you ship to Australia?');
    test.info().annotations.push({ type: '回复', description: reply });
    expect(reply.length).toBeGreaterThan(0);
    await expectLegacyStorefrontRound(m.tenant, since, conv);
    expectNoVkeyErrors(since);
  });
});
