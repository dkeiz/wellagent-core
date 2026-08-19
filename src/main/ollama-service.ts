// @ts-nocheck
const { TtlCache } = require('./cache/ttl-cache');
const { localProbeFetch } = require('./network-policy');

// Cache models for 5 minutes
const modelCache = new TtlCache({
  max: 100,
  ttl: 300 * 1000, // 5 minutes in ms
  allowStale: false
});

class OllamaService {
  constructor() {
    const envHost = process.env.OLLAMA_HOST;
    this.baseURL = envHost ? `http://${envHost}` : 'http://127.0.0.1:11434';
  }

  async checkConnection() {
    try {
      const response = await localProbeFetch(this.baseURL, { method: 'HEAD' }, {
        label: 'Ollama connection probe',
        timeoutMs: 3000
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async getModels() {
    // Try to get from cache first
    const cached = modelCache.get('models');
    if (cached) return cached;

    try {
      const response = await localProbeFetch(`${this.baseURL}/api/tags`, {}, {
        label: 'Ollama model list',
        timeoutMs: 5000
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json();
      const models = data.models.map(model => ({
        id: model.name.split(':')[0],
        name: model.name,
        size: model.size,
        modified: new Date(model.modified_at),
        type: model.remote_host ? 'cloud' : 'local'
      }));

      // Update cache
      modelCache.set('models', models);
      return models;
    } catch (error) {
      console.error('Ollama model fetch error:', error);
      return []; // Return empty array instead of throwing
    }
  }

  async listModels() {
    try {
      const models = await this.getModels();
      return models.map(model => model.name);
    } catch (error) {
      console.error('Failed to fetch models from Ollama API:', error);
      throw new Error(`Failed to fetch models from Ollama API: ${error.message}`);
    }
  }
}

const ollamaService = new OllamaService();

module.exports = ollamaService;
