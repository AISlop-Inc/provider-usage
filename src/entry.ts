import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { Usage } from "./contract"

type Meter = {
  id: string
  label: string
  usedPercent: number
  resetsAt?: number
  limited?: boolean
}

type ProviderUsage = {
  id: string
  name: string
  state: "ready" | "signed-out" | "unavailable"
  detail?: string
  meters: Meter[]
}

type Credential =
  | { type: "oauth"; access: string; expires: number; metadata?: Record<string, unknown> }
  | { type: "key"; key: string; metadata?: Record<string, unknown> }
  | { type: "external"; metadata?: Record<string, unknown> }

const cacheFor = 300_000
let cached: { at: number; providers: ProviderUsage[] } | undefined

export default Plugin.define({
  id: "provider-usage",
  async setup(ctx) {
    await ctx.rpc.register(Usage, {
      snapshot: async (input) => {
        const fresh = Boolean((input as { fresh?: boolean } | undefined)?.fresh)
        if (!fresh && cached && Date.now() - cached.at < cacheFor) {
          return { checkedAt: cached.at, providers: cached.providers }
        }
        const providers = await Promise.all([
          readGo(ctx),
          readChatGPT(ctx),
          readXAI(ctx),
          readClaude(ctx),
        ])
        cached = { at: Date.now(), providers }
        return { checkedAt: cached.at, providers }
      },
    })
  },
})

async function readGo(ctx: PluginContext): Promise<ProviderUsage> {
  const credential = await active(ctx, "opencode")
  if (!credential || credential.type === "external") return signedOut("opencode", "OpenCode Go")
  const workspaceID = stringOf(credential.metadata?.orgID)
  if (!workspaceID) return unavailable("opencode", "OpenCode Go", "ワークスペースがトークンにない")
  const server = stringOf(credential.metadata?.server) ?? "https://opencode.ai/console"
  const origin = new URL(server.replace(/^https:\/\/console\.opencode\.ai(?=\/|$)/, "https://opencode.ai/console")).origin
  const token = credential.type === "oauth" ? credential.access : credential.key
  const body = await getJSON(`${origin}/zen/go/v1/usage`, {
    authorization: `Bearer ${token}`,
    "x-opencode-org-id": workspaceID,
  })
  if (body.status === 403) return unavailable("opencode", "OpenCode Go", "このワークスペースは Go 未加入")
  if (!body.ok) return unavailable("opencode", "OpenCode Go", body.error)
  const usage = record(record(body.json)?.usage)
  const meters = ["rolling", "weekly", "monthly"].flatMap((id) => {
    const meter = goMeter(id, usage?.[id])
    return meter ? [meter] : []
  })
  if (meters.length === 0) return unavailable("opencode", "OpenCode Go", "使用量の形が読めない")
  return { id: "opencode", name: "OpenCode Go", state: "ready", meters }
}

async function readChatGPT(ctx: PluginContext): Promise<ProviderUsage> {
  const login = await chatLogin(ctx)
  if (!login) return signedOut("openai", "Codex")
  if (!login.accountID) return unavailable("openai", "Codex", login.reason)
  const body = await getJSON("https://chatgpt.com/backend-api/wham/usage", {
    authorization: `Bearer ${login.access}`,
    "ChatGPT-Account-Id": login.accountID,
  })
  if (!body.ok) return unavailable("openai", "Codex", body.error)
  const rate = record(record(body.json)?.rate_limit)
  const meters = [
    windowMeter("primary", rate?.primary_window),
    windowMeter("secondary", rate?.secondary_window),
  ].filter((meter): meter is Meter => meter !== undefined)
  if (meters.length === 0) return unavailable("openai", "Codex", "使用量の形が読めない")
  const plan = stringOf(record(body.json)?.plan_type)
  return ready("openai", "Codex", meters, plan)
}

async function readXAI(ctx: PluginContext): Promise<ProviderUsage> {
  const credential = await active(ctx, "xai")
  if (!credential) return signedOut("xai", "xAI")
  if (credential.type !== "oauth") return unavailable("xai", "xAI", "API キーでは SuperGrok の使用量を取れない")
  const body = await getJSON("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    authorization: `Bearer ${credential.access}`,
    "x-grok-client-mode": "cli",
  })
  if (body.status === 401 || body.status === 403) {
    return unavailable("xai", "xAI", "サブスクリプションの請求情報を拒否された")
  }
  if (!body.ok) return unavailable("xai", "xAI", body.error)
  const config = record(record(body.json)?.config)
  const raw = config?.creditUsagePercent ?? config?.credit_usage_percent
  const usedPercent = typeof raw === "number" ? raw : undefined
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) {
    return unavailable("xai", "xAI", "使用量の形が読めない")
  }
  const period = record(config?.currentPeriod ?? config?.current_period)
  const resetsAt = timeOf(period?.end)
  const plan = stringOf(record(body.json)?.subscription_tier ?? record(body.json)?.subscriptionTier)
  return ready("xai", "xAI", [usageMeter("period", periodLabel(stringOf(period?.type)), usedPercent, resetsAt)], plan)
}

async function readClaude(ctx: PluginContext): Promise<ProviderUsage> {
  const oauth = await active(ctx, "anthropic")
  const token = oauth?.type === "oauth" ? oauth.access : await claudeCodeToken()
  if (token === "expired") return unavailable("claude", "Claude", "ログインの再認証が必要")
  if (!token) return signedOut("claude", "Claude")
  const body = await getJSON("https://api.anthropic.com/api/oauth/usage", {
    authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
  })
  if (body.status === 401 || body.status === 403) return unavailable("claude", "Claude", "ログインの再認証が必要")
  if (!body.ok) return unavailable("claude", "Claude", body.error)
  const json = record(body.json)
  const meters = [
    claudeMeter("five_hour", "5時間", json?.five_hour),
    claudeMeter("seven_day", "週間", json?.seven_day),
    claudeMeter("seven_day_sonnet", "Sonnet 週間", json?.seven_day_sonnet),
    claudeMeter("seven_day_opus", "Opus 週間", json?.seven_day_opus),
  ].filter((meter): meter is Meter => meter !== undefined)
  if (meters.length === 0) return unavailable("claude", "Claude", "使用量の形が読めない")
  return { id: "claude", name: "Claude", state: "ready", meters }
}

async function chatLogin(ctx: PluginContext) {
  const credential = await active(ctx, "openai")
  const openAI =
    credential?.type === "oauth"
      ? {
          access: credential.access,
          accountID: stringOf(credential.metadata?.accountID) ?? accountFromToken(credential.access),
        }
      : undefined
  if (openAI?.accountID) return { access: openAI.access, accountID: openAI.accountID, reason: "" }
  const codex = await codexLogin()
  if (codex) return codex
  if (credential?.type === "key") {
    return { access: "", reason: "API キーではサブスクリプション使用量を取れない" }
  }
  if (openAI) return { access: openAI.access, reason: "Codex ログインのアカウント ID がない" }
  return
}

async function codexLogin() {
  try {
    const file = await Bun.file(join(homedir(), ".codex", "auth.json")).json()
    const tokens = record(record(file)?.tokens)
    const access = stringOf(tokens?.access_token)
    if (!access) return
    return {
      access,
      accountID: stringOf(tokens?.account_id) ?? accountFromToken(access),
      reason: "Codex ログインのアカウント ID がない",
    }
  } catch {
    return
  }
}

async function claudeCodeToken() {
  const keychain = process.platform === "darwin" ? await claudeKeychainToken() : undefined
  if (keychain) return keychain
  return claudeFileToken()
}

async function claudeFileToken() {
  try {
    const file = await Bun.file(join(homedir(), ".claude", ".credentials.json")).json()
    return oauthToken(record(file)?.claudeAiOauth)
  } catch {
    return
  }
}

async function claudeKeychainToken() {
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return
    return oauthToken(record(JSON.parse(output))?.claudeAiOauth)
  } catch {
    return
  }
}

function oauthToken(value: unknown) {
  const oauth = record(value)
  const token = stringOf(oauth?.accessToken)
  if (!token) return
  if (expired(oauth?.expiresAt)) return "expired" as const
  return token
}

async function active(ctx: PluginContext, integrationID: string): Promise<Credential | undefined> {
  const connection = await ctx.integration.connection.active(integrationID)
  if (!connection) return
  return (await ctx.integration.connection.resolve(connection)) as Credential | undefined
}

function ready(id: string, name: string, meters: Meter[], detail?: string): ProviderUsage {
  return { id, name, state: "ready", meters, ...(detail ? { detail } : {}) }
}

function usageMeter(id: string, label: string, usedPercent: number, resetsAt?: number, limited?: boolean): Meter {
  return {
    id,
    label,
    usedPercent: clamp(usedPercent),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(limited ? { limited } : {}),
  }
}

function signedOut(id: string, name: string): ProviderUsage {
  return { id, name, state: "signed-out", meters: [] }
}

function unavailable(id: string, name: string, detail: string): ProviderUsage {
  return { id, name, state: "unavailable", detail, meters: [] }
}

function goMeter(id: string, value: unknown): Meter | undefined {
  const meter = record(value)
  const percent = typeof meter?.percent === "number" ? meter.percent : undefined
  if (percent === undefined || !Number.isFinite(percent)) return
  const labels = { rolling: "5時間", weekly: "週間", monthly: "月間" }
  return usageMeter(id, labels[id as keyof typeof labels], percent, timeOf(meter?.resetsAt), meter?.status === "rate-limited")
}

function windowMeter(id: string, value: unknown): Meter | undefined {
  const meter = record(value)
  const percent = typeof meter?.used_percent === "number" ? meter.used_percent : undefined
  if (percent === undefined || !Number.isFinite(percent)) return
  const seconds = meter?.limit_window_seconds
  const label = seconds === 604800 ? "週間" : seconds === 18000 ? "5時間" : typeof seconds === "number" && seconds > 0 && seconds % 86400 === 0 ? `${seconds / 86400}日間` : typeof seconds === "number" && seconds > 0 && seconds % 3600 === 0 ? `${seconds / 3600}時間` : "期間"
  return usageMeter(id, label, percent, timeOf(meter?.reset_at), percent >= 100)
}

function claudeMeter(id: string, label: string, value: unknown): Meter | undefined {
  const meter = record(value)
  const raw = typeof meter?.utilization === "number" ? meter.utilization : undefined
  if (raw === undefined || !Number.isFinite(raw)) return
  return usageMeter(id, label, raw, timeOf(meter?.resets_at))
}

function periodLabel(type: string | undefined) {
  if (type?.endsWith("WEEKLY")) return "週間"
  if (type?.endsWith("MONTHLY")) return "月間"
  return "期間"
}

async function getJSON(url: string, headers: Record<string, string>) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) return { ok: false as const, status: response.status, error: `HTTP ${response.status}` }
    return { ok: true as const, status: response.status, json: (await response.json()) as unknown }
  } catch {
    return { ok: false as const, status: 0, error: "取得できなかった" }
  }
}

function record(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function stringOf(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function timeOf(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric
  }
  return
}

function accountFromToken(token: string) {
  const part = token.split(".")[1]
  if (!part) return
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString()) as {
      chatgpt_account_id?: string
      organizations?: Array<{ id?: string }>
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string; organizations?: Array<{ id?: string }> }
    }
    const auth = claims["https://api.openai.com/auth"]
    return (
      claims.chatgpt_account_id ??
      auth?.chatgpt_account_id ??
      claims.organizations?.[0]?.id ??
      auth?.organizations?.[0]?.id
    )
  } catch {
    return
  }
}

function expired(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return false
  return (value < 1e12 ? value * 1000 : value) <= Date.now()
}

function clamp(value: number) {
  return Math.min(100, Math.max(0, value))
}

type PluginContext = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]
