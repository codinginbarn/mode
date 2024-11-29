import { AIClient, AIClientConfig } from './aiClient';
import { ApiKeyManager } from './aiApiKeyManager';
import * as vscode from 'vscode';
import { AIModel } from './aiModel';

export class AIClientFactory {
    private static instances: Map<string, AIClient> = new Map();
    private static apiKeyManager: ApiKeyManager;

    private constructor() { } // Prevent instantiation

    public static initialize(context: vscode.ExtensionContext): void {
        AIClientFactory.apiKeyManager = new ApiKeyManager(context);
    }

    public static async createClient(
        provider: string,
        model: string
    ): Promise<{ success: boolean; message?: string; client?: AIClient }> {
        const instanceKey = `${provider}-${model || 'default'}`;

        // Return existing instance if available
        const existingClient = this.instances.get(instanceKey);
        if (existingClient) {
            return { success: true, client: existingClient };
        }

        let apiKey: string | undefined;
        // Fetch API key if not ollama
        if (provider !== 'ollama') {
            apiKey = await this.apiKeyManager?.getApiKey(provider);
            if (!apiKey) {
                return {
                    success: false,
                    message: `APIKey.${provider}.Missing`
                };
            }
        }

        // Get model info
        const modelInfo = AIModel.getModelInfo(model);
        const endpoint = modelInfo!.endpoint;

        try {
            const config: AIClientConfig = {
                provider,
                apiKey,
                model,
                endpoint // pass endpoint if available
            };

            const client = new AIClient(config);
            this.instances.set(instanceKey, client);
            return { success: true, client };
        } catch (error) {
            return {
                success: false,
                message: `Failed to initialize ${provider} client: ${(error as Error).message}`
            };
        }
    }

    public static getInstance(provider: string, model?: string): AIClient | undefined {
        const instanceKey = `${provider}-${model || 'default'}`;
        return this.instances.get(instanceKey);
    }

    public static invalidateClientsForProvider(provider: string): void {
        // Remove all instances for the given provider
        for (const [key, _] of this.instances) {
            if (key.startsWith(`${provider}-`)) {
                this.instances.delete(key);
            }
        }
    }
} 