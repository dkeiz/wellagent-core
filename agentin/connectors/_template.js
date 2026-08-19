/**
 * Connector Template
 * 
 * Copy this file as a starting point for new connectors.
 * Files prefixed with _ are not auto-loaded.
 * 
 * Connectors run in worker_threads with a context object:
 *   context.invoke(prompt)  → Send prompt through LLM pipeline, returns response text
 *   context.config          → Stored config values (API keys etc, from DB)
 *   context.log(msg)        → Log message visible in UI
 *   context.connectorName   → Name of this connector
 */

module.exports = {
    name: 'my-connector',
    description: 'Description of what this connector does',

    // Config fields the agent should ask the user for
    configSchema: {
        apiToken: { type: 'string', required: true, description: 'API token for the service' },
        // Add more config fields as needed
    },

    async start(context) {
        context.log('Connector starting...');

        // Access config values
        const token = context.config.apiToken;
        if (!token) {
            throw new Error('apiToken is required in config');
        }

        // Example: polling loop
        // setInterval(async () => {
        //     const messages = await fetchNewMessages(token);
        //     for (const msg of messages) {
        //         const response = await context.invoke(msg.text);
        //         await sendResponse(token, msg.chatId, response);
        //     }
        // }, 5000);

        context.log('Connector started successfully');
    },

    async stop() {
        // Clean up resources (close connections, clear intervals, etc.)
    }
};
