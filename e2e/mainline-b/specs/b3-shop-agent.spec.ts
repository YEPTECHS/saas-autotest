// 改造后（无开关，09-28）。BDD 第 5 节：第 3 项——店铺 agent 改走 LiteLLM + 商家 vkey（yepairag 36fc34b6）。
// B3-5（「开关已开、第 3 项未上」的漏计窗口）、B3-6（不含第 3 项时 R2 重试回归）已删：无开关后不存在这两种部署状态。
// 前置阻塞（BDD 0.1 / Q30）：dev LiteLLM 上要先挂好 PREMIUM_LLM_MODEL / PREMIUM_LLM_MODEL_STABLE 两个 Gemini 别名，否则整轮 500。
import { test, expect } from '@playwright/test';
import { merchant, requireWhitelistOnlyConcierge, nowIso, cfg } from '../lib/config';
import { adminPage, visitor, visitorRound, visitorSend, balance, waitBalance, aiBubbleCount, history, debitsSince } from '../lib/web';
import {
  LOG, ensureYepairagPath, waitW23, w23Rows, isRagVkey, byAlias, rowsPerRequest, sumCredits, logsSince, count, TEXT_RETIRED, TEXT_SENT,
  expectNoVkeyErrors, expectNoW23, sql, gateDeny,
} from '../lib/backend';

test.describe('改造后 第 3 项：店铺 agent 走 LiteLLM', () => {
  test.beforeEach(() => requireWhitelistOnlyConcierge());

  // B3-1 新套餐商家的店铺访客对话计入该商家 W23 账户
  test('B3-1 [BL-1b → 改造后] 店铺对话计入商家：主回复行 ≥1、路由行 1–4、每个 request_id 1 行', async ({ browser }) => {
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { conv } = await visitorRound(page, w, 'Do you ship to Australia?');
    await ensureYepairagPath(m.tenant, since, conv);
    const rows = await waitW23(m.tenant, since, (r) => r.some(byAlias(cfg.mainModel)));
    test.info().annotations.push({ type: 'SQL-W23 结果', description: JSON.stringify(rows) });
    expect(rows.every((r) => r.merchant_account_key === `chatbot:acct:${m.tenant}`)).toBe(true);
    expect(rowsPerRequest(rows).every((n) => n === 1), '商家 rag vkey：每次调用 1 行（Q4）').toBe(true);
    expect(rows.filter(byAlias(cfg.mainModel)).length, `主回复行（model_alias=${cfg.mainModel}）`).toBeGreaterThanOrEqual(1);
    const route = rows.filter(byAlias(cfg.routeModel)).length;
    expect(route, `路由行（model_alias=${cfg.routeModel}）`).toBeGreaterThanOrEqual(1);
    expect(route).toBeLessThanOrEqual(4);
    const B = await waitBalance(admin, m.tenant, (v) => v < A);
    expect(B).toBeLessThan(A);
    // /credits/history：实测 agentRef / actionType 为 null，只能断言「多了 debit、金额和余额差对得上」；按功能归属看上面的 W23 SQL
    const debits = debitsSince(await history(admin, m.tenant), since);
    expect(debits.length, '/credits/history 应新增 debit').toBeGreaterThanOrEqual(1);
    expect(-debits.reduce((s, d) => s + Number(d.amount), 0)).toBeCloseTo(A - B, 2);
  });

  // B3-2 老套餐（已发止血额度）商家的店铺对话开始扣费
  test('B3-2 [BL-12 → 改造后] 老套餐店铺对话走 yepairag 并开始扣费（W23 有该商家行，余额减少）', async ({ browser }) => {
    const m = merchant('LEGACY');
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    expect(A, '前提：余额 > 0（止血额度）').toBeGreaterThan(0);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { conv } = await visitorRound(page, w, 'Do you ship to Australia?');
    await ensureYepairagPath(m.tenant, since, conv);
    const rows = await waitW23(m.tenant, since, (r) => r.length > 0);
    expect(rows.length).toBeGreaterThan(0);
    expect(await waitBalance(admin, m.tenant, (v) => v < A)).toBeLessThan(A);
  });

  // B3-3 同一轮对话不能既进 LiteLLM 又发 SQS text 事件（防重复计费）
  test('B3-3 [BL-1b → 改造后] 不重复计费：这一轮 [CreditUsage] text rail retired、无 kind=text、W23 无 source≠litellm 行、余额减少 = 本轮 credits 之和', async ({ browser }) => {
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { conv } = await visitorRound(page, w, 'What is your return policy?');
    const log = await ensureYepairagPath(m.tenant, since, conv);
    expect(count(log, TEXT_RETIRED)).toBeGreaterThanOrEqual(1);
    expect(count(log, TEXT_SENT), '改造后不应再发 SQS kind=text').toBe(0);
    const rows = await waitW23(m.tenant, since, (r) => r.some(byAlias(cfg.mainModel)));
    expect(rowsPerRequest(rows).every((n) => n === 1)).toBe(true);
    const nonLitellm = sql(
      'W23_DATABASE_URL',
      `SELECT u.source FROM "digital-staff-su".usage_records_v2 u JOIN "digital-staff-su".accounts a ON a.id = u.account_id
       WHERE a.creation_idempotency_key = 'chatbot:acct:' || :'uid' AND u.source <> 'litellm' AND u.occurred_at >= :'since'::timestamptz`,
      { uid: m.tenant, since },
    );
    expect(nonLitellm, '本轮时间窗内不应有 source≠litellm 的用量记录').toEqual([]);
    const B = await waitBalance(admin, m.tenant, (v) => v < A);
    expect(A - B).toBeCloseTo(sumCredits(w23Rows(m.tenant, since)), 2);
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

  // B3-8 知识问答（ADK 查知识库）改造后能回答，并计入商家（含查询向量化，R5）
  test('B3-8 [BL-3/BL-9 → 改造后] 知识问答：依据 FAQ 回答，有主回复行和向量化行，全是商家 rag vkey', async ({ browser }) => {
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { reply, conv } = await visitorRound(page, w, 'Do you ship to Australia?');
    test.info().annotations.push({ type: '回复', description: reply });
    await ensureYepairagPath(m.tenant, since, conv);
    const rows = await waitW23(m.tenant, since, (r) => r.some(byAlias(cfg.mainModel)) && r.some(byAlias(cfg.embeddingModel)));
    expect(rows.filter(byAlias(cfg.mainModel)).length).toBeGreaterThanOrEqual(1);
    expect(rows.filter(byAlias(cfg.embeddingModel)).length, 'R5 搜索向量化').toBeGreaterThanOrEqual(1);
    expect(rows.every(isRagVkey)).toBe(true);
    expectNoVkeyErrors(since);
  });
});
