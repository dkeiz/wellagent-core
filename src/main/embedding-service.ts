// @ts-nocheck
/**
 * Embedding Service
 * 
 * Wrapper for Ollama embedding API to generate vector embeddings.
 * Used for semantic search of workflows.
 */

const { localProbeRequest } = require('./network-policy');

class EmbeddingService {
    constructor(baseURL) {
        const envHost = process.env.OLLAMA_HOST;
        this.baseURL = baseURL || (envHost ? `http://${envHost}` : 'http://127.0.0.1:11434');
        this.model = 'nomic-embed-text'; // Default embedding model
    }

    /**
     * Set the embedding model to use
     * @param {string} model - Model name
     */
    setModel(model) {
        this.model = model;
    }

    /**
     * Generate embedding for text
     * @param {string} text - Text to embed
     * @returns {Array<number>} Embedding vector
     */
    async embed(text) {
        try {
            const response = await localProbeRequest({
                method: 'POST',
                url: `${this.baseURL}/api/embeddings`,
                data: {
                model: this.model,
                prompt: text
                },
                timeout: 30000
            }, {
                label: 'Embedding request'
            });

            return response.data.embedding;
        } catch (error) {
            console.error('[EmbeddingService] Failed to generate embedding:', error.message);
            throw new Error(`Embedding failed: ${error.message}`);
        }
    }

    /**
     * Generate embeddings for multiple texts
     * @param {Array<string>} texts - Array of texts to embed
     * @returns {Array<Array<number>>} Array of embedding vectors
     */
    async embedBatch(texts) {
        const embeddings = [];
        for (const text of texts) {
            const embedding = await this.embed(text);
            embeddings.push(embedding);
        }
        return embeddings;
    }

    /**
     * Calculate cosine similarity between two vectors
     * @param {Array<number>} a - First vector
     * @param {Array<number>} b - Second vector
     * @returns {number} Cosine similarity (-1 to 1)
     */
    cosineSimilarity(a, b) {
        if (a.length !== b.length) {
            throw new Error('Vectors must have same length');
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Check if embedding service is available
     * @returns {boolean} True if available
     */
    async isAvailable() {
        try {
            const response = await localProbeRequest({
                method: 'GET',
                url: `${this.baseURL}/api/tags`,
                timeout: 5000
            }, {
                label: 'Embedding model probe'
            });
            const models = response.data.models || [];
            return models.some(m => m.name.includes('embed'));
        } catch {
            return false;
        }
    }
}

module.exports = EmbeddingService;
