'use strict';
const crypto = require('node:crypto');
const { AppError } = require('./errors');

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers));
  res.end(data);
}

function sendError(res, err, requestId) {
  if (!(err instanceof AppError)) {
    console.error('[server] lỗi:', err && err.message);
    err = new AppError(500, 'internal_error', 'Lỗi nội bộ');
  }
  send(res, err.status, { error: { code: err.code, message: err.message, details: err.details || null, requestId } });
}

function readJson(req, maxBytes = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new AppError(413, 'payload_too_large', 'Dữ liệu gửi lên quá lớn')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch { reject(new AppError(400, 'invalid_json', 'JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Bộ định tuyến tối giản: [method, /path/:param, handler]
function router(routes) {
  const compiled = routes.map(([method, pattern, handler]) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    return { method, re, keys, handler };
  });
  return (method, pathname) => {
    for (const r of compiled) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  };
}

module.exports = { send, sendError, readJson, safeEqual, router };
