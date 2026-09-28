// BDD 第 6 节：第 4 项——换走 LiteLLM 后「关闭思考」仍然生效。
// Q13（PM 定，可被用户推翻）：判据 = 每轮 reasoning_tokens 必须为 0；10 轮平均耗时 ≤ 改造前基线 × 1.2。
import { test, expect } from '@playwright/test';
import { merchant, requireSwitch, requireWhitelistOnlyConcierge, requireEnv, env, nowIso, cfg } from '../lib/config';
import { visitor, visitorRound } from '../lib/web';
import { ensureYepairagPath, waitW23, w23Rows, byAlias, sql, logsSince, count, CHAT_MEMORY_FROM, unverifiedLogPattern } from '../lib/backend';

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

test.describe('第 4 项：关闭思考', () => {
  test.beforeEach(() => {
    requireSwitch('on');
    requireWhitelistOnlyConcierge();
  });

  // B4-1 开关打开后，店铺对话的思考 token 为 0（reasoning_tokens 取自 LiteLLM SpendLogs）
  test('B4-1 10 轮店铺对话，每条主回复行 reasoning_tokens = 0', async ({ browser }) => {
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
  test('B4-2 10 轮平均耗时 ≤ 基线 × 1.2', async ({ browser }) => {
    requireEnv('E2E_SWITCH_ON_AT');
    const base = avgRoundSeconds(
      `e.author = 'root_main_agent' AND e.timestamp >= (:'on'::timestamptz AT TIME ZONE 'UTC') - interval '30 days' AND e.timestamp < (:'on'::timestamptz AT TIME ZONE 'UTC')`,
      { on: env('E2E_SWITCH_ON_AT') },
    );
    test.skip(!base, '基线为空：开关打开前 30 天 chat_memory 里没有非预览的 root_main_agent 轮次（dev 流量少时需要先在开关关闭时跑一遍 10 轮攒基线）');
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    for (const q of QUESTIONS) await visitorRound(page, w, q);
    const now = avgRoundSeconds(`s.tenant_id::text = :'uid' AND e.timestamp >= (:'since'::timestamptz AT TIME ZONE 'UTC')`, { uid: m.tenant, since });
    expect(now, `本次 10 轮平均 ${now}s，基线 ${base}s`).toBeLessThanOrEqual(base * LATENCY_RATIO);
  });

  // B4-3 改造后，工具调用格式错误时仍能被识别并自动重试【故障注入，默认 skip】
  // 第 5 版：R2 不改 → 重试仍直连 OpenAI、不计商家；第 4 项只负责「识别」在走 LiteLLM 后仍生效
  test('B4-3 格式错误被识别为 OTHER 且无 function_call/文本 → 重试兜住；重试不经 LiteLLM（R2 不改）', async ({ browser }) => {
    test.skip(env('E2E_FAULT_INJECTION') !== 'after', '需要 dev LiteLLM 测试 alias + mock 返回 finish_reason="malformed_function_call"——改部署，需单独授权（E2E_FAULT_INJECTION=after）');
    const m = merchant('NEW', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { reply } = await visitorRound(page, w, 'Do you have this in size M?');
    expect(reply.length).toBeGreaterThan(0);
    // 新判断的日志文字要等实现定（Q12 余项）
    expect(count(logsSince('YEPAIRAG_LOGS', since), unverifiedLogPattern('MALFORMED_OTHER'))).toBeGreaterThanOrEqual(1);
    // 首轮主回复经 LiteLLM（mock alias）记 1 行；重试直连 OpenAI 不记。注入时 PREMIUM_LLM_MODEL 要设成那个测试 alias
    await new Promise((r) => setTimeout(r, 90_000));
    expect(w23Rows(m.tenant, since).filter(byAlias(cfg.mainModel)).length).toBe(1);
  });
});
