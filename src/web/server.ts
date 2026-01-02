#!/usr/bin/env npx tsx
/**
 * YepAI E2E Automation Web UI Server
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { parse as parseYaml } from 'yaml';

const PORT = 3456;
const DATA_FILE = join(process.cwd(), 'data/shopify-oauth-urls.json');
const USERS_FILE = join(process.cwd(), 'data/test-users.json');
const FLOWS_DIR = join(process.cwd(), 'src/flows');

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Load OAuth data
function loadStores() {
  if (existsSync(DATA_FILE)) {
    return JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
  }
  return { records: [], lastUpdated: null };
}

// Save OAuth data
function saveStores(data: { records: any[]; lastUpdated: string }) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Mark a store's OAuth URL as used
function markStoreAsUsed(storeName: string): boolean {
  const data = loadStores();
  const store = data.records.find((r: any) => r.storeName === storeName);
  if (store) {
    store.used = true;
    data.lastUpdated = new Date().toISOString();
    saveStores(data);
    return true;
  }
  return false;
}

// Load test users
function loadUsers() {
  if (existsSync(USERS_FILE)) {
    return JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
  }
  return { users: [], lastUpdated: null };
}

// Load available flows
function loadFlows() {
  const flows: any[] = [];
  if (existsSync(FLOWS_DIR)) {
    const files = readdirSync(FLOWS_DIR).filter(f => f.endsWith('.flow.yml'));
    for (const file of files) {
      try {
        const content = readFileSync(join(FLOWS_DIR, file), 'utf-8');
        const flow = parseYaml(content);
        flows.push({
          id: file.replace('.flow.yml', ''),
          name: flow.name || file.replace('.flow.yml', ''),
          description: flow.description || '',
          steps: flow.steps?.length || 0,
        });
      } catch {}
    }
  }
  return flows;
}

// Escape shell argument to prevent & being interpreted as background operator
function escapeShellArg(arg: string): string {
  // Wrap in single quotes and escape any single quotes inside
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// Execute command and stream output
function executeCommand(cmd: string, args: string[], res: ServerResponse) {
  res.writeHead(200, {
    ...corsHeaders,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Escape arguments that contain special shell characters
  const escapedArgs = args.map(arg => {
    if (arg.includes('&') || arg.includes('|') || arg.includes(';') || arg.includes('$')) {
      return escapeShellArg(arg);
    }
    return arg;
  });

  console.log('Executing command:', cmd, escapedArgs);

  const child = spawn(cmd, escapedArgs, {
    cwd: process.cwd(),
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  child.stdout.on('data', (data) => {
    res.write(`data: ${JSON.stringify({ type: 'stdout', text: data.toString() })}\n\n`);
  });

  child.stderr.on('data', (data) => {
    res.write(`data: ${JSON.stringify({ type: 'stderr', text: data.toString() })}\n\n`);
  });

  child.on('close', (code) => {
    res.write(`data: ${JSON.stringify({ type: 'exit', code })}\n\n`);
    res.end();
  });

  child.on('error', (err) => {
    res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
    res.end();
  });
}

// Request handler
async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // API routes
  if (url.pathname === '/api/stores') {
    const data = loadStores();
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url.pathname === '/api/users') {
    const data = loadUsers();
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url.pathname === '/api/flows') {
    const flows = loadFlows();
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(flows));
    return;
  }

  // Mark a store's OAuth URL as used
  if (url.pathname === '/api/mark-used' && req.method === 'POST') {
    const storeName = url.searchParams.get('store');
    if (!storeName) {
      res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing store parameter' }));
      return;
    }

    const success = markStoreAsUsed(storeName);
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success, storeName }));
    return;
  }

  if (url.pathname === '/api/create-store' && req.method === 'POST') {
    executeCommand('pnpm', ['shopify:cdp'], res);
    return;
  }

  if (url.pathname === '/api/run-flow' && req.method === 'POST') {
    const flowId = url.searchParams.get('flow');

    // 获取原始查询字符串来提取完整的 oauth_url
    // 因为 oauth_url 本身包含 & 符号，标准 URL 解析会错误地分割它
    const rawQuery = req.url?.split('?')[1] || '';
    const oauthUrlMatch = rawQuery.match(/oauth_url=([^&]*(?:%26[^&]*)*)/);
    let oauthUrl = oauthUrlMatch ? decodeURIComponent(oauthUrlMatch[1]) : null;

    console.log('Raw query:', rawQuery);
    console.log('OAuth URL match:', oauthUrlMatch?.[1]);
    console.log('Decoded OAuth URL:', oauthUrl);

    if (!flowId) {
      res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing flow parameter' }));
      return;
    }

    const args = ['flow', flowId];
    if (oauthUrl) {
      args.push('--var', `OAUTH_URL=${oauthUrl}`);
      console.log('Final command args:', args);
    }

    executeCommand('pnpm', args, res);
    return;
  }

  // Serve static HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = generateHTML();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// Generate HTML UI
function generateHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YepAI E2E Automation</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%);
      min-height: 100vh;
      color: #e4e4e7;
      padding: 20px;
    }

    .container { max-width: 1400px; margin: 0 auto; }

    header {
      text-align: center;
      padding: 30px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      margin-bottom: 30px;
    }

    h1 {
      font-size: 2.5rem;
      background: linear-gradient(90deg, #22c55e, #3b82f6, #a855f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 10px;
    }

    .subtitle { color: #a1a1aa; font-size: 1.1rem; }

    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      padding-bottom: 16px;
    }

    .tab {
      padding: 12px 24px;
      border: none;
      background: rgba(255,255,255,0.05);
      color: #a1a1aa;
      border-radius: 10px 10px 0 0;
      cursor: pointer;
      font-size: 0.95rem;
      font-weight: 500;
      transition: all 0.2s;
    }

    .tab:hover { background: rgba(255,255,255,0.1); color: #e4e4e7; }
    .tab.active { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .section-title {
      font-size: 1.3rem;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .grid-3 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }

    .card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 20px;
      transition: all 0.3s ease;
    }

    .card:hover {
      transform: translateY(-2px);
      border-color: rgba(59, 130, 246, 0.3);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    }

    .card h3 {
      font-size: 1.1rem;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .card p {
      color: #a1a1aa;
      font-size: 0.85rem;
      margin-bottom: 16px;
      line-height: 1.5;
    }

    .card-meta {
      font-size: 0.8rem;
      color: #71717a;
      margin-bottom: 12px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      width: 100%;
      justify-content: center;
    }

    .btn-primary {
      background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
      color: white;
    }
    .btn-primary:hover { box-shadow: 0 6px 20px rgba(34, 197, 94, 0.4); }

    .btn-blue {
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      color: white;
    }
    .btn-blue:hover { box-shadow: 0 6px 20px rgba(59, 130, 246, 0.4); }

    .btn-purple {
      background: linear-gradient(135deg, #a855f7 0%, #9333ea 100%);
      color: white;
    }
    .btn-purple:hover { box-shadow: 0 6px 20px rgba(168, 85, 247, 0.4); }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.1);
      color: #e4e4e7;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.15); }

    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .output-section {
      background: #0a0a12;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      margin-top: 30px;
      overflow: hidden;
    }

    .output-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 20px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .output-header h3 { font-size: 0.95rem; display: flex; align-items: center; gap: 8px; }

    .status-badge {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .status-idle { background: rgba(161, 161, 170, 0.2); color: #a1a1aa; }
    .status-running { background: rgba(59, 130, 246, 0.2); color: #60a5fa; animation: pulse 2s infinite; }
    .status-success { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .status-error { background: rgba(239, 68, 68, 0.2); color: #ef4444; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    .output-content {
      padding: 16px 20px;
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      font-size: 0.8rem;
      line-height: 1.6;
      max-height: 350px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .output-content:empty::before {
      content: '等待执行...';
      color: #52525b;
    }

    .output-line { margin: 1px 0; }
    .output-stdout { color: #d4d4d8; }
    .output-stderr { color: #fbbf24; }
    .output-error { color: #ef4444; }
    .output-success { color: #22c55e; font-weight: 600; }

    .data-section { margin-top: 30px; }

    .data-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .badge {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 500;
    }

    .badge-blue { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    .badge-green { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .badge-purple { background: rgba(168, 85, 247, 0.2); color: #a855f7; }

    .data-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
    }

    .data-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      padding: 14px;
    }

    .data-card h4 {
      font-size: 0.95rem;
      color: #22c55e;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .data-card .subtitle {
      font-size: 0.8rem;
      color: #71717a;
      margin-bottom: 10px;
    }

    .data-card .meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75rem;
      color: #52525b;
    }

    .copy-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #a1a1aa;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
      margin-top: 10px;
      width: 100%;
    }

    .copy-btn:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }

    .loading {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 1s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: #52525b;
      font-size: 0.9rem;
    }

    .flow-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.7rem;
      margin-left: 8px;
    }

    .flow-badge.steps { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>YepAI E2E Automation</h1>
      <p class="subtitle">Shopify 商店创建 · OAuth 注册流程</p>
    </header>

    <div class="tabs">
      <button class="tab active" onclick="switchTab('actions')">🚀 操作</button>
      <button class="tab" onclick="switchTab('flows')">📋 流程</button>
      <button class="tab" onclick="switchTab('stores')">🏪 商店</button>
      <button class="tab" onclick="switchTab('users')">👥 用户</button>
    </div>

    <!-- Tab: Actions -->
    <div id="tab-actions" class="tab-content active">
      <h2 class="section-title">🎯 快速操作</h2>
      <div class="grid-3">
        <div class="card" style="border-color: rgba(34, 197, 94, 0.3);">
          <h3>🏪 创建 Shopify 商店</h3>
          <p>使用 CDP 模式快速创建 Shopify 开发商店，自动完成 OAuth 授权并获取回调 URL。</p>
          <div class="card-meta">预计耗时: ~40秒</div>
          <button class="btn btn-primary" onclick="createStore()" id="createStoreBtn">创建商店</button>
        </div>

        <div class="card" style="border-color: rgba(168, 85, 247, 0.3);">
          <h3>🛍️ Shopify OAuth 注册</h3>
          <p>使用已有的 OAuth URL 完成注册（选择 Free Plan，包含 Product Training）。自动使用未使用的商店 URL。</p>
          <div class="card-meta">预计耗时: ~3分钟</div>
          <button class="btn btn-purple" onclick="runShopifyOAuthFlow()" id="shopifyOAuthBtn">Shopify 注册</button>
        </div>

        <div class="card">
          <h3>⚙️ 自定义 OAuth URL</h3>
          <p>使用自定义的 OAuth URL 运行 Shopify 注册流程。</p>
          <div class="card-meta">手动输入 URL</div>
          <button class="btn btn-blue" onclick="runCustomOAuthFlow()">自定义 URL</button>
        </div>
      </div>

      <div class="grid-3">
        <div class="card">
          <h3>📋 获取未使用 URL</h3>
          <p>获取一个未被标记为已使用的 OAuth 回调 URL，并复制到剪贴板。</p>
          <button class="btn btn-secondary" onclick="getUnusedUrl()">获取 URL</button>
        </div>

        <div class="card">
          <h3>🔄 刷新数据</h3>
          <p>重新加载商店列表和用户数据。</p>
          <button class="btn btn-secondary" onclick="refreshAll()">刷新</button>
        </div>
      </div>
    </div>

    <!-- Tab: Flows -->
    <div id="tab-flows" class="tab-content">
      <h2 class="section-title">📋 可用流程</h2>
      <div class="grid-3" id="flowsGrid">
        <div class="empty-state">加载中...</div>
      </div>
    </div>

    <!-- Tab: Stores -->
    <div id="tab-stores" class="tab-content">
      <div class="data-header">
        <h2 class="section-title">🏪 已创建的商店</h2>
        <span class="badge badge-green" id="storeCount">0 个</span>
      </div>
      <div class="data-grid" id="storesGrid">
        <div class="empty-state">加载中...</div>
      </div>
    </div>

    <!-- Tab: Users -->
    <div id="tab-users" class="tab-content">
      <div class="data-header">
        <h2 class="section-title">👥 测试用户</h2>
        <span class="badge badge-purple" id="userCount">0 个</span>
      </div>
      <div class="data-grid" id="usersGrid">
        <div class="empty-state">加载中...</div>
      </div>
    </div>

    <!-- Output Section -->
    <div class="output-section">
      <div class="output-header">
        <h3>📟 执行输出</h3>
        <div>
          <button class="btn btn-secondary" style="width: auto; padding: 6px 12px; font-size: 0.8rem;" onclick="clearOutput()">清空</button>
          <span class="status-badge status-idle" id="statusBadge">待命</span>
        </div>
      </div>
      <div class="output-content" id="outputContent"></div>
    </div>
  </div>

  <script>
    const output = document.getElementById('outputContent');
    const statusBadge = document.getElementById('statusBadge');
    let isRunning = false;
    let currentBtn = null;

    function switchTab(tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelector(\`.tab[onclick*="\${tabId}"]\`).classList.add('active');
      document.getElementById('tab-' + tabId).classList.add('active');
    }

    function setStatus(status, text) {
      statusBadge.className = 'status-badge status-' + status;
      statusBadge.textContent = text;
    }

    function appendOutput(text, type = 'stdout') {
      const line = document.createElement('div');
      line.className = 'output-line output-' + type;
      line.textContent = text;
      output.appendChild(line);
      output.scrollTop = output.scrollHeight;
    }

    function clearOutput() { output.innerHTML = ''; setStatus('idle', '待命'); }

    function setButtonLoading(btn, loading, text) {
      if (loading) {
        btn.disabled = true;
        btn.dataset.originalText = btn.innerHTML;
        btn.innerHTML = '<span class="loading"></span> 执行中...';
      } else {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalText || text;
      }
    }

    async function executeStream(url, btn) {
      if (isRunning) return;
      isRunning = true;
      currentBtn = btn;

      setButtonLoading(btn, true);
      clearOutput();
      setStatus('running', '执行中');

      try {
        const response = await fetch(url, { method: 'POST' });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value);
          const lines = text.split('\\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'stdout') appendOutput(data.text, 'stdout');
                else if (data.type === 'stderr') appendOutput(data.text, 'stderr');
                else if (data.type === 'exit') {
                  if (data.code === 0) {
                    setStatus('success', '成功');
                    appendOutput('\\n✅ 执行完成', 'success');
                  } else {
                    setStatus('error', '失败');
                    appendOutput('\\n❌ 执行失败 (code: ' + data.code + ')', 'error');
                  }
                } else if (data.type === 'error') {
                  appendOutput('错误: ' + data.text, 'error');
                  setStatus('error', '错误');
                }
              } catch {}
            }
          }
        }
        setTimeout(refreshAll, 1000);
      } catch (err) {
        appendOutput('请求失败: ' + err.message, 'error');
        setStatus('error', '错误');
      }

      isRunning = false;
      setButtonLoading(btn, false);
    }

    function createStore() {
      executeStream('/api/create-store', document.getElementById('createStoreBtn'));
    }

    function runFlow(flowId, extraParams = '') {
      const btn = document.querySelector(\`[onclick*="\${flowId}"]\`) || document.getElementById(flowId + 'Btn');
      executeStream('/api/run-flow?flow=' + flowId + extraParams, btn);
    }

    async function runShopifyOAuthFlow() {
      // 获取未使用的 OAuth URL
      try {
        const res = await fetch('/api/stores');
        const data = await res.json();

        console.log('All stores:', data.records);
        console.log('Used status:', data.records.map(r => ({ name: r.storeName, used: r.used })));

        const unused = data.records.find(r => !r.used);

        if (!unused) {
          clearOutput();
          appendOutput('❌ 没有未使用的 OAuth URL', 'error');
          appendOutput('请先创建一个新的 Shopify 商店', 'stderr');
          appendOutput('\\n所有商店状态: ' + JSON.stringify(data.records.map(r => ({ name: r.storeName, used: r.used })), null, 2), 'stderr');
          setStatus('error', '无 URL');
          return;
        }

        clearOutput();
        appendOutput('使用商店: ' + unused.storeName, 'stdout');
        appendOutput('完整 OAuth URL:\\n' + unused.oauthCallbackUrl + '\\n', 'stdout');

        // 立即标记为已使用，防止重复使用
        await fetch('/api/mark-used?store=' + encodeURIComponent(unused.storeName), { method: 'POST' });
        appendOutput('✓ 已标记 OAuth URL 为已使用\\n', 'stdout');

        // 刷新商店列表显示
        refreshStores();

        const btn = document.getElementById('shopifyOAuthBtn');
        const encodedUrl = encodeURIComponent(unused.oauthCallbackUrl);
        console.log('Encoded URL:', encodedUrl);
        executeStream('/api/run-flow?flow=shopify-oauth-registration&oauth_url=' + encodedUrl, btn);
      } catch (err) {
        appendOutput('获取 OAuth URL 失败: ' + err.message, 'error');
        setStatus('error', '错误');
      }
    }

    function runCustomOAuthFlow() {
      const url = prompt('请输入 OAuth 回调 URL:');
      if (!url) return;

      if (!url.includes('yepai.io') && !url.includes('localhost')) {
        alert('URL 格式不正确，请输入有效的 OAuth 回调 URL');
        return;
      }

      clearOutput();
      appendOutput('使用自定义 OAuth URL:\\n' + url.substring(0, 80) + '...\\n', 'stdout');

      const btn = document.querySelector('[onclick*="runCustomOAuthFlow"]');
      const encodedUrl = encodeURIComponent(url);
      executeStream('/api/run-flow?flow=shopify-oauth-registration&oauth_url=' + encodedUrl, btn);
    }

    async function refreshStores() {
      try {
        const res = await fetch('/api/stores');
        const data = await res.json();
        document.getElementById('storeCount').textContent = data.records.length + ' 个';

        const grid = document.getElementById('storesGrid');
        if (data.records.length === 0) {
          grid.innerHTML = '<div class="empty-state">暂无商店，点击"创建商店"开始</div>';
        } else {
          grid.innerHTML = data.records.map(s => \`
            <div class="data-card">
              <h4>🏪 \${s.storeName}</h4>
              <div class="subtitle">\${s.storeUrl}</div>
              <div class="meta">
                <span>\${new Date(s.createdAt).toLocaleString('zh-CN')}</span>
                <span class="badge \${s.used ? '' : 'badge-green'}">\${s.used ? '已使用' : '未使用'}</span>
              </div>
              <button class="copy-btn" onclick="copyUrl('\${s.oauthCallbackUrl}')">复制 OAuth URL</button>
            </div>
          \`).join('');
        }
      } catch {}
    }

    async function refreshUsers() {
      try {
        const res = await fetch('/api/users');
        const data = await res.json();
        const users = data.users || [];
        document.getElementById('userCount').textContent = users.length + ' 个';

        const grid = document.getElementById('usersGrid');
        if (users.length === 0) {
          grid.innerHTML = '<div class="empty-state">暂无用户，运行注册流程创建测试用户</div>';
        } else {
          grid.innerHTML = users.map(u => \`
            <div class="data-card">
              <h4>👤 \${u.firstName} \${u.lastName}</h4>
              <div class="subtitle">\${u.email}</div>
              <div class="meta">
                <span>\${u.organization}</span>
                <span class="badge badge-purple">\${u.status}</span>
              </div>
              <button class="copy-btn" onclick="copyText('\${u.email}')">复制邮箱</button>
            </div>
          \`).join('');
        }
      } catch {}
    }

    async function refreshFlows() {
      try {
        const res = await fetch('/api/flows');
        const flows = await res.json();

        const grid = document.getElementById('flowsGrid');
        if (flows.length === 0) {
          grid.innerHTML = '<div class="empty-state">暂无可用流程</div>';
        } else {
          grid.innerHTML = flows.map(f => \`
            <div class="card">
              <h3>\${getFlowIcon(f.id)} \${f.name} <span class="flow-badge steps">\${f.steps} 步骤</span></h3>
              <p>\${f.description || '无描述'}</p>
              <button class="btn btn-secondary" onclick="runFlow('\${f.id}')">运行</button>
            </div>
          \`).join('');
        }
      } catch {}
    }

    function getFlowIcon(id) {
      const icons = {
        'shopify-store-create': '🏪',
        'shopify-oauth-registration': '🛍️',
      };
      return icons[id] || '📋';
    }

    function refreshAll() {
      refreshStores();
      refreshUsers();
      refreshFlows();
    }

    async function getUnusedUrl() {
      try {
        const res = await fetch('/api/stores');
        const data = await res.json();
        const unused = data.records.find(r => !r.used);

        clearOutput();
        if (unused) {
          appendOutput('找到未使用的 OAuth URL:\\n', 'success');
          appendOutput('商店: ' + unused.storeName, 'stdout');
          appendOutput('URL: ' + unused.oauthCallbackUrl, 'stdout');
          await navigator.clipboard.writeText(unused.oauthCallbackUrl);
          appendOutput('\\n✅ 已复制到剪贴板', 'success');
          setStatus('success', '找到');
        } else {
          appendOutput('没有未使用的 OAuth URL，请先创建新商店', 'stderr');
          setStatus('idle', '无结果');
        }
      } catch (err) {
        appendOutput('获取失败: ' + err.message, 'error');
        setStatus('error', '错误');
      }
    }

    async function copyUrl(url) {
      try { await navigator.clipboard.writeText(url); alert('已复制到剪贴板'); }
      catch { prompt('复制以下 URL:', url); }
    }

    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); alert('已复制'); }
      catch { prompt('复制:', text); }
    }

    // Initial load
    refreshAll();
  </script>
</body>
</html>`;
}

// Start server
const server = createServer(handler);
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  YepAI E2E Automation UI                         ║
║  http://localhost:${PORT}                           ║
╚══════════════════════════════════════════════════╝
  `);
});
