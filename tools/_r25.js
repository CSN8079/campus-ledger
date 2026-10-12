const fs = require('fs');
const path = require('path');
const ROOT = __dirname + '/..';
function load(p) {
  const raw = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  return { eol: eol, text: raw.split('\r\n').join('\n') };
}
function save(p, h, text) {
  fs.writeFileSync(path.join(ROOT, p), h.eol === '\n' ? text : text.split('\n').join('\r\n'), 'utf8');
}
function once(p, from, to) {
  const h = load(p);
  const n = h.text.split(from).length - 1;
  if (n !== 1) throw new Error('expect exactly 1 in ' + p + ' (got ' + n + '): ' + from.slice(0, 90));
  save(p, h, h.text.replace(from, () => to));
}

once('web/js/util.js',
"  U.download = function (filename, data, mime) {\n",
"  /* 在安卓外壳里发起一次网络请求，彻底绕开网页的跨源限制。\n" +
"     外壳会把结果通过 window.__aiCallbacks[id](状态码, base64 正文) 回传。 */\n" +
"  U.nativeHttp = function (method, url, headers, body) {\n" +
"    return new Promise(function (resolve, reject) {\n" +
"      const A = global.AndroidApp;\n" +
"      const canGet = A && typeof A.httpGet === 'function';\n" +
"      const canPost = A && typeof A.httpPost === 'function';\n" +
"      if ((method === 'GET' && !canGet) || (method !== 'GET' && !canPost)) {\n" +
"        reject(new Error('这台设备没有原生请求能力'));\n" +
"        return;\n" +
"      }\n" +
"      const id = 'nh' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);\n" +
"      global.__aiCallbacks = global.__aiCallbacks || {};\n" +
"      const timer = setTimeout(function () {\n" +
"        delete global.__aiCallbacks[id];\n" +
"        reject(new Error('请求超时'));\n" +
"      }, 25000);\n" +
"      global.__aiCallbacks[id] = function (status, b64) {\n" +
"        clearTimeout(timer);\n" +
"        delete global.__aiCallbacks[id];\n" +
"        let text = '';\n" +
"        try {\n" +
"          const bin = atob(String(b64 || ''));\n" +
"          const bytes = new Uint8Array(bin.length);\n" +
"          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n" +
"          text = new TextDecoder('utf-8').decode(bytes);\n" +
"        } catch (e) { text = ''; }\n" +
"        resolve({ status: Number(status) || 0, text: text });\n" +
"      };\n" +
"      try {\n" +
"        if (method === 'GET') A.httpGet(id, url, JSON.stringify(headers || {}));\n" +
"        else A.httpPost(id, url, JSON.stringify(headers || {}), JSON.stringify(body || {}));\n" +
"      } catch (e) {\n" +
"        clearTimeout(timer);\n" +
"        delete global.__aiCallbacks[id];\n" +
"        reject(new Error('调用系统请求失败：' + e.message));\n" +
"      }\n" +
"    });\n" +
"  };\n" +
"\n" +
"  U.download = function (filename, data, mime) {\n");

once('web/js/defaults.js',
"    vacationExclude: true,      // 假期期间不计入统计（假期在设置里自己加）\n" +
"    vacations: [],              // [{ id, name, start, end }]\n",
"    vacationExclude: true,      // 假期期间不计入统计（假期在设置里自己加）\n" +
"    vacations: [],              // [{ id, name, start, end }]\n" +
"    holidayRemindDays: 7,       // 节假日开始前 / 结束前多少天提醒\n" +
"    holidayData: null,          // 从网上取到的节假日：{ fetchedAt, source, list: [{key,name,start,end}] }\n" +
"    holidayPrompts: {},         // 已经处理过的提醒：{ 假期key: 'done' | 'skip' }\n");

once('web/js/store.js',
"    'vacations', 'vacationExclude'];\n",
"    'vacations', 'vacationExclude', 'holidayData', 'holidayPrompts', 'holidayRemindDays'];\n");

once('web/index.html',
'<script src="js/ai.js"></script>\n',
'<script src="js/ai.js"></script>\n<script src="js/holiday.js"></script>\n');

once('web/sw.js', "  './js/ai.js',\n", "  './js/ai.js',\n  './js/holiday.js',\n");

once('tools/serve.js',
"    if (urlPath === '/api/logout') {\n",
"    /* 代取节假日数据：浏览器受跨源限制时，由电脑上的服务去取。\n" +
"       和 AI 转发一样，只允许公网地址，避免变成内网探测工具。 */\n" +
"    if (urlPath === '/api/fetch' && req.method === 'GET') {\n" +
"      const q = new URL(req.url, 'http://localhost').searchParams.get('url') || '';\n" +
"      let parsed = null;\n" +
"      try { parsed = new URL(q); } catch (e) { parsed = null; }\n" +
"      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {\n" +
"        return sendJSON(res, 400, { ok: false, error: '只支持 http/https 地址' });\n" +
"      }\n" +
"      if (isPrivateHostname(parsed.hostname)) {\n" +
"        return sendJSON(res, 403, { ok: false, error: '不允许访问内网地址' });\n" +
"      }\n" +
"      try {\n" +
"        const out = await fetchGet(q);\n" +
"        console.log('  [代取] ' + parsed.hostname + ' 返回 ' + out.status);\n" +
"        return sendJSON(res, 200, { ok: true, status: out.status, body: out.body });\n" +
"      } catch (e) {\n" +
"        return sendJSON(res, 502, { ok: false, error: '获取失败：' + (e && e.message ? e.message : '未知错误') });\n" +
"      }\n" +
"    }\n" +
"    if (urlPath === '/api/logout') {\n");

once('tools/serve.js',
"function forwardRequest(url, headers, payload) {\n",
"/* 简单的 GET（用于代取节假日这类只读数据） */\n" +
"function fetchGet(url) {\n" +
"  return new Promise(function (resolve, reject) {\n" +
"    let u;\n" +
"    try { u = new URL(url); } catch (e) { reject(new Error('地址不合法')); return; }\n" +
"    const mod = u.protocol === 'https:' ? require('node:https') : require('node:http');\n" +
"    const r2 = mod.request({\n" +
"      hostname: u.hostname,\n" +
"      port: u.port || (u.protocol === 'https:' ? 443 : 80),\n" +
"      path: u.pathname + (u.search || ''),\n" +
"      method: 'GET',\n" +
"      headers: { 'Accept': 'application/json,text/plain,*/*', 'User-Agent': 'jizhangben/1.0' },\n" +
"      timeout: 20000\n" +
"    }, function (r3) {\n" +
"      const chunks = [];\n" +
"      let size = 0;\n" +
"      r3.on('data', function (c) {\n" +
"        size += c.length;\n" +
"        if (size > 2 * 1024 * 1024) { r3.destroy(); return; }\n" +
"        chunks.push(c);\n" +
"      });\n" +
"      r3.on('end', function () {\n" +
"        resolve({ status: r3.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });\n" +
"      });\n" +
"    });\n" +
"    r2.on('timeout', function () { r2.destroy(new Error('等待响应超时')); });\n" +
"    r2.on('error', function (e) { reject(e); });\n" +
"    r2.end();\n" +
"  });\n" +
"}\n" +
"\n" +
"function forwardRequest(url, headers, payload) {\n");

const MA = 'android-src/java/com/daxuesheng/jizhangben/MainActivity.java';
once(MA,
"        /**\n" +
"         * 由原生发起一次 POST（给内置 AI 用）。\n",
"        /** 由原生发起一次 GET（取节假日数据用） */\n" +
"        @JavascriptInterface\n" +
"        public void httpGet(final String id, final String url, final String headersJson) {\n" +
"            doHttp(id, url, headersJson, null);\n" +
"        }\n" +
"\n" +
"        /**\n" +
"         * 由原生发起一次 POST（给内置 AI 用）。\n");

once(MA,
"        public void httpPost(final String id, final String url, final String headersJson, final String bodyJson) {\n" +
"            new Thread(new Runnable() {\n",
"        public void httpPost(final String id, final String url, final String headersJson, final String bodyJson) {\n" +
"            doHttp(id, url, headersJson, bodyJson);\n" +
"        }\n" +
"\n" +
"        private void doHttp(final String id, final String url, final String headersJson, final String bodyJson) {\n" +
"            new Thread(new Runnable() {\n");

once(MA,
"                        conn.setRequestMethod(\"POST\");\n" +
"                        conn.setConnectTimeout(15000);\n" +
"                        conn.setReadTimeout(90000);\n" +
"                        conn.setDoOutput(true);\n",
"                        final boolean isGet = (bodyJson == null);\n" +
"                        conn.setRequestMethod(isGet ? \"GET\" : \"POST\");\n" +
"                        conn.setConnectTimeout(15000);\n" +
"                        conn.setReadTimeout(90000);\n" +
"                        conn.setDoOutput(!isGet);\n");

once(MA,
"                        byte[] payload = (bodyJson == null ? \"{}\" : bodyJson)\n" +
"                                .getBytes(java.nio.charset.Charset.forName(\"UTF-8\"));\n" +
"                        conn.setFixedLengthStreamingMode(payload.length);\n" +
"                        OutputStream os = conn.getOutputStream();\n" +
"                        os.write(payload);\n" +
"                        os.flush();\n" +
"                        os.close();\n",
"                        if (!isGet) {\n" +
"                            byte[] payload = bodyJson.getBytes(java.nio.charset.Charset.forName(\"UTF-8\"));\n" +
"                            conn.setFixedLengthStreamingMode(payload.length);\n" +
"                            OutputStream os = conn.getOutputStream();\n" +
"                            os.write(payload);\n" +
"                            os.flush();\n" +
"                            os.close();\n" +
"                        }\n");

console.log('r25 ok');
