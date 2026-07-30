/// <reference path="../worker-configuration.d.ts" />

import { DurableObject } from "cloudflare:workers";

type RuntimeEnv = Env & {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  AI_API_KEY: string;
  OPENROUTER_API_KEY: string;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  voice?: TelegramAudioFile;
  audio?: TelegramAudioFile;
  chat: { id: number };
  from?: { username?: string; first_name?: string; last_name?: string };
  reply_to_message?: TelegramMessage;
};

type TelegramAudioFile = {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
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

type AiStreamChunk = {
  response?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: AiResponse["choices"] extends Array<infer Choice>
      ? Choice extends { message?: infer Message }
        ? Message
        : never
      : never;
  }>;
};

type AudioStreamChunk = {
  error?: {
    code?: string | number;
    message?: string;
    metadata?: Record<string, unknown>;
  };
  choices?: Array<{
    delta?: {
      content?: string | null;
      audio?: {
        data?: string;
        transcript?: string;
      };
    };
  }>;
};

type AudioSource = {
  fileId: string;
  format: string;
  fileName?: string;
  declaredSize?: number;
};

type UserTurn = {
  text: string;
  audio?: AudioSource;
  voiceReply: boolean;
  audioMode: boolean;
};

type GeneratedAudio = {
  bytes: Uint8Array;
  format: "wav";
};

type SessionStatus = "idle" | "running" | "done" | "error";

type ReplyMapping = {
  sessionId: string;
  kind: "progress" | "final";
};

type SessionState = {
  status: SessionStatus;
  chatId: number | null;
  originMessageId: number | null;
  progressMessageId: number | null;
  history: ChatMessage[];
  steering: UserTurn[];
  voiceReply: boolean;
  startedAt: number | null;
  updatedAt: number;
};

type StartTurnInput = {
  chatId: number;
  originMessageId: number;
  progressMessageId: number;
  turn: UserTurn;
};

type SteerInput = {
  previousProgressMessageId: number;
  progressMessageId: number;
  turn: UserTurn;
};

type TelegramSentMessage = {
  message_id: number;
};

type TelegramApiResponse<T> = {
  ok?: boolean;
  description?: string;
  result?: T;
};

const MAX_HISTORY_MESSAGES = 12;
const MAX_TOOL_ROUNDS = 8;
const MAX_FILE_BYTES = 600_000;
const MAX_COMMIT_FILES = 12;
const MAX_AUDIO_BYTES = 8_000_000;
const OPENROUTER_AUDIO_MODEL = "openai/gpt-audio";

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

async function telegramMultipartRequest(
  env: RuntimeEnv,
  method: string,
  body: FormData,
): Promise<TelegramApiResponse<TelegramSentMessage>> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    body,
  });
  const payload = await response.json<TelegramApiResponse<TelegramSentMessage>>();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram ${method} failed (${response.status})`);
  }
  return payload;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function pcm16ToWav(pcm: Uint8Array, sampleRate = 24_000, channels = 1): Uint8Array {
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + pcm.length);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) wav[offset + index] = value.charCodeAt(index);
  };
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, headerSize);
  return wav;
}

async function downloadTelegramAudio(env: RuntimeEnv, source: AudioSource): Promise<Uint8Array> {
  if (source.declaredSize && source.declaredSize > MAX_AUDIO_BYTES) {
    throw new Error(`语音文件过大，最大支持 ${Math.floor(MAX_AUDIO_BYTES / 1_000_000)} MB。`);
  }
  const filePayload = await telegramRequest(env, "getFile", {
    file_id: source.fileId,
  }) as TelegramApiResponse<{ file_path?: string; file_size?: number }>;
  const filePath = filePayload.result?.file_path;
  const fileSize = filePayload.result?.file_size;
  if (!filePath) throw new Error("Telegram getFile 未返回文件路径");
  if (fileSize && fileSize > MAX_AUDIO_BYTES) {
    throw new Error(`语音文件过大，最大支持 ${Math.floor(MAX_AUDIO_BYTES / 1_000_000)} MB。`);
  }
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!response.ok) throw new Error(`Telegram 语音下载失败 (${response.status})`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_AUDIO_BYTES) {
    throw new Error(`语音文件过大，最大支持 ${Math.floor(MAX_AUDIO_BYTES / 1_000_000)} MB。`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new Error(`语音文件过大，最大支持 ${Math.floor(MAX_AUDIO_BYTES / 1_000_000)} MB。`);
  }
  return bytes;
}

async function sendTelegramAudio(
  env: RuntimeEnv,
  chatId: number,
  audio: GeneratedAudio,
  replyToMessageId?: number,
): Promise<number> {
  const body = new FormData();
  body.set("chat_id", String(chatId));
  if (replyToMessageId) body.set("reply_to_message_id", String(replyToMessageId));
  const audioBuffer = Uint8Array.from(audio.bytes).buffer;
  body.set("audio", new Blob([audioBuffer], { type: "audio/wav" }), `camelai.${audio.format}`);
  const payload = await telegramMultipartRequest(env, "sendAudio", body);
  const messageId = payload.result?.message_id;
  if (typeof messageId !== "number") throw new Error("Telegram sendAudio returned no message id");
  return messageId;
}

async function sendTelegram(
  env: RuntimeEnv,
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<number[]> {
  const messageIds: number[] = [];
  let replyTo = replyToMessageId;
  for (const chunk of chunkText(text)) {
    const payload = await telegramRequest(env, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    }) as TelegramApiResponse<TelegramSentMessage>;
    const messageId = payload.result?.message_id;
    if (typeof messageId !== "number") throw new Error("Telegram sendMessage returned no message id");
    messageIds.push(messageId);
    replyTo = messageId;
  }
  return messageIds;
}

async function editTelegram(env: RuntimeEnv, chatId: number, messageId: number, text: string): Promise<void> {
  await telegramRequest(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  });
}

async function deleteTelegram(env: RuntimeEnv, chatId: number, messageId: number): Promise<void> {
  await telegramRequest(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
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

async function runModel(
  env: RuntimeEnv,
  messages: ChatMessage[],
  onText?: (text: string) => Promise<void>,
): Promise<AiResponse> {
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
      stream: true,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 500);
    try {
      const payload = JSON.parse(text) as { error?: { message?: string } };
      message = payload.error?.message || message;
    } catch {
      // Keep the response excerpt.
    }
    throw new Error(message || `AI API failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    return await response.json<AiResponse>();
  }
  if (!response.body) throw new Error("AI streaming response had no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, ToolCall>();
  let content = "";
  let buffer = "";

  const consumeLine = async (line: string): Promise<void> => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as AiStreamChunk;
    const delta = chunk.choices?.[0]?.delta;
    const text = String(delta?.content || chunk.response || "");
    if (text) {
      content += text;
      await onText?.(content);
    }
    for (const streamedCall of delta?.tool_calls || []) {
      const index = streamedCall.index ?? 0;
      const call = calls.get(index) || { id: streamedCall.id, function: { name: "", arguments: "" } };
      if (streamedCall.id) call.id = streamedCall.id;
      if (!call.function) call.function = { name: "", arguments: "" };
      if (streamedCall.function?.name) {
        call.function.name = `${call.function.name || ""}${streamedCall.function.name}`;
      }
      if (streamedCall.function?.arguments) {
        call.function.arguments = `${call.function.arguments || ""}${streamedCall.function.arguments}`;
      }
      calls.set(index, call);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) await consumeLine(line);
    if (done) break;
  }
  if (buffer) await consumeLine(buffer);
  return {
    choices: [{
      message: {
        content,
        tool_calls: [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call),
      },
    }],
  };
}

async function runOpenRouterAudio(
  env: RuntimeEnv,
  body: Record<string, unknown>,
): Promise<{ text: string; audio: Uint8Array }> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "x-title": "camelAI Telegram Lite",
    },
    body: JSON.stringify({ model: OPENROUTER_AUDIO_MODEL, stream: true, ...body }),
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw.slice(0, 500);
    try {
      const payload = JSON.parse(raw) as AudioStreamChunk;
      message = formatOpenRouterError(payload.error, message);
    } catch {
      // Keep the response excerpt.
    }
    throw new Error(message || `OpenRouter audio API failed (${response.status})`);
  }
  if (!response.body) throw new Error("OpenRouter audio stream had no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const audioChunks: Uint8Array[] = [];
  let content = "";
  let transcript = "";
  let buffer = "";

  const consumeLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as AudioStreamChunk;
    if (chunk.error) throw new Error(formatOpenRouterError(chunk.error, "OpenRouter provider error"));
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) content += delta.content;
    if (delta?.audio?.transcript) transcript += delta.audio.transcript;
    if (delta?.audio?.data) audioChunks.push(base64ToBytes(delta.audio.data));
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (buffer) consumeLine(buffer);
  return { text: (content || transcript).trim(), audio: concatBytes(audioChunks) };
}

function formatOpenRouterError(
  error: AudioStreamChunk["error"],
  fallback: string,
): string {
  if (!error) return fallback;
  const metadata = error.metadata || {};
  const provider = typeof metadata.provider_name === "string" ? metadata.provider_name : "";
  const raw = typeof metadata.raw === "string" ? metadata.raw.slice(0, 240) : "";
  return [
    error.message || fallback,
    error.code === undefined ? "" : `code=${error.code}`,
    provider ? `provider=${provider}` : "",
    raw,
  ].filter(Boolean).join(" · ");
}

async function transcribeTelegramAudio(
  env: RuntimeEnv,
  source: AudioSource,
  caption: string,
): Promise<string> {
  const bytes = await downloadTelegramAudio(env, source);
  const instruction = [
    "Transcribe the attached audio accurately.",
    "Return only the transcript in the original spoken language, without commentary or markdown.",
    caption ? `The sender included this caption for context: ${caption}` : "",
  ].filter(Boolean).join("\n");
  const result = await runOpenRouterAudio(env, {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: instruction },
        {
          type: "input_audio",
          input_audio: { data: bytesToBase64(bytes), format: source.format },
        },
      ],
    }],
    modalities: ["text"],
    max_tokens: 1200,
  });
  if (!result.text) throw new Error("语音识别未返回文本");
  return result.text;
}

async function synthesizeVoice(env: RuntimeEnv, text: string): Promise<GeneratedAudio> {
  const result = await runOpenRouterAudio(env, {
    messages: [{
      role: "user",
      content: `Read the following assistant response aloud naturally. Preserve its language and meaning. Do not add commentary.\n\n${text}`,
    }],
    modalities: ["text", "audio"],
    audio: { voice: "alloy", format: "pcm16" },
    max_tokens: 3500,
  });
  if (!result.audio.length) throw new Error("语音生成未返回音频数据");
  return { bytes: pcm16ToWav(result.audio), format: "wav" };
}

async function generateAudioResponse(
  env: RuntimeEnv,
  messages: ChatMessage[],
): Promise<{ text: string; audio: GeneratedAudio }> {
  const result = await runOpenRouterAudio(env, {
    messages,
    modalities: ["text", "audio"],
    audio: { voice: "alloy", format: "pcm16" },
    max_tokens: 3500,
  });
  if (!result.text) throw new Error("音频模型未返回文本回复");
  if (!result.audio.length) throw new Error("音频模型未返回语音数据");
  return { text: result.text, audio: { bytes: pcm16ToWav(result.audio), format: "wav" } };
}

function initialSessionState(): SessionState {
  return {
    status: "idle",
    chatId: null,
    originMessageId: null,
    progressMessageId: null,
    history: [],
    steering: [],
    voiceReply: false,
    startedAt: null,
    updatedAt: Date.now(),
  };
}

export class TelegramRouter extends DurableObject<RuntimeEnv> {
  async getReply(messageId: number): Promise<ReplyMapping | null> {
    return await this.ctx.storage.get<ReplyMapping>(`reply:${messageId}`) ?? null;
  }

  async setReply(messageId: number, mapping: ReplyMapping): Promise<void> {
    await this.ctx.storage.put(`reply:${messageId}`, mapping);
  }

  async deleteReply(messageId: number): Promise<void> {
    await this.ctx.storage.delete(`reply:${messageId}`);
  }
}

export class TelegramSession extends DurableObject<RuntimeEnv> {
  private session = initialSessionState();
  private runPromise: Promise<void> | null = null;
  private lastProgressEditAt = 0;

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.session = await ctx.storage.get<SessionState>("session") ?? initialSessionState();
      this.session.voiceReply = Boolean(this.session.voiceReply);
      this.session.steering = (this.session.steering || []).map((turn) =>
        typeof turn === "string"
          ? { text: turn, voiceReply: false, audioMode: false }
          : { ...turn, audioMode: Boolean(turn.audioMode) }
      );
      if (this.session.status === "running") {
        this.session.status = "error";
        this.session.updatedAt = Date.now();
        await ctx.storage.put("session", this.session);
      }
    });
  }

  async startTurn(input: StartTurnInput): Promise<{ accepted: boolean; status: SessionStatus }> {
    if (this.session.status === "running") {
      return { accepted: false, status: this.session.status };
    }
    this.session.status = "running";
    this.session.chatId = input.chatId;
    this.session.originMessageId = input.originMessageId;
    this.session.progressMessageId = input.progressMessageId;
    this.session.steering = [];
    this.session.voiceReply = input.turn.voiceReply;
    this.session.startedAt = Date.now();
    this.session.updatedAt = Date.now();
    await this.persist();
    this.runPromise = this.runTurn(input.turn)
      .catch((error) => this.finishWithError(error))
      .finally(() => {
        this.runPromise = null;
      });
    this.ctx.waitUntil(this.runPromise);
    console.log("telegram session turn started", {
      sessionId: this.ctx.id.toString(),
      chatId: input.chatId,
      progressMessageId: input.progressMessageId,
    });
    return { accepted: true, status: this.session.status };
  }

  async steer(input: SteerInput): Promise<{ accepted: boolean; status: SessionStatus }> {
    if (
      this.session.status !== "running" ||
      this.session.progressMessageId !== input.previousProgressMessageId
    ) {
      return { accepted: false, status: this.session.status };
    }
    this.session.steering.push(input.turn);
    if (input.turn.voiceReply) this.session.voiceReply = true;
    this.session.progressMessageId = input.progressMessageId;
    this.session.updatedAt = Date.now();
    await this.persist();
    await this.updateProgress("已接收 steering，正在调整执行方向…", "", true);
    console.log("telegram session steering queued", {
      sessionId: this.ctx.id.toString(),
      previousProgressMessageId: input.previousProgressMessageId,
      progressMessageId: input.progressMessageId,
    });
    return { accepted: true, status: this.session.status };
  }

  async reset(): Promise<void> {
    if (this.session.status === "running") throw new Error("Cannot reset a running session");
    this.session = initialSessionState();
    await this.persist();
  }

  async getStatus(): Promise<SessionState> {
    return structuredClone(this.session);
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("session", this.session);
  }

  private takeSteering(): UserTurn[] {
    const steering = this.session.steering;
    this.session.steering = [];
    return steering;
  }

  private async updateProgress(stage: string, preview = "", force = false): Promise<void> {
    const { chatId, progressMessageId, startedAt } = this.session;
    if (chatId === null || progressMessageId === null) return;
    const now = Date.now();
    if (!force && now - this.lastProgressEditAt < 1_500) return;
    this.lastProgressEditAt = now;
    const elapsedSeconds = Math.max(0, Math.floor((now - (startedAt || now)) / 1_000));
    const elapsed = elapsedSeconds < 60
      ? `${elapsedSeconds}s`
      : `${Math.floor(elapsedSeconds / 60)}m${String(elapsedSeconds % 60).padStart(2, "0")}s`;
    const clippedPreview = preview.trim().slice(-1_500);
    const text = [
      `🟡 IN PROGRESS · ${elapsed}`,
      stage,
      clippedPreview ? `\n${clippedPreview}` : "",
    ].join("\n");
    await editTelegram(this.env, chatId, progressMessageId, text).catch((error) => {
      console.warn("telegram progress edit failed", {
        sessionId: this.ctx.id.toString(),
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async prepareTurn(turn: UserTurn, stage: string): Promise<string> {
    if (!turn.audio) return turn.text;
    await this.updateProgress(`${stage}：正在下载并识别语音…`, turn.text, true);
    const transcript = await transcribeTelegramAudio(this.env, turn.audio, turn.text);
    const prompt = [turn.text, transcript].filter(Boolean).join("\n\n");
    await this.updateProgress(`${stage}：语音识别完成`, transcript, true);
    return prompt;
  }

  private async runTurn(initialTurn: UserTurn): Promise<void> {
    const history = this.session.history.slice(-MAX_HISTORY_MESSAGES);
    const prompt = await this.prepareTurn(initialTurn, "输入");
    const turnInputs = [prompt];
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(this.env) },
      ...history,
      { role: "user", content: prompt },
    ];
    let finalText = "I could not complete the request.";
    let generatedAudio: GeneratedAudio | null = null;

    if (initialTurn.audioMode) {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        await this.updateProgress(`正在请求音频模型 · round ${round + 1}/${MAX_TOOL_ROUNDS}`, "", true);
        const result = await generateAudioResponse(this.env, messages);
        finalText = result.text;
        generatedAudio = result.audio;
        const steering = this.takeSteering();
        if (!steering.length) break;
        messages.push({ role: "assistant", content: finalText });
        for (const turn of steering) {
          const instruction = await this.prepareTurn(turn, "Steering");
          turnInputs.push(instruction);
          messages.push({ role: "user", content: instruction });
        }
        await this.persist();
        await this.updateProgress(`已合并 ${steering.length} 条 steering 指令，继续运行…`, "", true);
      }
    } else {

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        await this.updateProgress(`正在请求模型 · round ${round + 1}/${MAX_TOOL_ROUNDS}`, "", true);
        const result = await runModel(
          this.env,
          messages,
          (partial) => this.updateProgress(
            `模型生成中 · round ${round + 1}/${MAX_TOOL_ROUNDS}`,
            partial,
          ),
        );
        const choiceMessage = result.choices?.[0]?.message;
        const candidate = String(result.response || choiceMessage?.content || finalText).trim();
        const calls = Array.isArray(choiceMessage?.tool_calls)
          ? choiceMessage.tool_calls
          : Array.isArray(result.tool_calls)
            ? result.tool_calls
            : [];

        if (calls.length) {
          messages.push({
            role: "assistant",
            content: String(result.response || choiceMessage?.content || ""),
            tool_calls: calls,
          });
          for (let index = 0; index < calls.length; index += 1) {
            const call = calls[index];
            const id = toolId(call, index);
            const name = toolName(call);
            await this.updateProgress(
              `正在执行工具 · ${index + 1}/${calls.length}`,
              name || "unknown tool",
              true,
            );
            let output: unknown;
            try {
              output = await executeTool(this.env, name, parseArguments(call));
            } catch (error) {
              output = { error: error instanceof Error ? error.message : String(error) };
            }
            messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(output) });
          }
        } else {
          finalText = candidate || finalText;
        }

        const steering = this.takeSteering();
        if (steering.length) {
          if (!calls.length) messages.push({ role: "assistant", content: finalText });
          for (const turn of steering) {
            const instruction = await this.prepareTurn(turn, "Steering");
            turnInputs.push(instruction);
            messages.push({ role: "user", content: instruction });
          }
          await this.persist();
          await this.updateProgress(`已合并 ${steering.length} 条 steering 指令，继续运行…`, "", true);
          continue;
        }
        if (!calls.length) break;
      }
    }

    this.session.history = [
      ...history,
      ...turnInputs.map((content): ChatMessage => ({ role: "user", content })),
      { role: "assistant", content: finalText } as ChatMessage,
    ].slice(-MAX_HISTORY_MESSAGES);
    let voiceError = "";
    if (this.session.voiceReply && !generatedAudio) {
      await this.updateProgress("正在生成语音回复…", finalText, true);
      try {
        generatedAudio = await synthesizeVoice(this.env, finalText);
      } catch (error) {
        voiceError = error instanceof Error ? error.message : String(error);
        console.warn("telegram voice synthesis failed", {
          sessionId: this.ctx.id.toString(),
          message: voiceError,
        });
      }
    }
    this.session.status = "done";
    this.session.updatedAt = Date.now();
    await this.persist();
    await this.updateProgress("正在发送最终结果…", finalText, true);
    await this.publishFinal(finalText, generatedAudio, voiceError);
  }

  private async finishWithError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.error("telegram session failed", { message });
    this.session.status = "error";
    this.session.updatedAt = Date.now();
    await this.persist();
    await this.publishFinal(`处理失败：${message}`).catch((publishError) => {
      console.error("telegram error reply failed", {
        message: publishError instanceof Error ? publishError.message : String(publishError),
      });
    });
  }

  private async publishFinal(text: string, audio: GeneratedAudio | null = null, voiceError = ""): Promise<void> {
    const { chatId, originMessageId, progressMessageId } = this.session;
    if (chatId === null || originMessageId === null) return;
    const finalMessageIds = await sendTelegram(this.env, chatId, text, originMessageId);
    const router = this.env.TELEGRAM_ROUTER.getByName(String(chatId));
    for (const messageId of finalMessageIds) {
      await router.setReply(messageId, { sessionId: this.ctx.id.toString(), kind: "final" });
    }
    let audioMessageId: number | null = null;
    if (audio) {
      audioMessageId = await sendTelegramAudio(
        this.env,
        chatId,
        audio,
        finalMessageIds.at(-1) || originMessageId,
      );
      await router.setReply(audioMessageId, { sessionId: this.ctx.id.toString(), kind: "final" });
    } else if (voiceError) {
      const warningIds = await sendTelegram(
        this.env,
        chatId,
        `⚠️ 文本回复已完成，但语音输出失败：${voiceError}`,
        finalMessageIds.at(-1) || originMessageId,
      );
      for (const messageId of warningIds) {
        await router.setReply(messageId, { sessionId: this.ctx.id.toString(), kind: "final" });
      }
    }
    console.log("telegram session final published", {
      sessionId: this.ctx.id.toString(),
      chatId,
      finalMessageIds,
      audioMessageId,
    });
    if (progressMessageId !== null) {
      await router.deleteReply(progressMessageId);
      await deleteTelegram(this.env, chatId, progressMessageId).catch(() => undefined);
    }
  }
}

async function createProgress(env: RuntimeEnv, message: TelegramMessage, text = "🟡 IN PROGRESS"): Promise<number> {
  const messageIds = await sendTelegram(env, message.chat.id, text, message.message_id);
  return messageIds[0];
}

function audioSourceFromMessage(message: TelegramMessage): AudioSource | undefined {
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      format: "ogg",
      fileName: "voice.ogg",
      declaredSize: message.voice.file_size,
    };
  }
  if (!message.audio) return undefined;
  const fileName = message.audio.file_name || "";
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  const mime = (message.audio.mime_type || "").toLowerCase();
  const format = extension === "mp3" || mime === "audio/mpeg"
    ? "mp3"
    : extension === "wav" || mime === "audio/wav" || mime === "audio/x-wav"
      ? "wav"
      : extension === "ogg" || mime === "audio/ogg"
        ? "ogg"
        : extension === "flac" || mime === "audio/flac"
          ? "flac"
          : extension === "aac" || mime === "audio/aac"
            ? "aac"
            : extension === "m4a" || mime === "audio/mp4" || mime === "audio/x-m4a"
              ? "m4a"
              : "";
  if (!format) {
    throw new Error("暂不支持该音频格式；请发送 Telegram 语音，或 MP3/WAV/OGG/FLAC/AAC/M4A 文件。");
  }
  return {
    fileId: message.audio.file_id,
    format,
    fileName: message.audio.file_name,
    declaredSize: message.audio.file_size,
  };
}

function userTurnFromMessage(message: TelegramMessage): UserTurn | null {
  const audio = audioSourceFromMessage(message);
  let text = (audio ? message.caption : message.text)?.trim() || "";
  const audioMode = !audio && /^\/audio(?:\s|$)/i.test(text);
  if (audioMode) text = text.replace(/^\/audio(?:\s+|$)/i, "").trim() || "请用语音简短回复。";
  if (!audio && !text) return null;
  return { text, audio, voiceReply: Boolean(audio) || audioMode, audioMode };
}

async function startSession(
  env: RuntimeEnv,
  message: TelegramMessage,
  turn: UserTurn,
  existingSessionId?: string,
): Promise<void> {
  const progressMessageId = await createProgress(env, message);
  const router = env.TELEGRAM_ROUTER.getByName(String(message.chat.id));
  const sessionObjectId = existingSessionId
    ? env.TELEGRAM_SESSIONS.idFromString(existingSessionId)
    : env.TELEGRAM_SESSIONS.newUniqueId();
  const sessionId = sessionObjectId.toString();
  await router.setReply(progressMessageId, { sessionId, kind: "progress" });
  const session = env.TELEGRAM_SESSIONS.get(sessionObjectId);
  let result: { accepted: boolean; status: SessionStatus };
  try {
    result = await session.startTurn({
      chatId: message.chat.id,
      originMessageId: message.message_id,
      progressMessageId,
      turn,
    });
  } catch (error) {
    await router.deleteReply(progressMessageId);
    await editTelegram(
      env,
      message.chat.id,
      progressMessageId,
      `❌ ERROR\n${error instanceof Error ? error.message : String(error)}`,
    ).catch(() => undefined);
    throw error;
  }
  if (!result.accepted) {
    await router.deleteReply(progressMessageId);
    await editTelegram(env, message.chat.id, progressMessageId, "⚠️ SESSION BUSY");
  }
}

async function steerSession(
  env: RuntimeEnv,
  message: TelegramMessage,
  turn: UserTurn,
  mapping: ReplyMapping,
  previousProgressMessageId: number,
): Promise<void> {
  const progressMessageId = await createProgress(env, message, "🟡 IN PROGRESS\n(steer accepted…)");
  const router = env.TELEGRAM_ROUTER.getByName(String(message.chat.id));
  const session = env.TELEGRAM_SESSIONS.get(env.TELEGRAM_SESSIONS.idFromString(mapping.sessionId));
  const result = await session.steer({ previousProgressMessageId, progressMessageId, turn });
  if (!result.accepted) {
    await editTelegram(env, message.chat.id, progressMessageId, "⚠️ Steering 未接受：当前会话已不在运行中。");
    return;
  }
  await router.deleteReply(previousProgressMessageId);
  await router.setReply(progressMessageId, { sessionId: mapping.sessionId, kind: "progress" });
  await editTelegram(
    env,
    message.chat.id,
    previousProgressMessageId,
    "↪ STEER ACCEPTED\nContinuing in the newer progress message.",
  ).catch(() => undefined);
}

async function processMessage(env: RuntimeEnv, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  if (String(chatId) !== env.ALLOWED_CHAT_ID) return;
  const turn = userTurnFromMessage(message);
  if (!turn) {
    await sendTelegram(env, chatId, "目前支持文本、Telegram 语音和常见音频文件。", message.message_id);
    return;
  }
  const text = turn.text;
  const isCommand = !turn.audio;
  if (isCommand && text === "/start") {
    await sendTelegram(
      env,
      chatId,
      `camelAI Telegram Lite 已连接 ${env.GITHUB_OWNER}/${env.GITHUB_REPO}。支持文本和语音输入；语音消息会同时返回文本和语音。普通消息创建新会话；回复最终消息继续会话；回复进行中消息可 steering。`,
      message.message_id,
    );
    return;
  }
  if (isCommand && text === "/status") {
    await sendTelegram(env, chatId, JSON.stringify(await getCiStatus(env), null, 2), message.message_id);
    return;
  }
  const repliedMessageId = message.reply_to_message?.message_id;
  const router = env.TELEGRAM_ROUTER.getByName(String(chatId));
  const mapping = repliedMessageId === undefined ? null : await router.getReply(repliedMessageId);

  if (isCommand && text === "/reset") {
    if (!mapping) {
      await sendTelegram(env, chatId, "普通消息本来就会创建新会话；请回复某个最终消息后发送 /reset 来清空该会话。", message.message_id);
      return;
    }
    const session = env.TELEGRAM_SESSIONS.get(env.TELEGRAM_SESSIONS.idFromString(mapping.sessionId));
    try {
      await session.reset();
      await sendTelegram(env, chatId, "该会话上下文已清空。", message.message_id);
    } catch (error) {
      await sendTelegram(env, chatId, error instanceof Error ? error.message : String(error), message.message_id);
    }
    return;
  }

  await telegramRequest(env, "sendChatAction", {
    chat_id: chatId,
    action: turn.audio ? "record_voice" : "typing",
  });
  if (mapping?.kind === "progress" && repliedMessageId !== undefined) {
    await steerSession(env, message, turn, mapping, repliedMessageId);
    return;
  }
  if (mapping?.kind === "final") {
    await startSession(env, message, turn, mapping.sessionId);
    return;
  }
  await startSession(env, message, turn);
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
