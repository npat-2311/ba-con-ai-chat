'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const bad = (msg, details) => new AppError(400, 'invalid_request', msg, details);
const notFound = (what) => new AppError(404, 'not_found', `Không tìm thấy ${what}`);
const conflict = (msg) => new AppError(409, 'conflict', msg);
const limit = (msg) => new AppError(429, 'limit_exceeded', msg);

function parseMaxRounds(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw bad('Số vòng tối đa phải là số nguyên từ 1 đến 100', { field: 'maxRounds', value: v });
  }
  return n;
}

module.exports = { AppError, bad, notFound, conflict, limit, parseMaxRounds };
