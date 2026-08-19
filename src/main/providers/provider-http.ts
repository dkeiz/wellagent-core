// @ts-nocheck
const { nativeHttpRequest } = require('../net/native-http-client');
function isProviderRequestCanceled(error) {
  return Boolean(
    error?.name === 'AbortError'
    || error?.code === 'ERR_CANCELED'
    || error?.code === 'ABORT_ERR'
  );
}

function getProviderErrorDetail(error) {
  const data = error?.response?.data;
  const detail = typeof data === 'string'
    ? data
    : (data?.error?.message || data?.error || data?.message || data?.detail || '');
  const normalized = String(detail || error?.message || '').trim();
  if (!normalized || /^HTTP \d+$/i.test(normalized)) return '';
  return normalized.slice(0, 2000);
}

function normalizeProviderHttpError(error, label = 'Provider request') {
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || /timeout/i.test(String(error?.message || ''))) {
    const timeoutError = new Error(`${label} timed out`);
    timeoutError.cause = error;
    timeoutError.code = 'PROVIDER_TIMEOUT';
    return timeoutError;
  }
  const status = Number(error?.response?.status || error?.status || 0);
  if (status > 0) {
    const detail = getProviderErrorDetail(error);
    const statusError = new Error(detail ? `${label}: ${detail}` : `${label} failed with HTTP ${status}`);
    statusError.cause = error;
    statusError.code = 'PROVIDER_HTTP_ERROR';
    statusError.status = status;
    return statusError;
  }
  return error;
}

async function providerRequest(config, options = {}) {
  const timeout = Number(options.timeoutMs || config?.timeout || 0) || undefined;
  const label = options.label || 'Provider request';
  const request = options.requestImpl || nativeHttpRequest;
  try {
    return await request({
      ...config,
      timeout
    });
  } catch (error) {
    if (isProviderRequestCanceled(error)) {
      throw error;
    }
    throw normalizeProviderHttpError(error, label);
  }
}

module.exports = {
  isProviderRequestCanceled,
  getProviderErrorDetail,
  normalizeProviderHttpError,
  providerRequest
};
