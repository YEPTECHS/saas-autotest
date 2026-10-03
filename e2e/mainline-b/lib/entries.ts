// yepairag 入口清单（data/yepairag-entries.json，由 W32 盘点第 1 节 89 行转成）与真实流量对账。
// 「调用方不带 vkey」标注只描述现行调用方：GET calendar、POST brand_summary 10-02 起改走 chatbot 代理（带商家 vkey），已移出。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Entry {
  n: number;
  method: string; // GET / POST / … / MOUNT
  path: string; // FastAPI 模板，{x} 为路径参数
  ingress: string;
  onMissingVkey: string;
  rejects: boolean; // 缺 vkey 会拒
  callerNoVkey: boolean; // 现行调用方不带 vkey（W32 §2；随调用方变化更新——清单描述的是「现在」，不是历史）
  caller?: string; // 调用方变更说明（例：10-02 起改走 chatbot 代理）
}

export const ENTRIES: Entry[] = JSON.parse(readFileSync(fileURLToPath(new URL('../data/yepairag-entries.json', import.meta.url)), 'utf8')).entries;

/** 数字段归一为 N（和 PM 流量表口径一致）。 */
export const normalize = (path: string) => path.replace(/\/\d+(?=\/|$)/g, '/N');

/** 不算接口的路径：健康检查、根路径。 */
export const ignored = (method: string, path: string) => path.startsWith('/health/') || (method === 'GET' && /^\/yepairag\/?$/.test(path));

const re = (e: Entry) =>
  new RegExp(`^${e.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}${e.method === 'MOUNT' ? '(/.*)?' : ''}$`);
const compiled = ENTRIES.map((e) => ({ e, re: re(e) }));

/** 找到这条流量对应的入口；MOUNT 按前缀、任意方法。找不到返回 undefined。 */
export function matchEntry(method: string, path: string): Entry | undefined {
  // 优先精确方法匹配，再退到 mount
  return compiled.find((c) => c.e.method === method && c.re.test(path))?.e ?? compiled.find((c) => c.e.method === 'MOUNT' && c.re.test(path))?.e;
}
