// 改造后（无开关，09-28）。BDD 第 8 节：第 6 项 + prod 发版。全部只读；每次运行都要人类授权（requireProdReadonly）。
// 无开关 = 发版即切换：B6-1 / B6-2 必须在 prod 发版前通过；B6-3（「发版后开关仍关闭，仍发 kind=text」）已删。
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { requireProdReadonly, requireEnv, env, cfg } from '../lib/config';
import { logsSince, count, RECORDED_ECOMMERCE, TEXT_SENT_ANY, TEXT_RETIRED, chatbotConfigValue, deploymentImage } from '../lib/backend';
import { expectCleanLogs } from '../lib/loki';

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

  // P-1 prod 发版后：部署版本含 yepairag 第 5、7、9 项（第 3、4 项 09-29 撤回，不上 prod），chatbot 含第 1、2、9、10 项；chatbot 没把 rag 头名覆盖成别的
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

  // P-2 prod 发版后：老店铺客服保持原样（用户 09-29，第 3、4 项不上 prod）——每条 ecommerce Recorded conversation 仍发 kind=text，不走 text rail retired
  test('P-2 [BL-1b → 改造后：老客服保持原样] prod 店铺对话照发 kind=text：kind=text 条数 ≥ Recorded ecommerce 条数，无 text rail retired', async () => {
    requireEnv('E2E_DEPLOYED_AT');
    const log = logsSince('YEPAIRAG_LOGS', env('E2E_DEPLOYED_AT'));
    const rec = count(log, RECORDED_ECOMMERCE);
    test.info().annotations.push({ type: 'Recorded ecommerce / kind=text', description: `${rec} / ${count(log, TEXT_SENT_ANY)}` });
    // 发送行在 JSON 日志里引号被转义（\"kind\": \"text\"），用 TEXT_SENT_ANY 两种写法都认（1.4.2 曾因只认不转义写法误报）
    expect(count(log, TEXT_SENT_ANY)).toBeGreaterThanOrEqual(rec);
    // send_text_usage 只有 /responseV3 调；它在老客服下永远走发送分支
    expect(count(log, TEXT_RETIRED)).toBe(0);
  });

  // P-3 prod 发版后 24 小时：日志干净（查 Loki，同 guard-vkey G-LOG；kubectl logs 会漏轮转前的日志），MCP 工具照常可用（成功率口径未定，Q16）
  test('P-3 [BL-9 → 改造后] 发版 24 小时（Loki）：无 vkey 报错且每小时有日志；MCP 成功率与发版前相当', async () => {
    test.setTimeout(10 * 60_000);
    requireEnv('E2E_DEPLOYED_AT');
    const since = env('E2E_DEPLOYED_AT');
    test.skip(Date.now() - Date.parse(since) < 24 * 3600_000, '发版未满 24 小时');
    await expectCleanLogs(new Date(since).toISOString(), new Date(Date.parse(since) + 24 * 3600_000).toISOString());
    test.skip(!env('E2E_MCP_SUCCESS_SQL'), 'MCP 工具成功率口径未定（Q16）：E2E_MCP_SUCCESS_SQL');
  });
});
