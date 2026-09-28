// 后端检查：W23 SQL（psql，只读）、kubectl 日志、配置核对。全部只读。
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { env, poll } from './config';

// ---------- psql ----------

function hasBin(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 跑一条只读 SQL，返回行对象数组。vars 通过 psql 变量传入（SQL 里写 :'name'）。 */
export function sql(urlEnv: 'W23_DATABASE_URL' | 'YEPAIRAG_DATABASE_URL', query: string, vars: Record<string, string> = {}): Record<string, string>[] {
  const url = env(urlEnv);
  test.skip(!url, `缺 ${urlEnv}（只读账号）`);
  test.skip(!hasBin('psql'), '本机没有 psql，无法做 SQL 断言');
  const args = [url, '-X', '-q', '-A', '-F', '\x1f', '--pset=footer=off', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  // 只读保护：每个会话都设 read only（W23 库本身也是 default_transaction_read_only=on）
  const out = execFileSync('psql', args, { input: `SET default_transaction_read_only = on;\n${query}`, encoding: 'utf8', maxBuffer: 64 << 20 });
  const lines = out.split('\n').filter((l) => l.length > 0 && l !== 'SET');
  if (lines.length === 0) return [];
  const head = lines[0].split('\x1f');
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\x1f').map((v, i) => [head[i], v])));
}

// BDD 0.2 SQL-W23，按「采集时间 >= since」圈本轮。platformChatbotOnly=false 时数两个维度（数字员工 2 行）
const SQL_W23 = (platformChatbotOnly: boolean) => `
SELECT u.occurred_at, a.creation_idempotency_key AS merchant_account_key,
       u.platform, u.action AS model, s.model_group AS model_alias, u.source_event_id AS litellm_request_id,
       u.status, u.spend_usd, u.credits, u.transaction_id,
       (t.metadata->>'prompt_tokens')::int AS input_tokens, (t.metadata->>'completion_tokens')::int AS output_tokens,
       (s.metadata->'usage_object'->'completion_tokens_details'->>'reasoning_tokens')::int AS reasoning_tokens,
       s."user" AS vkey_user, s."startTime" AS call_started_utc
FROM "digital-staff-su".usage_records_v2 u
JOIN "digital-staff-su".accounts a ON a.id = u.account_id
LEFT JOIN "digital-staff-su".ledger_transactions t ON t.id = u.transaction_id
LEFT JOIN litellm."LiteLLM_SpendLogs" s ON s.request_id = u.source_event_id
WHERE u.source = 'litellm'
  ${platformChatbotOnly ? "AND a.platform = 'chatbot' AND a.creation_idempotency_key = 'chatbot:acct:' || :'uid'" : `AND u.source_event_id IN (
      SELECT u2.source_event_id FROM "digital-staff-su".usage_records_v2 u2
      JOIN "digital-staff-su".accounts a2 ON a2.id = u2.account_id
      WHERE a2.creation_idempotency_key = 'chatbot:acct:' || :'uid')`}
  AND u.occurred_at >= :'since'::timestamptz
ORDER BY u.occurred_at`;

export type W23Row = Record<string, string>;

export function w23Rows(tenant: string, since: string, platformChatbotOnly = true): W23Row[] {
  return sql('W23_DATABASE_URL', SQL_W23(platformChatbotOnly), { uid: tenant, since });
}

/** 等 W23 记录出现（90 秒 / 10 秒轮询）。 */
export async function waitW23(tenant: string, since: string, ok: (rows: W23Row[]) => boolean, platformChatbotOnly = true) {
  return poll(() => w23Rows(tenant, since, platformChatbotOnly), ok);
}

/** 等 90 秒后仍没有新行（反向断言）。 */
export async function expectNoW23(tenant: string, since: string, filter: (r: W23Row) => boolean = () => true) {
  await new Promise((r) => setTimeout(r, 90_000));
  const rows = w23Rows(tenant, since).filter(filter);
  expect(rows, `SQL-W23 在 ${since} 之后不应有该商家的新行`).toEqual([]);
}

export const isRagVkey = (r: W23Row) => {
  const [a, b] = (r.vkey_user ?? '').split(':');
  return !!a && a === b;
};
export const byAlias = (alias: string) => (r: W23Row) => r.model_alias === alias;
export const sumCredits = (rows: W23Row[]) => rows.reduce((s, r) => s + Number(r.credits || 0), 0);

/** 每个 litellm_request_id 的行数。 */
export function rowsPerRequest(rows: W23Row[]): number[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.litellm_request_id, (m.get(r.litellm_request_id) ?? 0) + 1);
  return [...m.values()];
}

/** B2-6 透支（W23 round4，prod 已实跑）：ledger_entries 里挂在商家钱包上、direction='DEBIT'、block_id 为空的分录。
 *  每行：charged_credits = overdraft_credits + from_blocks_credits；status 仍为 posted，透支只能看 overdraft_credits。 */
export function overdraftRows(tenant: string, since: string): Record<string, string>[] {
  return sql(
    'W23_DATABASE_URL',
    `SELECT u.occurred_at, u.source_event_id AS litellm_request_id, u.status, u.credits AS charged_credits,
            coalesce(od.overdraft, 0) AS overdraft_credits, coalesce(bk.from_blocks, 0) AS from_blocks_credits,
            u.transaction_id, a.balance AS wallet_balance_now
     FROM "digital-staff-su".usage_records_v2 u
     JOIN "digital-staff-su".accounts a ON a.id = u.account_id
     LEFT JOIN LATERAL (SELECT sum(le.amount) AS overdraft FROM "digital-staff-su".ledger_entries le
                        WHERE le.transaction_id = u.transaction_id AND le.account_id = u.account_id
                          AND le.direction = 'DEBIT' AND le.block_id IS NULL) od ON true
     LEFT JOIN LATERAL (SELECT sum(le.amount) AS from_blocks FROM "digital-staff-su".ledger_entries le
                        WHERE le.transaction_id = u.transaction_id AND le.account_id = u.account_id
                          AND le.direction = 'DEBIT' AND le.block_id IS NOT NULL) bk ON true
     WHERE u.source = 'litellm' AND a.platform = 'chatbot'
       AND a.creation_idempotency_key = 'chatbot:acct:' || :'uid'
       AND u.occurred_at >= :'since'::timestamptz
     ORDER BY u.occurred_at`,
    { uid: tenant, since },
  );
}

/** 某个模型别名在时间窗内的全部 W23 行（不限商家；B9-3 用来证明「没有记到任何商家」——平台 vkey 的行可能记在平台账户下，按 account_key 过滤）。 */
export function w23RowsByAlias(alias: string, since: string): Record<string, string>[] {
  return sql(
    'W23_DATABASE_URL',
    `SELECT u.occurred_at, a.creation_idempotency_key AS account_key, s.model_group AS model_alias
     FROM "digital-staff-su".usage_records_v2 u
     JOIN "digital-staff-su".accounts a ON a.id = u.account_id
     JOIN litellm."LiteLLM_SpendLogs" s ON s.request_id = u.source_event_id
     WHERE u.source = 'litellm' AND s.model_group = :'alias' AND u.occurred_at >= :'since'::timestamptz`,
    { alias, since },
  );
}

// ---------- kubectl 日志 ----------

export type LogTarget = 'YEPAIRAG_LOGS' | 'CHATBOT_LOGS' | 'LITELLM_LOGS';

export function logsSince(target: LogTarget, sinceIso: string): string {
  const spec = env(target);
  test.skip(!spec, `缺 ${target}（kubectl logs 参数）`);
  test.skip(!hasBin('kubectl'), '本机没有 kubectl');
  // --prefix：每行带 [pod/<pod>/<container>]，和 taskName 一起定位同一请求的日志
  const args = ['logs', ...spec.split(/\s+/), `--since-time=${sinceIso}`, '--all-containers=true', '--prefix=true'];
  return execFileSync('kubectl', args, { encoding: 'utf8', maxBuffer: 256 << 20 });
}

export const count = (text: string, needle: string | RegExp) =>
  typeof needle === 'string' ? text.split(needle).length - 1 : (text.match(new RegExp(needle, 'g')) ?? []).length;

/** yepairag 各入口的日志特征（W32 round3）：这些入口只有 uvicorn access 日志，不带商家，只能按时间窗。 */
export const LOG = {
  ACTIVE_LEADS: /POST \/yepairag\/(biz\/)?activeLeads HTTP\/1\.1/,
  COLLECT: /POST \/yepairag\/(biz\/)?collect HTTP\/1\.1/,
  ASYNC_RESPONSE: /POST \/yepairag\/async-response HTTP\/1\.1/,
  KB_CREATE: /POST \/yepairag\/create HTTP\/1\.1/,
  POLICY_SYNC: /POST \/yepairag\/kb\/merchant\/policies\/sync HTTP\/1\.1/,
  // 挂件的 /yepairag/api/asr 在集群内是 /yepairag/asr（网关改写，未确认），两种都认
  ASR: /POST \/yepairag\/(api\/)?asr HTTP\/1\.1/,
  RESPONSEV3: /POST \/yepairag\/responseV3 HTTP\/1\.1/,
  SELECTION_RANK_FAILED: '[OpsSelectionRank] ranking call failed',
  SOURCING_FAILED: /\[SourcingSignals\] \S+ call failed/,
};

/** MCP 工具调用：access 日志路径里带商家（W32 round3 实测样例）。 */
export const mcpAccess = (tenant: string) => new RegExp(`POST /yepairag/mcp/[^/]+/${tenant}/mcp`);

/** chatbot 余额闸门拒绝日志（BillBalanceGate.java）：`[Bill][gate] deny <entry> user=<租户> — …`。
 *  entry 标签（chatbot-api feature/jifei3 实现）：storefront-forward、preview、kb-train、asr、human-support-summary。 */
export const gateDeny = (label: string, tenant?: string) => `[Bill][gate] deny ${label}${tenant ? ` user=${tenant}` : ''}`;

/** 店铺 agent「工具调用格式错误」的识别日志（yepairag callback.py）：`agent <name> LLM error: FinishReason.<OTHER|MALFORMED_FUNCTION_CALL>`。 */
export const MALFORMED_LOG = /LLM error: FinishReason\.(OTHER|MALFORMED_FUNCTION_CALL)/;

/** 还定不下来的日志特征（由实现决定）：从 E2E_LOGPAT_<KEY> 读正则，没配就 skip，不猜。 */
export function unverifiedLogPattern(key: 'ALREADY_PROCESSING'): RegExp {
  const v = env(`E2E_LOGPAT_${key}`);
  test.skip(!v, `日志文字由实现决定、尚未确定：E2E_LOGPAT_${key}`);
  return new RegExp(v);
}

// chat_memory（W32）：events 挂到 sessions 上取商家和是否预览；timestamp 为 UTC
export const CHAT_MEMORY_FROM = `chat_memory.events e JOIN chat_memory.sessions s ON s.app_name = e.app_name AND s.user_id = e.user_id AND s.id = e.session_id`;

// "no rag vkey in request context" 是 VkeyMissing 的消息正文；有些入口会把异常吞掉只打这段文字（W32 round3）
export const VKEY_ERRORS = ['VkeyMissing', 'LiteLLMBaseMissing', 'no rag vkey in request context'];
export const UNKNOWN_MODEL = 'ValueError: Unknown model';
export const RECORDED_ECOMMERCE = 'Recorded conversation to database: agent_type=ecommerce';
export const TEXT_SENT = /\[CreditUsage\] sent to .*"kind": "text"/;
export const TEXT_RETIRED = '[CreditUsage] text rail retired';

export function expectNoVkeyErrors(sinceIso: string, extra: string[] = []) {
  const log = logsSince('YEPAIRAG_LOGS', sinceIso);
  for (const e of [...VKEY_ERRORS, ...extra]) expect(count(log, e), `yepairag 日志自 ${sinceIso} 起不应出现 ${e}`).toBe(0);
  return log;
}

/** 取某一轮店铺对话在 yepairag 里的全部日志（W32 round3）：
 *  Recorded conversation 行带 conversation_id（不带商家）；同一请求的日志共用 taskName，再加 pod 前缀区分实例。 */
export function roundLog(all: string, conversationId: string): string | null {
  const lines = all.split('\n');
  const hit = lines.find((l) => l.includes('Recorded conversation to database') && l.includes(`conversation_id=${conversationId},`));
  if (!hit) return null;
  const pod = hit.match(/^\[[^\]]+\]/)?.[0] ?? '';
  const task = hit.match(/"taskName":\s*"([^"]+)"/)?.[1];
  if (!task) return hit;
  return lines.filter((l) => l.startsWith(pod) && l.includes(`"taskName": "${task}"`)).join('\n');
}

/** 按「某行包含 needle」找到 yepairag 的一个请求，返回同一 pod、同一 taskName 的全部日志行（找不到返回 null）。
 *  greeting 等非 text 事件没有 Recorded conversation 行，用 message.hub.payload 里的 conversationId 定位（2026-09-27 dev 实测）。 */
export function yepairagTaskLog(all: string, needle: string): string | null {
  const lines = all.split('\n');
  const hit = lines.find((l) => l.includes(needle));
  if (!hit) return null;
  const pod = hit.match(/^\[[^\]]+\]/)?.[0] ?? '';
  const task = hit.match(/"taskName":\s*"([^"]+)"/)?.[1];
  if (!task) return hit;
  return lines.filter((l) => l.startsWith(pod) && l.includes(`"taskName": "${task}"`)).join('\n');
}

/** BDD 0.1 自检：这一轮确实走了 yepairag（不是 concierge）。按 conversation_id 找到这一轮，不只靠时间窗。
 *  不满足 → skip（环境不符，结果不算数）。返回这一轮的 yepairag 日志。 */
export async function ensureYepairagPath(tenant: string, sinceIso: string, conversationId: string): Promise<string> {
  expect(conversationId, '挂件请求体里应有 conversation_id').toBeTruthy();
  const all = await poll(() => logsSince('YEPAIRAG_LOGS', sinceIso), (l) => roundLog(l, conversationId) !== null, 60_000, 10_000);
  const round = roundLog(all, conversationId);
  const concierge = logsSince('CHATBOT_LOGS', sinceIso).includes(`[Concierge] turn done tenant=${tenant}`);
  test.skip(
    !round || concierge,
    `环境不符（BDD 0.1）：yepairag 日志${round ? '有' : '没有'} conversation_id=${conversationId} 的 Recorded conversation，chatbot 日志${concierge ? '有' : '没有'} [Concierge] turn done tenant=${tenant}——这一轮没走 yepairag，结果不算数`,
  );
  return round!;
}

// ---------- 配置核对 ----------

export function chatbotConfigValue(key: string): string {
  const spec = env('CHATBOT_CONFIGMAP');
  test.skip(!spec, '缺 CHATBOT_CONFIGMAP（kubectl get 参数）');
  return execFileSync('kubectl', ['get', ...spec.split(/\s+/), '-o', `jsonpath={.data.${key}}`], { encoding: 'utf8' }).trim();
}

export function deploymentImage(spec: string): string {
  return execFileSync('kubectl', ['get', ...spec.split(/\s+/), '-o', 'jsonpath={.spec.template.spec.containers[*].image}'], { encoding: 'utf8' }).trim();
}
