/**
 * LLM caller that uses `pi -p --no-session --mode json` subprocess
 * instead of directly calling pi-ai's complete() + ModelRegistry API.
 *
 * This avoids depending on pi-ai's internal API surface which changes
 * frequently between versions (e.g. getApiKey → getApiKeyAndHeaders in 0.65).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export interface LlmCallResult {
  success: boolean;
  text: string;
  error?: string;
}

/**
 * Call the LLM via `pi -p` subprocess.
 *
 * Uses the current model and lets pi handle API key resolution internally.
 * pi CLI is the stable public API — no internal pi-ai dependency needed.
 */
export async function callLlm(
  userPrompt: string,
  systemPrompt: string,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  const model = ctx.model;
  if (!model) {
    return { success: false, text: "", error: "No model selected" };
  }

  const modelFlag = `${model.provider}/${model.id}`;

  const args = [
    "-p",
    "--no-session",
    "--mode", "json",
    "--model", modelFlag,
    "--system-prompt", systemPrompt,
    "--",           // end of flags; remainder is the prompt
  ];

  try {
    const result = await execFileAsync("pi", [...args, userPrompt], {
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });

    const text = parseAssistantText(result.stdout);
    if (!text) {
      return { success: false, text: "", error: "No assistant response found in pi output" };
    }

    return { success: true, text };
  } catch (err: any) {
    if (err?.name === "AbortError" || signal?.aborted) {
      return { success: false, text: "", error: "Cancelled" };
    }
    return { success: false, text: "", error: err?.message ?? String(err) };
  }
}

/**
 * Parse the assistant's text content from pi's JSON stream output.
 *
 * pi --mode json emits newline-delimited JSON events.
 * We accumulate text_delta events to reconstruct the full response.
 */
function parseAssistantText(stdout: string): string | undefined {
  const lines = stdout.split("\n").filter(Boolean);
  let assistantText = "";

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // text_delta events carry incremental text
      if (
        event.type === "text_delta" &&
        event.assistantMessageEvent?.delta
      ) {
        assistantText += event.assistantMessageEvent.delta;
      }
    } catch {
      // Skip non-JSON lines (e.g. warnings)
    }
  }

  return assistantText || undefined;
}

/**
 * Call the LLM with retry on parse failure.
 */
export async function callLlmWithRetry(
  userPrompt: string,
  systemPrompt: string,
  retryPrompt: string,
  conversationSoFar: string,
  processResponse: (text: string) => { success: boolean; normalized?: unknown; error?: string },
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<{ success: boolean; text?: string; normalized?: unknown; error?: string }> {
  // First attempt
  const result1 = await callLlm(userPrompt, systemPrompt, ctx, signal);
  if (!result1.success) {
    return { success: false, error: result1.error };
  }

  const parsed1 = processResponse(result1.text);
  if (parsed1.success && parsed1.normalized) {
    return { success: true, text: result1.text, normalized: parsed1.normalized };
  }

  // Retry with stricter prompt (append retry instruction)
  const retryUserPrompt = `${conversationSoFar}\n\n---\n\n${retryPrompt}`;
  const result2 = await callLlm(retryUserPrompt, systemPrompt, ctx, signal);
  if (!result2.success) {
    return { success: false, error: result2.error };
  }

  const parsed2 = processResponse(result2.text);
  if (parsed2.success && parsed2.normalized) {
    return { success: true, text: result2.text, normalized: parsed2.normalized };
  }

  return {
    success: false,
    error: `Failed to parse extraction after retry: ${parsed2.error}`,
  };
}
