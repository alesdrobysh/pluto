export interface ChatGPTStatus {
  connected: boolean;
  planEnabled: boolean;
  email?: string;
  usageLimited?: boolean;
}

export interface ChatGPTModel {
  id: string;
  name: string;
}
