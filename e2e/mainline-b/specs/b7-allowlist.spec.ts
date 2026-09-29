// 改造后（无开关，09-28）。BDD 第 10 节：第 7 项——临时放行名单（MCP、选品报告、货源信号、商品工具，以及 E2E可写性判定里「不改」的 /activeLeads、/collect、/async-response）。
// 放行名单集中在 yepairag core/llm/vkey_context.py PLATFORM_FALLBACK_ENTRIES：不带 vkey 用平台 vkey；其余入口没有 vkey 一律 VkeyMissing。
// 例外（用户 09-29）：/responseV3 老店铺客服整条保持改造前原样（core/llm/legacy_storefront.py），不需要 vkey。
// B7-2 请求体、集群内地址、判据按 W32-round3-logs-B7.txt；Q18 作废——PM 09-28 按实现改口径：放行入口带 vkey 记商家，不带走平台。
import { test, expect } from '@playwright/test';
import { merchant, requireEnv, env, nowIso } from '../lib/config';
import { adminPage, staffChatSend, waitPageGrows } from '../lib/web';
import { logsSince, count, expectNoVkeyErrors, isRagVkey, waitW23, mcpAccess, LOG } from '../lib/backend';

// 集群内地址（老 dev）；本机跑要 kubectl port-forward 后改成 http://localhost:<port>
const yep = () => env('YEPAIRAG_BASE_URL') || 'http://yepairag-dev.llm:8080';
const jsonEnv = (k: string) => JSON.parse(env(k));

test.describe('改造后 第 7 项：临时放行', () => {
  // B7-1 回归：AI 员工调用 yepairag MCP 工具照常工作（不包括发帖）
  test('B7-1 [BL-9 → 改造后] Maya 查知识库（MCP 工具，平台 vkey）照常工作，不新增商家 rag vkey 行', async ({ browser }) => {
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const since = nowIso();
    const before = await staffChatSend(admin, '/ai-team/marketing/studio', 'Summarize our shipping policy from the knowledge base');
    await waitPageGrows(admin, before);
    // MCP access 日志路径里带商家：POST /yepairag/mcp/<server>/<tenantId>/mcp?agent=<agent>
    const log = logsSince('YEPAIRAG_LOGS', since);
    expect(count(log, mcpAccess(m.tenant)), '应能在 yepairag 日志看到该商家的 MCP 工具调用').toBeGreaterThanOrEqual(1);
    expectNoVkeyErrors(since);
    const rows = await waitW23(m.tenant, since, (r) => r.length > 0, false);
    expect(rows.filter(isRagVkey), 'MCP 工具内部调用走平台，不应有 rag vkey 行（Maya 自己的调用照常 2 行）').toEqual([]);
  });

  // B7-2 临时放行的非 MCP 入口改造后正常返回结果（接口级，不带 vkey）
  // W32：缺 vkey 时这些入口会被吞成降级 / 空结果而不是 500，所以按业务结果判，并检查日志里没有被吞掉的 VkeyMissing 正文
  const cases: { path: string; body: (t: string) => object; check: (status: number, j: Record<string, unknown>) => void }[] = [
    { path: '/operation/selection-report', body: () => ({ keywords: ['yoga mat'] }), check: (st) => expect(st, '503 scan_unavailable = 排序阶段调模型失败').toBe(200) },
    {
      path: '/operation/sourcing-signals',
      body: (t) => ({ tenant_id: t, keywords: ['yoga mat'], market: 'AU' }),
      check: (st, j) => {
        expect(st).toBe(200);
        expect(j.status, 'degraded = LLM 步骤失败后降级').not.toBe('degraded');
      },
    },
    {
      path: '/tools/product',
      body: (t) => ({ tenant_id: t, query: 'yoga mat' }),
      check: (st, j) => {
        expect(st).toBe(200);
        expect((j.Product_information as unknown[] | undefined)?.length ?? 0, '空列表 = embedding 失败被吞（测试商家须在 ShopifySync 里有商品）').toBeGreaterThan(0);
      },
    },
    // 纯回归：这个入口不调模型、不经过计量出口
    { path: '/tools/collection', body: (t) => ({ tenant_id: t }), check: (st) => expect(st).toBe(200) },
  ];
  for (const c of cases) {
    test(`B7-2 [BL-11 → 改造后] 放行入口 ${c.path} 不带 vkey 返回业务结果，无 VkeyMissing`, async ({ request }) => {
      const m = merchant('NEW', false);
      const since = nowIso();
      const res = await request.post(`${yep()}/yepairag${c.path}`, { data: c.body(m.tenant), timeout: 200_000 });
      const j = await res.json().catch(() => ({}));
      c.check(res.status(), j);
      const log = expectNoVkeyErrors(since);
      expect(count(log, LOG.SELECTION_RANK_FAILED)).toBe(0);
      expect(count(log, LOG.SOURCING_FAILED)).toBe(0);
    });
  }

  // B7-3 /responseV3 不带 vkey：老店铺客服保持改造前原样（用户 09-29；legacy_storefront 依赖只挂在 /responseV3），不 fail-closed
  test('B7-3 [BL-1b → 改造后：老客服保持原样] /responseV3 不带 vkey → 照常处理（<300），无 VkeyMissing', async ({ request }) => {
    // /responseV3 的请求体 W32 没给（缺口）
    requireEnv('E2E_RESPONSEV3_BODY');
    const conv = `e2e-b73-${Date.now()}`;
    const since = nowIso();
    const res = await request.post(`${yep()}/yepairag/responseV3`, { data: { ...jsonEnv('E2E_RESPONSEV3_BODY'), conversation_id: conv, session_id: conv } });
    expect(res.status(), await res.text()).toBeLessThan(300);
    expectNoVkeyErrors(since);
  });

  // B7-4 放行只认入口，不能被其他入口借用。原来拿 /responseV3 当「非放行入口」，09-29 后它不再要求 vkey，靶子失效。
  // ⚠️ 待 PM 定：换哪个「非放行、会调模型、可直调」的入口当靶子（候选：/yepairag/create、会话摘要路由），以及「MCP 请求特征」指哪些请求头。
  test.fixme('B7-4 [BL-无（改造后新增拒绝）→ 改造后] 非放行入口带 MCP 请求特征、不带 vkey → 仍被拒（靶子入口待 PM 定）', async () => {});

  // B7-5 放行入口带上了有效商家 vkey 时记给该商家（yepairag vkey_context._vkey_for：商家 vkey 优先，不带才用平台 vkey）
  // PM 09-28 按实现改口径：带 vkey 记商家（Q18「带 vkey 也走平台」作废）
  test('B7-5 [BL-11 → 改造后] /tools/product 带商家 vkey → 结果非空，W23 有该商家 rag vkey 行（商品查询向量化）', async ({ request }) => {
    requireEnv('E2E_NEW_MERCHANT_VKEY');
    const m = merchant('NEW', false);
    const since = nowIso();
    const res = await request.post(`${yep()}/yepairag/tools/product`, {
      data: { tenant_id: m.tenant, query: 'yoga mat' },
      headers: { 'X-Yep-Rag-Vkey': env('E2E_NEW_MERCHANT_VKEY') },
    });
    expect(res.status()).toBe(200);
    expect(((await res.json()).Product_information ?? []).length).toBeGreaterThan(0);
    expectNoVkeyErrors(since);
    const rows = await waitW23(m.tenant, since, (r) => r.some(isRagVkey));
    test.info().annotations.push({ type: 'SQL-W23 结果', description: JSON.stringify(rows) });
    expect(rows.filter(isRagVkey).length, '带商家 vkey：应记到该商家').toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.merchant_account_key === `chatbot:acct:${m.tenant}`)).toBe(true);
  });
});
