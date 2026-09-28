// 改造后（无开关，09-28）。BDD 第 10 节：第 7 项——临时放行名单（MCP、选品报告、货源信号、商品工具，以及 E2E可写性判定里「不改」的 /activeLeads、/collect、/async-response）。
// 放行名单集中在 yepairag core/llm/vkey_context.py PLATFORM_FALLBACK_ENTRIES：不带 vkey 用平台 vkey；其余入口没有 vkey 一律 VkeyMissing。
// B7-2 请求体、集群内地址、判据按 W32-round3-logs-B7.txt；Q18（PM 定）：放行入口带 vkey 也走平台。
import { test, expect } from '@playwright/test';
import { merchant, requireEnv, env, nowIso, sleep } from '../lib/config';
import { adminPage, staffChatSend, waitPageGrows } from '../lib/web';
import { logsSince, count, expectNoVkeyErrors, w23Rows, isRagVkey, waitW23, unverifiedLogPattern, mcpAccess, LOG } from '../lib/backend';

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

  // B7-3 其余入口没有 vkey 时必须被拒，且不连累同一会话的后续消息
  test('B7-3 [BL-无（改造后新增拒绝）→ 改造后] /responseV3 无 vkey → 500 + VkeyMissing；30 秒内同会话带 vkey 正常', async ({ request }) => {
    // /responseV3 的请求体 W32 没给（缺口），同会话后续消息被跳过时的日志文字由实现决定
    requireEnv('E2E_RESPONSEV3_BODY', 'E2E_NEW_MERCHANT_VKEY');
    const busy = unverifiedLogPattern('ALREADY_PROCESSING');
    const conv = `e2e-b73-${Date.now()}`;
    const body = { ...jsonEnv('E2E_RESPONSEV3_BODY'), conversation_id: conv, session_id: conv };
    const since = nowIso();
    const bad = await request.post(`${yep()}/yepairag/responseV3`, { data: body });
    expect(bad.status()).toBe(500);
    expect(await bad.text()).toBe('Internal Server Error');
    expect(count(logsSince('YEPAIRAG_LOGS', since), 'VkeyMissing')).toBeGreaterThanOrEqual(1);
    const ok = await request.post(`${yep()}/yepairag/responseV3`, { data: body, headers: { 'X-Yep-Rag-Vkey': env('E2E_NEW_MERCHANT_VKEY') } });
    expect(ok.status(), await ok.text()).toBeLessThan(300);
    expect(count(logsSince('YEPAIRAG_LOGS', since), busy), '同会话后续消息不应被 is_processing 卡住跳过').toBe(0);
  });

  // B7-4 放行只认入口，不能被其他入口借用
  test('B7-4 [BL-无（改造后新增拒绝）→ 改造后] 非放行入口带 MCP 请求特征、不带 vkey → 仍被拒', async ({ request }) => {
    // 「MCP 请求特征」指哪些请求头没有定义（缺口）
    requireEnv('E2E_RESPONSEV3_BODY', 'E2E_MCP_LIKE_HEADERS');
    const since = nowIso();
    const res = await request.post(`${yep()}/yepairag/responseV3`, { data: jsonEnv('E2E_RESPONSEV3_BODY'), headers: jsonEnv('E2E_MCP_LIKE_HEADERS') });
    expect(res.status()).toBe(500);
    expect(count(logsSince('YEPAIRAG_LOGS', since), 'VkeyMissing')).toBeGreaterThanOrEqual(1);
  });

  // B7-5 放行入口带上了有效商家 vkey 时，仍走平台出口、不记商家（Q18，PM 定）
  // ⚠️ 与实现冲突：yepairag vkey_context._vkey_for「商家 vkey 有就用商家的」（0c695a44 提交说明：带了商家 vkey 用商家的）→ 按现实现本条会失败。
  //   断言保留 Q18 口径不改，等 PM 决定改实现还是改 Q18。
  test('B7-5 [BL-11 → 改造后] /tools/product 带商家 vkey → 结果非空，不记商家（Q18；与现实现冲突，见注释）', async ({ request }) => {
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
    await sleep(90_000);
    expect(w23Rows(m.tenant, since), '放行入口走平台出口，不应记到商家').toEqual([]);
  });
});
