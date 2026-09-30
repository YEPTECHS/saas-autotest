// Loki 只读查询（主线 B 补漏 09-30）：kubectl logs 只能读当前 pod、会漏轮转前的日志，发布后观察一律查 Loki。
// 本机：kubectl --context oldeks -n grafana port-forward svc/loki-query-frontend 3101:3100，LOKI_URL=http://localhost:3101。
import { test, expect } from '@playwright/test';
import { env } from './config';

const HOUR = 3600_000;

export function lokiBase(): { url: string; tenant: string } {
  const url = env('LOKI_URL');
  test.skip(!url, '缺 LOKI_URL（例：http://localhost:3101，先 port-forward svc/loki-query-frontend）');
  return { url: url.replace(/\/$/, ''), tenant: env('LOKI_TENANT') || 'yepai' };
}

/** 实例标签：yepairag-<env> / chatbot-api-<env>，env 取 E2E_TARGET（默认 dev）。 */
export const instance = (app: 'yepairag' | 'chatbot-api') => `${app}-${env('E2E_TARGET') || 'dev'}`;
export const sel = (app: 'yepairag' | 'chatbot-api') => `{app_kubernetes_io_instance="${instance(app)}"}`;

async function loki(path: string, params: Record<string, string>): Promise<any> {
  const { url, tenant } = lokiBase();
  const res = await fetch(`${url}/loki/api/v1/${path}?${new URLSearchParams(params)}`, { headers: { 'X-Scope-OrgID': tenant } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Loki ${path} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).data;
}

/** 时间窗按 ≤24h 切块（instant 查询 + [Nh] 范围），避免单次查询范围过大。 */
function chunks(start: string, end: string): { at: string; range: string }[] {
  const out = [];
  for (let s = Date.parse(start), e = Date.parse(end); s < e; s += 24 * HOUR) {
    const to = Math.min(s + 24 * HOUR, e);
    out.push({ at: new Date(to).toISOString(), range: `${Math.round((to - s) / 1000)}s` });
  }
  return out;
}

/** metric 查询结果按 label 分组求和（跨块）。expr 里写 [RANGE] 占位。 */
export async function sumBy(expr: string, start: string, end: string): Promise<{ metric: Record<string, string>; n: number }[]> {
  const acc = new Map<string, { metric: Record<string, string>; n: number }>();
  for (const c of chunks(start, end)) {
    const d = await loki('query', { query: expr.replace('[RANGE]', `[${c.range}]`), time: c.at });
    for (const r of d.result) {
      const k = JSON.stringify(r.metric);
      const cur = acc.get(k) ?? { metric: r.metric, n: 0 };
      cur.n += Number(r.value[1]);
      acc.set(k, cur);
    }
  }
  return [...acc.values()];
}

/** 时间窗内包含 needle 的日志条数 + 前 5 条原文。 */
export async function countLines(selector: string, needle: string, start: string, end: string): Promise<{ n: number; first: string[] }> {
  const filter = `${selector} |= ${JSON.stringify(needle)}`;
  const n = (await sumBy(`sum(count_over_time(${filter} [RANGE]))`, start, end)).reduce((s, r) => s + r.n, 0);
  if (!n) return { n, first: [] };
  const d = await loki('query_range', { query: filter, start, end, limit: '5', direction: 'forward' });
  const first = d.result.flatMap((s: any) => s.values.map((v: [string, string]) => v[1].slice(0, 600)));
  return { n, first: first.slice(0, 5) };
}

/** 时间窗内每个整小时的日志条数；返回为 0 的小时（证明覆盖完整：有一小时没日志就说明采集断了，统计会假阴性）。 */
export async function emptyHours(selector: string, start: string, end: string): Promise<string[]> {
  // Loki 把 query_range 的点对齐到 step 的整倍数（整点），所以按整点检查：窗口内每个整点 t 统计 (t-1h, t]
  const first = Math.ceil(Date.parse(start) / HOUR) * HOUR;
  const last = Math.floor(Date.parse(end) / HOUR) * HOUR;
  const got = new Map<number, number>();
  // ponytail: 按天切块查询，避免超出 Loki 单次点数/范围上限
  for (let from = first; from <= last; from += 24 * HOUR) {
    const to = Math.min(from + 23 * HOUR, last);
    const d = await loki('query_range', { query: `sum(count_over_time(${selector}[1h]))`, start: new Date(from).toISOString(), end: new Date(to).toISOString(), step: '3600' });
    for (const r of d.result) for (const [t, v] of r.values) got.set(Number(t) * 1000, Number(v));
  }
  const empty: string[] = [];
  for (let t = first; t <= last; t += HOUR) if (!(got.get(t) ?? 0)) empty.push(new Date(t - HOUR).toISOString());
  return empty;
}

/** yepairag uvicorn.access 的 方法+路径 命中次数。路径里的数字段在 Loki 侧就归一成 /N：
 *  MCP 路径带租户号，不归一的话 7 天窗口会超过 Loki 单查询 500 个序列的上限（09-30 实测）。 */
export async function accessPaths(start: string, end: string): Promise<{ method: string; path: string; n: number }[]> {
  const expr = `sum by (method, path) (count_over_time(${sel('yepairag')} |= "uvicorn.access" | json | line_format "{{.message}}" | regexp "\\"(?P<method>[A-Z]+) (?P<path>[^ ?\\"]+)" | label_format path=\`{{ regexReplaceAll "/[0-9]+" .path "/N" }}\` [RANGE]))`;
  return (await sumBy(expr, start, end)).filter((r) => r.metric.method).map((r) => ({ method: r.metric.method, path: r.metric.path, n: r.n }));
}

const ERROR_NEEDLES = ['VkeyMissing', 'LiteLLMBaseMissing', 'PlatformVkeyMissing', 'Unknown model'];

/** G-LOG 主体：P-3 也调它。返回报告文本，任一报错 > 0 或有空白小时即失败。 */
export async function expectCleanLogs(start: string, end: string) {
  const report: string[] = [];
  const problems: string[] = [];
  for (const app of ['yepairag', 'chatbot-api'] as const) {
    const empty = await emptyHours(sel(app), start, end);
    report.push(`${instance(app)} 日志覆盖：${empty.length ? `缺 ${empty.length} 小时（${empty.slice(0, 5).join(', ')}）` : '每小时都有'}`);
    if (empty.length) problems.push(`${instance(app)} 有 ${empty.length} 个小时没有日志（采集不完整，结果不可信）`);
    for (const needle of ERROR_NEEDLES) {
      const { n, first } = await countLines(sel(app), needle, start, end);
      report.push(`${instance(app)} ${needle}=${n}`);
      if (n) problems.push(`${instance(app)} ${needle}=${n}，前 ${first.length} 条：\n${first.join('\n')}`);
    }
  }
  test.info().annotations.push({ type: `G-LOG ${start} ～ ${end}`, description: report.join('\n') });
  console.log(`[G-LOG] ${start} ～ ${end}\n${report.join('\n')}`);
  expect(problems, '发布后日志不应出现缺 vkey / LiteLLM 地址缺失 / 模型名不认的报错，且每小时都有日志').toEqual([]);
}

