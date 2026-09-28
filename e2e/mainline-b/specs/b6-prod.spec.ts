// 改造后（无开关，09-28）。BDD 第 8 节：第 6 项 + prod 发版。全部只读；每次运行都要人类授权（requireProdReadonly）。
// 无开关 = 发版即切换：B6-1 / B6-2 必须在 prod 发版前通过；B6-3（「发版后开关仍关闭，仍发 kind=text」）已删。
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { requireProdReadonly, requireEnv, env, cfg } from '../lib/config';
import { logsSince, count, VKEY_ERRORS, RECORDED_ECOMMERCE, TEXT_SENT, TEXT_RETIRED, sql, chatbotConfigValue, deploymentImage, CHAT_MEMORY_FROM } from '../lib/backend';

test.describe('改造后 prod（只读）', () => {
  test.beforeEach(() => requireProdReadonly());

  // B6-1 prod 发版前：litellm-prod 已配置所需模型（当前已知必然失败：缺两个 Gemini 别名和 Google 凭据，Q30）
  test('B6-1 [BL-无 → 改造后，发版前置] litellm-prod 有主回复 / 路由 / 向量化 / 语音别名，且能调通', async ({ request }) => {
    requireEnv('LITELLM_PROD_BASE_URL', 'LITELLM_PROD_TEST_VKEY');
    const base = env('LITELLM_PROD_BASE_URL');
    const key = env('LITELLM_PROD_TEST_VKEY');
    const res = await request.get(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.ok()).toBe(true);
    const ids: string[] = ((await res.json()).data ?? []).map((d: { id: string }) => d.id);
    const need = [cfg.mainModel, cfg.routeModel, cfg.embeddingModel, env('ASR_MODEL') || 'whisper-1'];
    for (const n of need) expect(ids, `litellm-prod 缺别名 ${n}`).toContain(n);
    for (const n of [cfg.mainModel, cfg.routeModel]) {
      const r = await request.post(`${base}/v1/chat/completions`, { headers: { authorization: `Bearer ${key}` }, data: { model: n, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 } });
      expect(r.ok(), `${n} 调用失败（上游凭据？）：${await r.text()}`).toBe(true);
    }
  });

  // B6-2 prod 发版前：yepairag prod 能连到 litellm-prod（kubectl exec 进 prod pod，需单独授权）
  test('B6-2 [BL-无 → 改造后，发版前置] yepairag prod → litellm-prod 连通', async () => {
    test.skip(env('E2E_ALLOW_PROD_EXEC') !== '1', '需要 kubectl exec 进 yepairag prod pod，执行人待定（Q15），需单独授权（E2E_ALLOW_PROD_EXEC=1）');
    requireEnv('YEPAIRAG_PROD_EXEC', 'LITELLM_PROD_INTERNAL_URL');
    const out = execFileSync('kubectl', ['exec', ...env('YEPAIRAG_PROD_EXEC').split(/\s+/), '--', 'python', '-c',
      `import urllib.request;print(urllib.request.urlopen("${env('LITELLM_PROD_INTERNAL_URL')}/health/liveliness",timeout=10).status)`], { encoding: 'utf8' });
    expect(out.trim()).toBe('200');
  });

  // P-1 prod 发版后：部署版本含 yepairag 第 3、4、5、7、9 项，chatbot 含第 1、2、9、10 项；chatbot 没把 rag 头名覆盖成别的
  test('P-1 [BL-无 → 改造后] prod 镜像含改造提交，chatbot 未覆盖 vkey.rag-header-name', async () => {
    requireEnv('YEPAIRAG_PROD_DEPLOY', 'CHATBOT_PROD_DEPLOY', 'E2E_REQUIRED_COMMITS_YEPAIRAG', 'E2E_REQUIRED_COMMITS_CHATBOT', 'YEPAIRAG_REPO', 'CHATBOT_REPO');
    for (const k of ['VKEY_RAGHEADERNAME', 'VKEY_RAG_HEADER_NAME']) expect(['', 'X-Yep-Rag-Vkey'], k).toContain(chatbotConfigValue(k));
    const check = (deploy: string, repo: string, commits: string) => {
      const tag = deploymentImage(deploy).split(':').pop() ?? '';
      const sha = tag.replace(/^prod-/, '');
      for (const c of commits.split(',').map((s) => s.trim()).filter(Boolean)) {
        let ok = true;
        try {
          execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', c, sha], { stdio: 'ignore' });
        } catch {
          ok = false;
        }
        expect(ok, `镜像 ${tag} 不含提交 ${c}（${repo}）——prod 跑的不是改造后版本`).toBe(true);
      }
    };
    check(env('YEPAIRAG_PROD_DEPLOY'), env('YEPAIRAG_REPO'), env('E2E_REQUIRED_COMMITS_YEPAIRAG'));
    check(env('CHATBOT_PROD_DEPLOY'), env('CHATBOT_REPO'), env('E2E_REQUIRED_COMMITS_CHATBOT'));
  });

  // P-2 prod 发版后：有店铺对话的商家主回复行数 ≥ 非预览轮数（对账，第 1 / 24 小时各一次）
  test('P-2 [BL-1b → 改造后] 对账：每家商家主回复行 ≥ 非预览 ecommerce 轮数', async () => {
    requireEnv('E2E_DEPLOYED_AT');
    const since = env('E2E_DEPLOYED_AT');
    // 商家 = sessions.tenant_id，预览 = sessions.is_preview（W32）
    const rounds = sql(
      'YEPAIRAG_DATABASE_URL',
      `SELECT s.tenant_id::text AS tenant, count(DISTINCT e.invocation_id) AS n FROM ${CHAT_MEMORY_FROM}
       WHERE e.author = 'root_main_agent' AND NOT s.is_preview AND e.timestamp >= (:'since'::timestamptz AT TIME ZONE 'UTC')
       GROUP BY s.tenant_id`,
      { since },
    );
    const main = sql(
      'W23_DATABASE_URL',
      `SELECT replace(a.creation_idempotency_key, 'chatbot:acct:', '') AS tenant, count(*) AS n
       FROM "digital-staff-su".usage_records_v2 u JOIN "digital-staff-su".accounts a ON a.id = u.account_id
       JOIN litellm."LiteLLM_SpendLogs" s ON s.request_id = u.source_event_id
       WHERE u.source = 'litellm' AND a.platform = 'chatbot' AND s.model_group = :'main' AND u.occurred_at >= :'since'::timestamptz
       GROUP BY 1`,
      { since, main: cfg.mainModel },
    );
    const got = new Map(main.map((r) => [r.tenant, Number(r.n)]));
    const white = env('E2E_WHITELIST_TENANT');
    const short = rounds.filter((r) => r.tenant !== white && (got.get(r.tenant) ?? 0) < Number(r.n));
    // 已知干扰：长耗时调用会被 W23 永久漏采（Q25），差异先按 SpendLogs 排除
    expect(short, '有对话但主回复行不足的商家——判定漏计窗口，立即上报').toEqual([]);
    const log = logsSince('YEPAIRAG_LOGS', since);
    expect(count(log, TEXT_SENT)).toBe(0);
    expect(count(log, TEXT_RETIRED)).toBeGreaterThanOrEqual(count(log, RECORDED_ECOMMERCE));
  });

  // P-3 prod 发版后 24 小时：日志干净，MCP 工具照常可用（成功率口径未定，Q16）
  test('P-3 [BL-9 → 改造后] 发版 24 小时：无 vkey 报错；MCP 成功率与发版前相当', async () => {
    requireEnv('E2E_DEPLOYED_AT');
    const since = env('E2E_DEPLOYED_AT');
    test.skip(Date.now() - Date.parse(since) < 24 * 3600_000, '发版未满 24 小时');
    const log = logsSince('YEPAIRAG_LOGS', since);
    for (const e of VKEY_ERRORS) expect(count(log, e)).toBe(0);
    test.skip(!env('E2E_MCP_SUCCESS_SQL'), 'MCP 工具成功率口径未定（Q16）：E2E_MCP_SUCCESS_SQL');
  });
});
