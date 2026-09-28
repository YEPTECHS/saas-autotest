// 改造后（无开关，09-28）。BDD 第 11 节：第 9 项——语音转文字记到商家（@item9，整组可删）。
// 契约（W3 定稿，chatbot-api 4fc25abf1 / 挂件 e080d05）：POST <chatbot API 前缀>/widget/asr（与 /widget/conversations/proxy 同前缀），
//   body {tenant_id, referrerUrl, voiceContent, isPreview}，响应 yepairag 原样 {query}；先做来源校验，再过 asr 闸门，
//   余额不足抛 LimitExceededException（message 前缀 INSUFFICIENT_CREDITS / BALANCE_UNREADABLE），再带商家 vkey 转发 yepairag /yepairag/asr。
// yepairag /asr 不带 vkey（旧挂件直连）→ 平台 vkey（PLATFORM_FALLBACK_ENTRIES）。B9-5（开关关闭时行为不变）已删。
// 录音（PM 实测）：macOS `say -o ask.wav --data-format=LEI16@16000 "Do you ship to Australia"` 生成真实录音，
// 用 addInitScript 把 getUserMedia 换成播放该文件的 MediaStream；挂件麦克风 mic-button → stop-recording-button。
import { test, expect } from '@playwright/test';
import { merchant, requireEnv, env, nowIso, cfg } from '../lib/config';
import { adminPage, visitor, recordVoice, balance, waitBalance, waitFor, USER_BUBBLE, wavBase64 } from '../lib/web';
import { waitW23, expectNoW23, logsSince, count, LOG, VKEY_ERRORS, w23RowsByAlias, gateDeny } from '../lib/backend';

const ASR_ALIAS = env('ASR_MODEL') || 'whisper-1';
const WIDGET_ASR = `${cfg.api}/chatbot/api/widget/asr`;
const isMerchantAccount = (r: Record<string, string>) => /^chatbot:acct:/.test(r.account_key ?? '');

// B9 只断言「转写出来了」：识别结果出现在输入框（message-input）或访客消息（user-message）里即可，不要求发送（2026-09-27 dev 实测：转写填进输入框、不自动发送）。
// 输入框的文字是 value 不是 textContent，hasText 匹配不到，所以读 inputValue。
const expectTranscript = (w: Awaited<ReturnType<typeof visitor>>['w']) =>
  expect
    .poll(async () => `${await w.input.inputValue().catch(() => '')} ${(await w.frame.locator(USER_BUBBLE).allInnerTexts().catch(() => [])).join(' ')}`, {
      timeout: 60_000,
      message: '语音转写结果（输入框或访客消息）里没有 Australia',
    })
    .toMatch(/Australia/i);

test.describe('@item9 改造后 第 9 项：语音转文字', () => {
  // B9-1 新套餐商家的访客语音提问经 chatbot 转写，并计入该商家
  test('B9-1 [BL-5 → 改造后] 语音 → chatbot /widget/asr（body 四字段、带商家 ID），不再直连 yepairag，转写含 Australia，W23 该商家有语音行，余额减少', async ({ browser }) => {
    const m = merchant('NEW');
    const b64 = wavBase64();
    const admin = await adminPage(browser, m);
    const A = await balance(admin, m.tenant);
    const since = nowIso();
    const { w } = await visitor(browser, m, { wavBase64: b64 });
    await recordVoice(w);
    await expect.poll(() => w.asrCalls.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const urls = w.asrCalls.map((r) => r.url());
    expect(urls.some((u) => u.includes('/widget/asr')), `应调 chatbot /widget/asr，实际：${urls}`).toBe(true);
    expect(urls.some((u) => u.includes('/yepairag/')), '不应再直连 yepairag').toBe(false);
    const asr = w.asrCalls.find((r) => r.url().includes('/widget/asr'))!;
    const body = asr.postDataJSON() ?? {};
    expect(Object.keys(body).sort(), 'W3 定稿请求体').toEqual(['isPreview', 'referrerUrl', 'tenant_id', 'voiceContent']);
    expect(body.tenant_id).toBe(m.tenant);
    expect(body.isPreview).toBe(false);
    const res = await waitFor(asr.response().then((r) => r ?? Promise.reject(new Error('没有响应'))), 'chatbot /widget/asr 响应');
    expect(res.status()).toBe(200);
    expect(String((await res.json()).query)).toMatch(/Australia/i);
    await expectTranscript(w);
    const rows = await waitW23(m.tenant, since, (r) => r.some((x) => x.model_alias === ASR_ALIAS));
    expect(rows.some((x) => x.model_alias === ASR_ALIAS)).toBe(true);
    expect(await waitBalance(admin, m.tenant, (v) => v < A)).toBeLessThan(A);
  });

  // B9-2 零余额商家的访客语音提问被 chatbot /widget/asr 的 asr 闸门拦下（接口级：挂件对失败只走现有 ASR 失败处理，不加交互）
  test('B9-2 [BL-5+BL-6 → 改造后] 零余额商家 POST /widget/asr → 400 INSUFFICIENT_CREDITS + [Bill][gate] deny asr，yepairag 无 ASR 请求，无 W23 行', async ({ request }) => {
    requireEnv('E2E_ZERO_TENANT');
    const m = merchant('ZERO', false);
    const since = nowIso();
    const res = await request.post(WIDGET_ASR, {
      data: { tenant_id: m.tenant, referrerUrl: `https://${m.shop}/`, voiceContent: wavBase64(), isPreview: false },
    });
    const text = await res.text();
    expect(res.status(), text).toBe(400);
    // 错误体结构与 proxy 同一异常处理（ExceptionHandlerV1）；message 前缀即错误码
    expect(text).toMatch(/INSUFFICIENT_CREDITS/);
    expect(count(logsSince('CHATBOT_LOGS', since), gateDeny('asr', m.tenant))).toBeGreaterThanOrEqual(1);
    expect(count(logsSince('YEPAIRAG_LOGS', since), LOG.ASR), 'yepairag 不应收到 ASR 请求').toBe(0);
    await expectNoW23(m.tenant, since);
  });

  // B9-3 发版过渡期（Q20，PM 定）：不带 vkey 直连 yepairag ASR 仍能转写，走平台 vkey、不记商家（请求体实测为 {"voiceContent": <base64>}）
  test('B9-3 [BL-5 → 改造后] 过渡期直连 yepairag /api/asr 不带 vkey → 200 转写含 Australia，无 VkeyMissing，不记任何商家', async ({ request }) => {
    requireEnv('YEPAIRAG_PUBLIC_ASR_URL');
    const since = nowIso();
    const res = await request.post(env('YEPAIRAG_PUBLIC_ASR_URL'), { data: { voiceContent: wavBase64() } });
    expect(res.status()).toBe(200);
    expect(String((await res.json()).query)).toMatch(/Australia/i);
    const log = logsSince('YEPAIRAG_LOGS', since);
    for (const e of VKEY_ERRORS) expect(count(log, e)).toBe(0);
    await new Promise((r) => setTimeout(r, 90_000));
    // 平台 vkey 的行可能记在平台账户下（W23 怎么归属平台 vkey 未确认）：只要求没有任何商家 chatbot 账户的语音行
    expect(w23RowsByAlias(ASR_ALIAS, since).filter(isMerchantAccount), '走平台 vkey：不应有任何商家的语音转文字行').toEqual([]);
  });

  // B9-4 旧版挂件缓存未更新期间，访客语音照常可用（走平台，Q20）
  test('B9-4 [BL-5 → 改造后] 旧版挂件：语音直连 /yepairag/api/asr，照常转写，不记商家', async ({ browser }) => {
    // 旧版挂件脚本从哪取（固定版本 URL）待确认（Q20 余项）
    requireEnv('E2E_OLD_WIDGET_SCRIPT_URL');
    const m = merchant('NEW', false);
    const b64 = wavBase64();
    const since = nowIso();
    const { w } = await visitor(browser, m, { wavBase64: b64, widgetScript: env('E2E_OLD_WIDGET_SCRIPT_URL') });
    await recordVoice(w);
    await expect.poll(() => w.asrCalls.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const urls = w.asrCalls.map((r) => r.url());
    expect(urls.some((u) => u.includes('/yepairag/api/asr'))).toBe(true);
    expect(urls.some((u) => u.includes('/widget/asr'))).toBe(false);
    await expectTranscript(w);
    await expectNoW23(m.tenant, since, (r) => r.model_alias === ASR_ALIAS);
  });
});
