// BDD 第 9 节：dev 打开开关后的整体验收。
import { test, expect } from '@playwright/test';
import { merchant, requireSwitch, requireWhitelistOnlyConcierge, requireEnv, env, nowIso, cfg, sleep } from '../lib/config';
import { adminPage, visitor, visitorRound, previewSend, waitReplyAfter, openInboxConversation, marker } from '../lib/web';
import { logsSince, count, VKEY_ERRORS, UNKNOWN_MODEL, ensureYepairagPath, waitW23, byAlias, expectNoVkeyErrors } from '../lib/backend';

test.describe('dev 开关打开：整体验收', () => {
  test.beforeEach(() => requireSwitch('on'));

  // D-1 dev 连续 24 小时日志干净
  test('D-1 开关打开起 24 小时无 VkeyMissing / LiteLLMBaseMissing / Unknown model', async () => {
    requireEnv('E2E_SWITCH_ON_AT');
    const since = env('E2E_SWITCH_ON_AT');
    test.skip(Date.now() - Date.parse(since) < 24 * 3600_000, '开关打开未满 24 小时');
    const log = logsSince('YEPAIRAG_LOGS', since);
    for (const e of [...VKEY_ERRORS, UNKNOWN_MODEL]) expect(count(log, e), e).toBe(0);
  });

  // D-2 入口各跑一次，都能在 W23 里看到对应记录。
  // ⚠️ 线索意图已判「不改、放行」（不记商家），这里只跑店铺对话、知识问答、会话摘要三个（BDD D-2 需同步，缺口）
  test('D-2 店铺对话 / 知识问答 / 会话摘要各有 W23 记录', async ({ browser }) => {
    requireWhitelistOnlyConcierge();
    const m = merchant('NEW');
    const tag = marker('d2');
    let since = nowIso();
    const { page, w } = await visitor(browser, m);
    const { conv } = await visitorRound(page, w, `What is your return policy? ${tag}`);
    await ensureYepairagPath(m.tenant, since, conv);
    const shop = await waitW23(m.tenant, since, (r) => r.some(byAlias(cfg.mainModel)));
    expect(shop.some(byAlias(cfg.mainModel)), '店铺对话').toBe(true);

    since = nowIso();
    await visitorRound(page, w, 'Do you ship to Australia?');
    const kb = await waitW23(m.tenant, since, (r) => r.some(byAlias(cfg.embeddingModel)));
    expect(kb.some(byAlias(cfg.embeddingModel)), '知识问答（向量化）').toBe(true);

    await sleep(90_000);
    const admin = await adminPage(browser, m);
    since = nowIso();
    const k = await openInboxConversation(admin, tag, 1);
    const sum = await waitW23(m.tenant, since, (r) => r.length >= k);
    expect(sum.length, '会话摘要').toBeGreaterThanOrEqual(k);
    test.info().annotations.push({ type: 'SQL-W23 结果', description: JSON.stringify({ shop, kb, sum }) });
  });

  // D-3 开关打开后，后台 Anna 预览仍能回复，用量同样记到商家（预览带商家 vkey，Q17；余额 > 0 时过闸门，第 10 项）
  test('D-3 预览能回复，W23 有归属商家的行', async ({ browser }) => {
    requireWhitelistOnlyConcierge();
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const since = nowIso();
    const { frame, body, text } = await previewSend(admin, 'What is your return policy?');
    expect(body.isPreview).toBe(true);
    await waitReplyAfter(frame, text);
    expectNoVkeyErrors(since);
    const rows = await waitW23(m.tenant, since, (r) => r.length > 0);
    expect(rows.length).toBeGreaterThan(0);
  });
});
