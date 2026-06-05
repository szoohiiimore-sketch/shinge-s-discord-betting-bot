export interface AppConfig {
  nodeEnv: string;
  logLevel: string;
  port: number;
}

export interface DatabaseConfig {
  url: string;
  directUrl: string;
}

export interface RedisConfig {
  url: string;
}

export interface DiscordConfig {
  token: string;
  clientId: string;
  guildId: string;
}

export interface ApiConfig {
  theOddsApiKey: string;
  pandascoreApiKey: string;
  deepseekApiKey: string;
}

export interface BettingConfig {
  defaultBankroll: number;
  maxConcurrentBets: number;
  analysisBudgetDaily: number;
}

export interface Config {
  app: AppConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  discord: DiscordConfig;
  api: ApiConfig;
  betting: BettingConfig;
}
