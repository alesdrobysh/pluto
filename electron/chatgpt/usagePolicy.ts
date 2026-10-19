/** Pluto admission budgets; these do not represent the account's upstream allowance. */
export interface ChatGPTUsagePolicy {
  dailyRequests: number;
  dailyTokens: number;
  backgroundEnabled: boolean;
}

export const CHATGPT_DEFAULT_USAGE_POLICY: Readonly<ChatGPTUsagePolicy> = {
  dailyRequests: 50,
  dailyTokens: 200_000,
  backgroundEnabled: true,
};
export const CHATGPT_MAX_BACKGROUND_REQUESTS = 10;
export const CHATGPT_BACKGROUND_BUDGET_SHARE = 0.2;
export const CHATGPT_MIN_REQUEST_TOKEN_RESERVATION = 8192;

export const chatGPTBackgroundBudget = (policy: ChatGPTUsagePolicy) => ({
  requests: Math.min(
    CHATGPT_MAX_BACKGROUND_REQUESTS,
    Math.floor(policy.dailyRequests * CHATGPT_BACKGROUND_BUDGET_SHARE),
  ),
  tokens: Math.floor(policy.dailyTokens * CHATGPT_BACKGROUND_BUDGET_SHARE),
});
