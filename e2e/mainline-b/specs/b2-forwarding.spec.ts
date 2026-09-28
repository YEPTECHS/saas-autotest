// 改造后（无开关，09-28）。BDD 第 4 节（第 5 版）：第 2 项——知识库训练带 vkey + 过闸门（改）；线索意图 / 线索收集 / /async-response 放行回归。
// 实现（chatbot-api 94f6b9466）：手动训练 TrainFileSourceService.trainSources 先过 checkOrThrow(userId, "kb-train")；删除后自动重训不过闸门；
// 两者转发 /create 都带商家 vkey。yepairag 放行名单（PLATFORM_FALLBACK_ENTRIES）含 /activeLeads、/collect、/async-response：不带 vkey 用平台 vkey。
// B2-4 已在第 5 版删除（放行入口走平台出口，不用商家 rag vkey，「另开 digital-staff 钱包」的前提不存在）。
import { test, expect } from '@playwright/test';
import { merchant, requireWhitelistOnlyConcierge, requireEnv, env, nowIso, poll, cfg } from '../lib/config';
import { adminPage, visitor, visitorRound, balance, withCustomisation, kbAddManually, waitKbSynced, kbDeleteByText, openInboxConversation, marker } from '../lib/web';
import {
  logsSince, count, expectNoVkeyErrors, UNKNOWN_MODEL, waitW23, byAlias, overdraftRows, expectNoW23, LOG, gateDeny,
} from '../lib/backend';

/** 等 yepairag 日志里出现某个特征（90 秒 / 10 秒轮询）。 */
const waitLog = (since: string, re: RegExp) => poll(() => logsSince('YEPAIRAG_LOGS', since), (l) => re.test(l), 90_000, 10_000);

test.describe('改造后 第 2 项', () => {
  // B2-1 回归：线索意图（/activeLeads）改造后照常工作（放行名单，平台承担）
  test('B2-1 [BL-无（放行回归）→ 改造后] /activeLeads 照常工作，无 VkeyMissing / Unknown model', async ({ browser }) => {
    requireWhitelistOnlyConcierge();
    const pat = LOG.ACTIVE_LEADS;
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    await withCustomisation(admin, m.tenant, { enableLead: 'active', leadOnStart: 'no' }, async () => {
      const since = nowIso();
      const { page, w } = await visitor(browser, m); // 新 context = 没被提示过留资的新访客
      await visitorRound(page, w, 'What is your return policy?');
      expect(await waitLog(since, pat), '这一轮之后应有 /activeLeads 请求（回答里不能有商品）').toMatch(pat);
      expectNoVkeyErrors(since, [UNKNOWN_MODEL]);
    });
  });

  // B2-2 回归：线索收集（/collect）定时任务改造后照常工作（放行名单）【后端检查】
  test('B2-2 [BL-无（放行回归）→ 改造后] /collect 定时任务不报错（后端检查）', async () => {
    requireEnv('E2E_COLLECT_RUN_AT');
    const pat = LOG.COLLECT;
    const since = env('E2E_COLLECT_RUN_AT');
    const n = count(logsSince('YEPAIRAG_LOGS', since), pat);
    test.skip(n === 0, `自 ${since} 起没有 /collect 请求（需要 enableLead=passive 且近 12 小时有会话的商家；手动触发方法未确认，Q8）`);
    expectNoVkeyErrors(since, [UNKNOWN_MODEL]);
  });

  // B2-3 回归：/async-response 转发改造后不被拒（放行名单，接口级）
  test('B2-3 [BL-无（放行回归）→ 改造后] /async-response 转发不被拒（接口级）', async ({ request }) => {
    const pat = LOG.ASYNC_RESPONSE;
    const m = merchant('NEW', false);
    const since = nowIso();
    const res = await request.post(`${cfg.api}/chatbot/api/widget/conversations/proxy`, {
      data: { tenant_id: m.tenant, conversation_id: `e2e-b23-${Date.now()}`, type: 'text', content: 'hello', isPreview: false, agent_type: 'marketing', messages: [] },
    });
    expect(res.status(), await res.text()).toBeLessThan(300);
    expect(await waitLog(since, pat)).toMatch(pat);
    expectNoVkeyErrors(since);
  });

  // B2-5 知识库训练改造后正常完成并计入商家（POST /v1/sources/train/{userId} → yepairag /create）
  test('B2-5 [BL-3 → 改造后] 知识库训练完成，yepairag 收到 /create，向量化行计入商家', async ({ browser }) => {
    const pat = LOG.KB_CREATE;
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const q = `Do you offer gift wrapping? ${marker('b25')}`;
    const since = nowIso();
    const train = await kbAddManually(admin, m.tenant, q, 'Yes, for $5');
    expect((await train).status(), 'POST /v1/sources/train/{userId}').toBeLessThan(300);
    await waitKbSynced(admin, q);
    expect(await waitLog(since, pat), 'yepairag 应收到 /yepairag/create').toMatch(pat);
    expectNoVkeyErrors(since);
    const rows = await waitW23(m.tenant, since, (r) => r.some(byAlias(cfg.embeddingModel)));
    expect(rows.filter(byAlias(cfg.embeddingModel)).length).toBeGreaterThanOrEqual(1);
    await kbDeleteByText(admin, q);
  });

  // B2-6 零余额商家在各消费入口的表现（按 B 计划「余额闸门」一节）。线索意图行、预览行已在第 5 版删除（预览见 B10-1）
  test.describe('B2-6 零余额商家', () => {
    test('B2-6 [BL-3+BL-6 → 改造后] 零余额 知识库训练（手动）→ 被 kb-train 闸门拦下，无 W23 行', async ({ browser }) => {
      const m = merchant('ZERO');
      const admin = await adminPage(browser, m);
      expect(await balance(admin, m.tenant)).toBeLessThanOrEqual(0);
      const since = nowIso();
      const res = await (await kbAddManually(admin, m.tenant, `Zero balance FAQ ${marker('b26')}`, 'n/a'));
      expect(res.status(), '训练应被余额闸门拒绝（LimitExceededException）').toBeGreaterThanOrEqual(400);
      // checkOrThrow 的 message 前缀是 INSUFFICIENT_CREDITS / BALANCE_UNREADABLE；训练接口的错误体结构未实测，只要求出现错误码
      expect(await res.text()).toMatch(/INSUFFICIENT_CREDITS|VISIT_LIMITS_REACHED/);
      expect(count(logsSince('CHATBOT_LOGS', since), gateDeny('kb-train', m.tenant))).toBeGreaterThanOrEqual(1);
      await expectNoW23(m.tenant, since);
      expect(await balance(admin, m.tenant)).toBeLessThanOrEqual(0);
    });

    test('B2-6 [BL-2+BL-6 → 改造后] 零余额 会话摘要 → 被 human-support-summary 闸门拦下，无 W23 行', async ({ browser }) => {
      const gate = gateDeny('human-support-summary');
      const m = merchant('ZERO');
      // 零余额商家的店铺对话会被闸门拦下，Inbox 里的会话需提前准备
      requireEnv('E2E_ZERO_INBOX_MARKER');
      const admin = await adminPage(browser, m);
      const since = nowIso();
      await openInboxConversation(admin, env('E2E_ZERO_INBOX_MARKER'), 1);
      expect(count(logsSince('CHATBOT_LOGS', since), gate)).toBeGreaterThanOrEqual(1);
      await expectNoW23(m.tenant, since);
    });

    test('B2-6 [BL-3 → 改造后] 零余额 删除知识源后自动重训 → 例外不拦，照扣成负数（透支，status=posted）', async ({ browser }) => {
      const m = merchant('ZERO');
      // 零余额时无法新增知识源，需提前准备一条可删除的条目
      requireEnv('E2E_ZERO_KB_ITEM');
      const admin = await adminPage(browser, m);
      const since = nowIso();
      await kbDeleteByText(admin, env('E2E_ZERO_KB_ITEM'));
      await waitW23(m.tenant, since, (r) => r.length > 0);
      const rows = overdraftRows(m.tenant, since);
      test.info().annotations.push({ type: '透支 SQL 结果', description: JSON.stringify(rows) });
      expect(rows.length, '自动重训应照常扣费').toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.status).toBe('posted');
        expect(Number(r.overdraft_credits), '零余额：应有 block_id 为空的借方分录（透支）').toBeGreaterThan(0);
        expect(Number(r.charged_credits)).toBeCloseTo(Number(r.overdraft_credits) + Number(r.from_blocks_credits), 4);
      }
      expect(await balance(admin, m.tenant)).toBeLessThan(0);
    });

    test('B2-6 [BL-无（放行回归）→ 改造后] 零余额 线索收集 → 放行名单，平台承担，商家无新增行', async () => {
      requireEnv('E2E_ZERO_COLLECT_RUN_AT', 'E2E_ZERO_TENANT');
      const pat = LOG.COLLECT;
      const since = env('E2E_ZERO_COLLECT_RUN_AT');
      test.skip(count(logsSince('YEPAIRAG_LOGS', since), pat) === 0, '这段时间没有 /collect 请求（需要零余额且 enableLead=passive 的商家）');
      expectNoVkeyErrors(since, [UNKNOWN_MODEL]);
      await expectNoW23(env('E2E_ZERO_TENANT'), since);
    });
  });
});
