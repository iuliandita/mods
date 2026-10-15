// Stand-in for the engine types that --hosts type checking does not have. The host code imports the mods' shared
// logic, which names a few engine types; this models just the parts those files and the adapters touch.
declare module 'claude-code' {
  export type PromptSubmitInput = {
    text: string
    attachments?: readonly unknown[]
    context?: readonly string[]
    turnId?: string
    wait: boolean
    origin: { kind: string; [field: string]: unknown }
  }
  export type PromptSubmitResult = { text: string; context?: readonly string[]; drop?: undefined } | { drop: string }
  export type CommandRunInput = { args: string; [field: string]: unknown }
  export type EngineInterface = {
    clock: { now(): Promise<number>; sleep(ms: number, opts?: { signal?: AbortSignal }): Promise<void>; after(ms: number, fn: () => unknown): void }
    env: { get(name: string): Promise<string | undefined> }
    store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
    ui: { toast(text: string, opts?: { timeoutMs?: number }): void }
    session: { cwd(): Promise<string> }
    fs: { read(name: string): Promise<string> }
    model: {
      complete(req: { model: string; prompt: string | readonly { text: string; cache?: boolean }[]; system: string; maxTokens: number; effort?: string; timeoutMs: number }): Promise<{
        isAnswered: boolean
        text: string
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
      }>
    }
    http: { fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> }
    command: { register(spec: { name: string; description: string; argumentHint?: string }): Promise<void> }
  }
  type Handler = ($: EngineInterface, e: any, next: (e: any) => Promise<any>) => unknown
  type On = (event: string, optsOrHandler: Record<string, unknown> | Handler, handler?: Handler) => { catch(fallback: Handler): void }
  export type Register = (on: On, options: Record<string, unknown>) => void
}
