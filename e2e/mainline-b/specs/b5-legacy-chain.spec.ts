// 改造后（无开关，09-28）。BDD 第 7 节：第 5 项——走 UnifiedLLM（llama_index）的老链路不因模型名报错（yepairag 0c695a44：改用 LiteLLMOpenAI）。
import { test, expect } from '@playwright/test';
import { merchant, requireWhitelistOnlyConcierge, nowIso, cfg, sleep } from '../lib/config';
import { adminPage, visitor, visitorRound, expandWidget, waitAiReply, openInboxConversation, marker } from '../lib/web';
import { waitW23, byAlias, expectNoVkeyErrors, UNKNOWN_MODEL } from '../lib/backend';

test.describe('改造后 第 5 项：llama_index 老链路', () => {
  test.beforeEach(() => requireWhitelistOnlyConcierge());

  // B5-1 非文字事件（greeting）改造后能正常回复，并计入商家
  // 触发（W3 round2 Q14）：新浏览器上下文、挂件默认收起，本次页面加载后第一次展开 → type=greeting
  test('B5-1 [BL-10 → 改造后] 首次展开挂件发 greeting → 欢迎语，无 Unknown model，W23 该商家 ≥2 行', async ({ browser }) => {
    const m = merchant('NEW', false);
    const since = nowIso();
    const { w } = await visitor(browser, m, { expand: false });
    await expandWidget(w);
    await expect.poll(() => w.proxyCalls.length, { timeout: 30_000, message: '展开挂件没有发出 conversations/proxy' }).toBeGreaterThan(0);
    const greet = w.proxyCalls.find((r) => (r.postDataJSON() ?? {}).type === 'greeting');
    expect(greet, '应有一条 type=greeting 的请求（若后台 widgetStatus=open，会在页面加载时就发）').toBeTruthy();
    await waitAiReply(w, 0);
    expectNoVkeyErrors(since, [UNKNOWN_MODEL]);
    const rows = await waitW23(m.tenant, since, (r) => r.length >= 2);
    expect(rows.length, 'greeting 预期 2 次调用：achat + suggest_questions').toBeGreaterThanOrEqual(2);
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

  // B5-4 非 Shopify 租户的店铺文字对话改造后能回复
  test('B5-4 [BL-无（dev 无非 Shopify 基线）→ 改造后] 非 Shopify 商家文字对话能回复并计入商家', async ({ browser }) => {
    const m = merchant('NONSHOPIFY', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    await visitorRound(page, w, 'What is your return policy?');
    expectNoVkeyErrors(since, [UNKNOWN_MODEL]);
    const rows = await waitW23(m.tenant, since, (r) => r.length > 0);
    expect(rows.length).toBeGreaterThan(0);
  });
});
