// @ts-nocheck
class VectorStore {
    constructor(db, embeddingService) {
        this.db = db;
        this.embeddingService = embeddingService;
        this.cache = new Map();
    }

    async indexWorkflow(workflow, text, options = {}) {
        try {
            const embedding = await this.embeddingService.embed(text);
            await this.db.updateWorkflowEmbedding(workflow.id, embedding, options || {});
            this.cache.set(`${workflow.id}:${String(options?.userId || options?.requestContext?.userId || workflow.user_id || 'localuser')}`, embedding);
            console.log(`[VectorStore] Indexed workflow ${workflow.id}`);
        } catch (error) {
            console.error(`[VectorStore] Failed to index workflow ${workflow.id}:`, error.message);
        }
    }

    async search(query, topK = 5, options = {}) {
        try {
            const queryEmbedding = await this.embeddingService.embed(query);
            const workflows = await this.db.getWorkflows(options || {});
            const results = [];

            for (const workflow of workflows) {
                if (!workflow.embedding) continue;

                const cacheKey = `${workflow.id}:${String(options?.userId || options?.requestContext?.userId || workflow.user_id || 'localuser')}`;
                let embedding;
                if (this.cache.has(cacheKey)) {
                    embedding = this.cache.get(cacheKey);
                } else {
                    embedding = JSON.parse(workflow.embedding);
                    this.cache.set(cacheKey, embedding);
                }

                const score = this.embeddingService.cosineSimilarity(queryEmbedding, embedding);
                results.push({
                    workflow: {
                        ...workflow,
                        tool_chain: JSON.parse(workflow.tool_chain)
                    },
                    score
                });
            }

            return results.sort((a, b) => b.score - a.score).slice(0, topK);
        } catch (error) {
            console.error('[VectorStore] Search failed:', error.message);
            return [];
        }
    }

    async reindexAll(options = {}) {
        const workflows = await this.db.getWorkflows(options || {});
        let indexed = 0;

        for (const workflow of workflows) {
            const text = [workflow.name, workflow.description, workflow.trigger_pattern].filter(Boolean).join(' ');
            try {
                await this.indexWorkflow(workflow, text, options);
                indexed++;
            } catch (error) {
                console.error(`[VectorStore] Failed to reindex workflow ${workflow.id}:`, error.message);
            }
        }

        console.log(`[VectorStore] Reindexed ${indexed} workflows`);
        return { indexed };
    }

    clearCache() {
        this.cache.clear();
    }
}

module.exports = VectorStore;

