// 测试脚手架自身的离线自检（不连任何环境）。
import { test, expect } from '@playwright/test';
import { rowsPerRequest, isRagVkey, count, roundLog, LOG } from '../lib/backend';

test('selfcheck: 行统计 / rag vkey 判定 / 按 conversation_id + taskName 取一轮日志', () => {
  expect(rowsPerRequest([{ litellm_request_id: 'a' }, { litellm_request_id: 'a' }, { litellm_request_id: 'b' }]).sort()).toEqual([1, 2]);
  expect(isRagVkey({ vkey_user: 'x:x' })).toBe(true);
  expect(isRagVkey({ vkey_user: 'digital-staff:x' })).toBe(false);
  expect(count('a VkeyMissing b VkeyMissing', 'VkeyMissing')).toBe(2);

  const P1 = '[pod/yepairag-dev-1/app]';
  const P2 = '[pod/yepairag-dev-2/app]';
  const log = [
    `${P1} {"message": "[Tenant=1] Session found:", "taskName": "Task-7"}`,
    `${P1} {"message": "Recorded conversation to database: agent_type=ecommerce, conversation_id=c1, message_id=m1", "taskName": "Task-7"}`,
    `${P1} {"message": "[CreditUsage] text rail retired", "taskName": "Task-7"}`,
    `${P1} {"message": "other request", "taskName": "Task-8"}`,
    `${P2} {"message": "same task name on another pod", "taskName": "Task-7"}`,
    `${P1} {"message": "Recorded conversation to database: agent_type=ecommerce, conversation_id=c10, message_id=m2", "taskName": "Task-9"}`,
  ].join('\n');
  const r = roundLog(log, 'c1')!;
  expect(r.split('\n')).toHaveLength(3);
  expect(r).toContain('text rail retired');
  expect(r).not.toContain('another pod');
  expect(roundLog(log, 'c2')).toBeNull();
  expect(LOG.KB_CREATE.test('{"message": "10.0.0.1:1 - \\"POST /yepairag/create HTTP/1.1\\" 200"}')).toBe(true);
});

import { matchEntry, normalize, ignored, ENTRIES } from '../lib/entries';

test('selfcheck: 入口清单 89 条、流量路径对账（归一 / 路径参数 / MCP mount / 排除项）', () => {
  expect(ENTRIES).toHaveLength(89);
  expect(ENTRIES.filter((e) => e.rejects)).toHaveLength(19);
  expect(normalize('/yepairag/mcp/task/1157962189542760448/mcp')).toBe('/yepairag/mcp/task/N/mcp');
  expect(matchEntry('POST', '/yepairag/mcp/task/0/mcp')?.method).toBe('MOUNT');
  expect(matchEntry('DELETE', '/yepairag/composio/connections/instagram')?.n).toBe(67);
  expect(matchEntry('GET', '/yepairag/merchant/marketing/calendar/plan/0/outcome')?.n).toBe(17);
  const cal = matchEntry('GET', '/yepairag/merchant/marketing/calendar')!;
  // 10-02 起 GET calendar / POST brand_summary 的调用方是 chatbot 代理（带 vkey），移出「调用方不带 vkey」
  expect([cal.n, cal.rejects, cal.callerNoVkey]).toEqual([16, true, false]);
  expect(ENTRIES.filter((e) => e.callerNoVkey)).toHaveLength(12);
  expect(matchEntry('GET', '/yepairag/brand_summary')?.rejects).toBe(false); // GET 版本不调模型
  expect(matchEntry('POST', '/yepairag/brand_summary')?.callerNoVkey).toBe(false);
  expect(matchEntry('POST', '/yepairag/toHumanV3')?.callerNoVkey).toBe(true);
  expect(matchEntry('POST', '/yepairag/kb/merchant/policies/sync')?.callerNoVkey).toBe(false);
  expect(matchEntry('POST', '/yepairag/nope')).toBeUndefined();
  expect([ignored('GET', '/health/live'), ignored('GET', '/yepairag'), ignored('POST', '/yepairag')]).toEqual([true, true, false]);
});
