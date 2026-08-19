// @ts-nocheck
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { assertNetworkPolicyUrl, externalWebFetch } = require('./network-policy');
const TARGET_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'target';
}

function safeJsonParse(rawValue, fallback = null) {
  if (!rawValue) return fallback;
  try {
    return JSON.parse(rawValue);
  } catch (_) {
    return fallback;
  }
}

function normalizeTargetId(value, options = {}) {
  const allowNull = options.allowNull !== false;
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new Error('Target id is required');
  }
  const normalized = String(value).trim();
  if (!normalized) {
    if (allowNull) return null;
    throw new Error('Target id is required');
  }
  if (!TARGET_ID_PATTERN.test(normalized)) {
    throw new Error('Invalid target id');
  }
  return normalized;
}

class A2ATargetExecutor {
  constructor(manager) {
    this.manager = manager;
  }

  _fetch(rawUrl, options = {}, requestOptions = {}) {
    return externalWebFetch(rawUrl, options, {
      label: requestOptions.label || 'A2A target request',
      timeoutMs: requestOptions.timeoutMs || 15000
    });
  }

  async listTargets() {
    const manifests = [];
    for (const fileName of fs.readdirSync(this.manager.targetsDir)) {
      if (!fileName.endsWith('.json')) continue;
      const manifest = safeJsonParse(
        fs.readFileSync(path.join(this.manager.targetsDir, fileName), 'utf-8'),
        null
      );
      if (manifest) manifests.push(manifest);
    }
    return manifests.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
  }

  async describeTarget(targetId) {
    const target = await this._loadTarget(targetId);
    if (!target) {
      throw new Error(`Unknown target: ${targetId}`);
    }
    return target;
  }

  async probeTarget(targetId) {
    const target = await this.describeTarget(targetId);
    switch (target.bridgeType) {
      case 'provider':
        return this._probeProviderTarget(target);
      case 'a2a':
        return this._probeA2ATarget(target);
      case 'workflow-http':
        return this._probeWorkflowTarget(target);
      case 'cli':
        return this._probeCliTarget(target);
      default:
        throw new Error(`Unsupported bridge type: ${target.bridgeType}`);
    }
  }

  async callTarget(targetId, payload = {}) {
    const target = await this.describeTarget(targetId);
    if (target.enabled === false) {
      throw new Error(`Target "${targetId}" is disabled`);
    }

    const run = this.manager._createTaskRecord({
      id: String(payload.runId || payload.id || crypto.randomUUID()),
      direction: 'outbound',
      bridgeType: target.bridgeType,
      targetId: target.id,
      status: 'working',
      contextId: String(payload.contextId || crypto.randomUUID()),
      history: [],
      artifacts: [],
      metadata: {
        targetLabel: target.label,
        request: this.manager._clone(payload)
      }
    });
    await this.manager._saveTask(run);

    try {
      let result;
      switch (target.bridgeType) {
        case 'provider':
          result = await this._callProviderTarget(target, payload);
          break;
        case 'a2a':
          result = await this._callA2ATarget(target, payload);
          break;
        case 'workflow-http':
          result = await this._callWorkflowTarget(target, payload);
          break;
        case 'cli':
          result = await this._callCliTarget(run.id, target, payload);
          break;
        default:
          throw new Error(`Unsupported bridge type: ${target.bridgeType}`);
      }

      run.status = {
        state: 'completed',
        timestamp: new Date().toISOString()
      };
      run.result = this.manager._clone(result);
      if (result?.content) {
        run.artifacts = [this.manager._buildTextArtifact(String(result.content), run.id, run.contextId)];
      }
      await this.manager._saveTask(run);
      return this.manager._serializeTask(run);
    } catch (error) {
      run.status = {
        state: 'failed',
        message: error.message,
        timestamp: new Date().toISOString()
      };
      await this.manager._saveTask(run);
      throw error;
    }
  }

  async discoverA2A(rawUrl) {
    const baseUrl = String(rawUrl || '').trim();
    if (!baseUrl) {
      throw new Error('url is required for A2A discovery');
    }

    const cardUrl = baseUrl.endsWith('/.well-known/agent-card.json')
      ? baseUrl
      : `${baseUrl.replace(/\/+$/, '')}/.well-known/agent-card.json`;
    const response = await this._fetch(cardUrl, {}, { label: 'A2A discovery card fetch' });
    if (!response.ok) {
      throw new Error(`A2A card fetch failed: HTTP ${response.status}`);
    }

    const card = await response.json();
    const rpcUrl = String(card?.url || '').trim();
    if (!rpcUrl) {
      throw new Error('Discovered A2A card does not declare an RPC url');
    }

    const manifest = {
      id: `a2a-${slugify(card.name || new URL(cardUrl).hostname)}`,
      label: String(card.name || 'A2A Target'),
      bridgeType: 'a2a',
      enabled: true,
      capabilities: {
        streaming: card?.capabilities?.streaming === true
      },
      transport: {
        cardUrl,
        rpcUrl
      },
      execution: {
        remoteName: card?.name || 'A2A Target'
      },
      privacy: {
        localOnly: false
      },
      defaults: {}
    };

    await this._saveTargetManifest(manifest);
    return manifest;
  }

  async _saveTargetManifest(manifest) {
    this._validateTargetManifest(manifest);
    fs.writeFileSync(
      path.join(this.manager.targetsDir, `${normalizeTargetId(manifest.id, { allowNull: false })}.json`),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );
  }

  async _loadTarget(targetId) {
    const normalizedId = normalizeTargetId(targetId, { allowNull: true });
    if (!normalizedId) return null;
    const filePath = path.join(this.manager.targetsDir, `${normalizedId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return safeJsonParse(fs.readFileSync(filePath, 'utf-8'), null);
  }

  _validateTargetManifest(manifest) {
    const required = ['id', 'label', 'bridgeType', 'transport', 'execution', 'privacy', 'defaults'];
    for (const field of required) {
      if (!Object.prototype.hasOwnProperty.call(manifest || {}, field)) {
        throw new Error(`Target manifest missing required field: ${field}`);
      }
    }
    normalizeTargetId(manifest?.id, { allowNull: false });
  }

  async _probeProviderTarget(target) {
    const provider = String(target?.execution?.provider || '').trim();
    const availableProviders = this.manager.aiService?.getProviders
      ? this.manager.aiService.getProviders()
      : [];
    const models = this.manager.aiService?.getModels
      ? await this.manager.aiService.getModels(provider, false)
      : [];
    return {
      ok: availableProviders.includes(provider),
      provider,
      models: Array.isArray(models) ? models.slice(0, 25) : []
    };
  }

  async _probeA2ATarget(target) {
    const cardUrl = String(target?.transport?.cardUrl || '').trim();
    const response = await this._fetch(cardUrl, {}, { label: 'A2A probe card fetch' });
    if (!response.ok) {
      throw new Error(`A2A probe failed: HTTP ${response.status}`);
    }
    return {
      ok: true,
      card: await response.json()
    };
  }

  async _probeWorkflowTarget(target) {
    const baseUrl = String(target?.transport?.baseUrl || '').trim().replace(/\/+$/, '');
    const probePath = String(target?.transport?.probePath || '/system_stats');
    const response = await this._fetch(`${baseUrl}${probePath}`, {}, { label: 'Workflow target probe' });
    if (!response.ok) {
      throw new Error(`Workflow probe failed: HTTP ${response.status}`);
    }
    return { ok: true, status: response.status };
  }

  async _probeCliTarget(target) {
    return {
      ok: true,
      command: String(target?.execution?.command || '').trim()
    };
  }

  async _callProviderTarget(target, payload) {
    const provider = String(target?.execution?.provider || '').trim();
    const prompt = String(payload?.prompt || '').trim();
    const response = await this.manager.dispatcher.dispatch(prompt, [], {
      mode: 'internal',
      provider,
      model: target?.defaults?.model || undefined
    });
    return {
      provider,
      model: response?.model || '',
      content: String(response?.content || '')
    };
  }

  async _callA2ATarget(target, payload) {
    const rpcUrl = String(target?.transport?.rpcUrl || '').trim();
    const prompt = String(payload?.prompt || '').trim();
    const method = payload?.stream === true ? 'message/stream' : 'message/send';
    const body = {
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params: {
        message: {
          role: 'user',
          contextId: String(payload.contextId || crypto.randomUUID()),
          parts: [{ type: 'text', text: prompt }]
        },
        metadata: payload.metadata || {}
      }
    };

    if (method === 'message/send') {
      const response = await this._fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, { label: 'Remote A2A send' });
      const json = await response.json();
      if (!response.ok || json?.error) {
        throw new Error(json?.error?.message || `Remote A2A call failed: HTTP ${response.status}`);
      }
      return {
        content: JSON.stringify(json.result),
        remoteTask: json.result
      };
    }

    const events = await this._collectA2AStream(rpcUrl, body, Number(payload.timeoutMs) || 15000);
    return {
      content: events.length ? JSON.stringify(events[events.length - 1]) : '',
      events
    };
  }

  _collectA2AStream(rpcUrl, body, timeoutMs) {
    const url = new URL(rpcUrl);
    assertNetworkPolicyUrl(url.toString(), 'external-web');
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        }
      });

      const timer = setTimeout(() => {
        req.destroy(new Error(`A2A stream timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const events = [];

      req.on('response', (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          let idx = buffer.indexOf('\n\n');
          while (idx !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = block.split(/\r?\n/).find((line) => line.startsWith('data:'));
            if (dataLine) {
              const parsed = safeJsonParse(dataLine.slice(5).trim(), null);
              if (parsed?.error) {
                clearTimeout(timer);
                reject(new Error(parsed.error.message || 'Remote A2A stream error'));
                return;
              }
              if (parsed?.result) {
                events.push(parsed.result);
              }
            }
            idx = buffer.indexOf('\n\n');
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve(events);
        });
      });
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  async _callWorkflowTarget(target, payload) {
    const baseUrl = String(target?.transport?.baseUrl || '').trim().replace(/\/+$/, '');
    const submitPath = String(target?.transport?.submitPath || '/prompt');
    const promptPayload = payload?.workflow || payload?.payload || payload?.promptJson;
    const submitResponse = await this._fetch(`${baseUrl}${submitPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptPayload })
    }, { label: 'Workflow target submit', timeoutMs: Number(payload?.timeoutMs || target?.defaults?.timeoutMs) || 15000 });
    if (!submitResponse.ok) {
      throw new Error(`Workflow submit failed: HTTP ${submitResponse.status}`);
    }

    const submitJson = await submitResponse.json();
    const promptId = submitJson?.prompt_id || submitJson?.promptId;
    const historyTemplate = String(target?.transport?.historyPathTemplate || '/history/{id}');
    const pollIntervalMs = Number(target?.defaults?.pollIntervalMs) || 250;
    const timeoutMs = Number(payload?.timeoutMs || target?.defaults?.timeoutMs) || 15000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const historyPath = historyTemplate.replace('{id}', encodeURIComponent(promptId));
      const historyResponse = await this._fetch(`${baseUrl}${historyPath}`, {}, {
        label: 'Workflow target history poll',
        timeoutMs: Math.min(5000, timeoutMs)
      });
      const history = await historyResponse.json();
      const entry = history?.[promptId] || history?.[String(promptId)] || history;
      if (entry?.outputs || entry?.status?.completed === true) {
        return {
          promptId,
          content: JSON.stringify(entry, null, 2),
          outputs: entry?.outputs || null
        };
      }
      await sleep(pollIntervalMs);
    }

    throw new Error(`Workflow target timed out after ${timeoutMs}ms`);
  }

  _callCliTarget(runId, target, payload) {
    const command = String(target?.execution?.command || '').trim();
    const args = Array.isArray(target?.execution?.args)
      ? target.execution.args.map((arg) => String(arg))
      : [];
    const prompt = String(payload?.prompt || '').trim();
    const timeoutMs = Number(payload?.timeoutMs || target?.defaults?.timeoutMs) || 15000;
    const cwd = target?.execution?.cwd ? String(target.execution.cwd) : process.cwd();
    const env = { ...process.env, ...(target?.execution?.env || {}) };

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false
      });

      this.manager.activeRuns.set(runId, {
        child,
        canceled: false,
        kind: 'cli'
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch (_) {}
        this.manager.activeRuns.delete(runId);
        reject(new Error(`CLI target timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf-8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.manager.activeRuns.delete(runId);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.manager.activeRuns.delete(runId);
        if (code !== 0) {
          reject(new Error(`CLI target exited with code ${code}: ${stderr || stdout}`.trim()));
          return;
        }
        resolve({
          exitCode: code,
          content: stdout.trim() || stderr.trim(),
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      });

      if (prompt) {
        try {
          child.stdin.write(prompt);
        } catch (_) {}
      }
      try {
        child.stdin.end();
      } catch (_) {}
    });
  }
}

module.exports = A2ATargetExecutor;
