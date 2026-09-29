// 改造后（无开关，09-28）。BDD 第 7 节：第 5 项——走 UnifiedLLM（llama_index）的老链路不因模型名报错（yepairag 0c695a44：改用 LiteLLMOpenAI）。
// 用户 09-29：/responseV3（店铺文字对话 + greeting 等非文字事件）整条保持改造前原样（legacy_storefront.LegacyUnifiedLLM），B5-1 / B5-4 断言「和改造前一样」；
// 会话摘要不走 /responseV3，B5-3 维持改造后。
import { test, expect } from '@playwright/test';
import { merchant, requireWhitelistOnlyConcierge, nowIso, cfg, sleep } from '../lib/config';
import { adminPage, visitor, visitorRound, expandWidget, waitAiReply, openInboxConversation, marker } from '../lib/web';
import { waitW23, w23Rows, isRagVkey, byAlias, expectNoVkeyErrors, UNKNOWN_MODEL, expectLegacyStorefrontRound, logsSince, yepairagTaskLog } from '../lib/backend';

test.describe('改造后 第 5 项：llama_index 老链路', () => {
  test.beforeEach(() => requireWhitelistOnlyConcierge());

  // B5-1 非文字事件（greeting）经 /responseV3 → 老客服保持原样（对照 BL-10）
  // 触发（W3 round2 Q14）：新浏览器上下文、挂件默认收起，本次页面加载后第一次展开 → type=greeting
  test('B5-1 [BL-10 → 改造后：老客服保持原样] 首次展开挂件发 greeting → 欢迎语，yepairag 走 UnifiedLLM 老写法，无 Unknown model，W23 无该商家 rag vkey 行', async ({ browser }) => {
    const m = merchant('NEW', false);
    const since = nowIso();
    const { w } = await visitor(browser, m, { expand: false });
    await expandWidget(w);
    await expect.poll(() => w.proxyCalls.length, { timeout: 30_000, message: '展开挂件没有发出 conversations/proxy' }).toBeGreaterThan(0);
    const greet = w.proxyCalls.find((r) => (r.postDataJSON() ?? {}).type === 'greeting');
    expect(greet, '应有一条 type=greeting 的请求（若后台 widgetStatus=open，会在页面加载时就发）').toBeTruthy();
    const conv = String((greet!.postDataJSON() ?? {}).conversation_id ?? '');
    await waitAiReply(w, 0);
    // BL-10 口径：同一 taskName 下有带本轮 conversationId 的 payload 和 Initializing LLM with provider（LegacyUnifiedLLM 原样打这行）
    const round = yepairagTaskLog(logsSince('YEPAIRAG_LOGS', since), `'conversationId': '${conv}'`);
    expect(round, `yepairag 日志里应有 conversationId=${conv} 的 greeting 处理`).toBeTruthy();
    expect(round!).toContain('Initializing LLM with provider');
    expectNoVkeyErrors(since, [UNKNOWN_MODEL]);
    await sleep(90_000);
    expect(w23Rows(m.tenant, since).filter(isRagVkey), '老客服不走 LiteLLM：不应有该商家 rag vkey 的 W23 行').toEqual([]);
  });

  // B5-3 会话摘要（UnifiedLLM）改造后成功（每打开一次生成一次，Q27）
  test('B5-3 [BL-2 → 改造后] Inbox 打开会话 1 次 → 摘要调用 k 次，无模型名报错，W23 行数 = k', async ({ browser }) => {
    const m = merchant('NEW');
    const tag = marker('b53');
    const { page, w } = await visitor(browser, m);
    await visitorRound(page, w, `What is your return policy? ${tag}`);
    await sleep(90_000);
    const admin = await adminPage(browser, m);
    const since = nowIso();
    const k = await openInboxConversation(admin, tag, 1);
    expectNoVkeyErrors(since, [UNKNOWN_MODEL]);
    const notEmb = (r: Record<string, string>) => !byAlias(cfg.embeddingModel)(r);
    const rows = await waitW23(m.tenant, since, (r) => r.filter(notEmb).length >= k);
    expect(rows.filter(notEmb).length).toBe(k);
  });

  // B5-4 非 Shopify 租户的店铺文字对话同样走 /responseV3 → 老客服保持原样
  test('B5-4 [BL-1b → 改造后：老客服保持原样] 非 Shopify 商家文字对话有回复，发 kind=text，W23 无该商家 rag vkey 行', async ({ browser }) => {
    const m = merchant('NONSHOPIFY', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { reply, conv } = await visitorRound(page, w, 'What is your return policy?');
    expect(reply.length).toBeGreaterThan(0);
    await expectLegacyStorefrontRound(m.tenant, since, conv);
    expectNoVkeyErrors(since, [UNKNOWN_MODEL]);
  });
});
