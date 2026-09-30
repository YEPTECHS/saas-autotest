// 主线 B 补漏 G1 / G2（需求 pm/.trellis/tasks/09-30-mainline-b-vkey-gap，D1：单独迭代「扣商家」）。按业务结果断言：
// 现有代码（前端直连 yepairag 不带 vkey）上应红，「扣商家」迭代修好后在 dev 跑绿。
// ⚠️ 默认不跑：G1 一跑就会在该商家写入内容认知判定并锁 7 天（失败时写入的是中性判定），G2 会覆盖该商家的品牌摘要。
//    只在修复部署后、用专门的测试商家时设 E2E_RUN_G1G2=1。
import { test, expect } from '@playwright/test';
import { merchant, env, nowIso, cfg, poll } from '../lib/config';
import { adminPage, waitFor } from '../lib/web';
import { waitW23 } from '../lib/backend';
import { sel, countLines } from '../lib/loki';

test.describe('主线 B 补漏：前端直连 yepairag 的调用记到商家', () => {
  test.beforeEach(() =>
    test.skip(env('E2E_RUN_G1G2') !== '1', '会在商家写入内容认知判定（锁 7 天）/ 覆盖品牌摘要，只在「扣商家」修复部署后用专门商家跑（E2E_RUN_G1G2=1）'),
  );

  // G1 商家在后台打开营销日历 → 内容认知判定成功，且费用记到该商家
  test('G1 [营销日历] 打开营销日历 → calendar 200；内容认知判定成功（[Cognition] wrote … judged>0，无 VkeyMissing）；W23 有该商家 chatbot:acct 记录', async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const since = nowIso();
    const calendar = waitFor(
      admin.waitForResponse((r) => r.request().method() === 'GET' && /\/merchant\/marketing\/calendar(\?|$)/.test(r.url()), { timeout: 60_000 }),
      '营销日历页面发出的 GET …/merchant/marketing/calendar',
    );
    await admin.goto(`${cfg.base}/ai-team/marketing/hub/calendar`, { waitUntil: 'domcontentloaded' });
    expect((await calendar).status()).toBe(200);
    // 内容认知在后台跑；Loki 有入库延迟，最多等 5 分钟
    const wrote = await poll(
      () => countLines(sel('yepairag'), `[Cognition] wrote`, since, nowIso()).then((r) => r.first.filter((l) => l.includes(`tenant=${m.tenant}`))),
      (lines) => lines.some((l) => /judged=([1-9]\d*)/.test(l)),
      5 * 60_000,
      20_000,
    );
    expect(wrote.some((l) => /judged=([1-9]\d*)/.test(l)), `yepairag 应有 [Cognition] wrote … tenant=${m.tenant} … judged>0（judged=0 = 判定全中性，7 天不重判）`).toBe(true);
    expect((await countLines(sel('yepairag'), 'VkeyMissing', since, nowIso())).n, '内容认知不应缺 vkey').toBe(0);
    const rows = await waitW23(m.tenant, since, (r) => r.length > 0);
    test.info().annotations.push({ type: 'SQL-W23 结果', description: JSON.stringify(rows) });
    expect(rows.length, '内容认知的模型调用应记到该商家 chatbot 账户').toBeGreaterThan(0);
  });

  // G2 商家提交品牌问卷 → 生成品牌摘要，且费用记到该商家
  test('G2 [品牌摘要] 提交品牌问卷第一步 → POST /brand_summary 200；GET /brand_summary 有摘要；W23 有该商家 chatbot:acct 记录', async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const m = merchant('NEW');
    const site = env('E2E_G2_WEBSITE_URL') || `https://${m.shop}`;
    const admin = await adminPage(browser, m);
    const since = nowIso();
    await admin.goto(`${cfg.base}/questionnaire`, { waitUntil: 'domcontentloaded' });
    const post = waitFor(
      admin.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/brand_summary'), { timeout: 180_000 }),
      '问卷第一步静默发出的 POST …/brand_summary',
    );
    await admin.locator('input[name="websiteUrl"]').fill(site);
    await admin.locator('button[type="submit"]').first().click();
    const res = await post;
    expect(res.status(), `POST /brand_summary：${(await res.text()).slice(0, 300)}`).toBe(200);
    // 前端 .catch 吞错不提示，所以摘要是否生成以 GET 为准
    const got = await admin.request.get(res.url().replace(/\/brand_summary.*$/, `/brand_summary?tenant_id=${m.tenant}`));
    const text = await got.text();
    expect(got.status(), text.slice(0, 300)).toBe(200);
    expect((JSON.stringify(JSON.parse(text)).match(/"[^"]{40,}"/g) ?? []).length, `品牌摘要应有内容：${text.slice(0, 300)}`).toBeGreaterThan(0);
    const rows = await waitW23(m.tenant, since, (r) => r.length > 0);
    test.info().annotations.push({ type: 'SQL-W23 结果', description: JSON.stringify(rows) });
    expect(rows.length, '品牌摘要的模型调用应记到该商家 chatbot 账户').toBeGreaterThan(0);
  });
});
