// BDD 第 5 节：第 3 项——店铺 agent 改走 LiteLLM + 商家 vkey。
// 前置阻塞（BDD 0.1 / Q30）：dev LiteLLM 上要先挂好 PREMIUM_LLM_MODEL / PREMIUM_LLM_MODEL_STABLE 两个 Gemini 别名，否则整轮 500。
import { test, expect } from '@playwright/test';
import { merchant, requireSwitch, requireWhitelistOnlyConcierge, env, nowIso, cfg } from '../lib/config';
import { adminPage, visitor, visitorRound, visitorSend, balance, waitBalance, aiBubbleCount, history, debitsSince } from '../lib/web';
import {
  LOG, ensureYepairagPath, waitW23, w23Rows, isRagVkey, byAlias, rowsPerRequest, sumCredits, logsSince, count, TEXT_RETIRED, TEXT_SENT,
  expectNoVkeyErrors, expectNoW23, sql, CHAT_MEMORY_FROM,
} from '../lib/backend';

test.describe('第 3 项：店铺 agent 走 LiteLLM', () => {
  test.beforeEach(() => {
    requireSwitch('on');
    requireWhitelistOnlyConcierge();
  });

  // B3-1 新套餐商家的店铺访客对话计入该商家 W23 账户
  test('B3-1 店铺对话计入商家：主回复行 ≥1、路由行 1–4、每个 request_id 1 行', async ({ browser }) => {
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
  test('B3-2 老套餐店铺对话开始扣费', async ({ browser }) => {
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
  test('B3-3 不重复计费：text rail retired、无 kind=text、余额减少 = 本轮 credits 之和', async ({ browser }) => {
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { conv } = await visitorRound(page, w, 'What is your return policy?');
    const log = await ensureYepairagPath(m.tenant, since, conv);
    expect(count(log, TEXT_RETIRED)).toBeGreaterThanOrEqual(1);
    expect(count(log, TEXT_SENT), '开关打开后不应再发 kind=text').toBe(0);
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

  // B3-4 白名单商家不被重复计费（concierge，每个 request_id 恰好 2 行，与 R0-3 一致）
  test('B3-4 白名单 concierge：每个 request_id 恰好 2 行', async ({ browser }) => {
    const m = merchant('WHITELIST', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    await visitorRound(page, w, 'Do you ship to Australia?');
    expect(logsSince('CHATBOT_LOGS', since)).toContain(`[Concierge] turn done tenant=${m.tenant}`);
    expect(count(logsSince('YEPAIRAG_LOGS', since), LOG.RESPONSEV3)).toBe(0);
    const rows = await waitW23(m.tenant, since, (r) => r.length >= 2, false);
    expect(rowsPerRequest(rows).every((n) => n === 2)).toBe(true);
  });

  // B3-5 ADK 改造没上而开关已打开时，对账检查必须报出主回复漏计（造故障：需部署不含第 3 项的镜像，单独授权）
  test('B3-5 漏计窗口：有路由行、主回复行 0，对账判「主回复漏计」', async ({ browser }) => {
    test.skip(env('E2E_B35_DEPLOYED') !== '1', '需要在 dev 部署不含第 3 项的 yepairag 镜像并打开开关——改部署，需单独授权（E2E_B35_DEPLOYED=1）');
    test.skip(cfg.mainModel === cfg.routeModel, 'PREMIUM_LLM_MODEL 与 PREMIUM_LLM_MODEL_STABLE 取值相同，无法区分主回复');
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    for (const q of ['Do you ship to Australia?', 'What is your return policy?', 'Do you have gift cards?']) {
      const { conv } = await visitorRound(page, w, q);
      const round = await ensureYepairagPath(m.tenant, since, conv);
      expect(count(round, TEXT_RETIRED), `conversation_id=${conv} 这一轮应 text rail retired`).toBe(1);
    }
    const rows = await waitW23(m.tenant, since, (r) => r.some(byAlias(cfg.routeModel)));
    expect(rows.filter(byAlias(cfg.routeModel)).length).toBeGreaterThan(0);
    expect(rows.filter(byAlias(cfg.mainModel)).length).toBe(0);
    const rounds = Number(
      sql(
        'YEPAIRAG_DATABASE_URL',
        `SELECT count(DISTINCT e.invocation_id) AS n FROM ${CHAT_MEMORY_FROM}
         WHERE e.author = 'root_main_agent' AND NOT s.is_preview AND s.tenant_id::text = :'uid'
           AND e.timestamp >= (:'since'::timestamptz AT TIME ZONE 'UTC')`,
        { uid: m.tenant, since },
      )[0]?.n ?? 0,
    );
    const mainRows = rows.filter(byAlias(cfg.mainModel)).length;
    // 对账判定（Q21 口径）：主回复行数 < 轮数 → 漏计
    expect(rounds).toBe(3);
    expect(mainRows < rounds, `对账应判定「主回复漏计」：轮数 ${rounds}，主回复行 ${mainRows}`).toBe(true);
  });

  // B3-6 回归（R2 不改，BDD 第 5 版）：主 agent 直连 Gemini 时，格式错误的工具调用仍由直连 OpenAI 的重试兜住【故障注入，默认 skip】
  test('B3-6 R2 不改：注入 MALFORMED → 重试兜住、访客有回复、LiteLLM 侧查不到重试', async ({ browser }) => {
    test.skip(env('E2E_FAULT_INJECTION') !== 'before', '需要 dev 部署不含第 3 项的 yepairag 并设 GOOGLE_GEMINI_BASE_URL→mock 注入 MALFORMED_FUNCTION_CALL——改部署，需单独授权（E2E_FAULT_INJECTION=before）');
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    await visitorRound(page, w, 'Do you have this in size M?');
    const rag = logsSince('YEPAIRAG_LOGS', since);
    expect(rag).toContain('LLM error: FinishReason.MALFORMED_FUNCTION_CALL');
    expect(rag).not.toContain('retry failed');
    // 直连 OpenAI 的重试不经过 LiteLLM：该时间窗内 W23 不应出现 OpenAI 模型的行（主 agent 本身也直连 Gemini，不含第 3 项时应为 0 行主回复）
    await new Promise((r) => setTimeout(r, 90_000));
    expect(w23Rows(m.tenant, since).filter(byAlias(cfg.mainModel)), '不含第 3 项时主回复和重试都不应出现在 W23').toEqual([]);
  });

  // B3-7 零余额商家在开关打开后仍被 chatbot 余额闸门拦下，yepairag 不产生调用
  test('B3-7 零余额商家被 storefront-forward 闸门拦下', async ({ browser }) => {
    const m = merchant('ZERO', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const before = await aiBubbleCount(w);
    const res = await visitorSend(page, w, 'Do you ship to Australia?');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.subtype).toBe('visit_limits_reached');
    expect(String(body.errorMessage)).toMatch(/^INSUFFICIENT_CREDITS:/);
    expect(logsSince('CHATBOT_LOGS', since)).toContain('[Bill][gate] deny storefront-forward');
    await page.waitForTimeout(30_000);
    expect(await aiBubbleCount(w)).toBe(before);
    await expectNoW23(m.tenant, since);
  });

  // B3-8 知识问答（ADK 查知识库）在开关打开后能回答，并计入商家（含查询向量化，R5）
  test('B3-8 知识问答：依据 FAQ 回答，有主回复行和向量化行', async ({ browser }) => {
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
