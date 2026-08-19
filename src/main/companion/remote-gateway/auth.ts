// @ts-nocheck
const crypto = require('crypto');

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readSecret(req, url) {
  const header = String(req.headers?.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return '';
}

function isAuthorized(req, url, expectedSecret) {
  if (!expectedSecret) return false;
  return timingSafeEqualText(readSecret(req, url), expectedSecret);
}

module.exports = { isAuthorized, readSecret, timingSafeEqualText };
