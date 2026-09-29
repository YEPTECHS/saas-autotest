// 第 6 项（yepai-infra feature/jifei3 17e3620 / db318ba，configs/base/litellm/configmap.yaml）：老 dev LiteLLM（oldeks zeroclaw/litellm，dev/test 共用）。
// IL-BL = 改造前（configmap 还没 apply），现在就能跑；IL = 改造后，W30 apply + 重启后设 E2E_INFRA_LITELLM_DEPLOYED=1 打开。
// 调用：kubectl exec 进 litellm pod，在 pod 内请求 http://localhost:4000。pod 里没有 curl（2026-09-28 实测），用镜像自带 python3 标准库；
//   Authorization 取 pod 内 $LITELLM_MASTER_KEY（os.environ，脚本不打印），请求 JSON 走 stdin，只回 {status, body}。
// 每轮请求带唯一 user / metadata.tags = e2e-infra-<时间戳>。SpendLogs 按 request_tags 圈本轮（master key 下 "user" 列恒为 default_user_id，2026-09-28 实测）；
//   只读 sql()，W23 库的 litellm schema。调用失败的行 model_group 为空、spend=0，不影响按新名分组。
// 只读 + 极小额调用；不改 LiteLLM 任何配置。
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { env, poll } from '../lib/config';
import { sql } from '../lib/backend';
import { wavBase64 } from '../lib/web';

const LIVE = ['qwen3.7-plus', 'google/gemini-3.5-flash-lite'];
const NEW_CHAT = ['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gpt-4.1-mini', 'gpt-4o-mini', 'openai/gpt-4o-mini', 'gpt-5-nano'];
const NEW_EMBED = 'text-embedding-3-large';
const NEW_ALL = [...NEW_CHAT, NEW_EMBED];
const RUN = `e2e-infra-${Date.now()}`;

// ponytail: 一个 stdlib 脚本覆盖 JSON 和 multipart（whisper），不引依赖
const POD_PY = `
import json,os,sys,base64,urllib.request,urllib.error,uuid
q=json.load(sys.stdin)
h={"Authorization":"Bearer "+os.environ["LITELLM_MASTER_KEY"]}
if "multipart" in q:
  m=q["multipart"];b="----e2e"+uuid.uuid4().hex;parts=[]
  for k,v in m["fields"].items(): parts.append(('--%s\\r\\nContent-Disposition: form-data; name="%s"\\r\\n\\r\\n%s\\r\\n'%(b,k,v)).encode())
  parts.append(('--%s\\r\\nContent-Disposition: form-data; name="file"; filename="%s"\\r\\nContent-Type: audio/wav\\r\\n\\r\\n'%(b,m["filename"])).encode()+base64.b64decode(m["file_b64"])+b"\\r\\n")
  data=b"".join(parts)+("--%s--\\r\\n"%b).encode();h["Content-Type"]="multipart/form-data; boundary="+b
else:
  data=json.dumps(q["body"]).encode();h["Content-Type"]="application/json"
r=urllib.request.Request("http://localhost:4000"+q["path"],data=data,method="POST",headers=h)
try:
  with urllib.request.urlopen(r,timeout=120) as resp: st,out=resp.status,resp.read()
except urllib.error.HTTPError as e: st,out=e.code,e.read()
print(json.dumps({"status":st,"body":out.decode("utf-8","replace")}))
`;

type Res = { status: number; body: string; json: Record<string, any> };

function litellm(req: object): Res {
  const spec = env('LITELLM_EXEC');
  test.skip(!spec, "缺 LITELLM_EXEC（kubectl exec 目标，例：'--context oldeks -n zeroclaw deploy/litellm'）");
  const [target, ...flags] = spec.split(/\s+/).reverse();
  const out = execFileSync('kubectl', [...flags.reverse(), 'exec', '-i', target, '--', 'python3', '-c', POD_PY], {
    input: JSON.stringify(req), encoding: 'utf8', maxBuffer: 16 << 20, timeout: 150_000,
  });
  const r = JSON.parse(out.trim().split('\n').pop()!);
  let json = {};
  try { json = JSON.parse(r.body); } catch { /* 非 JSON 响应原样看 body */ }
  return { ...r, json };
}

const tag = { user: RUN, metadata: { tags: [RUN] } };
const chat = (model: string, extra: object = {}) =>
  litellm({ path: '/v1/chat/completions', body: { model, messages: [{ role: 'user', content: 'Reply with one word: pong' }], max_tokens: 16, ...tag, ...extra } });
const embed = (model: string) => litellm({ path: '/v1/embeddings', body: { model, input: 'e2e infra ping', ...tag } });
const call = (model: string) => (model === NEW_EMBED ? embed(model) : chat(model));
const whisper = () =>
  litellm({ path: '/v1/audio/transcriptions', multipart: { filename: 'ask.wav', file_b64: wavBase64(), fields: { model: 'whisper-1', user: RUN } } });

const errMsg = (r: Res) => String(r.json?.error?.message ?? r.body).slice(0, 300);
const note = (type: string, v: unknown) => test.info().annotations.push({ type, description: typeof v === 'string' ? v : JSON.stringify(v) });

test.describe('第 6 项 LiteLLM（老 dev）', () => {
  test.describe('IL-BL 改造前（configmap 未 apply）', () => {
    test.beforeEach(() => test.skip(env('E2E_INFRA_LITELLM_DEPLOYED') === '1', '已声明 LiteLLM 改造已部署，改造前基线不再成立'));

    test('IL-BL-1 在用模型 qwen3.7-plus、google/gemini-3.5-flash-lite 各 chat 一次 → 200', () => {
      for (const m of LIVE) {
        const r = chat(m);
        note(m, `${r.status} ${r.json?.choices?.[0]?.finish_reason ?? errMsg(r)}`);
        expect(r.status, `${m}：${errMsg(r)}`).toBe(200);
        expect(r.json.choices?.length, m).toBeGreaterThan(0);
      }
    });

    test('IL-BL-2 8 个新名现在调用都失败：400 invalid_request_error「Invalid model name passed in model=<名>」', () => {
      for (const m of NEW_ALL) {
        const r = call(m);
        note(m, `${r.status} ${errMsg(r)}`);
        expect(r.status, `${m} 现在不应能调通`).toBe(400);
        expect(r.json.error?.type, m).toBe('invalid_request_error');
        expect(errMsg(r), m).toContain(`Invalid model name passed in model=${m}`);
      }
    });

    test('IL-BL-3 whisper-1 现状（改造前已在 configmap 里）：转写 200 且含 Australia', () => {
      const r = whisper();
      note('whisper-1', `${r.status} ${String(r.json?.text ?? errMsg(r)).slice(0, 200)}`);
      expect(r.status, errMsg(r)).toBe(200);
      expect(String(r.json.text)).toMatch(/Australia/i);
    });
  });

  test.describe('IL 改造后（W30 apply configmap/deployment + 重启后）', () => {
    test.beforeEach(() => test.skip(env('E2E_INFRA_LITELLM_DEPLOYED') !== '1', '改造后用例：LiteLLM 挂好新模型后设 E2E_INFRA_LITELLM_DEPLOYED=1'));

    test('IL-1 在用模型仍 200', () => {
      for (const m of LIVE) {
        const r = chat(m);
        expect(r.status, `${m}：${errMsg(r)}`).toBe(200);
      }
    });

    // IL-2、IL-3 串行：IL-3 查的是 IL-2 本轮（RUN 标记）打出的调用
    test('IL-2 + IL-3 8 个新名 chat/embeddings 都 200；SpendLogs 本轮每个新名都有记录且 spend > 0', async () => {
      for (const m of NEW_ALL) {
        const r = call(m);
        note(m, `${r.status} ${r.status === 200 ? '' : errMsg(r)}`);
        expect.soft(r.status, `${m}：${errMsg(r)}`).toBe(200);
      }
      expect(test.info().errors, 'IL-2 有新名没调通，IL-3 不算数').toEqual([]);
      const q = () =>
        sql(
          'W23_DATABASE_URL',
          `SELECT model_group, count(*) AS n, sum(spend) AS spend, min(spend) AS min_spend FROM litellm."LiteLLM_SpendLogs"
           WHERE request_tags::text LIKE '%' || :'run' || '%' AND "startTime" >= now() - interval '1 hour' GROUP BY model_group`,
          { run: RUN },
        );
      // SpendLogs 异步落库，等所有新名都出现
      const rows = await poll(q, (rs) => NEW_ALL.every((m) => rs.some((r) => r.model_group === m)), 120_000, 10_000);
      note('SpendLogs', rows);
      const missing = NEW_ALL.filter((m) => !rows.some((r) => r.model_group === m));
      expect(missing, 'SpendLogs 里本轮缺记录的新名').toEqual([]);
      const zero = rows.filter((r) => NEW_ALL.includes(r.model_group) && !(Number(r.min_spend) > 0)).map((r) => `${r.model_group} min_spend=${r.min_spend}`);
      expect(zero, 'spend 为 0 的新名（价格表缺这个名字 → 平台白付）').toEqual([]);
    });

    test('IL-4 gemini-flash-latest 带 reasoning_effort="none" → usage reasoning_tokens 为 0 或缺失', () => {
      const r = chat('gemini-flash-latest', { reasoning_effort: 'none' });
      expect(r.status, errMsg(r)).toBe(200);
      const rt = r.json.usage?.completion_tokens_details?.reasoning_tokens;
      note('usage', r.json.usage);
      expect(rt ?? 0, '关闭思考后不应有思考 token').toBe(0);
    });

    // IL-5 不适用（用户 09-29）：语音转文字保持原样，yepairag /asr 直连 OpenAI Whisper、不经 LiteLLM；prod LiteLLM 也不挂 whisper-1。默认 skip，保留备查
    test.skip('IL-5 [不适用：语音保持原样] whisper-1 转写 wavBase64 录音 → 200 且含 Australia', () => {
      const r = whisper();
      expect(r.status, errMsg(r)).toBe(200);
      expect(String(r.json.text)).toMatch(/Australia/i);
    });
  });
});
