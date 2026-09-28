// BDD 第 3 节：第 1 项——chatbot 发给 yepairag 的 vkey 请求头名字统一为 X-Yep-Rag-Vkey。
import { test, expect } from '@playwright/test';
import { merchant, requireSwitch, requireWhitelistOnlyConcierge, requireEnv, env, nowIso } from '../lib/config';
import { adminPage, visitor, visitorRound, balance, waitBalance, openInboxConversation, marker, waitFor } from '../lib/web';
import {
  chatbotConfigValue, logsSince, count, ensureYepairagPath, waitW23, isRagVkey, rowsPerRequest, expectNoVkeyErrors, sumCredits, byAlias, LOG,
} from '../lib/backend';
import { cfg } from '../lib/config';

test.describe('第 1 项：vkey 请求头名字', () => {
  // B1-1 打开开关前：chatbot 配置的 vkey 请求头名字与 yepairag 一致（配置核对；PM 定不在 dev 复现不一致，Q2）
  test('B1-1 chatbot VKEY_HEADER_NAME = X-Yep-Rag-Vkey，开关打开后无 "no rag vkey" 报错', async () => {
    expect(chatbotConfigValue('VKEY_HEADER_NAME'), '任一不满足：不得打开开关').toBe('X-Yep-Rag-Vkey');
    if (env('E2E_METERING_SWITCH') === 'on') {
      requireEnv('E2E_SWITCH_ON_AT');
      const log = logsSince('YEPAIRAG_LOGS', env('E2E_SWITCH_ON_AT'));
      expect(count(log, 'no rag vkey in request context')).toBe(0);
    }
  });

  test.describe('开关打开', () => {
    test.beforeEach(() => requireSwitch('on'));

    // B1-2 开关打开后，店铺对话正常且计入商家（正向对照）
    test('B1-2 店铺对话正常且计入商家', async ({ browser }) => {
      requireWhitelistOnlyConcierge();
      const m = merchant('NEW');
      const admin = await adminPage(browser, m);
      const A = await balance(admin, m.tenant);
      const since = nowIso();
      const { page, w } = await visitor(browser, m);
      const { conv } = await visitorRound(page, w, 'Do you ship to Australia?');
      await ensureYepairagPath(m.tenant, since, conv);
      const rows = await waitW23(m.tenant, since, (r) => r.some(isRagVkey));
      test.info().annotations.push({ type: 'SQL-W23 结果', description: JSON.stringify(rows) });
      expect(rows.filter(isRagVkey).length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.merchant_account_key === `chatbot:acct:${m.tenant}`)).toBe(true);
      expect(await waitBalance(admin, m.tenant, (v) => v < A)).toBeLessThan(A);
      expectNoVkeyErrors(since);
    });

    // B1-3 开关打开后，商家在 Inbox 打开会话时的会话摘要计入商家（每打开一次生成一次、计费一次，Q27）
    test('B1-3 Inbox 打开会话 2 次 → 摘要调用 k 次，W23 行数 = k，余额减少 = k 行 credits 之和', async ({ browser }) => {
      requireWhitelistOnlyConcierge();
      const m = merchant('NEW');
      const tag = marker('b13');
      const { page, w } = await visitor(browser, m);
      await visitorRound(page, w, `Do you ship to Australia? ${tag}`);
      const admin = await adminPage(browser, m);
      await new Promise((r) => setTimeout(r, 90_000)); // 等这轮对话本身的 W23 记录采完，避免混进摘要时间窗
      const A = await balance(admin, m.tenant);
      const since = nowIso();
      const k = await openInboxConversation(admin, tag, 2);
      expect(k, 'Inbox 前端打开一次发几个请求未确认（Q27 余项），这里按实际次数 k 断言').toBeGreaterThanOrEqual(2);
      // 摘要调用走 UnifiedLLM；时间窗内只有摘要，排除向量化行
      const notEmbedding = (r: Record<string, string>) => !byAlias(cfg.embeddingModel)(r);
      const rows = await waitW23(m.tenant, since, (r) => r.filter(notEmbedding).length >= k);
      expect(rows.filter(notEmbedding).length, '每次 GET …/human/summary 对应 1 行（yepairag 侧若有缓存按 Q27 修正）').toBe(k);
      expect(rowsPerRequest(rows).every((n) => n === 1)).toBe(true);
      const B = await waitBalance(admin, m.tenant, (v) => v < A);
      expect(A - B).toBeCloseTo(sumCredits(rows), 2);
      expectNoVkeyErrors(since);
    });

    // B1-4 回归：原本就用 X-Yep-Rag-Vkey 的政策同步，改配置后仍然计入商家
    test('B1-4 政策同步（打开后台首页触发）→ 向量化行数 = 写入 entry 数', async ({ browser }) => {
      test.skip(env('E2E_POLICY_SYNC_READY') !== '1', '需要已授 read_legal_policies 且 7 天内没同步过的商家（Q7 余项：怎么绕过 7 天限制未定）');
      const sync = LOG.POLICY_SYNC;
      const m = merchant('NEW');
      const since = nowIso();
      const admin = await adminPage(browser, m);
      const scope = waitFor(admin.waitForRequest((r) => r.url().includes('/integration/shopify/scope-upgrade-url'), { timeout: 60_000 }), '打开后台首页发出 /integration/shopify/scope-upgrade-url（政策同步触发点）');
      await admin.goto(`${cfg.base}/`, { waitUntil: 'domcontentloaded' });
      await scope;
      const log = await (async () => {
        for (let i = 0; i < 9; i++) {
          const l = logsSince('YEPAIRAG_LOGS', since);
          if (sync.test(l)) return l;
          await new Promise((r) => setTimeout(r, 10_000));
        }
        return logsSince('YEPAIRAG_LOGS', since);
      })();
      expect(log, 'yepairag 日志应有这次 policies/sync 请求').toMatch(sync);
      expectNoVkeyErrors(since);
      const rows = await waitW23(m.tenant, since, (r) => r.some(byAlias(cfg.embeddingModel)));
      // ⚠️ 本次写入的 entry 数从哪读没有确认（日志 / 接口），先断言至少 1 行，并把实际行数写进报告
      test.info().annotations.push({ type: '向量化行数（需与写入 entry 数比对）', description: String(rows.filter(byAlias(cfg.embeddingModel)).length) });
      expect(rows.filter(byAlias(cfg.embeddingModel)).length).toBeGreaterThanOrEqual(1);
    });
  });
});
