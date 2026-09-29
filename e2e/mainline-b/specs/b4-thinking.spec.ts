// 改造后。BDD 第 6 节：第 4 项「关闭思考」。
// 用户 09-29：老店铺客服下周下线，第 3、4 项不上 prod；yepairag 0e1380a5 撤回 36fc34b6，店铺 agent 恢复直连 Gemini + BuiltInPlanner(thinking_budget=0)，
// callback.py（路由判断、格式错误重试）恢复 c75314a1 直连写法。所以本文件断言「和改造前一样」：不经 LiteLLM、照发 kind=text、W23 无 rag vkey 行；
// SpendLogs 里看不到这条链路的 reasoning_tokens，原 B4-1「reasoning_tokens=0」改为逐轮核对走的是老链路。
// Q13：10 轮平均耗时 ≤ 改造前基线 × 1.2（B4-2 保留，作为「行为不变」的延迟守护）。
import { test, expect } from '@playwright/test';
import { merchant, requireWhitelistOnlyConcierge, requireEnv, env, nowIso, sleep } from '../lib/config';
import { visitor, visitorRound } from '../lib/web';
import { ensureYepairagPath, w23Rows, sql, logsSince, count, CHAT_MEMORY_FROM, isRagVkey, TEXT_SENT } from '../lib/backend';

const QUESTIONS = [
  'Do you ship to Australia?', 'What is your return policy?', 'Do you have gift cards?', 'How long does delivery take?', 'Can I change my order?',
  'Do you offer discounts?', 'Which payment methods do you accept?', 'Can I cancel my order?', 'Do you ship internationally?', 'How do I contact support?',
];
const LATENCY_RATIO = 1.2;

/** chat_memory 里每轮耗时（同一 invocation_id 下事件 timestamp 的首尾差）的平均值，排除预览。 */
function avgRoundSeconds(where: string, vars: Record<string, string>): number {
  const r = sql(
    'YEPAIRAG_DATABASE_URL',
    `SELECT avg(d) AS avg_s, count(*) AS n FROM (
       SELECT extract(epoch FROM max(e.timestamp) - min(e.timestamp)) AS d FROM ${CHAT_MEMORY_FROM}
       WHERE NOT s.is_preview AND ${where}
       GROUP BY e.invocation_id) x`,
    vars,
  )[0];
  return Number(r?.avg_s || 0);
}

test.describe('改造后 第 4 项：关闭思考（老客服保持原样）', () => {
  test.beforeEach(() => requireWhitelistOnlyConcierge());

  // B4-1 10 轮店铺对话都走老客服原链路（对照 BL-1b，逐轮核对；W23 断言在 10 轮后统一做一次）
  test('B4-1 [BL-1b → 改造后：老客服保持原样] 10 轮店铺对话：每轮 yepairag 有这一轮且发 1 条 kind=text，W23 无该商家 rag vkey 行', async ({ browser }) => {
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    for (const q of QUESTIONS) {
      const { reply, conv } = await visitorRound(page, w, q);
      expect(reply.length, q).toBeGreaterThan(0);
      const round = await ensureYepairagPath(m.tenant, since, conv);
      expect(count(round, TEXT_SENT), `conversation_id=${conv} 应发 1 条 kind=text`).toBe(1);
    }
    await sleep(90_000);
    expect(w23Rows(m.tenant, since).filter(isRagVkey), '老客服不走 LiteLLM：不应有该商家 rag vkey 的 W23 行').toEqual([]);
  });

  // B4-2 10 轮平均耗时 ≤ 改造前基线 × 1.2（两边都用 chat_memory 口径：同一 invocation_id 首尾差，排除预览）
  test('B4-2 [BL-1b → 改造后：老客服保持原样] 10 轮平均耗时 ≤ 部署前 30 天基线 × 1.2', async ({ browser }) => {
    requireEnv('E2E_DEPLOYED_AT');
    const base = avgRoundSeconds(
      `e.author = 'root_main_agent' AND e.timestamp >= (:'on'::timestamptz AT TIME ZONE 'UTC') - interval '30 days' AND e.timestamp < (:'on'::timestamptz AT TIME ZONE 'UTC')`,
      { on: env('E2E_DEPLOYED_AT') },
    );
    test.skip(!base, '基线为空：部署前 30 天 chat_memory 里没有非预览的 root_main_agent 轮次（dev 流量少时需要在部署前跑一遍 10 轮攒基线）');
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    for (const q of QUESTIONS) await visitorRound(page, w, q);
    const now = avgRoundSeconds(`s.tenant_id::text = :'uid' AND e.timestamp >= (:'since'::timestamptz AT TIME ZONE 'UTC')`, { uid: m.tenant, since });
    expect(now, `本次 10 轮平均 ${now}s，基线 ${base}s`).toBeLessThanOrEqual(base * LATENCY_RATIO);
  });

  // B4-3 回归：工具调用格式错误仍由改造前的重试兜住（callback.py 恢复 c75314a1：识别 MALFORMED_FUNCTION_CALL，重试直连、不经 LiteLLM）【故障注入，默认 skip】
  test('B4-3 [BL-1b → 改造后：老客服保持原样] 注入 MALFORMED_FUNCTION_CALL → 重试兜住有回复，W23 无该商家 rag vkey 行', async ({ browser }) => {
    test.skip(env('E2E_FAULT_INJECTION') !== 'legacy-storefront', '需要 dev yepairag 设 GOOGLE_GEMINI_BASE_URL→mock 注入 MALFORMED_FUNCTION_CALL——改部署，需单独授权（E2E_FAULT_INJECTION=legacy-storefront）');
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { reply } = await visitorRound(page, w, 'Do you have this in size M?');
    expect(reply.length).toBeGreaterThan(0);
    const log = logsSince('YEPAIRAG_LOGS', since);
    expect(log).toContain('LLM error: FinishReason.MALFORMED_FUNCTION_CALL');
    expect(log, '重试不应失败').not.toContain('retry failed');
    await sleep(90_000);
    expect(w23Rows(m.tenant, since).filter(isRagVkey), '首轮和重试都不经 LiteLLM').toEqual([]);
  });
});
