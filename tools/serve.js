/* ============================================================
   serve.js - 零依赖本地静态服务器
   用法： node tools/serve.js [--port 8788] [--open]
   作用：把 web/ 目录发布到本机与局域网，手机/电脑浏览器都能访问。
   ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');

const ROOT = path.join(__dirname, '..', 'web');
const argv = process.argv.slice(2);
const portArgIdx = argv.indexOf('--port');
const PORT = Number(portArgIdx >= 0 ? argv[portArgIdx + 1] : (process.env.PORT || 8788));
const SHOULD_OPEN = argv.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  }, headers || {}));
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return send(res, 400, 'Bad Request');
  }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(ROOT))) {
    return send(res, 403, 'Forbidden');
  }

  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      // 单页应用回退
      const fallback = path.join(ROOT, 'index.html');
      return fs.readFile(fallback, (e2, data) => {
        if (e2) return send(res, 404, 'Not Found');
        send(res, 200, data, { 'Content-Type': MIME['.html'] });
      });
    }
    const ext = path.extname(resolved).toLowerCase();
    fs.readFile(resolved, (e2, data) => {
      if (e2) return send(res, 500, 'Read Error');
      send(res, 200, data, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': data.length
      });
    });
  });
});

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) out.push({ name, address: info.address });
    });
  });
  return out;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n端口 ' + PORT + ' 已被占用。');
    console.error('可能记账本已经在运行了，直接打开浏览器访问 http://127.0.0.1:' + PORT + ' 即可。');
    console.error('或者换个端口，例如： node tools/serve.js --port 8899\n');
  } else {
    console.error('启动失败：', err.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const local = 'http://127.0.0.1:' + PORT + '/';
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │        大学生活记账本  已启动                 │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log('  电脑上打开：' + local);
  const lan = lanAddresses();
  if (lan.length) {
    console.log('');
    console.log('  手机上打开（需与电脑在同一 WiFi）：');
    lan.forEach((i) => console.log('    http://' + i.address + ':' + PORT + '/    (' + i.name + ')'));
    console.log('');
    console.log('  手机首次打开后，浏览器菜单里选「添加到主屏幕」，即可当 App 使用。');
  }
  console.log('');
  console.log('  按 Ctrl + C 停止服务。');
  console.log('');

  if (SHOULD_OPEN) {
    const cmd = process.platform === 'win32' ? 'start "" "' + local + '"'
      : process.platform === 'darwin' ? 'open "' + local + '"' : 'xdg-open "' + local + '"';
    exec(cmd, () => {});
  }
});