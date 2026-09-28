// 改造后（无开关，09-28）：第 10 项——后台预览过余额闸门（标签 preview）；请求方自填 isPreview=true 不能绕过（安全）。
// 实现（chatbot-api cc1a57e1e）：ForwardConversationService.checkCredits 在 isPreview 分支先 billBalanceGate.checkOrThrow(userId, "preview")，
// 被拒抛 LimitExceededException（message 前缀 INSUFFICIENT_CREDITS / BALANCE_UNREADABLE），与 storefront-forward 同一出口。
// Q31：自填 isPreview 跳过来源校验 / 留资不在本次范围，不写成通过条件。
import { test, expect } from '@playwright/test';
import { merchant, nowIso, cfg, requireEnv } from '../lib/config';
import { adminPage, balance, previewSend } from '../lib/web';
import { logsSince, count, expectNoW23, gateDeny } from '../lib/backend';

test.describe('改造后 第 10 项：预览过余额闸门', () => {
  // 在 fixture 启动浏览器之前先判前置条件
  test.beforeEach(() => requireEnv('E2E_ZERO_TENANT'));

  // B10-1 零余额商家在后台 Anna 预览发消息被余额闸门拦下
  // 注：BL-6 的零余额商家（unsubscribed 账号 16）登录后只能进 /plan-details，进不了预览页——需要一个能进后台的零余额商家
  test('B10-1 [BL-4 → 改造后] 零余额商家 Anna 预览 → 400 visit_limits_reached + [Bill][gate] deny preview，无 W23 行', async ({ browser }) => {
    const m = merchant('ZERO');
    const admin = await adminPage(browser, m);
    expect(await balance(admin, m.tenant)).toBeLessThanOrEqual(0);
    const since = nowIso();
    const { body, res } = await previewSend(admin, 'What is your return policy?');
    expect(body.isPreview).toBe(true);
    expect(res.status()).toBe(400);
    const j = await res.json();
    expect(j.subtype).toBe('visit_limits_reached');
    expect(String(j.errorMessage)).toMatch(/^INSUFFICIENT_CREDITS:/);
    expect(count(logsSince('CHATBOT_LOGS', since), gateDeny('preview', m.tenant))).toBeGreaterThanOrEqual(1);
    await expectNoW23(m.tenant, since);
    expect(await balance(admin, m.tenant)).toBeLessThanOrEqual(0);
  });

  // B10-2 请求方自填 isPreview=true 不能绕过余额闸门（安全）
  test('B10-2 [BL-4 → 改造后] 匿名直接 POST conversations/proxy 带 isPreview=true → 400 + deny preview，无 W23 行', async ({ request }) => {
    const m = merchant('ZERO', false);
    const since = nowIso();
    const res = await request.post(`${cfg.api}/chatbot/api/widget/conversations/proxy`, {
      data: { tenant_id: m.tenant, conversation_id: `e2e-b102-${Date.now()}`, type: 'text', content: 'What is your return policy?', isPreview: true, messages: [] },
    });
    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).subtype).toBe('visit_limits_reached');
    expect(count(logsSince('CHATBOT_LOGS', since), gateDeny('preview', m.tenant))).toBeGreaterThanOrEqual(1);
    await expectNoW23(m.tenant, since);
  });
});
