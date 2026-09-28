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
