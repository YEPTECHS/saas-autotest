// 环境配置 + 前置条件自检。原则：前置条件不满足一律 test.skip 并写明原因，不静默通过。
import { test } from '@playwright/test';

export const env = (k: string): string => (process.env[k] ?? '').trim();

export const cfg = {
  base: env('YEPAI_BASE_URL') || 'https://bot-dev.yepai.io',
  api: env('CHATBOT_API_BASE') || 'https://api-test.yepai.io/dev',
  widgetScript: env('WIDGET_SCRIPT_URL') || 'https://widget.yepai.io/chat-widget.js',
  widgetOrigin: env('WIDGET_ORIGIN') || 'https://chat-bot-dev.yepai.ai',
  mainModel: env('PREMIUM_LLM_MODEL') || 'gemini-flash-latest',
  routeModel: env('PREMIUM_LLM_MODEL_STABLE') || 'gemini-3-flash-preview',
  embeddingModel: env('EMBEDDING_MODEL') || 'text-embedding-3-large',
};

export type MerchantKind = 'NEW' | 'LEGACY' | 'WHITELIST' | 'ZERO' | 'NONSHOPIFY';

export interface Merchant {
  kind: MerchantKind;
  tenant: string;
  shop: string;
  email: string;
  password: string;
}

/** 取测试商家；needLogin=true 时缺登录凭据就 skip（余额要登录后读）。 */
export function merchant(kind: MerchantKind, needLogin = true): Merchant {
  const m: Merchant = {
    kind,
    tenant: env(`E2E_${kind}_TENANT`),
    // ponytail: 没配店铺域名就用一个固定的假 myshopify 域名；BDD S1 路径 B 实测来源白名单为空时不拦（未确认，见缺口）
    shop: env(`E2E_${kind}_SHOP`) || `e2e-mainline-b-${kind.toLowerCase()}.myshopify.com`,
    email: env(`E2E_${kind}_EMAIL`),
    password: env(`E2E_${kind}_PASSWORD`),
  };
  test.skip(!m.tenant, `缺测试商家 E2E_${kind}_TENANT（BDD 0.2 / Q9）`);
  test.skip(needLogin && (!m.email || !m.password), `缺 E2E_${kind}_EMAIL / PASSWORD（从 autotest-account 领取）`);
  return m;
}

/** 只给 specs/baseline（改造前现状基线，保留不动）用：那套是 RAG_METERING_ENABLED 关闭时写的。
 *  用户 09-28 定：不要开关，代码一部署即切新方案——改造后用例一律不调用这个函数。 */
export function requireSwitch(state: 'on' | 'off') {
  const cur = env('E2E_METERING_SWITCH');
  test.skip(cur !== state, `需要 RAG_METERING_ENABLED=${state}，当前声明为 "${cur || '未声明'}"（E2E_METERING_SWITCH）`);
}

/** BDD 0.1：店铺类用例必须在「concierge 只对白名单开放」的环境跑。先看声明，跑完一轮再用日志核实（ensureYepairagPath）。 */
export function requireWhitelistOnlyConcierge() {
  test.skip(
    env('E2E_CONCIERGE_WHITELIST_ONLY') !== '1',
    '环境未声明 concierge 只对白名单开放（E2E_CONCIERGE_WHITELIST_ONLY!=1）。老 dev 是全量 concierge，测不到 yepairag（BDD 0.1 / Q1）',
  );
}

export function requireEnv(...keys: string[]) {
  const missing = keys.filter((k) => !env(k));
  test.skip(missing.length > 0, `缺配置：${missing.join(', ')}`);
}

export function requireProdReadonly() {
  test.skip(
    env('E2E_TARGET') !== 'prod' || env('E2E_ALLOW_PROD_READONLY') !== '1',
    'prod 只读核对：需要 E2E_TARGET=prod 且 E2E_ALLOW_PROD_READONLY=1（每次都要人类授权）',
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** W23 断言统一等待：最多 90 秒，每 10 秒轮询（BDD 0.2 / Q6）。返回最后一次结果。 */
export async function poll<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, timeoutMs = 90_000, stepMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(stepMs);
    v = await fn();
  }
  return v;
}

export const nowIso = () => new Date().toISOString();
