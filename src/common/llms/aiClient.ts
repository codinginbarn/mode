import * as anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CohereClientV2 as Cohere } from 'cohere-ai';
import { Mistral } from '@mistralai/mistralai';
import { GoogleAIFileManager } from "@google/generative-ai/server";
import crypto from 'crypto';
import * as vscode from 'vscode';
import { LLMChatParams } from './llmChatParams';

export interface AIMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | Array<any>;
    name?: string;
    type?: 'image';
}

export interface AIClientConfig {
    provider: string;
    apiKey: string;
    model?: string;
}

export interface StreamCallbacks {
    onToken: (token: string) => void;
    onComplete: (fullText: string) => void;
}

export class AIClient {
    private anthropicClient?: anthropic.Anthropic;
    private openaiClient?: OpenAI;
    private googleClient?: GoogleGenerativeAI;
    private cohereClient?: Cohere;
    private mistralClient?: Mistral;
    private provider: string;
    private model!: string;
    private isCancelled = false;
    private googleFileManager?: GoogleAIFileManager;

    constructor(config: AIClientConfig) {
        this.provider = config.provider;

        switch (config.provider) {
            case 'anthropic':
                this.anthropicClient = new anthropic.Anthropic({ apiKey: config.apiKey });
                this.model = config.model || 'claude-3-sonnet-20240229';
                break;
            case 'openai':
                this.openaiClient = new OpenAI({ apiKey: config.apiKey });
                this.model = config.model || 'gpt-4-turbo-preview';
                break;
            case 'google':
                this.googleClient = new GoogleGenerativeAI(config.apiKey);
                this.googleFileManager = new GoogleAIFileManager(config.apiKey);
                this.model = config.model || 'gemini-pro';
                break;
            case 'cohere':
                this.cohereClient = new Cohere({ token: config.apiKey });
                this.model = config.model || 'command';
                break;
            case 'mistral':
                this.mistralClient = new Mistral({ apiKey: config.apiKey });
                this.model = config.model || 'mistral-medium';
                break;
        }
    }

    private filterDiagnosticMessages(messages: AIMessage[]): AIMessage[] {
        return messages.filter(msg => {
            if (typeof msg.content === 'string') {
                return !msg.content.startsWith('Mode.');
            }
            if (Array.isArray(msg.content)) {
                // For array content, check if any text elements start with 'Mode.'
                return !msg.content.some(item =>
                    typeof item === 'string' && item.startsWith('Mode.') ||
                    (item.type === 'text' && item.text?.startsWith('Mode.'))
                );
            }
            return true;
        });
    }

    async chat(outputChannel: vscode.OutputChannel, messages: AIMessage[], callbacks: StreamCallbacks): Promise<string> {
        try {
            const filteredMessages = this.filterDiagnosticMessages(messages);

            switch (this.provider) {
                case 'anthropic':
                    return this.anthropicChat(filteredMessages, callbacks);
                case 'openai':
                    return this.openaiChat(filteredMessages, callbacks);
                case 'google':
                    return this.googleChat(filteredMessages, callbacks);
                case 'cohere':
                    return this.cohereChat(filteredMessages, callbacks);
                case 'mistral':
                    return this.mistralChat(filteredMessages, callbacks);
                default:
                    throw new Error(`Unsupported provider: ${this.provider}`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            outputChannel.appendLine(`\n\nMode Client Error: ${errorMessage}`);
            outputChannel.show();
            throw error;
        }
    }

    public stopGeneration() {
        this.isCancelled = true;
    }

    private async anthropicChat(messages: AIMessage[], callbacks: StreamCallbacks): Promise<string> {
        this.isCancelled = false;
        if (!this.anthropicClient) throw new Error('Anthropic client not initialized');

        const systemMessage = messages.find(msg => msg.role === 'system')?.content;
        const nonSystemMessages = messages
            .filter(msg => msg.role !== 'system')
            .map(msg => ({
                role: msg.role as 'user' | 'assistant',
                content: typeof msg.content === 'string' && msg.content.startsWith('data:image')
                    ? AIClient.formatImageContent('anthropic', msg.content)
                    : Array.isArray(msg.content) 
                        ? msg.content 
                        : [{ type: 'text', text: msg.content as string }]
            }));

        let fullText = '';
        const response = await this.anthropicClient.messages.create({
            model: this.model,
            system: systemMessage,
            messages: nonSystemMessages,
            max_tokens: 4096,
            stream: true,
            temperature: LLMChatParams.temperature
        });

        try {
            for await (const chunk of response) {
                if (this.isCancelled) {
                    return fullText;
                }
                if (chunk.type === 'content_block_delta') {
                    const text = chunk.delta?.type === 'text_delta' ? chunk.delta.text : '';
                    if (text) {
                        fullText += text;
                        callbacks.onToken(text);
                    }
                }
            }
        } catch (error) {
            if (this.isCancelled) {
                return fullText;
            }
            throw error;
        }
        callbacks.onComplete(fullText);
        return fullText;
    }

    private async openaiChat(messages: AIMessage[], callbacks: StreamCallbacks): Promise<string> {
        this.isCancelled = false;
        if (!this.openaiClient) throw new Error('OpenAI client not initialized');

        let fullText = '';
        const response = await this.openaiClient.chat.completions.create({
            model: this.model,
            messages: messages.map(msg => ({
                role: this.model.startsWith('o1') && msg.role === 'system' ? 'user' : msg.role,
                content: typeof msg.content === 'string' && msg.content.startsWith('data:image')
                    ? AIClient.formatImageContent('openai', msg.content)
                    : msg.content
            })),
            [this.model.startsWith('o1') ? 'max_completion_tokens' : 'max_tokens']: 4096,
            stream: true,
            temperature: LLMChatParams.temperature
        }) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

        try {
            for await (const chunk of response) {
                if (this.isCancelled) {
                    return fullText;
                }
                const text = chunk.choices[0]?.delta?.content || '';
                if (text) {
                    fullText += text;
                    callbacks.onToken(text);
                }
            }
        } catch (error) {
            if (this.isCancelled) {
                return fullText;
            }
            throw error;
        }
        callbacks.onComplete(fullText);
        return fullText;
    }

    private async googleChat(messages: AIMessage[], callbacks: StreamCallbacks): Promise<string> {
        this.isCancelled = false;
        if (!this.googleClient || !this.googleFileManager) throw new Error('Google client not initialized');

        const filteredMessages = messages.filter(msg => msg.type !== 'image');

        const model = this.googleClient.getGenerativeModel({ model: this.model });

        const processedMessages = filteredMessages.map(msg => {
            const parts = typeof msg.content === 'string' && msg.content.startsWith('data:image')
                ? AIClient.formatImageContent('google', msg.content)
                : Array.isArray(msg.content)
                    ? msg.content
                    : [{ text: msg.content as string }];
            return {
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts
            };
        });

        const chat = model.startChat({
            history: processedMessages.slice(0, -1),
            generationConfig: {
                temperature: LLMChatParams.temperature
            }
        });

        const lastMessage = processedMessages[processedMessages.length - 1];

        let fullText = '';
        try {
            const response = await chat.sendMessageStream(lastMessage.parts);

            for await (const chunk of response.stream) {
                if (this.isCancelled) {
                    return fullText;
                }
                const text = chunk.text();
                if (text) {
                    fullText += text;
                    callbacks.onToken(text);
                }
            }
        } catch (error) {
            if (this.isCancelled) {
                return fullText;
            }
            throw error;
        }

        callbacks.onComplete(fullText);
        return fullText;
    }

    private async cohereChat(messages: AIMessage[], callbacks: StreamCallbacks): Promise<string> {
        this.isCancelled = false;
        if (!this.cohereClient) throw new Error('Cohere client not initialized');

        const filteredMessages = messages.filter(msg => msg.type !== 'image');

        let fullText = '';
        try {
            const response = await this.cohereClient.chatStream({
                model: this.model,
                messages: filteredMessages.map(msg => ({
                    role: msg.role,
                    content: msg.content
                })),
                temperature: LLMChatParams.temperature
            });

            for await (const chunk of response) {
                if (this.isCancelled) {
                    return fullText;
                }
                if (chunk.type === 'content-delta') {
                    const text = chunk.delta?.message?.content?.text || '';
                    if (text) {
                        fullText += text;
                        callbacks.onToken(text);
                    }
                }
            }
        } catch (error) {
            if (this.isCancelled) {
                return fullText;
            }
            throw error;
        }
        callbacks.onComplete(fullText);
        return fullText;
    }

    private async mistralChat(messages: AIMessage[], callbacks: StreamCallbacks): Promise<string> {
        this.isCancelled = false;
        if (!this.mistralClient) throw new Error('Mistral client not initialized');

        const filteredMessages = messages.filter(msg => msg.type !== 'image');

        let fullText = '';
        try {
            const chatStreamResponse = await this.mistralClient.chat.stream({
                model: this.model,
                messages: filteredMessages.map(msg => ({
                    role: msg.role,
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                })),
                stream: true,
                temperature: LLMChatParams.temperature
            });

            for await (const chunk of chatStreamResponse) {
                if (this.isCancelled) {
                    return fullText;
                }
                const text = chunk.data.choices[0].delta.content || '';
                if (text && typeof text === 'string') {
                    fullText += text;
                    callbacks.onToken(text);
                }
            }
        } catch (error) {
            if (this.isCancelled) {
                return fullText;
            }
            throw error;
        }
        callbacks.onComplete(fullText);
        return fullText;
    }

    private static formatImageContent(provider: string, imageData: string): any {
        switch (provider) {
            case 'anthropic':
                return [{
                    type: "image",
                    source: { 
                        type: "base64", 
                        media_type: imageData.startsWith('data:image/png') ? 'image/png' : 'image/jpeg',
                        data: imageData.replace(/^data:image\/(png|jpeg);base64,/, '')
                    }
                },
                {
                    type: "text",
                    text: "Describe this image."
                }];
            case 'openai':
                return [{ 
                    type: "image_url", 
                    image_url: { url: imageData } 
                }];
            case 'google':
                return [{
                    text: "Here's an image: "
                }, {
                    inlineData: {
                        data: imageData,
                        mimeType: imageData.startsWith('data:image/png') ? 'image/png' : 'image/jpeg'
                    }
                }];
            case 'mistral':
            case 'cohere':
                return `[Image input not supported for ${provider}]`;
            default:
                return `[Image]`;
        }
    }

    public getProvider(): string {
        return this.provider;
    }
} 