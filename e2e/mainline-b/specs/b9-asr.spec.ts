// BDD 第 11 节：第 9 项——语音转文字记到商家（@item9，整组可删）。
// 录音（PM 实测）：macOS `say -o ask.wav --data-format=LEI16@16000 "Do you ship to Australia"` 生成真实录音，
// 用 addInitScript 把 getUserMedia 换成播放该文件的 MediaStream；挂件麦克风 mic-button → stop-recording-button。
import { test, expect } from '@playwright/test';
import { merchant, requireSwitch, requireEnv, env, nowIso } from '../lib/config';
import { adminPage, visitor, recordVoice, balance, waitBalance, waitFor, USER_BUBBLE, wavBase64 } from '../lib/web';
import { waitW23, expectNoW23, logsSince, count, LOG, VKEY_ERRORS, w23RowsByAlias } from '../lib/backend';

const ASR_ALIAS = env('ASR_MODEL') || 'whisper-1';

// B9 只断言「转写出来了」：识别结果出现在输入框（message-input）或访客消息（user-message）里即可，不要求发送（2026-09-27 dev 实测：转写填进输入框、不自动发送）。
// 输入框的文字是 value 不是 textContent，hasText 匹配不到，所以读 inputValue。
const expectTranscript = (w: Awaited<ReturnType<typeof visitor>>['w']) =>
  expect
    .poll(async () => `${await w.input.inputValue().catch(() => '')} ${(await w.frame.locator(USER_BUBBLE).allInnerTexts().catch(() => [])).join(' ')}`, {
      timeout: 60_000,
      message: '语音转写结果（输入框或访客消息）里没有 Australia',
    })
    .toMatch(/Australia/i);

test.describe('@item9 第 9 项：语音转文字', () => {
  test.describe('开关打开', () => {
    test.beforeEach(() => requireSwitch('on'));

    // B9-1 新套餐商家的访客语音提问被转成文字，并计入该商家
    test('B9-1 语音 → chatbot /widget/asr（带商家 ID），识别含 Australia，计入商家', async ({ browser }) => {
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
      expect(urls.some((u) => u.includes('/yepairag/api/asr')), '不应再直连 yepairag').toBe(false);
      const asr = w.asrCalls.find((r) => r.url().includes('/widget/asr'))!;
      // /widget/asr 的请求结构还没设计（商家 ID 放 URL 还是请求体，缺口）
      expect(`${asr.url()} ${asr.postData() ?? ''}`, '请求里应带商家 ID').toContain(m.tenant);
      await expectTranscript(w);
      const rows = await waitW23(m.tenant, since, (r) => r.some((x) => x.model_alias === ASR_ALIAS));
      expect(rows.some((x) => x.model_alias === ASR_ALIAS)).toBe(true);
      expect(await waitBalance(admin, m.tenant, (v) => v < A)).toBeLessThan(A);
    });

    // B9-2 零余额商家的访客语音提问被 chatbot 拦下（B 计划：/widget/asr 加闸门）
    test('B9-2 零余额商家语音被 /widget/asr 闸门拦下', async ({ browser }) => {
      const m = merchant('ZERO', false);
      const b64 = wavBase64();
      const since = nowIso();
      const { page, w } = await visitor(browser, m, { wavBase64: b64 });
      const resP = waitFor(page.waitForResponse((r) => r.url().includes('/widget/asr'), { timeout: 30_000 }), '挂件语音上传 /widget/asr 的响应');
      await recordVoice(w);
      const res = await resP;
      expect(res.status(), '余额不足应被拒（挂件提示文案待定，Q19）').toBeGreaterThanOrEqual(400);
      expect(count(logsSince('YEPAIRAG_LOGS', since), LOG.ASR), 'yepairag 不应收到 ASR 请求').toBe(0);
      await expectNoW23(m.tenant, since);
    });

    // B9-3 发版过渡期（Q20，PM 定）：不带 vkey 直连 yepairag ASR 仍能转写，走平台出口、不记商家（请求体实测为 {"voiceContent": <base64>}）
    test('B9-3 过渡期直连 yepairag /yepairag/api/asr 不带 vkey → 200 转写含 Australia，不记任何商家', async ({ request }) => {
      requireEnv('YEPAIRAG_PUBLIC_ASR_URL');
      const since = nowIso();
      const res = await request.post(env('YEPAIRAG_PUBLIC_ASR_URL'), { data: { voiceContent: wavBase64() } });
      expect(res.status()).toBe(200);
      expect(String((await res.json()).query)).toMatch(/Australia/i);
      const log = logsSince('YEPAIRAG_LOGS', since);
      for (const e of VKEY_ERRORS) expect(count(log, e)).toBe(0);
      await new Promise((r) => setTimeout(r, 90_000));
      expect(w23RowsByAlias(ASR_ALIAS, since), '走平台出口：不应有任何商家的语音转文字行').toEqual([]);
    });

    // B9-4 旧版挂件缓存未更新期间，访客语音照常可用（走平台，Q20）
    test('B9-4 旧版挂件：语音直连 /yepairag/api/asr，照常转写，不记商家', async ({ browser }) => {
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

  // B9-5 开关关闭时语音转文字行为不变
  test.describe('开关关闭', () => {
    test.beforeEach(() => requireSwitch('off'));

    test('B9-5 开关关闭：识别含 Australia，W23 无语音行', async ({ browser }) => {
      const m = merchant('NEW', false);
      const b64 = wavBase64();
      const since = nowIso();
      const { w } = await visitor(browser, m, { wavBase64: b64 });
      await recordVoice(w);
      await expectTranscript(w);
      await expectNoW23(m.tenant, since, (r) => r.model_alias === ASR_ALIAS);
    });
  });
});
