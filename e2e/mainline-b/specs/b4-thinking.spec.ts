// 改造后（无开关，09-28）。BDD 第 6 节：第 4 项——换走 LiteLLM 后「关闭思考」仍然生效。
// 实现（yepairag 36fc34b6）：主 agent reasoning_effort="none"（原 thinking_budget=0）；格式错误重试（callback.py）改走 LiteLLM + 本次请求商家 vkey、同一模型。
// Q13（PM 定，可被用户推翻）：判据 = 每轮 reasoning_tokens 必须为 0；10 轮平均耗时 ≤ 改造前基线 × 1.2。
import { test, expect } from '@playwright/test';
import { merchant, requireWhitelistOnlyConcierge, requireEnv, env, nowIso, cfg } from '../lib/config';
import { visitor, visitorRound } from '../lib/web';
import { ensureYepairagPath, waitW23, byAlias, sql, logsSince, count, CHAT_MEMORY_FROM, MALFORMED_LOG, isRagVkey } from '../lib/backend';

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

test.describe('改造后 第 4 项：关闭思考', () => {
  test.beforeEach(() => requireWhitelistOnlyConcierge());

  // B4-1 改造后，店铺对话的思考 token 为 0（reasoning_tokens 取自 LiteLLM SpendLogs）
  test('B4-1 [BL-1b → 改造后] 10 轮店铺对话，每条主回复行 reasoning_tokens = 0', async ({ browser }) => {
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    for (const q of QUESTIONS) {
      const { conv } = await visitorRound(page, w, q);
      await ensureYepairagPath(m.tenant, since, conv);
    }
    const rows = await waitW23(m.tenant, since, (r) => r.filter(byAlias(cfg.mainModel)).length >= QUESTIONS.length);
    const main = rows.filter(byAlias(cfg.mainModel));
    expect(main.length).toBeGreaterThanOrEqual(QUESTIONS.length);
    for (const r of main) expect(Number(r.reasoning_tokens || 0), `request ${r.litellm_request_id} 有思考 token`).toBe(0);
  });

  // B4-2 10 轮平均耗时 ≤ 改造前基线 × 1.2（两边都用 chat_memory 口径：同一 invocation_id 首尾差，排除预览）
  test('B4-2 [BL-1b → 改造后] 10 轮平均耗时 ≤ 部署前 30 天基线 × 1.2', async ({ browser }) => {
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

  // B4-3 改造后，工具调用格式错误时仍能被识别并自动重试【故障注入，默认 skip】
  // 设计（design.md 第 3 项「含 callback.py:785 出错重试」）+ 实现：重试也走 LiteLLM + 商家 vkey → 首轮 + 重试都记商家。
  // ⚠️ 与计划文档页头「R2 出错重试不改」、BDD 第 5 版 B4-3「重试不经 LiteLLM」冲突，这里按 design.md 与实现写，待 PM 确认。
  test('B4-3 [BL-1b → 改造后] 格式错误被识别（FinishReason.OTHER/MALFORMED）→ 重试兜住有回复；首轮 + 重试都经 LiteLLM 记商家（主回复行 ≥2）', async ({ browser }) => {
    test.skip(env('E2E_FAULT_INJECTION') !== 'after', '需要 dev LiteLLM 测试 alias + mock 返回 finish_reason="malformed_function_call"——改部署，需单独授权（E2E_FAULT_INJECTION=after）');
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { reply } = await visitorRound(page, w, 'Do you have this in size M?');
    expect(reply.length).toBeGreaterThan(0);
    const log = logsSince('YEPAIRAG_LOGS', since);
    expect(count(log, MALFORMED_LOG)).toBeGreaterThanOrEqual(1);
    expect(log, '重试不应失败').not.toContain('retry failed');
    // 注入时 PREMIUM_LLM_MODEL 要设成那个测试 alias；重试沿用缓存请求里的同一模型
    const rows = await waitW23(m.tenant, since, (r) => r.filter(byAlias(cfg.mainModel)).length >= 2);
    expect(rows.filter(byAlias(cfg.mainModel)).length, '首轮 + 重试各 1 行').toBeGreaterThanOrEqual(2);
    expect(rows.every(isRagVkey)).toBe(true);
  });
});
