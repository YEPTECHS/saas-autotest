// 营销日历内容认知、品牌摘要扣商家（迭代 pm/.trellis/tasks/10-01-calendar-brand-billing）。
// 验收清单 = design.md「C6. E2E 可断言点」E1–E14；BDD 见需求目录 bdd.md。环境默认 dev（E2E_TARGET）。
// 账号：A = E2E_NEW_*（余额 > 0）、Z = E2E_ZERO_*（余额 ≤ 0）、B = E2E_B_TENANT（另一商家，只用来冒充，不登录）。
//
// ⚠️ 安全约束：不得经旧直连入口打开营销日历——现有 yepairag 会给该商家写全中性判定并锁 7 天（G1 旧路径）。
//    本文件所有浏览器 context 都拦截旧的直连整月日历 GET 和直连 POST brand_summary，并打印拦截次数；
//    接口级用例只调 chatbot 新路由（新路由未部署时是 404，不会触到 yepairag）。
import { test, expect, type Browser, type BrowserContext, type Page, type APIResponse } from '@playwright/test';
import { merchant, env, nowIso, cfg, poll, type Merchant } from '../lib/config';
import { blockGa, login, authOf, balance, closeContexts } from '../lib/web';
import { waitW23, expectNoW23, isRagVkey } from '../lib/backend';
import { sel, countLines } from '../lib/loki';

const RUN_START = nowIso();
const PROXY = `${cfg.api}/chatbot/api/v1/digital-staff`;
const CAL = `${PROXY}/marketing-calendar`;
const BRAND = `${PROXY}/brand-summary`;
const MONTH = env('E2E_CALBRAND_MONTH') || new Date().toISOString().slice(0, 7);
const B = () => {
  const b = env('E2E_B_TENANT');
  test.skip(!b, '缺 E2E_B_TENANT（另一个余额 > 0 的商家，只作冒充用的 tenant_id）');
  return b;
};

// ---------- 旧入口拦截（防锁 7 天）----------

const LEGACY_CAL = /\/yepairag\/(api\/)?merchant\/marketing\/calendar(\?|$)/;
const LEGACY_BRAND = /\/yepairag\/(api\/)?brand_summary(\?|$)/;
const guarded = new WeakMap<BrowserContext, { calendar: number; brandPost: number }>();

async function guard(ctx: BrowserContext) {
  const n = { calendar: 0, brandPost: 0 };
  guarded.set(ctx, n);
  await ctx.route(LEGACY_CAL, (r) => (r.request().method() === 'GET' ? (n.calendar++, r.abort()) : r.continue()));
  await ctx.route(LEGACY_BRAND, (r) => (r.request().method() === 'POST' ? (n.brandPost++, r.abort()) : r.continue()));
  ctx.on('close', () => console.log(`[LEGACY-BLOCK] calendar GET aborted=${n.calendar} brand_summary POST aborted=${n.brandPost}`));
}

async function guardedPage(browser: Browser, m: Merchant): Promise<Page> {
  const ctx = await blockGa(await browser.newContext());
  await guard(ctx);
  const page = await ctx.newPage();
  await login(page, m);
  return page;
}

/** 登录一次拿 token，同一个 worker 内复用。 */
const sessions = new Map<string, Promise<Page>>();
const session = (browser: Browser, m: Merchant) => {
  if (!sessions.has(m.kind)) sessions.set(m.kind, guardedPage(browser, m));
  return sessions.get(m.kind)!;
};
const hdr = async (browser: Browser, m: Merchant) => {
  const h = authOf(await session(browser, m));
  expect(h, '没抓到登录后的 Authorization 头').toBeTruthy();
  return h!;
};

test.afterAll(async () => closeContexts());

// ---------- 小工具 ----------

const json = async (r: APIResponse) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const expectRoute = (r: APIResponse, label: string) =>
  expect(r.status(), `${label}：chatbot 新路由未部署时这里是 404（${r.url()}）`).not.toBe(404);
const expectCalendarShape = (body: any) => {
  expect(body, '日历响应应是 JSON 对象').toEqual(expect.objectContaining({ month: expect.anything(), items: expect.any(Array), pool: expect.any(Array) }));
};
/** Loki：时间窗内 yepairag 带 tenant 的某类日志。 */
const cognitionLines = (needle: string, tenant: string, since: string) =>
  countLines(`${sel('yepairag')} |= ${JSON.stringify(needle)}`, `tenant=${tenant}`, since, nowIso());

// ---------- S4 身份 ----------

test.describe('S4 身份只取自 JWT', () => {
  // E1 不带 Authorization → Kong 自己回 401（没到上游）
  for (const [name, method, url] of [
    ['R1 日历', 'GET', `${CAL}?month=${MONTH}`],
    ['R2 摘要 GET', 'GET', BRAND],
    ['R3 摘要 POST', 'POST', BRAND],
  ] as const) {
    test(`E1 [S4] ${name} 不带 Authorization → 401，Kong 自己拦（有 x-kong-response-latency、无 x-kong-upstream-latency）`, async ({ request }) => {
      const r = method === 'GET' ? await request.get(url) : await request.post(url, { data: { url: 'https://example.com' } });
      const h = r.headers();
      expect(r.status()).toBe(401);
      expect(h.server ?? '', 'server 头').toMatch(/^kong\//);
      expect(h['x-kong-response-latency'], 'Kong 自己回的响应带 x-kong-response-latency').toBeDefined();
      expect(h['x-kong-upstream-latency'], '没转给上游').toBeUndefined();
    });
  }

  // E3 token 有效但 chatbot 查不到用户 → 404 resource_not_found（不登出）
  test('E3 [S4] token 的 sub 在 chatbot 查不到用户 → 404 resource_not_found', async ({ request }) => {
    const token = env('E2E_NOCHATBOT_BEARER');
    test.skip(!token, '需要「Cognito 有、chatbot 无用户行」账号的 Bearer token（E2E_NOCHATBOT_BEARER），账号池没有，需造号');
    for (const url of [`${CAL}?month=${MONTH}`, BRAND]) {
      const r = await request.get(url, { headers: { authorization: token } });
      expect(r.status(), url).toBe(404);
      expect((await json(r)).subtype, url).toBe('resource_not_found');
    }
  });
});

// ---------- S1 日历 ----------

test.describe('S1 营销日历', () => {
  // E4 A 打开日历 → 200，结构 {month, items, pool}，未压缩 JSON
  test('E4 [S1] A 打开日历 → 200，有 month/items/pool，无 Content-Encoding: gzip，可直接按 JSON 解析', async ({ browser, request }) => {
    const A = merchant('NEW');
    const r = await request.get(`${CAL}?month=${MONTH}`, { headers: await hdr(browser, A) });
    expectRoute(r, 'R1');
    expect(r.status(), (await r.text()).slice(0, 300)).toBe(200);
    expect(r.headers()['content-encoding'] ?? '', '不能把上游的 gzip 透给浏览器').not.toMatch(/gzip/);
    expect(r.headers()['content-type'] ?? '').toContain('application/json');
    // chatbot 共享 WebClient 缓冲上限 4MB：记下整月响应体字节数，接近上限要提前报
    const bytes = (await r.body()).length;
    test.info().annotations.push({ type: '日历整月响应体字节数', description: `${bytes}（${(bytes / 1024 / 1024).toFixed(3)} MB / 上限 4 MB）` });
    console.log(`[E4] month=${MONTH} body bytes=${bytes}`);
    expectCalendarShape(await r.json());
    // ponytail: 不和「直连 yepairag 同月结果」比——直连会在现有代码上给 A 写中性判定锁 7 天；只比结构
  });

  // E8 月份格式不合法 → 422，且与直连 yepairag 一致。yepairag 只校验格式 ^\d{4}-\d{2}$（month=2026-13 直连本来就 200 空日历，现有行为），
  // 所以只测格式非法的值。格式非法时 yepairag 在启动内容认知之前就 422，直连对照不会写判定（10-02 dev Loki 实测 abc 无 [Cognition] 行）
  for (const bad of ['abc', '2026-1', '']) {
    test(`E8 [S1] month=${JSON.stringify(bad)} → 422，与直连 yepairag 一致`, async ({ browser, request }) => {
      const A = merchant('NEW');
      const r = await request.get(`${CAL}?month=${encodeURIComponent(bad)}`, { headers: await hdr(browser, A) });
      expectRoute(r, 'R1');
      expect(r.status(), (await r.text()).slice(0, 300)).toBe(422);
      const yep = env('YEPAIRAG_BASE_URL');
      test.skip(!yep, '缺 YEPAIRAG_BASE_URL，未做直连对照（port-forward svc/yepairag-<env>）');
      const direct = await request.get(`${yep}/yepairag/merchant/marketing/calendar?tenant_id=${A.tenant}&month=${encodeURIComponent(bad)}`);
      expect(direct.status(), '直连 yepairag 也应 422').toBe(422);
      expect(await json(r), '应原样透传 yepairag 的校验错误').toEqual(await json(direct));
    });
  }

  // E5 有已发布内容、7 天内未判定的商家打开日历 → 内容认知判出结果，费用记该商家（G1 转绿）
  // 商家用 E2E_COG_*（不能用 A：A 没有已发布内容，yepairag 打 [Cognition] nothing to judge）。10-02 只读查 dev Loki：
  // 近 30 天 judged>0 的只有 1133289854005231616、1192650577220251648，二者近 7 天都有 judge failed（锁中），且无登录凭据 → 暂无可用商家
  test('E5 [S1] 有内容商家打开日历 → [Cognition] wrote … judged>0、无 VkeyMissing、无 no merchant vkey；W23 chatbot:acct 有 rag vkey 记录', async ({ browser, request }) => {
    test.setTimeout(10 * 60_000);
    test.skip(
      !env('E2E_COG_TENANT'),
      '缺「有已发布内容、7 天内未判定」的 dev 测试商家（E2E_COG_TENANT/EMAIL/PASSWORD）。10-02 查 dev Loki 近 30 天 judged>0 的 2 个 tenant 都在 7 天锁内、且不在账号池；不造数据，待有可用商家再跑',
    );
    const A = merchant('COG');
    // 7 天新鲜度门：A 最近 7 天判过就会跳过，结果不算数（不删库，换商家或等锁过期）
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const recent = (await cognitionLines('[Cognition] wrote', A.tenant, weekAgo)).n + (await cognitionLines('[Cognition] judge failed', A.tenant, weekAgo)).n;
    test.skip(recent > 0, `商家 ${A.tenant} 7 天内已做过内容认知（新鲜度门会跳过），换「7 天内未判定」的商家（E2E_COG_*）`);
    expect(await balance(await session(browser, A), A.tenant), '前提：A 余额 > 0').toBeGreaterThan(0);
    const since = nowIso();
    const r = await request.get(`${CAL}?month=${MONTH}`, { headers: await hdr(browser, A) });
    expectRoute(r, 'R1');
    expect(r.status()).toBe(200);
    // 等到出现结果：wrote（判定完成）或 nothing to judge（A 没有可判定的已发布内容 = 数据前提不满足）
    const outcome = await poll(
      async () => ({
        wrote: (await cognitionLines('[Cognition] wrote', A.tenant, since)).first,
        nothing: (await cognitionLines('[Cognition] nothing to judge', A.tenant, since)).n,
      }),
      (o) => o.wrote.some((l) => /judged=[1-9]\d*/.test(l)) || o.nothing > 0,
      5 * 60_000,
      20_000,
    );
    test.skip(
      outcome.nothing > 0 && outcome.wrote.length === 0,
      `数据前提不满足：yepairag [Cognition] nothing to judge tenant=${A.tenant}（A 没有可判定的已发布内容），换有已发布内容、7 天内未判定的商家`,
    );
    const wrote = outcome.wrote;
    test.info().annotations.push({ type: '[Cognition] wrote', description: wrote.join('\n') });
    expect(wrote.some((l) => /judged=[1-9]\d*/.test(l)), 'judged=0 = 判定全中性，并锁 7 天').toBe(true);
    expect((await countLines(sel('yepairag'), 'VkeyMissing', since, nowIso())).n).toBe(0);
    expect((await cognitionLines('[Cognition] no merchant vkey, skipping', A.tenant, since)).n, 'chatbot 应已把商家 vkey 带到 yepairag').toBe(0);
    const rows = await waitW23(A.tenant, since, (x) => x.some(isRagVkey));
    test.info().annotations.push({ type: 'SQL-W23', description: JSON.stringify(rows) });
    expect(rows.filter(isRagVkey).length, '内容认知的模型调用应记到 A').toBeGreaterThan(0);
  });

  // E2 A 冒充 B：日历 / 摘要返回 A 的数据，W23 B 无 rag vkey 新行
  test('E2 [S4] A 带 tenant_id=B 调 R1 / R2 / R3 → 返回 A 的数据；W23 B 无新增 rag vkey 行', async ({ browser, request }) => {
    test.setTimeout(10 * 60_000);
    const A = merchant('NEW');
    const b = B();
    const h = await hdr(browser, A);
    const since = nowIso();
    const calA = await request.get(`${CAL}?month=${MONTH}`, { headers: h });
    expectRoute(calA, 'R1');
    const calForged = await request.get(`${CAL}?month=${MONTH}&tenant_id=${b}`, { headers: h });
    expect(calForged.status()).toBe(calA.status());
    expect(await json(calForged), 'R1：填 B 的 tenant_id 仍应是 A 的日历').toEqual(await json(calA));
    const sumA = await request.get(BRAND, { headers: h });
    const sumForged = await request.get(`${BRAND}?tenant_id=${b}`, { headers: h });
    expect(await json(sumForged), 'R2：填 B 的 tenant_id 仍应是 A 的摘要').toEqual(await json(sumA));
    const post = await request.post(BRAND, { headers: h, data: { tenant_id: b, url: env('E2E_A_SITE_URL') || `https://${A.shop}` }, timeout: 150_000 });
    expect(post.status(), (await post.text()).slice(0, 300)).toBe(200);
    await expectNoW23(b, since, isRagVkey);
  });
});

// ---------- S2 品牌摘要 ----------

test.describe('S2 品牌摘要', () => {
  // E9 A、Z 读摘要都 200，与 yepairag 原样一致（GET 不调模型，直连对照安全）
  test('E9 [S2] A、Z 读品牌摘要 → 200，与 yepairag GET /brand_summary?tenant_id 一致', async ({ browser, request }) => {
    for (const m of [merchant('NEW'), merchant('ZERO')]) {
      const r = await request.get(BRAND, { headers: await hdr(browser, m) });
      expectRoute(r, 'R2');
      expect(r.status(), `${m.kind}：${(await r.text()).slice(0, 300)}`).toBe(200);
      const yep = env('YEPAIRAG_BASE_URL');
      if (yep) {
        const direct = await request.get(`${yep}/yepairag/brand_summary?tenant_id=${m.tenant}`);
        expect(await json(r), `${m.kind}：应原样透传 yepairag`).toEqual(await json(direct));
      } else test.info().annotations.push({ type: 'skip-part', description: '缺 YEPAIRAG_BASE_URL，未做直连对照' });
    }
  });

  // E12 空提交 → 400 透传
  test('E12 [S2] A 提交 {} → 400 {"status":"ERROR","message":"URL or summary is required"}', async ({ browser, request }) => {
    const r = await request.post(BRAND, { headers: await hdr(browser, merchant('NEW')), data: {} });
    expectRoute(r, 'R3');
    expect(r.status()).toBe(400);
    expect(await json(r)).toEqual({ status: 'ERROR', message: 'URL or summary is required' });
  });

  // E10 A 提交 url → 200 OK + 摘要；W23 计入 A（G2 转绿）
  test('E10 [S2] A 提交 {url} → 200 status=OK 有摘要；W23 chatbot:acct:A 有 rag vkey 记录', async ({ browser, request }) => {
    test.setTimeout(10 * 60_000);
    const A = merchant('NEW');
    expect(await balance(await session(browser, A), A.tenant), '前提：A 余额 > 0').toBeGreaterThan(0);
    const since = nowIso();
    const r = await request.post(BRAND, { headers: await hdr(browser, A), data: { url: env('E2E_A_SITE_URL') || `https://${A.shop}` }, timeout: 150_000 });
    expectRoute(r, 'R3');
    const body = await json(r);
    expect(r.status(), JSON.stringify(body).slice(0, 300)).toBe(200);
    expect(body.status).toBe('OK');
    expect(String(body.summary ?? '').length, '应有摘要内容').toBeGreaterThan(0);
    const rows = await waitW23(A.tenant, since, (x) => x.some(isRagVkey));
    expect(rows.filter(isRagVkey).length, '品牌摘要的模型调用应记到 A').toBeGreaterThan(0);
  });
});

// ---------- S3 零余额 ----------

test.describe('S3 零余额商家', () => {
  // E6 Z 打开日历 → 200 结构不变；chatbot gate denied；W23 Z 无新行
  test('E6 [S3] Z 打开日历 → 200 结构同 E4；chatbot 有 gate denied user=Z；W23 Z 无新行', async ({ browser, request }) => {
    test.setTimeout(10 * 60_000);
    const Z = merchant('ZERO');
    expect(await balance(await session(browser, Z), Z.tenant), '前提：Z 余额 ≤ 0').toBeLessThanOrEqual(0);
    const since = nowIso();
    const r = await request.get(`${CAL}?month=${MONTH}`, { headers: await hdr(browser, Z) });
    expectRoute(r, 'R1');
    expect(r.status(), (await r.text()).slice(0, 300)).toBe(200);
    expectCalendarShape(await r.json());
    const denied = await poll(
      () => countLines(`${sel('chatbot-api')} |= "[MarketingCalendarProxy] gate denied"`, `user=${Z.tenant}`, since, nowIso()),
      (x) => x.n > 0,
      120_000,
      15_000,
    );
    expect(denied.n, `chatbot 日志应有 [MarketingCalendarProxy] gate denied user=${Z.tenant}`).toBeGreaterThan(0);
    await expectNoW23(Z.tenant, since);
  });

  // E7 Z 打开日历后不写判定、不锁 7 天（依赖 yepairag C4）
  test('E7 [S3] Z 打开日历后 yepairag 不做内容认知：无 [Cognition] wrote / judge failed tenant=Z', async ({ browser, request }) => {
    test.setTimeout(10 * 60_000);
    const Z = merchant('ZERO');
    const since = nowIso();
    const r = await request.get(`${CAL}?month=${MONTH}`, { headers: await hdr(browser, Z) });
    expectRoute(r, 'R1');
    expect(r.status()).toBe(200);
    await new Promise((x) => setTimeout(x, 120_000)); // 内容认知在后台跑，等它有机会写
    for (const needle of ['[Cognition] wrote', '[Cognition] judge failed']) {
      const got = await cognitionLines(needle, Z.tenant, since);
      expect(got.n, `${needle} tenant=${Z.tenant} 不应出现（出现 = 写了判定并锁 7 天）：\n${got.first.join('\n')}`).toBe(0);
    }
  });

  // E7 后半：充值后当次判定——要写 W23 余额（共享库），E2E 不做
  test.fixme('E7b [S3] 给 Z 充值后再打开日历 → 当次判定（E5 断言对 Z 成立）——充值需改共享库，人工充值后用 E5 的断言跑', async () => {});

  // E11 Z 提交 → 402 原样；yepairag 没收到
  test('E11 [S3] Z 提交 {url} → 402 {"errorMessage":"Not enough credits","subtype":"INSUFFICIENT_CREDITS","errorCode":402}；yepairag 无 POST /brand_summary', async ({ browser, request }) => {
    test.setTimeout(5 * 60_000);
    const Z = merchant('ZERO');
    const since = nowIso();
    const r = await request.post(BRAND, { headers: await hdr(browser, Z), data: { url: `https://${Z.shop}` } });
    expectRoute(r, 'R3');
    expect(r.status()).toBe(402);
    expect(await json(r)).toEqual({ errorMessage: 'Not enough credits', subtype: 'INSUFFICIENT_CREDITS', errorCode: 402 });
    await new Promise((x) => setTimeout(x, 60_000)); // Loki 入库延迟
    const hit = await countLines(sel('yepairag'), 'POST /yepairag/brand_summary', since, nowIso());
    expect(hit.n, `yepairag 不应收到这次请求：\n${hit.first.join('\n')}`).toBe(0);
  });

  // E13 前端：Z 触发品牌摘要 → 走 chatbot、不带 tenant、无 toast
  const TOAST = '[data-sonner-toast], .Toastify__toast, [role="alert"], .ant-message-notice, .ant-notification-notice';
  for (const [name, base] of [
    ['React', cfg.base],
    ['Business', env('E2E_BUSINESS_BASE_URL')],
  ] as const) {
    test(`E13 [S3] ${name}：Z 在问卷第 1 步提交网址 → 品牌摘要请求走 chatbot /digital-staff/brand-summary、不带 tenant_id；页面无 toast`, async ({ browser }) => {
      test.skip(!base, `缺 ${name} 前端地址（E2E_BUSINESS_BASE_URL）`);
      test.setTimeout(5 * 60_000);
      const Z = merchant('ZERO');
      const ctx = await blockGa(await browser.newContext());
      await guard(ctx);
      const page = await ctx.newPage();
      await login(page, Z);
      const calls: { url: string; body: string }[] = [];
      page.on('request', (q) => {
        if (q.method() === 'POST' && /brand[-_]summary/.test(q.url())) calls.push({ url: q.url(), body: q.postData() ?? '' });
      });
      await page.goto(`${base}/questionnaire`, { waitUntil: 'domcontentloaded' });
      const input = page.locator('input[name="websiteUrl"]');
      const reached = await input.waitFor({ timeout: 30_000 }).then(() => true, () => false);
      test.skip(!reached, `Z 进不了问卷页（落在 ${page.url()}），换能进后台的零余额商家`);
      await input.fill(`https://${Z.shop}`);
      await page.locator('button[type="submit"]').first().click();
      await expect.poll(() => calls.length, { timeout: 30_000, message: '问卷第 1 步没有发出品牌摘要请求' }).toBeGreaterThan(0);
      test.info().annotations.push({ type: '品牌摘要请求', description: JSON.stringify(calls) });
      expect(calls.every((c) => c.url.includes('/chatbot/api/v1/digital-staff/brand-summary')), `应走 chatbot 代理，实际：${calls.map((c) => c.url).join(', ')}`).toBe(true);
      expect(calls.some((c) => /tenant_id/.test(c.url + c.body)), '不应再带 tenant_id').toBe(false);
      await page.waitForTimeout(5_000);
      expect(await page.locator(TOAST).count(), '零余额被拒应静默，不弹 toast').toBe(0);
      const g = guarded.get(ctx)!;
      test.info().annotations.push({ type: '旧入口拦截', description: `calendar GET=${g.calendar} brand_summary POST=${g.brandPost}` });
    });
  }
});

// ---------- 安全 ----------

test.describe('安全', () => {
  // E14 新路由日志不含 JWT、vkey 头、Authorization（跑在 E1–E12 之后）
  test('E14 [安全] 本轮 chatbot 三条新路由的日志里没有测试账号 JWT、X-Yep-Rag-Vkey、Authorization', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const A = merchant('NEW');
    const token = (await hdr(browser, A)).authorization.replace(/^Bearer\s+/i, '');
    // ponytail: 用 JWT 第二段（payload）前 20 个字符——第一段（header）同一用户池的 token 都一样，grep 它会误中别人的 token
    const jwtPart = token.split('.')[1]?.slice(0, 20) ?? '';
    await new Promise((x) => setTimeout(x, 60_000)); // Loki 入库延迟
    // 逗号或竖线分隔都认（W3 实现的 operation 名：marketingCalendarProxy,brandSummaryGetProxy,brandSummaryPostProxy）
    const ops = (env('E2E_CALBRAND_LOG_OPS') || 'marketingCalendarProxy,brandSummaryGetProxy,brandSummaryPostProxy').split(/[,|]/).map((x) => x.trim()).filter(Boolean).join('|');
    const proxyLines = `${sel('chatbot-api')} |~ ${JSON.stringify(ops)}`;
    const all = await countLines(proxyLines, '', RUN_START, nowIso());
    expect(all.n, `本轮 chatbot 日志里没有新路由的日志（按 ${ops} 过滤）——查不到就证明不了没泄露`).toBeGreaterThan(0);
    for (const needle of [jwtPart, 'X-Yep-Rag-Vkey', 'Authorization', 'Bearer ']) {
      const got = await countLines(proxyLines, needle, RUN_START, nowIso());
      expect(got.n, `新路由日志不应包含 ${needle === jwtPart ? '测试账号 JWT' : needle}`).toBe(0);
    }
    test.info().annotations.push({ type: 'skip-part', description: '未 grep A 的 vkey 前缀：取 vkey 属于读 secret，按要求不做' });
  });
});
