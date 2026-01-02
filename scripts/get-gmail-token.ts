/**
 * Gmail OAuth Token Generator
 * Run: npx tsx scripts/get-gmail-token.ts
 */

import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';
import open from 'open';

// ========================================
// 在这里填入你的 OAuth 凭证 (从 Google Cloud Console 获取)
// 1. https://console.cloud.google.com/apis/credentials
// 2. 创建 OAuth 2.0 Client ID (Web application)
// 3. 添加 redirect URI: http://localhost:3456/oauth2callback
// ========================================
const CLIENT_ID = '961802278424-960uohh0asdctbdrji4ee3l4ea77fopv.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
// ========================================

const REDIRECT_URI = 'http://localhost:3456/oauth2callback';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

async function main() {
  if (CLIENT_ID === 'YOUR_CLIENT_ID.apps.googleusercontent.com') {
    console.log('❌ 请先编辑此文件，填入你的 CLIENT_ID 和 CLIENT_SECRET');
    console.log('\n从 Google Cloud Console 获取:');
    console.log('https://console.cloud.google.com/apis/credentials');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // 强制生成 refresh token
  });

  console.log('\n🔐 Gmail OAuth 授权\n');
  console.log('正在打开浏览器进行授权...\n');

  // 创建本地服务器接收回调
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '', `http://localhost:3456`);

    if (url.pathname === '/oauth2callback') {
      const code = url.searchParams.get('code');

      if (code) {
        try {
          const { tokens } = await oauth2Client.getToken(code);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>✅ 授权成功!</h1>
                <p>请返回终端查看 Token</p>
                <p>可以关闭此窗口</p>
              </body>
            </html>
          `);

          console.log('✅ 授权成功!\n');
          console.log('========================================');
          console.log('将以下内容添加到 .env 文件:');
          console.log('========================================\n');
          console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
          console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
          console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
          console.log(`GMAIL_TARGET_EMAIL=xmqywx@gmail.com`);
          console.log('\n========================================\n');

          server.close();
          process.exit(0);
        } catch (error) {
          res.writeHead(500);
          res.end('Token exchange failed');
          console.error('❌ Token 获取失败:', error);
          server.close();
          process.exit(1);
        }
      }
    }
  });

  server.listen(3456, () => {
    console.log('📡 本地服务器已启动 (端口 3456)');
    open(authUrl);
  });
}

main().catch(console.error);
