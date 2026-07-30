/// <reference path="../worker-configuration.d.ts" />

type RuntimeEnv = Env & {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  AI_API_KEY: string;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: { id: number };
  from?: { username?: string; first_name?: string; last_name?: string };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

type ToolCall = {
  id?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
};

type AiResponse = {
  response?: string;
  tool_calls?: ToolCall[];
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
};

const MAX_HISTORY_MESSAGES = 12;
const MAX_TOOL_ROUNDS = 8;
const MAX_FILE_BYTES = 600_000;
const MAX_COMMIT_FILES = 12;

const tools = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories in the GitHub repository at a path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the GitHub repository.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commit_files",
      description: "Create or replace files in one atomic commit on the main branch.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          },
        },
        required: ["message", "files"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_ci_status",
      description: "Get recent GitHub Actions runs for the main branch.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function validateRepoPath(value: unknown): string {
  const path = String(value || "").trim().replace(/^\/+/, "");
  const lower = path.toLowerCase();
  if (
    !path ||
    path.includes("..") ||
    path.includes("\\") ||
    path.startsWith(".git/") ||
    path.startsWith(".github/workflows/") ||
    lower.endsWith(".env") ||
    lower.includes("secret") ||
    lower.includes("credential")
  ) {
    throw new Error("Invalid repository path");
  }
  return path;
}

function parseArguments(call: ToolCall): Record<string, unknown> {
  const raw = call.function?.arguments ?? call.arguments ?? {};
  if (typeof raw === "string") return JSON.parse(raw || "{}");
  return raw;
}

function toolName(call: ToolCall): string {
  return String(call.function?.name ?? call.name ?? "");
}

function toolId(call: ToolCall, index: number): string {
  return String(call.id || `tool-${index}`);
}

function decodeBase64(value: string): string {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function chunkText(value: string, maxLength = 3500): string[] {
  const chunks: string[] = [];
  let remaining = value.trim();
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength * 0.6) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < maxLength * 0.6) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ["Done."];
}

async function telegramRequest(
  env: RuntimeEnv,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json<{ ok?: boolean; description?: string }>();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram ${method} failed (${response.status})`);
  }
  return payload;
}

async function sendTelegram(env: RuntimeEnv, chatId: number, text: string): Promise<void> {
  for (const chunk of chunkText(text)) {
    await telegramRequest(env, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
}

async function githubRequest<T>(
  env: RuntimeEnv,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "camelai-telegram-lite",
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) as T : {} as T;
}

function repoBase(env: RuntimeEnv): string {
  return `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}`;
}

async function listFiles(env: RuntimeEnv, args: Record<string, unknown>): Promise<unknown> {
  const rawPath = String(args.path || "").trim().replace(/^\/+/, "");
  if (rawPath.includes("..") || rawPath.includes("\\")) throw new Error("Invalid repository path");
  const suffix = rawPath ? `/${rawPath.split("/").map(encodeURIComponent).join("/")}` : "";
  const result = await githubRequest<Array<{ name: string; path: string; type: string; size: number }>>(
    env,
    `${repoBase(env)}/contents${suffix}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`,
  );
  return result.slice(0, 200).map(({ name, path, type, size }) => ({ name, path, type, size }));
}

async function readFile(env: RuntimeEnv, args: Record<string, unknown>): Promise<unknown> {
  const path = validateRepoPath(args.path);
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const result = await githubRequest<{ content?: string; encoding?: string; size?: number; sha?: string }>(
    env,
    `${repoBase(env)}/contents/${encoded}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`,
  );
  if (result.encoding !== "base64" || !result.content) throw new Error("File is not base64 text content");
  if ((result.size || 0) > MAX_FILE_BYTES) throw new Error("File exceeds Telegram Lite read limit");
  return { path, sha: result.sha, content: decodeBase64(result.content) };
}

async function commitFiles(env: RuntimeEnv, args: Record<string, unknown>): Promise<unknown> {
  const message = String(args.message || "Update from camelAI Telegram").trim().slice(0, 200);
  const files = Array.isArray(args.files) ? args.files : [];
  if (!files.length || files.length > MAX_COMMIT_FILES) {
    throw new Error(`Commit must contain 1-${MAX_COMMIT_FILES} files`);
  }
  const normalized = files.map((entry) => {
    const file = entry as Record<string, unknown>;
    const path = validateRepoPath(file.path);
    const content = String(file.content ?? "");
    if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${path}`);
    }
    return { path, content };
  });
  const base = repoBase(env);
  const ref = await githubRequest<{ object: { sha: string } }>(
    env,
    `${base}/git/ref/heads/${encodeURIComponent(env.GITHUB_BRANCH)}`,
  );
  const parentSha = ref.object.sha;
  const parent = await githubRequest<{ tree: { sha: string } }>(env, `${base}/git/commits/${parentSha}`);
  const treeEntries = await Promise.all(normalized.map(async (file) => {
    const blob = await githubRequest<{ sha: string }>(env, `${base}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: encodeBase64(file.content), encoding: "base64" }),
    });
    return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
  }));
  const tree = await githubRequest<{ sha: string }>(env, `${base}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: parent.tree.sha, tree: treeEntries }),
  });
  const commit = await githubRequest<{ sha: string; html_url?: string }>(env, `${base}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
  });
  await githubRequest(env, `${base}/git/refs/heads/${encodeURIComponent(env.GITHUB_BRANCH)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return { committed: true, sha: commit.sha, files: normalized.map((file) => file.path) };
}

async function getCiStatus(env: RuntimeEnv): Promise<unknown> {
  const result = await githubRequest<{
    workflow_runs: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      head_sha: string;
      html_url: string;
    }>;
  }>(env, `${repoBase(env)}/actions/runs?branch=${encodeURIComponent(env.GITHUB_BRANCH)}&per_page=8`);
  return result.workflow_runs.map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    head_sha: run.head_sha,
  }));
}

async function executeTool(
  env: RuntimeEnv,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "list_files") return listFiles(env, args);
  if (name === "read_file") return readFile(env, args);
  if (name === "commit_files") return commitFiles(env, args);
  if (name === "get_ci_status") return getCiStatus(env);
  throw new Error(`Unknown tool: ${name}`);
}

function systemPrompt(env: RuntimeEnv): string {
  return [
    "You are camelAI Telegram Lite, an autonomous coding assistant for one GitHub repository.",
    `Repository: ${env.GITHUB_OWNER}/${env.GITHUB_REPO}, branch: ${env.GITHUB_BRANCH}.`,
    "Reply in the user's language. Be concise but report exact file paths, commit SHA, and CI run IDs.",
    "For code changes, inspect relevant files first, make the smallest correct change, then commit atomically.",
    "Never expose tokens or credentials. Never read or write secret files. Never change repository ownership.",
    "A push to main triggers CI; CI success deploys this Worker and promotes the tested commit to production.",
    "If a request is ambiguous or risky, explain what is needed instead of guessing.",
  ].join("\n");
}

async function runModel(env: RuntimeEnv, messages: ChatMessage[]): Promise<AiResponse> {
  const response = await fetch(`${env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.AI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      messages,
      tools,
      max_tokens: 3500,
    }),
  });
  const payload = await response.json<AiResponse & { error?: { message?: string } }>();
  if (!response.ok) {
    throw new Error(payload.error?.message || `AI API failed (${response.status})`);
  }
  return payload;
}

async function runAgent(env: RuntimeEnv, chatId: number, prompt: string): Promise<string> {
  const key = `chat:${chatId}`;
  const history = await env.SESSIONS.get<ChatMessage[]>(key, "json") || [];
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(env) },
    ...history.slice(-MAX_HISTORY_MESSAGES),
    { role: "user", content: prompt },
  ];

  let finalText = "I could not complete the request.";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const result = await runModel(env, messages);
    const choiceMessage = result.choices?.[0]?.message;
    const calls = Array.isArray(choiceMessage?.tool_calls)
      ? choiceMessage.tool_calls
      : Array.isArray(result.tool_calls)
        ? result.tool_calls
        : [];
    if (!calls.length) {
      finalText = String(result.response || choiceMessage?.content || finalText).trim();
      break;
    }
    messages.push({
      role: "assistant",
      content: String(result.response || choiceMessage?.content || ""),
      tool_calls: calls,
    });
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      const id = toolId(call, index);
      const name = toolName(call);
      let output: unknown;
      try {
        output = await executeTool(env, name, parseArguments(call));
      } catch (error) {
        output = { error: error instanceof Error ? error.message : String(error) };
      }
      messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(output) });
    }
  }

  const nextHistory: ChatMessage[] = [
    ...history,
    { role: "user", content: prompt },
    { role: "assistant", content: finalText },
  ].slice(-MAX_HISTORY_MESSAGES);
  await env.SESSIONS.put(key, JSON.stringify(nextHistory), { expirationTtl: 60 * 60 * 24 * 30 });
  return finalText;
}

async function processMessage(env: RuntimeEnv, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  if (String(chatId) !== env.ALLOWED_CHAT_ID) return;
  const text = message.text?.trim();
  if (!text) {
    await sendTelegram(env, chatId, "目前仅支持文本消息。");
    return;
  }
  if (text === "/start") {
    await sendTelegram(
      env,
      chatId,
      `camelAI Telegram Lite 已连接 ${env.GITHUB_OWNER}/${env.GITHUB_REPO}。直接描述要检查、修改或提交的任务即可。`,
    );
    return;
  }
  if (text === "/reset") {
    await env.SESSIONS.delete(`chat:${chatId}`);
    await sendTelegram(env, chatId, "会话上下文已清空。");
    return;
  }
  if (text === "/status") {
    await sendTelegram(env, chatId, JSON.stringify(await getCiStatus(env), null, 2));
    return;
  }
  await telegramRequest(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  const response = await runAgent(env, chatId, text);
  await sendTelegram(env, chatId, response);
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, worker: "camelai-telegram-lite" });
    }
    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") {
      return new Response("Not found", { status: 404 });
    }
    const secret = request.headers.get("x-telegram-bot-api-secret-token") || "";
    if (!constantTimeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }
    let update: TelegramUpdate;
    try {
      update = await request.json<TelegramUpdate>();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (update.message) {
      ctx.waitUntil(processMessage(env, update.message).catch(async (error) => {
        console.error("telegram message failed", {
          updateId: update.update_id,
          error: error instanceof Error ? error.message : String(error),
        });
        await sendTelegram(
          env,
          update.message!.chat.id,
          `处理失败：${error instanceof Error ? error.message : String(error)}`,
        ).catch(() => undefined);
      }));
    }
    return new Response("ok");
  },
} satisfies ExportedHandler<RuntimeEnv>;
