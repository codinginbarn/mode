/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aruna Labs, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { ChatSessionManager } from './chat.session.handler';
import { ChatMessageHandler } from './chat.message.handler';
import { AIClientFactory } from '../../../common/llms/clients/llm.client.factory';
import { AIClient, AIMessage } from '../../../common/llms/clients/llm.client';
import { AIModelUtils } from '../../../common/llms/llm.model.utils';
import { TextResponseProcessor } from '../response/text.response.processor';
import { ApiKeyManager } from '../../../common/llms/llm.api.key.manager';
import { chatPromptv2, SESSION_SUMMARY_PROMPT } from '../../../common/llms/llm.prompt';
import { autoCodingPrompt, autoCodingWithToolsPrompt } from '../../../common/llms/llm.prompt';
import {
	isChatPrePromptDisabled,
	getChatPromptOverride,
	isPromptOverrideEmpty,
	getChatAdditionalPrompt,
	isChatAdditionalPromptEmpty
} from '../../../common/config.utils';
import { displayFileChanges } from '../../tools/display.file.changes';
import { MarkdownRenderer } from '../../../common/rendering/markdown.renderer';
import { sanitizeJsonString } from '../../../common/rendering/json.utils';

export class ChatManager {
	private aiClient: AIClient | null = null;
	private md: MarkdownIt;
	private currentModel: string;
	private currentHandler: ChatMessageHandler | null = null;
	private readonly context: vscode.ExtensionContext;

	constructor(
		private readonly _view: vscode.WebviewView,
		private readonly sessionManager: ChatSessionManager,
		context: vscode.ExtensionContext
	) {
		this.md = new MarkdownIt();
		this.currentModel = '';
		this.context = context;
	}

	private async initializeClient(selectedModel: string): Promise<{ success: boolean; message?: string }> {
		if (this.currentModel !== selectedModel || !this.aiClient) {
			const modelInfo = AIModelUtils.getModelInfo(selectedModel)!;
			const provider = modelInfo.provider;
			const apiKey = await new ApiKeyManager(this.context).getApiKey(provider);
			const result = await AIClientFactory.createClient(provider, selectedModel, apiKey, modelInfo.endpoint);
			if (result.success && result.client) {
				this.aiClient = result.client;
				this.currentModel = selectedModel;
			}
			return { success: result.success, message: result.message };
		}
		return { success: true };
	}

	private hasSystemPrompt(): boolean {
		const messages = this.sessionManager.getCurrentSession()?.messages || [];
		return messages.some(msg => msg.role === 'system');
	}

	private getBaseSystemPrompt(selectedModel: string): string {
		if (AIModelUtils.supportsToolUsage(selectedModel)) {
			return autoCodingWithToolsPrompt;
		}
		return AIModelUtils.supportsAutocoding(selectedModel) ? autoCodingPrompt : chatPromptv2;
	}

	private initializeSystemPrompt(selectedModel: string): void {
		const messages = this.sessionManager.getCurrentSession().messages;
		const promptOverride = getChatPromptOverride();
		const disableSystemPrompt = isChatPrePromptDisabled() && isPromptOverrideEmpty();
		let systemPrompt = disableSystemPrompt ? '' : (promptOverride || this.getBaseSystemPrompt(selectedModel));

		if (!isChatAdditionalPromptEmpty()) {
			systemPrompt += ` ${getChatAdditionalPrompt()}`;
		}

		if (!disableSystemPrompt) {
			messages.push({
				role: "system" as const,
				content: systemPrompt
			});
		}
	}

	public async sendMessage(
		outputChannel: vscode.OutputChannel,
		message: string,
		images: { id: string; data: string; fileName?: string }[],
		codeSnippets: { fileName: string; range: string; code: string }[] = [],
		fileUrls: string[] = [],
		currentFilePath: string | null = null,
		selectedModel: string,
		autoCodingEnabled: boolean
	): Promise<void> {

		// initialize client
		const initResult = await this.initializeClient(selectedModel);

		if (!initResult.success) {
			this._view.webview.postMessage({
				command: 'addChatError',
				role: 'assistant',
				message: initResult.message
			});
			return;
		}

		// Initialize system prompt for new sessions or if missing
		if (!this.hasSystemPrompt()) {
			this.initializeSystemPrompt(selectedModel);
		}

		this.currentHandler = new ChatMessageHandler(
			this._view,
			this.aiClient!,
			this.md,
			this.sessionManager
		);
		await this.currentHandler.handleMessage(message, images, codeSnippets, fileUrls, currentFilePath, autoCodingEnabled, AIModelUtils.supportsAutocoding(selectedModel), selectedModel);
		this.sessionManager.saveSessions();

		// Generate overview
		this.generateSessionOverview(outputChannel, message).then(overview => {
			this.sessionManager.updateCurrentSessionOverview(overview);
		});
	}

	private async generateSessionOverview(outputChannel: vscode.OutputChannel, message: string): Promise<string> {
		if (!this.aiClient) {
			return "New Chat";
		}

		try {
			let overview = '';
			await this.aiClient.chat([
				{ role: "system", content: SESSION_SUMMARY_PROMPT },
				{ role: "user", content: message }
			], {
				onToken: () => {},
				onComplete: (fullText: string) => { // we only need the final response when generating the overview
					overview = fullText;
				}
			});
			return overview || "New Chat";
		} catch (error) {
			return "New Chat";
		}
	}

	public getChatSessions() {
		return this.sessionManager.getChatSessions();
	}

	public loadChatSession(sessionId: string) {
		const session = this.sessionManager.loadChatSession(sessionId);
		if (session) {
			// Clear the current chat in the webview
			this._view.webview.postMessage({ command: 'clearChat' });
			// Render the messages in the session
			session.messages.forEach((message: AIMessage) => {
				if (!message.name) return;
				
				if (message.role === 'user') {
					this._view.webview.postMessage({
						command: 'addMessage',
						role: message.role,
						content: message.content
					});
				} else if (message.role === 'assistant') {
					if (message.name === 'Mode.ChatResponse') {
						const content = message.content as string;
						if (content && content.trim().length > 0) {
							const streamProcessor = new TextResponseProcessor(this._view, this.md);
							this._view.webview.postMessage({ command: 'chatStream', action: 'startStream' });
							for (const line of content.split('\n')) {
								streamProcessor.processLine(line);
							}
							this._view.webview.postMessage({ command: 'chatStream', action: 'endStream' });
						}
					} else if (message.name === 'Mode.FunctionCall') {
						// we parse both auto coding and function calls the same way
						let parsedArgs: any;

						for (const toolCall of message.params as any[]) {
							if (toolCall.function.name === 'apply_file_changes') {
								// Parse the arguments if they're a string, otherwise use as-is
								parsedArgs = typeof toolCall.function.arguments === 'string' 
									? JSON.parse(sanitizeJsonString(toolCall.function.arguments))
									: toolCall.function.arguments;
							}
						}

						const textProcessor = new TextResponseProcessor(this._view, this.md);
						const markdownRenderer = new MarkdownRenderer(this._view, this.md);

						// display the file changes
						this._view.webview.postMessage({ command: 'chatStream', action: 'startStream' });
						displayFileChanges(parsedArgs, textProcessor, markdownRenderer);
						this._view.webview.postMessage({ command: 'chatStream', action: 'endStream' });
					}
				}
			});
		}
	}

	public stopGeneration() {
		this.currentHandler?.stopGeneration();
	}
}
