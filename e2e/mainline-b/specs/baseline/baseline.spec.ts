// 主线 B 现状基线（2026-09-27 用户要求：E2E 先针对现状写，在现在的代码 / 现在的老 dev 上跑通；改造后的断言等改造时再改）。
// 环境：老 dev（bot-dev.yepai.io；挂件 / API 连 api-test.yepai.io/dev），yepairag RAG_METERING_ENABLED 关闭，concierge 对所有商家打开。
// 依据：pm/docs/改造点-E2E可写性判定.md、pm/docs/BDD-主线B-场景真实性核验.md、pm/docs/tasks/bdd-answers-2026-09-27/（W3 / W23 / W32）。
// 改造后的用例在上一级 specs/ 里，保留不动。
//
// 跑 baseline 需要的环境变量（lib/config.ts 只自动读仓库根目录 .env，不读 .env.example；缺哪个，对应用例 skip 并写明原因）：
//   E2E_METERING_SWITCH=off              必填：本套是开关关闭的现状，不是 off 全部 skip
//   E2E_CONCIERGE_WHITELIST_ONLY=0       老 dev 是全量 concierge；设 1 时只跑 BL-1b
//   E2E_TARGET=dev
//   E2E_NEW_TENANT / E2E_NEW_EMAIL / E2E_NEW_PASSWORD   新套餐测试商家；账号从 autotest-account 领 bot/dev/growth，
//                                        租户必须和账号对应（账号 29 = 1213797964756733952），先登录核对
//   E2E_LEGACY_TENANT=918807096909901824 老套餐商家（有商品数据）：BL-11 tools/product、tools/collection 和 BL-12 用；不设则这 3 条 skip
//   YEPAIRAG_BASE_URL=http://localhost:18080   BL-11 用；先 kubectl --context oldeks -n llm port-forward svc/yepairag-dev 18080:8080，跑完关掉
//   YEPAIRAG_LOGS='--context oldeks -n llm deploy/yepairag-dev'
//   CHATBOT_LOGS='--context oldeks -n bigdata deploy/chatbot-api-dev'
//   W23_DATABASE_URL                     只读，放仓库根目录 .env；本机要有 psql（PATH=/opt/homebrew/opt/libpq/bin:$PATH）
//   E2E_ZERO_TENANT=1211632914216980480   可选：余额 ≤ 0 商家（unsubscribed 账号 16，见 BL-6 注释），没有则 BL-6 skip
// 报错里出现成批 net::ERR_CONNECTION_CLOSED（挂件诊断会列出来）= 本机浏览器网络断了，不是 dev 的问题，先修网络再跑。
// 不在代码里写死 E2E_LEGACY_TENANT：测试商家由运行环境声明，写死会在别的环境悄悄打到这家商家。
import { test, expect, type Browser } from '@playwright/test';
import { cfg, merchant, requireSwitch, requireWhitelistOnlyConcierge, requireEnv, env, nowIso, sleep, poll } from '../../lib/config';
import {
  adminPage, visitor, visitorRound, visitorSend, aiBubbleCount, previewSend, waitReplyAfter, kbAddManually, waitKbSynced, kbDeleteByText,
  openInboxConversation, staffChatSend, waitStaffReply, closeContexts, widgetSend, netHint, recordVoice, wavBase64, waitFor, marker, withCustomisation,
} from '../../lib/web';
import { logsSince, count, waitW23, w23Rows, rowsPerRequest, isRagVkey, byAlias, expectNoW23, ensureYepairagPath, mcpAccess, yepairagTaskLog, TEXT_SENT, LOG, VKEY_ERRORS } from '../../lib/backend';

const conciergeDone = (tenant: string) => `[Concierge] turn done tenant=${tenant}`;
const KB_TOOL = '[Concierge] tool_result name=SEARCH_KNOWLEDGE_BASE';
const ASR_ALIAS = env('ASR_MODEL') || 'whisper-1';

/** 访客发消息前要关掉 Email Collection（enableLead），否则 209 lead_required（核验文档 R0-1 前提）。
 *  ponytail: 用例内临时改、结束恢复（withCustomisation 自带 finally）；共享商家配置被改的窗口 = 用例时长。 */
async function withLeadOff(browser: Browser, m: ReturnType<typeof merchant>, fn: () => Promise<void>) {
  const admin = await adminPage(browser, m);
  await withCustomisation(admin, m.tenant, { enableLead: 'no' }, fn);
}

/** 现状 dev 形态：concierge 全量打开。声明成 prod 形态（仅白名单）时，dev 形态的用例不算数。 */
const requireConciergeForAll = () =>
  test.skip(env('E2E_CONCIERGE_WHITELIST_ONLY') === '1', '这是 concierge 全量打开（老 dev 现状）的用例；当前声明为仅白名单（E2E_CONCIERGE_WHITELIST_ONLY=1）');

test.describe('现状基线（开关关闭）', () => {
  test.beforeEach(() => requireSwitch('off'));
  test.afterEach(() => closeContexts());

  // BL-1a 老 dev 上店铺访客对话走 concierge：有回复，W23 每个 request_id 两个维度各一行（数字员工 + 商家，设计行为）
  test('BL-1a 店铺访客对话（dev 现状走 concierge）：有回复，[Concierge] turn done，W23 每个 request_id 2 行', async ({ browser }) => {
    requireConciergeForAll();
    const m = merchant('NEW');
    const since = nowIso();
    await withLeadOff(browser, m, async () => {
      const { page, w } = await visitor(browser, m);
      const { reply } = await visitorRound(page, w, 'What is your return policy?');
      expect(reply.length).toBeGreaterThan(0);
    });
    const log = await poll(() => logsSince('CHATBOT_LOGS', since), (l) => l.includes(conciergeDone(m.tenant)), 60_000);
    expect(log.includes(conciergeDone(m.tenant)), `chatbot 日志应有 ${conciergeDone(m.tenant)}`).toBe(true);
    const rows = await waitW23(m.tenant, since, (r) => r.length >= 2, false);
    expect(rows.length, 'concierge 这一轮应在 W23 留下记录').toBeGreaterThanOrEqual(2);
    expect(rowsPerRequest(rows).every((n) => n === 2), `每个 litellm_request_id 应恰好 2 行，实际 ${JSON.stringify(rowsPerRequest(rows))}`).toBe(true);
    expect(new Set(rows.map((r) => r.platform))).toEqual(new Set(['digital-staff', 'chatbot']));
  });

  // BL-1b prod 形态（concierge 仅白名单）：普通商家走 yepairag，W23 无 rag vkey 行，yepairag 发 [CreditUsage] kind=text
  test('BL-1b 店铺访客对话（prod 形态，仅白名单 concierge）：走 yepairag，W23 无 rag vkey 行，发 [CreditUsage] kind=text', async ({ browser }) => {
    requireWhitelistOnlyConcierge();
    const m = merchant('NEW');
    const since = nowIso();
    let conv = '';
    await withLeadOff(browser, m, async () => {
      const { page, w } = await visitor(browser, m);
      ({ conv } = await visitorRound(page, w, 'What is your return policy?'));
    });
    const round = await ensureYepairagPath(m.tenant, since, conv);
    expect(count(round, TEXT_SENT), '这一轮应有一条 [CreditUsage] sent … "kind": "text"').toBe(1);
    await sleep(90_000);
    expect(w23Rows(m.tenant, since).filter(isRagVkey), '开关关闭时不应有 rag vkey 的 W23 行').toEqual([]);
  });

  // BL-2 会话摘要：商家在 Inbox 打开会话 → GET …/human/summary 200 且有摘要。
  // chatbot 发给 yepairag 的 vkey 头名现状是 vkey（不是 X-Yep-Rag-Vkey），但 yepairag 日志不打请求头（W32），看不到，所以不断言头名。
  test('BL-2 Inbox 打开会话 → human/summary 200，有摘要', async ({ browser }) => {
    const m = merchant('NEW');
    const tag = marker('bl2');
    await withLeadOff(browser, m, async () => {
      const { page, w } = await visitor(browser, m);
      await visitorRound(page, w, `What is your return policy? ${tag}`);
    });
    await sleep(30_000); // 会话进 Inbox 列表需要一点时间
    const admin = await adminPage(browser, m);
    const since = nowIso();
    const resP = waitFor(
      admin.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes('/human/summary'), { timeout: 120_000 }),
      'Inbox 打开会话发出的 GET …/human/summary 响应',
    );
    await openInboxConversation(admin, tag, 1);
    const res = await resP;
    const text = await res.text();
    expect(res.status(), `human/summary 应 200：${text.slice(0, 300)}`).toBe(200);
    // 响应结构未实测：要求里有一段非空的字符串（摘要），打印出来人工核对
    console.log(`[BL-2] human/summary body: ${text.slice(0, 500)}`);
    const strings = JSON.stringify(JSON.parse(text)).match(/"[^"]{20,}"/g) ?? [];
    expect(strings.length, 'human/summary 响应里应有摘要文字').toBeGreaterThan(0);
    const ylog = logsSince('YEPAIRAG_LOGS', since);
    console.log(`[BL-2] yepairag session_summary access 行数=${count(ylog, /session_summary/)}（仅记录，不断言）`);
  });

  // BL-3 知识库训练：Add manually → POST /sources + /sources/train → Synced；访客问到（dev 现状：concierge 用 SEARCH_KNOWLEDGE_BASE 查到）
  test('BL-3 知识库 Add manually → train → Synced，访客问到这条 FAQ', async ({ browser }) => {
    requireConciergeForAll();
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const code = `GW${Date.now().toString(36).toUpperCase()}`;
    const q = `Do you offer gift wrapping? ${marker('bl3')}`;
    const since = nowIso();
    const train = await kbAddManually(admin, m.tenant, q, `Yes. Gift wrapping is available; enter the code ${code} at checkout.`);
    try {
      expect((await train).status(), 'POST /v1/sources/train/{userId}').toBeLessThan(300);
      await waitKbSynced(admin, q);
      // yepairag 处理训练：先打 download.file.successful.file.url: …/file/{tenant}/…（带商家），处理完才打 access 日志 POST /yepairag/create（实测相隔约 5 秒）。
      // 列表显示 Synced 不代表 yepairag 已收到：2026-09-27 PM 复跑出现过 Synced 了但 yepairag 一直没收到这次训练
      const trained = (l: string) => l.includes(`/file/${m.tenant}/`) && count(l, LOG.KB_CREATE) > 0;
      const ylog = await poll(() => logsSince('YEPAIRAG_LOGS', since), trained, 90_000);
      expect(trained(ylog), `yepairag 应收到这次训练（download.file …/file/${m.tenant}/ + POST /yepairag/create）`).toBe(true);
      const askAt = nowIso();
      await withCustomisation(admin, m.tenant, { enableLead: 'no' }, async () => {
        const { page, w } = await visitor(browser, m);
        const { reply } = await visitorRound(page, w, 'Do you offer gift wrapping? What code do I enter at checkout?');
        // 回答措辞由模型决定（2026-09-27 实跑：答了「gift wrapping is available」但没带代码），只要求提到这件事；是否查到以检索结果为准
        expect(reply, '访客应得到关于 gift wrapping 的回答').toMatch(/gift[- ]?wrap/i);
      });
      const kbHits = logsSince('CHATBOT_LOGS', askAt).split('\n').filter((l) => l.includes(KB_TOOL));
      expect(kbHits.length, `chatbot 日志应有 ${KB_TOOL}`).toBeGreaterThan(0);
      expect(kbHits.some((l) => l.includes(code)), `SEARCH_KNOWLEDGE_BASE 的返回里应有刚训练的 FAQ（代码 ${code}）`).toBe(true);
    } finally {
      await kbDeleteByText(admin, q).catch((e) => console.log(`[BL-3] 清理失败，需手工删除知识库条目「${q}」：${e}`));
    }
  });

  // BL-4 后台 Anna 预览：isPreview:true，有回复，不过余额闸门（闸门放行不打日志，只能断言没有该租户的 [Bill][gate] 记录）
  test('BL-4 Anna 预览 isPreview:true，有回复，无该租户 [Bill][gate] 记录', async ({ browser }) => {
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const since = nowIso();
    const { frame, body, res, text } = await previewSend(admin, 'What is your return policy?');
    expect(body.isPreview, '预览请求体 isPreview 应为 true').toBe(true);
    expect(res.status()).toBeLessThan(300);
    expect((await waitReplyAfter(frame, text)).length, '预览应有回复').toBeGreaterThan(0);
    const gate = logsSince('CHATBOT_LOGS', since).split('\n').filter((l) => l.includes('[Bill][gate]') && l.includes(m.tenant));
    expect(gate, '预览不过余额闸门').toEqual([]);
  });

  // BL-5 语音转文字：挂件直连 POST …/yepairag/api/asr，请求体只有 voiceContent、无商家身份；转写含 Australia；W23 无该商家语音行
  test('BL-5 语音 → 直连 yepairag /api/asr（只有 voiceContent），转写含 Australia，W23 无该商家语音行', async ({ browser }) => {
    const m = merchant('NEW', false);
    const b64 = wavBase64();
    const { w } = await visitor(browser, m, { wavBase64: b64 });
    const since = nowIso();
    await recordVoice(w);
    await expect.poll(() => w.asrCalls.length, { timeout: 30_000, message: '挂件没有发出语音上传请求' }).toBeGreaterThan(0);
    const req = w.asrCalls[0];
    expect(req.url(), '现状：挂件直连 yepairag').toContain('/yepairag/api/asr');
    const body = req.postDataJSON() ?? {};
    expect(Object.keys(body), '请求体只有 voiceContent').toEqual(['voiceContent']);
    expect(req.url(), 'URL 里没有商家身份（请求体已断言只有 voiceContent）').not.toContain(m.tenant);
    const res = await waitFor(req.response().then((r) => r ?? Promise.reject(new Error('没有响应'))), 'yepairag /api/asr 响应');
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(String(j.query), `转写结果：${JSON.stringify(j)}`).toMatch(/Australia/i);
    expect(count(logsSince('YEPAIRAG_LOGS', since), LOG.ASR), 'yepairag access 日志应有 POST /yepairag/asr').toBeGreaterThanOrEqual(1);
    // 只看语音别名：打开挂件的 greeting 在 concierge 下本身会产生 W23 行，和语音无关
    await expectNoW23(m.tenant, since, byAlias(ASR_ALIAS));
  });

  // BL-6 余额闸门现状：余额 ≤ 0 的商家店铺对话 → 400 INSUFFICIENT_CREDITS，日志 [Bill][gate] deny storefront-forward user=<租户>
  // 数据来源（2026-09-28）：autotest-account 领 bot/dev/unsubscribed（未订阅）账号。账号 16 = 租户 1211632914216980480：
  //   credits/overview availableCredits=0、creditPlan=false、planCode=null；W23 有 chatbot:acct:<租户> 钱包、balance=0；
  //   登录后落在 /plan-details（选套餐页），后台其它页面都进不去 → 只能测访客侧。账号只用来核对租户，访客侧不需要登录。
  // 实测拒绝理由是「wallet total null」（钱包总额没取到），不是「wallet total=0」；这里把理由原样记下来，不断言它等于 0。
  // 闸门在留资检查之前：该商家开着 Email Collection，也是 400 而不是 209；挂件打开时的 greeting 同样 400。
  test('BL-6 余额 ≤ 0 商家店铺对话 → 400 INSUFFICIENT_CREDITS，[Bill][gate] deny storefront-forward user=<租户>', async ({ browser }) => {
    test.skip(!env('E2E_ZERO_TENANT'), '缺余额 ≤ 0 的商家 E2E_ZERO_TENANT（可用 autotest-account 的 unsubscribed 账号对应租户，见上方注释）');
    const m = merchant('ZERO', false);
    const since = nowIso();
    const { page, w } = await visitor(browser, m);
    const before = await aiBubbleCount(w);
    const res = await visitorSend(page, w, 'Do you ship to Australia?');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.subtype).toBe('visit_limits_reached');
    expect(String(body.errorMessage)).toMatch(/^INSUFFICIENT_CREDITS/);
    const deny = `[Bill][gate] deny storefront-forward user=${m.tenant}`;
    const log = await poll(() => logsSince('CHATBOT_LOGS', since), (l) => l.includes(deny), 30_000, 5_000);
    const line = log.split('\n').find((l) => l.includes(deny));
    expect(line, `chatbot 日志应有 ${deny}`).toBeTruthy();
    const reason = line!.match(/deny storefront-forward user=\d+ — ([^"\\]*)/)?.[1] ?? '(未解析)';
    test.info().annotations.push({ type: '闸门拒绝理由', description: reason });
    console.log(`[BL-6] 闸门拒绝理由：${reason}`);
    await page.waitForTimeout(30_000);
    expect(await aiBubbleCount(w), '被拦下后不应有 AI 回复').toBe(before);
  });

  // BL-7 政策同步入口：商家打开后台首页 → GET …/integration/shopify/scope-upgrade-url
  test('BL-7 后台首页加载 → scope-upgrade-url 请求', async ({ browser }) => {
    const m = merchant('NEW');
    const admin = await adminPage(browser, m);
    const req = waitFor(admin.waitForRequest((r) => r.url().includes('/integration/shopify/scope-upgrade-url'), { timeout: 60_000 }), '后台首页发出 scope-upgrade-url');
    await admin.goto(`${cfg.base}/`, { waitUntil: 'domcontentloaded' });
    expect((await req).url()).toContain(m.tenant);
  });

  // BL-8 数字员工回归：Oscar 先 precheck、有回复；Maya 有回复；W23 每个 request_id 2 行
  for (const s of [
    { name: 'Oscar', path: '/ai-team/operation/chat', text: 'How many orders did we get this week?', precheck: true },
    // 不要让 Maya 写文案：会随机进入内容发布任务，弹 Quick setup 卡片后本轮以 aborted 结束、没有文字回复（设计行为，2026-09-27 实测 2/4 次）
    { name: 'Maya', path: '/ai-team/marketing/studio', text: 'In one sentence, what kind of products does our store sell? Just answer, no content creation.', precheck: false },
  ]) {
    test(`BL-8 ${s.name}：${s.precheck ? 'precheck + ' : ''}有回复，W23 每个 request_id 2 行`, async ({ browser }) => {
      const m = merchant('NEW');
      const admin = await adminPage(browser, m);
      const since = nowIso();
      const pre = s.precheck ? waitFor(admin.waitForRequest((r) => r.url().includes(`/credits/precheck/${m.tenant}`), { timeout: 60_000 }), `${s.name} 发送前的 /credits/precheck`) : null;
      await staffChatSend(admin, s.path, s.text);
      if (pre) await pre;
      expect((await waitStaffReply(admin)).length, `${s.name} 应有回复`).toBeGreaterThan(0);
      const rows = await waitW23(m.tenant, since, (r) => r.length >= 2, false);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rowsPerRequest(rows).every((n) => n === 2), `每个 request_id 应 2 行，实际 ${JSON.stringify(rowsPerRequest(rows))}`).toBe(true);
      expect(rows.some(isRagVkey), '数字员工不是 rag vkey').toBe(false);
    });
  }

  // BL-9 MCP 工具：AI 员工（dev 现状是 concierge）一轮里调 SEARCH_KNOWLEDGE_BASE 正常
  test('BL-9 concierge 一轮调 SEARCH_KNOWLEDGE_BASE：chatbot tool_result + yepairag MCP access 200', async ({ browser }) => {
    requireConciergeForAll();
    const m = merchant('NEW');
    const since = nowIso();
    await withLeadOff(browser, m, async () => {
      const { page, w } = await visitor(browser, m);
      await visitorRound(page, w, 'Do you ship to Australia? Please check your store policy.');
    });
    const cb = await poll(() => logsSince('CHATBOT_LOGS', since), (l) => l.includes(conciergeDone(m.tenant)), 60_000);
    expect(cb.includes(conciergeDone(m.tenant)), `chatbot 日志应有 ${conciergeDone(m.tenant)}`).toBe(true);
    expect(cb.includes(KB_TOOL), `chatbot 日志应有 ${KB_TOOL}`).toBe(true);
    const ylog = logsSince('YEPAIRAG_LOGS', since);
    const mcp = ylog.split('\n').filter((l) => mcpAccess(m.tenant).test(l));
    expect(mcp.length, '应有该商家的 MCP 调用').toBeGreaterThanOrEqual(1);
    expect(mcp.every((l) => /HTTP\/1\.1\\?" 2\d\d/.test(l)), `MCP 调用应全部 2xx（streamable HTTP 的通知返回 202）：\n${mcp.join('\n').slice(0, 800)}`).toBe(true);
  });

  // BL-10 改动点 5（llama_index 老链路）：访客打开挂件 → 挂件自己发 type=greeting → chatbot 转 yepairag /responseV3（非 text 事件，
  // 走 _handle_event → UnifiedLLM，W32 Q14）。concierge 只接 text / order_tracking，所以 dev 上 greeting 也走 yepairag（2026-09-27 实测）。
  // 日志特征（实测）：同一 taskName 下有带本轮 conversationId 的 message.hub.payload、Initializing LLM with provider、POST /yepairag/responseV3 200；
  // greeting 没有 Recorded conversation 行（那是 text 链路）。开关关闭：W23 无 rag vkey 行。
  test('BL-10 访客打开挂件 → greeting 走 yepairag /responseV3（UnifiedLLM），有问候，W23 无 rag vkey 行', async ({ browser }) => {
    const m = merchant('NEW', false);
    const since = nowIso();
    const { w } = await visitor(browser, m);
    const isGreeting = (b: Record<string, unknown>) => b.type === 'greeting';
    const greet = w.proxyResponses.find((r) => isGreeting(r.request().postDataJSON() ?? {}));
    expect(greet, '挂件展开后应发出 type=greeting 的 conversations/proxy').toBeTruthy();
    expect(greet!.status()).toBe(200);
    const conv = String((greet!.request().postDataJSON() ?? {}).conversation_id ?? '');
    expect(conv, 'greeting 请求体应带 conversation_id').toBeTruthy();
    await expect(w.frame.locator('[data-testid="bot-message"]').first(), '挂件里应出现问候').toBeVisible({ timeout: 60_000 });
    const needle = `'conversationId': '${conv}'`;
    const all = await poll(() => logsSince('YEPAIRAG_LOGS', since), (l) => {
      const t = yepairagTaskLog(l, needle);
      return !!t && /POST \/yepairag\/responseV3 HTTP\/1\.1\\?" 200/.test(t);
    }, 90_000);
    const round = yepairagTaskLog(all, needle);
    expect(round, `yepairag 日志里应有 conversationId=${conv} 的 greeting 处理`).toBeTruthy();
    expect(round!, 'greeting 走 UnifiedLLM（llama_index）').toContain('Initializing LLM with provider');
    expect(/POST \/yepairag\/responseV3 HTTP\/1\.1\\?" 200/.test(round!), 'greeting 这一轮 /responseV3 应 200').toBe(true);
    await sleep(90_000);
    expect(w23Rows(m.tenant, since).filter(isRagVkey), '开关关闭时不应有 rag vkey 的 W23 行').toEqual([]);
  });

  // BL-11 改动点 7（临时放行入口）：现状不带 vkey 也返回业务结果。
  // 界面触发点没找到（核验文档 B7-2 同样结论；dev 2026-09-27 02:18 起这四个入口 0 次调用），按接口直调 yepairag。
  // 本机跑：kubectl --context oldeks -n llm port-forward svc/yepairag-dev 18080:8080，再设 YEPAIRAG_BASE_URL=http://localhost:18080（跑完关掉）。
  // /tools/product、/tools/collection 要有商品数据的商家：新套餐测试商家从没同步过商品（返回空），用老套餐 918807096909901824（有商品）。
  test.describe('BL-11 临时放行入口（接口直调，不带 vkey）', () => {
    test.beforeEach(() => requireEnv('YEPAIRAG_BASE_URL'));
    const yep = (path: string) => `${env('YEPAIRAG_BASE_URL')}/yepairag${path}`;
    const cases: { name: string; kind: 'NEW' | 'LEGACY'; path: string; body: (t: string) => object; check: (j: Record<string, unknown>) => void }[] = [
      { name: 'selection-report', kind: 'NEW', path: '/operation/selection-report', body: () => ({ keywords: ['snowboard'] }), check: (j) => expect(j.status).toBe('success') },
      { name: 'sourcing-signals', kind: 'NEW', path: '/operation/sourcing-signals', body: (t) => ({ tenant_id: t, keywords: ['snowboard'], market: 'US' }), check: (j) => expect(j.status, 'degraded = LLM 步骤失败后降级').toBe('success') },
      { name: 'tools/product', kind: 'LEGACY', path: '/tools/product', body: (t) => ({ tenant_id: t, query: 'snowboard' }), check: (j) => expect((j.Product_information as unknown[] | undefined)?.length ?? 0, '应返回商品').toBeGreaterThan(0) },
      { name: 'tools/collection', kind: 'LEGACY', path: '/tools/collection', body: (t) => ({ tenant_id: t }), check: (j) => expect(Array.isArray(j.collection_information), '应返回 collection_information 数组').toBe(true) },
    ];
    for (const c of cases) {
      test(`BL-11 ${c.name} 不带 vkey → 200 业务结果，无 VkeyMissing，W23 无该商家 rag vkey 行`, async ({ request }) => {
        const m = merchant(c.kind, false);
        const since = nowIso();
        // sourcing-signals 实测约 160 秒
        const res = await request.post(yep(c.path), { data: c.body(m.tenant), timeout: 240_000 });
        const text = await res.text();
        expect(res.status(), `${c.path} → ${res.status()}：${text.slice(0, 300)}`).toBe(200);
        c.check(JSON.parse(text));
        const log = logsSince('YEPAIRAG_LOGS', since);
        for (const e of [...VKEY_ERRORS, LOG.SELECTION_RANK_FAILED]) expect(count(log, e), `yepairag 日志不应出现 ${e}`).toBe(0);
        expect(count(log, LOG.SOURCING_FAILED), 'yepairag 日志不应出现 [SourcingSignals] … call failed').toBe(0);
        await sleep(90_000);
        expect(w23Rows(m.tenant, since).filter(isRagVkey), '不应有该商家 rag vkey 的 W23 行').toEqual([]);
      });
    }
  });

  // BL-12 老套餐商家（918807096909901824，已发 7000 止血额度）店铺访客对话：dev 上走 concierge，有回复。
  // autotest-account 没有老套餐类型的账号（只有 growth / core / unsubscribed / cancel），拿不到登录凭据：只走访客侧，余额断言跳过；
  // 也就没法临时关 Email Collection——该商家开着留资时本条 skip 并写明。
  test('BL-12 老套餐商家店铺访客对话（dev 走 concierge）：有回复，[Concierge] turn done，W23 每个 request_id 2 行（余额断言跳过：无登录凭据）', async ({ browser }) => {
    requireConciergeForAll();
    const m = merchant('LEGACY', false);
    const since = nowIso();
    const { w } = await visitor(browser, m);
    const text = 'What is your return policy?';
    const before = w.proxyResponses.length;
    await w.input.fill(text);
    await widgetSend(w.frame, w.input);
    const mine = () => w.proxyResponses.slice(before).find((r) => (r.request().postDataJSON() ?? {}).type !== 'greeting');
    await expect.poll(() => !!mine(), { timeout: 90_000, message: '本条消息的 conversations/proxy 没有响应' }).toBe(true);
    test.skip(mine()!.status() === 209, '老套餐商家开着 Email Collection（209 lead_required），没有登录凭据无法临时关闭（数据待准备）');
    expect(mine()!.status(), `proxy → ${mine()!.status()}：${(await mine()!.text()).slice(0, 200)}`).toBe(200);
    expect((await waitReplyAfter(w.frame, text, 120_000, () => netHint(w))).length, '应有回复').toBeGreaterThan(0);
    const log = await poll(() => logsSince('CHATBOT_LOGS', since), (l) => l.includes(conciergeDone(m.tenant)), 60_000);
    expect(log.includes(conciergeDone(m.tenant)), `chatbot 日志应有 ${conciergeDone(m.tenant)}`).toBe(true);
    const rows = await waitW23(m.tenant, since, (r) => r.length >= 2, false);
    expect(rows.length, 'concierge 这一轮应在 W23 留下记录').toBeGreaterThanOrEqual(2);
    expect(rowsPerRequest(rows).every((n) => n === 2), `每个 litellm_request_id 应恰好 2 行，实际 ${JSON.stringify(rowsPerRequest(rows))}`).toBe(true);
    console.log(`[BL-12] 老套餐 W23 本轮 credits=${rows.filter((r) => r.platform === 'chatbot').map((r) => r.credits).join(',')}（余额断言跳过：无登录凭据）`);
  });
});
