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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-primary: #0A0E14;
      --bg-secondary: #0F1419;
      --bg-card: rgba(255, 255, 255, 0.02);
      --bg-card-hover: rgba(255, 255, 255, 0.04);
      --border-color: rgba(255, 255, 255, 0.06);
      --border-hover: rgba(59, 130, 246, 0.4);
      --text-primary: #E4E4E7;
      --text-secondary: #A1A1AA;
      --text-muted: #71717A;
      --accent-blue: #2563EB;
      --accent-blue-light: #3B82F6;
      --accent-green: #22C55E;
      --accent-purple: #A855F7;
      --accent-orange: #F97316;
      --accent-red: #EF4444;
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      min-height: 100vh;
      color: var(--text-primary);
      line-height: 1.5;
    }

    .container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px 16px;
    }

    @media (min-width: 768px) { .container { padding: 32px 24px; } }
    @media (min-width: 1024px) { .container { padding: 40px 32px; } }

    /* Header */
    header {
      text-align: center;
      padding: 32px 0 40px;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 32px;
    }

    .logo { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 8px; }

    .logo svg { width: 40px; height: 40px; color: var(--accent-blue); }

    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }

    @media (min-width: 768px) { h1 { font-size: 2rem; } }

    .subtitle { color: var(--text-secondary); font-size: 0.9rem; margin-top: 4px; }

    /* Navigation Tabs */
    .nav-tabs {
      display: flex;
      gap: 4px;
      padding: 4px;
      background: var(--bg-secondary);
      border-radius: 12px;
      margin-bottom: 32px;
      overflow-x: auto;
    }

    .nav-tab {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      font-family: inherit;
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    .nav-tab:hover { color: var(--text-primary); background: rgba(255, 255, 255, 0.05); }
    .nav-tab.active { background: var(--accent-blue); color: white; }
    .nav-tab svg { width: 18px; height: 18px; flex-shrink: 0; }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Section Title */
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }

    .section-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .section-title svg { width: 22px; height: 22px; color: var(--accent-blue); }

    /* Grid */
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
      margin-bottom: 24px;
    }

    @media (min-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1024px) { .grid { grid-template-columns: repeat(3, 1fr); } }

    /* Cards */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
      transition: all 0.2s ease;
      cursor: pointer;
    }

    .card:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-hover);
      transform: translateY(-1px);
    }

    .card-header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }

    .card-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .card-icon svg { width: 20px; height: 20px; color: white; }

    .card-icon.green { background: linear-gradient(135deg, var(--accent-green), #16A34A); }
    .card-icon.purple { background: linear-gradient(135deg, var(--accent-purple), #9333EA); }
    .card-icon.blue { background: linear-gradient(135deg, var(--accent-blue), #1D4ED8); }
    .card-icon.orange { background: linear-gradient(135deg, var(--accent-orange), #EA580C); }
    .card-icon.gray { background: rgba(255, 255, 255, 0.1); }

    .card-title { font-size: 0.95rem; font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
    .card-meta { font-size: 0.75rem; color: var(--text-muted); }
    .card-desc { font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5; margin-bottom: 16px; }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 16px;
      border: none;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s ease;
      width: 100%;
    }

    .btn svg { width: 16px; height: 16px; }

    .btn-primary { background: var(--accent-blue); color: white; }
    .btn-primary:hover { background: var(--accent-blue-light); box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3); }

    .btn-green { background: var(--accent-green); color: white; }
    .btn-green:hover { box-shadow: 0 4px 12px rgba(34, 197, 94, 0.3); }

    .btn-purple { background: var(--accent-purple); color: white; }
    .btn-purple:hover { box-shadow: 0 4px 12px rgba(168, 85, 247, 0.3); }

    .btn-ghost {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
    }
    .btn-ghost:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-primary); }

    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .badge-blue { background: rgba(59, 130, 246, 0.15); color: var(--accent-blue-light); }
    .badge-green { background: rgba(34, 197, 94, 0.15); color: var(--accent-green); }
    .badge-purple { background: rgba(168, 85, 247, 0.15); color: var(--accent-purple); }
    .badge-gray { background: rgba(161, 161, 170, 0.15); color: var(--text-secondary); }

    /* Data Cards */
    .data-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 16px;
      transition: all 0.2s ease;
    }

    .data-card:hover { border-color: var(--border-hover); }

    .data-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .data-card-header svg { width: 18px; height: 18px; color: var(--accent-green); }

    .data-card-title { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
    .data-card-subtitle { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 12px; }

    .data-card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 12px;
    }

    .copy-btn {
      width: 100%;
      padding: 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      color: var(--text-secondary);
      font-size: 0.8rem;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .copy-btn:hover { background: rgba(255, 255, 255, 0.06); color: var(--text-primary); }

    /* Output Console */
    .console {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      margin-top: 32px;
      overflow: hidden;
    }

    .console-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border-color);
    }

    .console-title { display: flex; align-items: center; gap: 8px; font-size: 0.875rem; font-weight: 500; }
    .console-title svg { width: 18px; height: 18px; color: var(--accent-blue); }

    .console-actions { display: flex; align-items: center; gap: 8px; }

    .status-badge {
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .status-idle { background: rgba(161, 161, 170, 0.15); color: var(--text-muted); }
    .status-running { background: rgba(59, 130, 246, 0.15); color: var(--accent-blue-light); animation: pulse 2s infinite; }
    .status-success { background: rgba(34, 197, 94, 0.15); color: var(--accent-green); }
    .status-error { background: rgba(239, 68, 68, 0.15); color: var(--accent-red); }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

    .console-body {
      padding: 16px;
      font-family: 'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace;
      font-size: 0.8rem;
      line-height: 1.7;
      max-height: 320px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .console-body:empty::before { content: '等待执行...'; color: var(--text-muted); }

    .output-line { margin: 2px 0; }
    .output-stdout { color: var(--text-primary); }
    .output-stderr { color: #FBBF24; }
    .output-error { color: var(--accent-red); }
    .output-success { color: var(--accent-green); font-weight: 500; }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    /* Loading Spinner */
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Flow Badge */
    .flow-steps {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      background: rgba(59, 130, 246, 0.1);
      border-radius: 4px;
      font-size: 0.7rem;
      color: var(--accent-blue-light);
      margin-left: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
          <path d="M2 17l10 5 10-5"/>
          <path d="M2 12l10 5 10-5"/>
        </svg>
        <h1>YepAI E2E Automation</h1>
      </div>
      <p class="subtitle">Shopify 商店创建 · 用户注册 · OAuth 注册流程</p>
    </header>

    <nav class="nav-tabs">
      <button class="nav-tab active" onclick="switchTab('actions')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        操作
      </button>
      <button class="nav-tab" onclick="switchTab('flows')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
        流程
      </button>
      <button class="nav-tab" onclick="switchTab('stores')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        商店
      </button>
      <button class="nav-tab" onclick="switchTab('users')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        用户
      </button>
    </nav>

    <!-- Tab: Actions -->
    <div id="tab-actions" class="tab-content active">
      <div class="section-header">
        <h2 class="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          快速操作
        </h2>
      </div>

      <div class="grid">
        <div class="card" onclick="createStore()">
          <div class="card-header">
            <div class="card-icon green">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            </div>
            <div>
              <div class="card-title">创建 Shopify 商店</div>
              <div class="card-meta">预计耗时 ~40秒</div>
            </div>
          </div>
          <p class="card-desc">使用 CDP 模式快速创建 Shopify 开发商店，自动完成 OAuth 授权并获取回调 URL。</p>
          <button class="btn btn-green" id="createStoreBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            创建商店
          </button>
        </div>

        <div class="card" onclick="runShopifyOAuthFlow()">
          <div class="card-header">
            <div class="card-icon purple">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
            </div>
            <div>
              <div class="card-title">Shopify OAuth 注册</div>
              <div class="card-meta">预计耗时 ~3分钟</div>
            </div>
          </div>
          <p class="card-desc">使用已有的 OAuth URL 完成注册（选择 Free Plan，包含 Product Training）。</p>
          <button class="btn btn-purple" id="shopifyOAuthBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            开始注册
          </button>
        </div>

        <div class="card" onclick="runFlow('registration')">
          <div class="card-header">
            <div class="card-icon blue">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6"/><path d="M23 11h-6"/></svg>
            </div>
            <div>
              <div class="card-title">用户注册流程</div>
              <div class="card-meta">预计耗时 ~2分钟</div>
            </div>
          </div>
          <p class="card-desc">完整的 YepAI 注册流程，包括表单填写、邮箱验证、平台选择、问卷调查等。</p>
          <button class="btn btn-primary" id="registrationBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            运行注册
          </button>
        </div>
      </div>

      <div class="grid">
        <div class="card" onclick="runCustomOAuthFlow()">
          <div class="card-header">
            <div class="card-icon orange">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </div>
            <div>
              <div class="card-title">自定义 OAuth URL</div>
              <div class="card-meta">手动输入</div>
            </div>
          </div>
          <p class="card-desc">使用自定义的 OAuth URL 运行 Shopify 注册流程。</p>
          <button class="btn btn-ghost">输入 URL</button>
        </div>

        <div class="card" onclick="getUnusedUrl()">
          <div class="card-header">
            <div class="card-icon gray">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </div>
            <div>
              <div class="card-title">获取未使用 URL</div>
              <div class="card-meta">复制到剪贴板</div>
            </div>
          </div>
          <p class="card-desc">获取一个未被标记为已使用的 OAuth 回调 URL。</p>
          <button class="btn btn-ghost">获取 URL</button>
        </div>

        <div class="card" onclick="refreshAll()">
          <div class="card-header">
            <div class="card-icon gray">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
            </div>
            <div>
              <div class="card-title">刷新数据</div>
              <div class="card-meta">重新加载</div>
            </div>
          </div>
          <p class="card-desc">重新加载商店列表、用户数据和可用流程。</p>
          <button class="btn btn-ghost">刷新</button>
        </div>
      </div>
    </div>

    <!-- Tab: Flows -->
    <div id="tab-flows" class="tab-content">
      <div class="section-header">
        <h2 class="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
          可用流程
        </h2>
      </div>
      <div class="grid" id="flowsGrid">
        <div class="empty-state">加载中...</div>
      </div>
    </div>

    <!-- Tab: Stores -->
    <div id="tab-stores" class="tab-content">
      <div class="section-header">
        <h2 class="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          已创建的商店
        </h2>
        <span class="badge badge-green" id="storeCount">0 个</span>
      </div>
      <div class="grid" id="storesGrid">
        <div class="empty-state">加载中...</div>
      </div>
    </div>

    <!-- Tab: Users -->
    <div id="tab-users" class="tab-content">
      <div class="section-header">
        <h2 class="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          测试用户
        </h2>
        <span class="badge badge-purple" id="userCount">0 个</span>
      </div>
      <div class="grid" id="usersGrid">
        <div class="empty-state">加载中...</div>
      </div>
    </div>

    <!-- Console -->
    <div class="console">
      <div class="console-header">
        <div class="console-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          执行输出
        </div>
        <div class="console-actions">
          <button class="btn btn-ghost" style="width:auto;padding:6px 12px;font-size:0.75rem" onclick="clearOutput()">清空</button>
          <span class="status-badge status-idle" id="statusBadge">待命</span>
        </div>
      </div>
      <div class="console-body" id="outputContent"></div>
    </div>
  </div>

  <script>
    const output = document.getElementById('outputContent');
    const statusBadge = document.getElementById('statusBadge');
    let isRunning = false;

    function switchTab(tabId) {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelector(\`.nav-tab[onclick*="\${tabId}"]\`).classList.add('active');
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

    function setButtonLoading(btn, loading) {
      if (loading) {
        btn.disabled = true;
        btn.dataset.originalText = btn.innerHTML;
        btn.innerHTML = '<span class="spinner"></span> 执行中...';
      } else {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalText || '';
      }
    }

    async function executeStream(url, btn) {
      if (isRunning) return;
      isRunning = true;

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
                    appendOutput('\\n✓ 执行完成', 'success');
                  } else {
                    setStatus('error', '失败');
                    appendOutput('\\n✗ 执行失败 (code: ' + data.code + ')', 'error');
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

    function runFlow(flowId) {
      const btn = document.getElementById(flowId + 'Btn') || document.querySelector(\`[onclick*="\${flowId}"]\`);
      executeStream('/api/run-flow?flow=' + flowId, btn);
    }

    async function runShopifyOAuthFlow() {
      try {
        const res = await fetch('/api/stores');
        const data = await res.json();
        const unused = data.records.find(r => !r.used);

        if (!unused) {
          clearOutput();
          appendOutput('✗ 没有未使用的 OAuth URL', 'error');
          appendOutput('请先创建一个新的 Shopify 商店', 'stderr');
          setStatus('error', '无 URL');
          return;
        }

        clearOutput();
        appendOutput('使用商店: ' + unused.storeName, 'stdout');
        appendOutput('OAuth URL: ' + unused.oauthCallbackUrl.substring(0, 60) + '...\\n', 'stdout');

        await fetch('/api/mark-used?store=' + encodeURIComponent(unused.storeName), { method: 'POST' });
        appendOutput('✓ 已标记为已使用\\n', 'stdout');
        refreshStores();

        const btn = document.getElementById('shopifyOAuthBtn');
        const encodedUrl = encodeURIComponent(unused.oauthCallbackUrl);
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
        alert('URL 格式不正确');
        return;
      }
      clearOutput();
      appendOutput('使用自定义 OAuth URL:\\n' + url.substring(0, 60) + '...\\n', 'stdout');
      const btn = document.querySelector('[onclick*="runCustomOAuthFlow"]');
      executeStream('/api/run-flow?flow=shopify-oauth-registration&oauth_url=' + encodeURIComponent(url), btn);
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
              <div class="data-card-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                <span class="data-card-title">\${s.storeName}</span>
              </div>
              <div class="data-card-subtitle">\${s.storeUrl}</div>
              <div class="data-card-footer">
                <span>\${new Date(s.createdAt).toLocaleString('zh-CN')}</span>
                <span class="badge \${s.used ? 'badge-gray' : 'badge-green'}">\${s.used ? '已使用' : '未使用'}</span>
              </div>
              <button class="copy-btn" onclick="event.stopPropagation();copyUrl('\${s.oauthCallbackUrl}')">复制 OAuth URL</button>
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
              <div class="data-card-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span class="data-card-title">\${u.firstName} \${u.lastName}</span>
              </div>
              <div class="data-card-subtitle">\${u.email}</div>
              <div class="data-card-footer">
                <span>\${u.organization || '-'}</span>
                <span class="badge badge-purple">\${u.status || 'active'}</span>
              </div>
              <button class="copy-btn" onclick="event.stopPropagation();copyText('\${u.email}')">复制邮箱</button>
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
            <div class="card" onclick="runFlow('\${f.id}')">
              <div class="card-header">
                <div class="card-icon blue">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </div>
                <div>
                  <div class="card-title">\${f.name} <span class="flow-steps">\${f.steps} 步骤</span></div>
                </div>
              </div>
              <p class="card-desc">\${f.description || '无描述'}</p>
              <button class="btn btn-ghost">运行流程</button>
            </div>
          \`).join('');
        }
      } catch {}
    }

    function refreshAll() { refreshStores(); refreshUsers(); refreshFlows(); }

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
          appendOutput('\\n✓ 已复制到剪贴板', 'success');
          setStatus('success', '已复制');
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
