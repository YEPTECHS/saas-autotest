// 改造后（无开关，09-28）。BDD 第 9 节：改造后代码部署 dev 后的整体验收。
// 用户 09-29：/responseV3 老店铺客服保持改造前原样（yepairag core/llm/legacy_storefront.py），店铺对话 / 知识问答 / 预览按「和改造前一样」断言。
import { test, expect } from '@playwright/test';
import { merchant, requireWhitelistOnlyConcierge, requireEnv, env, nowIso, sleep } from '../lib/config';
import { adminPage, visitor, visitorRound, previewSend, waitReplyAfter, openInboxConversation, marker } from '../lib/web';
import { logsSince, count, VKEY_ERRORS, UNKNOWN_MODEL, waitW23, w23Rows, isRagVkey, expectNoVkeyErrors, expectLegacyStorefrontRound } from '../lib/backend';

test.describe('改造后 dev 整体验收', () => {
  // D-1 dev 连续 24 小时日志干净
  test('D-1 [BL-无 → 改造后] 部署起 24 小时 yepairag 无 VkeyMissing / LiteLLMBaseMissing / Unknown model', async () => {
    requireEnv('E2E_DEPLOYED_AT');
    const since = env('E2E_DEPLOYED_AT');
    test.skip(Date.now() - Date.parse(since) < 24 * 3600_000, '部署未满 24 小时');
    const log = logsSince('YEPAIRAG_LOGS', since);
    for (const e of [...VKEY_ERRORS, UNKNOWN_MODEL]) expect(count(log, e), e).toBe(0);
  });

  // D-2 入口各跑一次。店铺对话 / 知识问答走 /responseV3 → 老客服保持原样（用户 09-29）；会话摘要维持改造后（记商家）。
  // ⚠️ 线索意图已判「不改、放行」（不记商家），这里不跑（BDD D-2 需同步，缺口）
  test('D-2 [BL-1b → 改造后：老客服保持原样 / BL-2 → 改造后] 店铺对话、知识问答照旧（kind=text、无 rag vkey 行）；会话摘要有 W23 记录', async ({ browser }) => {
    requireWhitelistOnlyConcierge();
    const m = merchant('NEW');
    const tag = marker('d2');
    let since = nowIso();
    const { page, w } = await visitor(browser, m);
    const shop = await visitorRound(page, w, `What is your return policy? ${tag}`);
    await expectLegacyStorefrontRound(m.tenant, since, shop.conv);

    since = nowIso();
    const kb = await visitorRound(page, w, 'Do you ship to Australia?');
    await expectLegacyStorefrontRound(m.tenant, since, kb.conv);

    const admin = await adminPage(browser, m);
    since = nowIso();
    const k = await openInboxConversation(admin, tag, 1);
    const sum = await waitW23(m.tenant, since, (r) => r.length >= k);
    expect(sum.length, '会话摘要').toBeGreaterThanOrEqual(k);
    test.info().annotations.push({ type: 'SQL-W23 结果（会话摘要）', description: JSON.stringify(sum) });
  });

  // D-3 余额 > 0 商家的后台 Anna 预览：chatbot 侧过 preview 闸门放行（第 10 项，改造后）；
  // 预览同样转 yepairag /responseV3 → 老客服保持原样（用户 09-29），不走 LiteLLM、W23 无该商家 rag vkey 行
  test('D-3 [BL-4 → 改造后：老客服保持原样] 余额 > 0 商家预览能回复（preview 闸门放行），W23 无该商家 rag vkey 行', async ({ browser }) => {
    requireWhitelistOnlyConcierge();
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const since = nowIso();
    const { frame, body, text } = await previewSend(admin, 'What is your return policy?');
    expect(body.isPreview).toBe(true);
    await waitReplyAfter(frame, text);
    expectNoVkeyErrors(since);
    await sleep(90_000);
    expect(w23Rows(m.tenant, since).filter(isRagVkey)).toEqual([]);
  });
});
