// 主线 B 补漏兜底（需求 pm/.trellis/tasks/09-30-mainline-b-vkey-gap，BDD 见同目录 bdd.md）：只读，查 Loki。
// ⚠️ G-TRAFFIC 只反映「现行调用方」：清单的「调用方不带 vkey」随调用方变更更新（10-02 起 GET calendar、POST brand_summary 改走 chatbot 代理已移出），
//    拿历史窗口跑时，按的是现在的清单，历史上的直连不会再被标出来。漏带 vkey 由 G-LOG 的 VkeyMissing 兜住。
// 时间窗：E2E_WINDOW_START ～ E2E_WINDOW_END（ISO，UTC）；不给 START 用 E2E_DEPLOYED_AT，不给 END 用现在。环境取 E2E_TARGET（prod / dev）。
import { test, expect } from '@playwright/test';
import { env } from '../lib/config';
import { accessPaths, expectCleanLogs } from '../lib/loki';
import { matchEntry, normalize, ignored } from '../lib/entries';

function window(): { start: string; end: string } {
  const start = env('E2E_WINDOW_START') || env('E2E_DEPLOYED_AT');
  test.skip(!start, '缺时间窗：E2E_WINDOW_START（或 E2E_DEPLOYED_AT）');
  const end = env('E2E_WINDOW_END') || new Date().toISOString();
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

test.describe('兜底：发布后 vkey 规则', () => {
  test('G-LOG [兜底] 时间窗内 yepairag / chatbot-api 无 VkeyMissing / LiteLLMBaseMissing / PlatformVkeyMissing / Unknown model，且每小时都有日志', async () => {
    test.setTimeout(10 * 60_000);
    const { start, end } = window();
    await expectCleanLogs(start, end);
  });

  test('G-TRAFFIC [兜底] 时间窗内 yepairag 真实流量全部在入口清单内，且「缺 vkey 会拒 + 调用方不带 vkey」的入口没有流量', async () => {
    test.setTimeout(10 * 60_000);
    const { start, end } = window();
    const hits = new Map<string, number>();
    for (const r of await accessPaths(start, end)) {
      if (ignored(r.method, r.path)) continue;
      const k = `${r.method} ${normalize(r.path)}`;
      hits.set(k, (hits.get(k) ?? 0) + r.n);
    }
    const rows = [...hits].sort((a, b) => b[1] - a[1]).map(([k, n]) => {
      const [method, path] = k.split(' ');
      return { k, n, e: matchEntry(method, path.replace(/\/N(?=\/|$)/g, '/0')) };
    });
    const report = rows.map((r) => `${r.n}\t${r.k}\t${r.e ? `#${r.e.n} ${r.e.ingress}${r.e.rejects ? ' 会拒' : ''}${r.e.callerNoVkey ? ' 调用方不带vkey' : ''}${r.e.caller ? `（${r.e.caller}）` : ''}` : '清单外'}`);
    test.info().annotations.push({ type: `G-TRAFFIC ${start} ～ ${end}`, description: report.join('\n') });
    console.log(`[G-TRAFFIC] ${start} ～ ${end}\n${report.join('\n')}`);
    expect(rows.length, 'Loki 里时间窗内一条 uvicorn.access 都没有——查询或采集有问题').toBeGreaterThan(0);
    const unknown = rows.filter((r) => !r.e).map((r) => `${r.k} ×${r.n}`);
    const broken = rows.filter((r) => r.e?.rejects && r.e.callerNoVkey).map((r) => `${r.k} ×${r.n}（#${r.e!.n} ${r.e!.onMissingVkey}）`);
    expect.soft(unknown, '清单外的路径（入口清单要补，或是新增入口没过 vkey 盘点）').toEqual([]);
    expect.soft(broken, '缺 vkey 会拒、且调用方不带 vkey 的入口有真实流量 = 线上正在坏').toEqual([]);
  });
});
