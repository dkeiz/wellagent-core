module.exports = {
    onEnable(context) {
        context.registerHandler('hello', {
            description: 'Say hello — test handler from the test plugin',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Name to greet' }
                }
            }
        }, async (params) => {
            const greeting = context.getConfig('greeting') || 'Hello';
            const name = params.name || 'World';
            context.log(`Greeting ${name}`);
            return `${greeting}, ${name}! (from test-plugin)`;
        });

        context.log('Test plugin enabled successfully');
    },

    onDisable() {
        console.log('[test-plugin] Disabled');
    }
};
