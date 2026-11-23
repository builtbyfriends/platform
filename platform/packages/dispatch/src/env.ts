export type Env = Readonly<{
  PLATFORM_APPLICATION?: string;
  DISPATCH: DispatchNamespace;
  PREVIEW_API?: Fetcher;
  ROUTING: KVNamespace;
  STATIC_ASSETS: KVNamespace;
  STATIC_ASSETS_R2: R2Bucket;
  ANALYTICS: AnalyticsEngineDataset;
  // Decision: The `platform_logs` dataset belongs to the tail worker. Dispatch writes to it only to explain a
  // 503 it made itself (recordPlatformLog in metering.ts).
  LOGS: AnalyticsEngineDataset;
  USAGE_QUEUE: Queue<unknown>;
  // Decision: Optional so a dispatcher installed before the binding existed still serves apps in their grace days.
  CREDITS_GRACE_LIMITER?: RateLimit;
  BASE_HOSTNAME?: string;
  DISPATCH_TIMEOUT_MS?: string;
  PLATFORM_HEALTH_PROBE_TOKEN?: string;
  PLATFORM_INSTALLATION_ID?: string;
  PLATFORM_RUNTIME_LOGS?: 'minimal';
  PLATFORM_TRAFFIC_STATE?: string;
}>;
