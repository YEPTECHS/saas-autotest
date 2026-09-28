// BDD 第 10b 节（第 5 版新增）：第 10 项——后台预览过余额闸门；请求方自填 isPreview=true 不能绕过（安全）。
// Q32（PM 定）：第 10 项挂在开关后面，只在开关打开时生效；开关关闭时的行为见 R0-5。
// Q31：自填 isPreview 跳过来源校验 / 留资不在本次范围，不写成通过条件。
import { test, expect } from '@playwright/test';
import { merchant, nowIso, cfg, requireEnv, requireSwitch } from '../lib/config';
import { adminPage, balance, previewSend } from '../lib/web';
import { logsSince, count, expectNoW23, gateDeny, gateLabel } from '../lib/backend';

test.describe('第 10 项：预览过余额闸门', () => {
  // 在 fixture 启动浏览器之前先判前置条件
  test.beforeEach(() => {
    requireSwitch('on');
    requireEnv('E2E_ZERO_TENANT');
  });

  // B10-1 零余额商家在后台 Anna 预览发消息被余额闸门拦下
  test('B10-1 零余额商家的 Anna 预览 → 400 visit_limits_reached，无 W23 行', async ({ browser }) => {
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
    expect(count(logsSince('CHATBOT_LOGS', since), gateDeny(gateLabel('PREVIEW', 'storefront-forward')))).toBeGreaterThanOrEqual(1);
    await expectNoW23(m.tenant, since);
    expect(await balance(admin, m.tenant)).toBeLessThanOrEqual(0);
  });

  // B10-2 请求方自填 isPreview=true 不能绕过余额闸门（安全）
  test('B10-2 匿名直接 POST conversations/proxy 带 isPreview=true → 仍被闸门拦下', async ({ request }) => {
    const m = merchant('ZERO', false);
    const since = nowIso();
    const res = await request.post(`${cfg.api}/chatbot/api/widget/conversations/proxy`, {
      data: { tenant_id: m.tenant, conversation_id: `e2e-b102-${Date.now()}`, type: 'text', content: 'What is your return policy?', isPreview: true, messages: [] },
    });
    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).subtype).toBe('visit_limits_reached');
    await expectNoW23(m.tenant, since);
  });
});
