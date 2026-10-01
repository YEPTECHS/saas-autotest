// 页面操作：后台登录、读余额 / 用量明细、定制配置、假页面注入挂件（E2E 文档 S1 路径 B）、Inbox、知识库、预览、Brand IQ、数字员工对话。
// 选择器和接口按 pm/docs/tasks/bdd-answers-2026-09-27/PM-verified-facts-for-e2e.md（PM playwright 实测，老 dev）。
// 挂件 data-testid 和知识库删除按钮见该文档文末「补充」。数字员工对话页没有 data-testid，回复只能用页面文本变化判断。
import { test, expect, type Browser, type BrowserContext, type Page, type Request, type Response, type FrameLocator, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cfg, type Merchant, poll, env } from './config';

// ---------- 后台登录 + 取接口鉴权头 ----------

const authHeaders = new WeakMap<Page, Record<string, string>>();

/** 登录后台（选择器同 src/flows/_shared/login.steps.yml）。实测：前端调 chatbot-api 带 Authorization 头，抓下来给 page.request 用（页面内跨域 fetch 会失败）。 */
export async function login(page: Page, m: Merchant) {
  page.on('request', (req) => {
    const h = req.headers();
    if (req.url().includes('/chatbot/api/') && h.authorization) authHeaders.set(page, { authorization: h.authorization });
  });
  await page.goto(`${cfg.base}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.fill("input[type='email'], input[name='email'], #email", m.email);
  await page.fill("input[type='password'], input[name='password'], #password", m.password);
  await page.click("button[type='submit']:not([disabled])");
  // plan-details：未订阅账号登录后落在选套餐页（2026-09-28 dev 实测，账号池 unsubscribed 类型）
  await page.waitForURL(/dashboard|home|ai-training|analytics|customers|onboarding|ai-team|platform|inbox|plan-details/, { timeout: 30_000 });
  await expect.poll(() => !!authHeaders.get(page), { message: '登录后没抓到前端调 chatbot-api 的 Authorization 头', timeout: 30_000 }).toBe(true);
}

/** 登录后抓到的 chatbot-api 鉴权头（{authorization}）；只在内存里传，不打印。 */
export const authOf = (page: Page) => authHeaders.get(page);

const apiUrl = (path: string) => `${cfg.api}/chatbot/api${path}`;

export async function apiGet(page: Page, path: string) {
  const res = await page.request.get(apiUrl(path), { headers: authHeaders.get(page) ?? {} });
  expect(res.ok(), `GET ${path} → ${res.status()}`).toBe(true);
  return res.json();
}

export async function apiPut(page: Page, path: string, data: unknown) {
  const res = await page.request.put(apiUrl(path), { headers: authHeaders.get(page) ?? {}, data });
  expect(res.ok(), `PUT ${path} → ${res.status()}`).toBe(true);
  return res;
}

/** 余额 = GET /v1/credits/overview/{userId} 的 availableCredits。 */
export async function balance(page: Page, tenant: string): Promise<number> {
  const j = await apiGet(page, `/v1/credits/overview/${tenant}`);
  const v = Number(j?.availableCredits ?? j?.data?.availableCredits);
  expect(Number.isFinite(v), `credits/overview 没有 availableCredits：${JSON.stringify(j).slice(0, 300)}`).toBe(true);
  return v;
}

export async function waitBalance(page: Page, tenant: string, ok: (v: number) => boolean) {
  return poll(() => balance(page, tenant), ok);
}

export interface HistoryItem {
  id: string;
  direction: string;
  amount: number;
  source: string;
  createdAt: string;
}

/** 用量明细 GET /v1/credits/history/{userId}?limit=50。实测 agentRef / actionType 都是 null：只能断言「多了 debit、金额对得上」，按功能归属用 W23 SQL。 */
export async function history(page: Page, tenant: string): Promise<HistoryItem[]> {
  const j = await apiGet(page, `/v1/credits/history/${tenant}?limit=50`);
  const list = Array.isArray(j) ? j : (j?.data ?? j?.items ?? j?.content ?? []);
  return list as HistoryItem[];
}

export const debitsSince = (items: HistoryItem[], sinceIso: string) =>
  items.filter((i) => i.direction === 'debit' && Date.parse(i.createdAt) >= Date.parse(sinceIso));

/** 定制配置：GET/PUT /v1/customisations/{userId}。实测 PUT 体 = 只含要改的对象的数组（对象原样取自 GET，只改 value）。结束后恢复。
 *  patch 的 key 是配置名（如 enableLead / leadOnStart），按 type=chatbot 的对象里哪个字段等于该名字来定位。 */
export async function withCustomisation(page: Page, tenant: string, patch: Record<string, string>, fn: () => Promise<void>) {
  const all = await apiGet(page, `/v1/customisations/${tenant}`);
  const list: Record<string, unknown>[] = Array.isArray(all) ? all : (all?.data ?? []);
  const pick = (name: string) => {
    const o = list.find((x) => x.type === 'chatbot' && Object.entries(x).some(([k, v]) => k !== 'value' && v === name));
    expect(o, `customisations 里找不到 type=chatbot 的 ${name}`).toBeTruthy();
    return o!;
  };
  const originals = Object.keys(patch).map((k) => ({ ...pick(k) }));
  try {
    await apiPut(page, `/v1/customisations/${tenant}`, originals.map((o, i) => ({ ...o, value: Object.values(patch)[i] })));
    await fn();
  } finally {
    await apiPut(page, `/v1/customisations/${tenant}`, originals);
  }
}

// ---------- 挂件（假页面注入，非预览）----------

export const WIDGET_IFRAME = 'iframe[src*="chat-bot"]';
const WIDGET_INPUT = '[data-testid="message-input"]';
const AI_BUBBLE = '[data-testid="bot-message"]';
export const USER_BUBBLE = '[data-testid="user-message"]';

export interface Widget {
  frame: FrameLocator;
  input: Locator;
  proxyCalls: Request[];
  proxyResponses: Response[];
  asrCalls: Request[];
  /** 页面上失败的网络请求（只记 yepai 域名）。等待失败时写进报错，用来区分「本机网络断了」和「dev 真出问题」 */
  netErrors: string[];
}

/** 等待失败时附带的网络诊断（2026-09-27 PM 复跑：本机到 api-test / widget.yepai.io 的连接被整批 ERR_CONNECTION_CLOSED，
 *  表现成「挂件没加载」「没有回复」，实际是网络断了）。 */
export const netHint = (w: Pick<Widget, 'netErrors'>) =>
  w.netErrors.length ? `；期间本机网络请求失败 ${w.netErrors.length} 次，最近：${w.netErrors.slice(-3).join(' | ')}` : '';

/** 用 page.route 接管店铺域名下的一个路径，返回嵌入挂件脚本的假页面（E2E 文档 S1 路径 B）。 */
export async function openFakeShop(page: Page, m: Merchant, opts: { expand?: boolean; widgetScript?: string } = { expand: true }): Promise<Widget> {
  const url = `https://${m.shop}/e2e-widget`;
  const html = `<!doctype html><html><body><h1>e2e</h1>
<script src="${opts.widgetScript ?? cfg.widgetScript}" data-type="chatbot" data-user-id="${m.tenant}" data-origin="${cfg.widgetOrigin}"></script></body></html>`;
  await page.route(url, (r) => r.fulfill({ contentType: 'text/html', body: html }));
  const frame = page.frameLocator(WIDGET_IFRAME);
  const w: Widget = { frame, input: frame.locator(WIDGET_INPUT).first(), proxyCalls: [], proxyResponses: [], asrCalls: [], netErrors: [] };
  page.on('requestfailed', (req) => {
    const f = req.failure()?.errorText ?? '';
    // 视频背景的 ERR_ABORTED 是挂件自己取消的，不算
    if (/yepai\.(io|ai)/.test(req.url()) && !/ERR_ABORTED/.test(f)) w.netErrors.push(`${new Date().toISOString().slice(11, 19)} ${f} ${req.url().slice(0, 80)}`);
  });
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/conversations/proxy')) w.proxyCalls.push(req);
    if (req.method() === 'POST' && /\/asr(\b|$)/.test(req.url())) w.asrCalls.push(req);
  });
  page.on('response', (res) => {
    if (res.request().method() === 'POST' && res.url().includes('/conversations/proxy')) w.proxyResponses.push(res);
  });
  await page.goto(url);
  await page.waitForSelector(WIDGET_IFRAME, { timeout: 30_000 }).catch((e: Error) => {
    throw new Error(`挂件 iframe 30 秒没出现（挂件脚本 ${opts.widgetScript ?? cfg.widgetScript}）${netHint(w)}\n${e.message}`);
  });
  if (opts.expand !== false) {
    await expandWidget(w);
    // 挂件展开后会自己发一次 type=greeting（W3 Q14）。2026-09-27 dev 实测：greeting 回来之前就发消息，concierge 这一轮会 60 秒 TIMEOUT 再回落 yepairag。
    // 真实访客不会在挂件初始化完成前发消息，所以先等 greeting 响应；ponytail: 30 秒没有 greeting（旧版挂件等）就照常继续
    const greeted = () => w.proxyResponses.some((r) => (r.request().postDataJSON() ?? {}).type === 'greeting');
    await expect.poll(greeted, { timeout: 30_000 }).toBe(true).catch(() => console.log('[openFakeShop] 30 秒内没等到 greeting 响应，继续'));
  }
  return w;
}

export async function expandWidget(w: Widget) {
  if (!(await w.input.isVisible().catch(() => false))) await w.frame.locator('[data-testid="minimized-chat-button"]').click();
  await w.input.waitFor({ timeout: 30_000 });
}

export const aiBubbleCount = (w: Widget) => w.frame.locator(AI_BUBBLE).count();

/** 挂件（店铺 / 预览同一套）点发送按钮。2026-09-27 dev 实测：
 *  - 预览里 press('Enter') 发不出去，文字留在输入框；按钮 aria-label="Send message"、data-testid="send-button"；
 *  - Playwright 普通 click 在挂件初始化期间会被外层页面 <html> 挡住（intercepts pointer events），重试 10 秒也点不上，所以直接派发事件。 */
export async function widgetSend(frame: FrameLocator, input: Locator) {
  const btn = frame.locator('[data-testid="send-button"], button[aria-label="Send message"]').first();
  if (!(await btn.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false))) return input.press('Enter'); // ponytail: 找不到按钮才退回 Enter，兼容旧版挂件
  // 实测：单发 DOM click() 不触发发送；按顺序派发整套指针事件才行（挂件监听的是 pointer/mouse 事件）
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) await btn.dispatchEvent(t);
}

/** 给 waitForRequest / waitForResponse 的超时报错补上「等的是哪个请求」（它本身的报错只有 Timeout）。 */
export const waitFor = <T>(p: Promise<T>, what: string): Promise<T> =>
  p.catch((e: unknown) => {
    throw new Error(`等待 ${what} 失败：${e instanceof Error ? e.message : String(e)}`);
  });

/** 访客发一条消息；返回 proxy 响应。209 lead_required 直接判前置条件不满足（Email Collection 没关）。 */
export async function visitorSend(page: Page, w: Widget, text: string): Promise<Response> {
  const before = w.proxyResponses.length;
  // 2026-09-27 dev 实测：挂件第一次发消息时会同时发 type=greeting 和本条消息两个 proxy 请求，响应先后不定——只认非 greeting 的那条
  const mine = () => w.proxyResponses.slice(before).find((r) => (r.request().postDataJSON() ?? {}).type !== 'greeting');
  await w.input.fill(text);
  await widgetSend(w.frame, w.input);
  const t0 = Date.now();
  // ponytail: 90 秒——dev 实测 async proxy 在返回前会先做留资意图判断，30 秒不够；超时报错里区分「没发出」和「发出了没响应」
  await expect
    .poll(() => !!mine(), { timeout: 90_000, message: '本条消息的 conversations/proxy 90 秒内没有响应（发送按钮没点上，或接口没返回）' })
    .toBe(true);
  const res = mine()!;
  console.log(`[visitorSend] proxy ${res.status()} 用时 ${Date.now() - t0}ms`);
  expect(res.status(), '返回 209 lead_required：该商家 Email Collection（enableLead）没关（BDD 0.2 前置条件）').not.toBe(209);
  return res;
}

/** 等挂件里出现新的 AI 回复（经 Message Hub 推回，实测约 40 秒）。 */
export async function waitAiReply(w: Widget, beforeCount: number, timeout = 120_000): Promise<string> {
  await expect.poll(() => aiBubbleCount(w), { timeout, message: '挂件里没有出现新的 AI 回复' }).toBeGreaterThan(beforeCount);
  return (await w.frame.locator(AI_BUBBLE).last().innerText()).trim();
}

/** 等挂件里「本条访客消息之后」出现的 AI 气泡，返回其文字。
 *  不能只数气泡：第一次发消息时 greeting 的欢迎语也会冒出来；预览里旧气泡会被替换，数量不涨（2026-09-27 dev 实测）。 */
export async function waitReplyAfter(frame: FrameLocator, text: string, timeout = 120_000, hint: () => string = () => ''): Promise<string> {
  const after = frame.locator(USER_BUBBLE, { hasText: text }).last().locator(`xpath=following::*[@data-testid="bot-message"]`);
  await expect.poll(() => after.count(), { timeout, message: '本条访客消息之后没有出现 AI 回复' }).toBeGreaterThan(0).catch((e: Error) => {
    throw new Error(`${e.message.split('\n')[0]}${hint()}\n${e.message}`);
  });
  return (await after.last().innerText()).trim();
}

/** 一轮完整的访客对话：发送 → 断言 isPreview=false → 等回复。返回 conversation_id，用来在 yepairag 日志里找到这一轮。 */
export async function visitorRound(page: Page, w: Widget, text: string, timeout = 120_000) {
  const res = await visitorSend(page, w, text);
  const body = res.request().postDataJSON() ?? {};
  expect(body.isPreview, 'conversations/proxy 请求体 isPreview 应为 false').toBeFalsy();
  const reply = await waitReplyAfter(w.frame, text, timeout, () => netHint(w));
  expect(reply).not.toMatch(/Connection issue, please hold on/);
  return { res, body, reply, conv: String(body.conversation_id ?? '') };
}

// ---------- 录音：用 addInitScript 把 getUserMedia 换成播放指定 wav 的 MediaStream（实测可走通录音 → 上传）----------

/** wavBase64：macOS `say -o ask.wav --data-format=LEI16@16000 "Do you ship to Australia"` 生成的文件。对所有 frame（含挂件 iframe）生效。 */
export async function injectMicrophone(ctx: BrowserContext, wavBase64: string) {
  await ctx.addInitScript((b64: string) => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (!c?.audio) return orig(c);
      const ac = new AudioContext();
      await ac.resume();
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const buf = await ac.decodeAudioData(bytes.buffer);
      const src = ac.createBufferSource();
      src.buffer = buf;
      const dest = ac.createMediaStreamDestination();
      src.connect(dest);
      src.start();
      return dest.stream;
    };
  }, wavBase64);
}

export const ASR_PHRASE = 'Do you ship to Australia';

/** 取录音 wav 的 base64：优先 E2E_ASR_WAV；否则用 macOS say 现场生成；都不行就 skip。 */
export function wavBase64(): string {
  let file = env('E2E_ASR_WAV');
  if (!file) {
    file = join(tmpdir(), 'e2e-mainline-b-ask.wav');
    if (!existsSync(file)) {
      try {
        execFileSync('say', ['-o', file, '--data-format=LEI16@16000', ASR_PHRASE]);
      } catch {
        test.skip(true, '没有 E2E_ASR_WAV，本机也没有 macOS say，无法生成录音');
      }
    }
  }
  return readFileSync(file).toString('base64');
}

export async function recordVoice(w: Widget, ms = 3_500) {
  await w.frame.locator('[data-testid="mic-button"]').click();
  await w.frame.locator('[data-testid="stop-recording-button"]').waitFor({ timeout: 10_000 });
  await new Promise((r) => setTimeout(r, ms));
  await w.frame.locator('[data-testid="stop-recording-button"]').click();
}

// ---------- 后台：Inbox / 知识库 / 预览 / Brand IQ / 数字员工 ----------

/** 在 Inbox 用会话里的一句话点开会话 times 次，返回实际发出的 GET …/human/summary 次数（每打开一次生成一次，Q27）。 */
export async function openInboxConversation(page: Page, text: string, times: number): Promise<number> {
  let k = 0;
  const onReq = (r: Request) => {
    if (r.method() === 'GET' && r.url().includes('/human/summary')) k++;
  };
  page.on('request', onReq);
  for (let i = 0; i < times; i++) {
    await page.goto(`${cfg.base}/inbox/conversations`, { waitUntil: 'domcontentloaded' });
    await page.getByText(text).first().click({ timeout: 60_000 });
    await expect.poll(() => k, { timeout: 30_000, message: '打开会话没有发出 GET …/human/summary' }).toBeGreaterThan(i);
  }
  await page.waitForTimeout(3_000);
  page.off('request', onReq);
  return k;
}

/** /platform/settings → Upload Sources → Add manually → 问 / 答 → Upload（实测）。返回 train 请求的响应 Promise。 */
export async function kbAddManually(page: Page, tenant: string, q: string, a: string) {
  await page.goto(`${cfg.base}/platform/settings`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Upload Sources' }).click();
  await page.getByText('Add manually', { exact: true }).click();
  await page.locator('input[placeholder="Enter your question"]').fill(q);
  await page.locator('textarea[placeholder="Enter your answer"]').fill(a);
  const create = waitFor(page.waitForResponse((r) => r.request().method() === 'POST' && new RegExp(`/v1/sources/${tenant}(\\?|$)`).test(r.url()), { timeout: 60_000 }), `POST /v1/sources/${tenant} 响应（知识源创建）`);
  const train = waitFor(page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/v1/sources/train/${tenant}`), { timeout: 60_000 }), `POST /v1/sources/train/${tenant} 响应（知识库训练）`);
  train.catch(() => {}); // 创建断言先失败时，别让 train 变成未处理的 rejection；调用方 await 仍会拿到报错
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  const c = await create;
  expect(c.status(), 'POST /v1/sources/{userId} 应返回 201').toBe(201);
  return train;
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kbRow = (page: Page, text: string) => page.getByRole('row', { name: new RegExp(escapeRe(text)) });

/** 列表行状态 Syncing → Synced（实测约 1–2 分钟）。 */
export async function waitKbSynced(page: Page, text: string) {
  // 2026-09-27 dev 实测：列表不会自己刷新状态，要重新加载页面才看得到 Synced
  await expect
    .poll(
      async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        // isVisible 不等待；用 waitFor 给列表加载留时间
        return kbRow(page, text).filter({ hasText: 'Synced' }).waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
      },
      { timeout: 300_000, intervals: [20_000], message: `知识库条目「${text}」5 分钟内没有变成 Synced` },
    )
    .toBe(true);
}

/** 删除知识源（实测：该行里的 Delete 按钮）。删除后 chatbot 会自动重训。 */
export async function kbDeleteByText(page: Page, text: string) {
  await page.goto(`${cfg.base}/platform/settings`, { waitUntil: 'domcontentloaded' });
  await kbRow(page, text).getByRole('button', { name: 'Delete' }).click();
  // 确认弹窗「Confirm Delete」→ 按钮 Delete（实测）。弹窗是动画弹出的，要等它出现再点，并确认这一行真的没了
  await page.getByRole('dialog').getByRole('button', { name: /^(delete|confirm|yes)/i }).click({ timeout: 10_000 });
  await expect(kbRow(page, text), `知识库条目「${text}」删除后应从列表消失`).toHaveCount(0, { timeout: 60_000 });
}

/** 后台 Anna 预览发一条消息（iframe URL 含 chat-bot-dev-preview）。返回请求体（应带 isPreview:true）和响应。 */
export async function previewSend(page: Page, text: string) {
  const isProxy = (r: Request) => r.method() === 'POST' && r.url().includes('/conversations/proxy');
  const typeOf = (r: Request) => (r.postDataJSON() ?? {}).type;
  // 同店铺挂件：greeting 回来之前挂件还没初始化完，点发送不生效（2026-09-27 dev 实测）
  const greeted = page.waitForResponse((r) => isProxy(r.request()) && typeOf(r.request()) === 'greeting', { timeout: 30_000 }).catch(() => console.log('[previewSend] 30 秒内没等到 greeting 响应，继续'));
  await page.goto(`${cfg.base}/ai-team/anna/chat?preview=1`, { waitUntil: 'domcontentloaded' });
  const frame = page.frameLocator('iframe[src*="chat-bot-dev-preview"]');
  const input = frame.locator(WIDGET_INPUT).first();
  await input.waitFor({ timeout: 60_000 });
  await greeted;
  const before = await frame.locator(AI_BUBBLE).count();
  const reqP = waitFor(page.waitForRequest((r) => isProxy(r) && typeOf(r) !== 'greeting', { timeout: 60_000 }), '预览发出 POST /conversations/proxy 请求（消息没发出去？）');
  const resP = waitFor(page.waitForResponse((r) => isProxy(r.request()) && typeOf(r.request()) !== 'greeting', { timeout: 60_000 }), '预览 POST /conversations/proxy 响应');
  await input.fill(text);
  await widgetSend(frame, input);
  const [req, res] = await Promise.all([reqP, resP]);
  return { frame, body: req.postDataJSON() ?? {}, res, before, text };
}

/** Brand IQ：/platform/settings → Auto Set Up → 弹窗按钮 Analyze My Store & Auto-Setup（实测）。返回 request-analysis 请求。 */
export async function brandIqAutoSetup(page: Page, tenant: string) {
  await page.goto(`${cfg.base}/platform/settings`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Auto Set Up' }).click();
  const req = waitFor(page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/brand-profiles/${tenant}/request-analysis`), { timeout: 60_000 }), `Brand IQ 发出 POST /brand-profiles/${tenant}/request-analysis`);
  await page.getByRole('button', { name: 'Analyze My Store & Auto-Setup' }).click();
  return req;
}

/** 数字员工页面（/ai-team/operation/chat、/ai-team/marketing/studio）：输入框是页面最后一个 textarea（实测）。回复区域未实测，用页面文本增长判断。 */
const staffReplies = new WeakMap<Page, string[]>();
const staffEnds = new WeakMap<Page, string[]>();

export async function staffChatSend(page: Page, path: string, text: string) {
  // 数字员工 WS（…/digital-staff/ws/{tenant}?agentType=…）一轮结束时推一帧带 full_response（2026-09-27 dev 实测 Maya）。
  // 页面文本增长不可靠：发消息后开场提示按钮会消失，总文本反而变短
  const replies: string[] = [];
  const ends: string[] = [];
  staffReplies.set(page, replies);
  staffEnds.set(page, ends);
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/digital-staff/ws/')) return;
    ws.on('framereceived', (f) => {
      try {
        const j = JSON.parse(String(f.payload));
        if (typeof j.full_response === 'string') replies.push(j.full_response);
        // 没有文字回复就结束的帧：error（如并发连接超限）、aborted（如 Maya 进入内容发布任务、弹出 Quick setup 卡片后本轮结束）
        if (j.type === 'error' || j.type === 'aborted') ends.push(JSON.stringify(j).slice(0, 300));
        if (j.type === 'tool_call') ends.push(`(tool_call ${j.name})`);
      } catch { /* 非 JSON 帧 */ }
    });
  });
  await page.goto(`${cfg.base}${path}`, { waitUntil: 'domcontentloaded' });
  const box = page.locator('textarea').last();
  await box.waitFor({ timeout: 60_000 });
  const bodyBefore = (await page.locator('body').innerText()).length;
  await box.fill(text);
  await box.press('Enter');
  return bodyBefore;
}

/** 等数字员工这一轮的完整回复（WS full_response 帧），返回回复文字。须先调 staffChatSend。 */
export async function waitStaffReply(page: Page, timeout = 180_000): Promise<string> {
  const replies = staffReplies.get(page) ?? [];
  const ends = staffEnds.get(page) ?? [];
  const ended = () => ends.some((e) => !e.startsWith('(tool_call'));
  await expect.poll(() => replies.length > 0 || ended(), { timeout, message: '数字员工 WS 没有推回 full_response（没有回复）' }).toBe(true);
  expect(replies.length, `数字员工这一轮没有文字回复就结束了：${ends.join(' → ')}`).toBeGreaterThan(0);
  return replies[replies.length - 1];
}

export async function waitPageGrows(page: Page, before: number, timeout = 180_000) {
  await expect.poll(async () => (await page.locator('body').innerText()).length, { timeout, message: '页面上没有出现回复' }).toBeGreaterThan(before + 20);
}

/** 标记文本，便于在 Inbox / 日志里找到本轮。 */
export const marker = (tag: string) => `[e2e-${tag}-${Date.now().toString(36)}]`;

// ---------- 组合：后台页 / 访客页各用独立 context（访客不带后台登录态、不带 keepChatOpen）----------

/** 挡掉 GA/GTM，防止 E2E 往生产 GA4 打数据；清 sessionStorage 里 ga 开头的键（ga_real 有粘性）。context 关闭时打印拦截次数。 */
const openContexts = new Set<BrowserContext>();

/** 关掉本 worker 里经 blockGa 建的全部 context。用例结束要调：context 不关，数字员工 WS 连接一直挂着，
 *  攒多了会被拒（2026-09-27 dev 实测 "Too many active Digital Staff conversations"）。 */
export async function closeContexts() {
  for (const c of [...openContexts]) await c.close().catch(() => {});
}

export async function blockGa(ctx: BrowserContext) {
  openContexts.add(ctx);
  ctx.on('close', () => openContexts.delete(ctx));
  let aborted = 0;
  await ctx.route(/google-analytics\.com|googletagmanager\.com|analytics\.google\.com|doubleclick\.net/, (r) => {
    aborted++;
    return r.abort();
  });
  // ponytail: 只删 ga 开头的键，不 clear()——initScript 每次导航都跑，clear() 会冲掉 sessionStorage 里可能存在的登录态
  await ctx.addInitScript(() => {
    try {
      for (const k of Object.keys(sessionStorage)) if (k.toLowerCase().startsWith('ga')) sessionStorage.removeItem(k);
    } catch { /* about:blank 等无 storage 的 frame */ }
  });
  ctx.on('close', () => console.log(`[GA-BLOCK] aborted=${aborted}`));
  return ctx;
}

export async function adminPage(browser: Browser, m: Merchant) {
  const ctx = await blockGa(await browser.newContext());
  const page = await ctx.newPage();
  await login(page, m);
  return page;
}

export async function visitor(browser: Browser, m: Merchant, opts?: { expand?: boolean; wavBase64?: string; widgetScript?: string }) {
  const ctx = await blockGa(await browser.newContext());
  if (opts?.wavBase64) await injectMicrophone(ctx, opts.wavBase64);
  const page = await ctx.newPage();
  const w = await openFakeShop(page, m, { expand: true, ...opts });
  return { page, w };
}
