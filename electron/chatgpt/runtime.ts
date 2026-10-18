import type { ChatGPTAuth } from './auth';
import { type ChatGPTUsage, createMemoryChatGPTUsage } from './usage';

let auth: ChatGPTAuth | undefined;
let usage = createMemoryChatGPTUsage();

export function initializeChatGPTAuth(
  instance: ChatGPTAuth,
  controller = createMemoryChatGPTUsage(),
) {
  auth = instance;
  usage = controller;
}

export function getChatGPTUsage(): ChatGPTUsage {
  return usage;
}

export function getChatGPTAuth(): ChatGPTAuth {
  if (!auth) throw new Error('chatgpt_runtime_not_initialized');
  return auth;
}
