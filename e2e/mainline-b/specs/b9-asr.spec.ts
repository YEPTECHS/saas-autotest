// 改造后。BDD 第 11 节：第 9 项——语音转文字（@item9，整组可删）。
// 用户 09-29 范围变更：语音转文字本次保持原样——聊天窗口不发布（挂件仍直连 yepairag /yepairag/api/asr，请求体只有 voiceContent），
// yepairag /asr 恢复原代码（直连 OpenAI Whisper、不走 LiteLLM、不要 vkey）。所以 B9 断言「和改造前一样」，对照 baseline BL-5。
// 已删：B9-2（零余额 /widget/asr 被 asr 闸门拦）、B9-3（过渡期直连不带 vkey 走平台 vkey）、B9-4（旧版挂件过渡期）——都只在「走 /widget/asr」时成立。
// 录音（PM 实测）：macOS `say -o ask.wav --data-format=LEI16@16000 "Do you ship to Australia"` 生成真实录音，
// 用 addInitScript 把 getUserMedia 换成播放该文件的 MediaStream；挂件麦克风 mic-button → stop-recording-button。
import { test, expect } from '@playwright/test';
import { merchant, env, nowIso } from '../lib/config';
import { visitor, recordVoice, waitFor, wavBase64 } from '../lib/web';
import { expectNoW23, logsSince, count, LOG, byAlias, sql } from '../lib/backend';

const ASR_ALIAS = env('ASR_MODEL') || 'whisper-1';

test.describe('@item9 改造后 第 9 项：语音转文字（保持原样）', () => {
  test('B9-1 [BL-5 → 改造后：语音保持原样] 挂件直连 yepairag /api/asr（只有 voiceContent），转写含 Australia，W23 无该商家语音行，LiteLLM SpendLogs 本轮无 whisper-1 行', async ({ browser }) => {
    const m = merchant('NEW', false);
    const b64 = wavBase64();
    const { w } = await visitor(browser, m, { wavBase64: b64 });
    const since = nowIso();
    await recordVoice(w);
    await expect.poll(() => w.asrCalls.length, { timeout: 30_000, message: '挂件没有发出语音上传请求' }).toBeGreaterThan(0);
    const req = w.asrCalls[0];
    expect(req.url(), '挂件仍直连 yepairag').toContain('/yepairag/api/asr');
    expect(w.asrCalls.some((r) => r.url().includes('/widget/asr')), '聊天窗口本次不发布：不应调 chatbot /widget/asr').toBe(false);
    expect(Object.keys(req.postDataJSON() ?? {}), '请求体只有 voiceContent').toEqual(['voiceContent']);
    expect(req.url(), 'URL 里没有商家身份').not.toContain(m.tenant);
    const res = await waitFor(req.response().then((r) => r ?? Promise.reject(new Error('没有响应'))), 'yepairag /api/asr 响应');
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(String(j.query), `转写结果：${JSON.stringify(j)}`).toMatch(/Australia/i);
    expect(count(logsSince('YEPAIRAG_LOGS', since), LOG.ASR), 'yepairag access 日志应有 POST /yepairag/asr').toBeGreaterThanOrEqual(1);
    // 只看语音别名：打开挂件的 greeting 本身会产生别的行，和语音无关
    await expectNoW23(m.tenant, since, byAlias(ASR_ALIAS));
    // 直连 Whisper 不经 LiteLLM：SpendLogs 本轮不应有 whisper-1。LiteLLM dev/test 共用，窗口内若别处有语音调用会误报（dev/test 近期 ASR 调用为 0）
    // SpendLogs."startTime" 是不带时区的 UTC（2026-09-28 实测）
    const spend = sql(
      'W23_DATABASE_URL',
      `SELECT request_id, "startTime" FROM litellm."LiteLLM_SpendLogs"
       WHERE model_group = :'alias' AND "startTime" >= (:'since'::timestamptz AT TIME ZONE 'UTC')`,
      { alias: ASR_ALIAS, since },
    );
    expect(spend, `LiteLLM SpendLogs 自 ${since} 起不应有 ${ASR_ALIAS} 行`).toEqual([]);
  });
});
