/**
 * Handoff Extension
 *
 * Provides a `/handoff` command that generates a high-quality "new thread prompt"
 * from the current session, then starts a new session with that prompt.
 *
 * Usage:
 *   /handoff                           - Auto-detect next task from conversation
 *   /handoff implement team-level handoff with proper tests
 *   /handoff fix the authentication bug in login flow
 *   /handoff add unit tests for the parser module
 *
 * The generated prompt is shown for review/editing, then automatically sent.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";

import { loadConfig, validateGoal } from "./config.js";
import { ProgressLoader, EXTRACTION_PHASES } from "./progress.js";
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_AUTO_DETECT,
  EXTRACTION_RETRY_PROMPT,
  buildExtractionUserMessage,
  buildExtractionUserMessageAutoDetect,
  processExtractionResponse,
} from "./extraction.js";
import { callLlm, callLlmWithRetry } from "./llm.js";
import { collectSessionMetadata } from "./metadata.js";
import { assembleHandoffPrompt } from "./prompt.js";
import {
  SKILL_ENTRY_TYPE,
  type HandoffConfig,
  type SkillEntry,
} from "./types.js";

/**
 * Resolves the model ID string to use for extraction.
 * Returns a "provider/id" string, or undefined to use current model.
 */
function resolveExtractionModelId(
  _ctx: ExtensionCommandContext,
  config: HandoffConfig,
): string | undefined {
  if (config.useCurrentModel || !config.model) {
    return undefined; // use current
  }

  const [provider, ...modelParts] = config.model.split("/");
  const modelId = modelParts.join("/");

  if (!provider || !modelId) {
    return undefined;
  }

  return config.model;
}

/**
 * Main handoff command handler
 */
async function runHandoffCommand(
  args: string | undefined,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  lastSkill: string | undefined,
): Promise<void> {
  // Load config from .pi/settings.json
  const cwd = ctx.sessionManager.getCwd();
  const config = loadConfig(cwd);

  // Validate goal (allowAutoDetect = true by default)
  const goal = args?.trim() ?? "";
  const goalValidation = validateGoal(goal, true);

  if (!goalValidation.valid) {
    if (ctx.hasUI) {
      ctx.ui.notify(goalValidation.error!, "error");
    } else {
      console.error(goalValidation.error);
    }
    return;
  }

  const autoDetect = goalValidation.autoDetect ?? false;

  // Check for model
  if (!ctx.model) {
    const errorMsg = "No model selected. Use /model to select a model first.";
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  // Get conversation context from current branch
  const branch = ctx.sessionManager.getBranch();
  const messages = branch
    .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
    .map((entry) => entry.message);

  if (messages.length === 0) {
    const errorMsg = "No conversation to hand off.";
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  // Convert messages to LLM format and serialize
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  const currentSessionFile = ctx.sessionManager.getSessionFile();

  // Collect metadata
  const activeTools = pi.getActiveTools();
  const sessionName = ctx.sessionManager.getSessionName();
  const thinkingLevel = pi.getThinkingLevel();

  const metadata = await collectSessionMetadata({
    model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    thinkingLevel: thinkingLevel !== "off" ? thinkingLevel : undefined,
    tools: activeTools,
    sessionName: sessionName ?? undefined,
    lastSkill,
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
  });

  // Resolve which model to use for extraction
  const extractionModelId = resolveExtractionModelId(ctx, config);
  if (extractionModelId !== undefined) {
    // If an override model is specified, we just use its ID via the pi subprocess
    // (pi handles model resolution and API key lookup)
  }

  // Generate extraction via LLM subprocess
  const extractionResult = await generateExtraction(
    conversationText,
    goal,
    autoDetect,
    config,
    ctx,
    extractionModelId,
  );

  if (!extractionResult.success || !extractionResult.extraction) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        extractionResult.error ?? "Failed to generate handoff context",
        "error",
      );
    } else {
      console.error(extractionResult.error ?? "Failed to generate handoff context");
    }
    return;
  }

  // Assemble the handoff prompt
  const handoffPrompt = assembleHandoffPrompt(
    extractionResult.extraction,
    goal,
    metadata,
    config,
    autoDetect,
  );

  // Non-UI mode: just print the prompt
  if (!ctx.hasUI) {
    console.log(handoffPrompt);
    return;
  }

  // Interactive mode: let user edit the prompt
  const editedPrompt = await ctx.ui.editor("Edit handoff prompt", handoffPrompt);

  if (editedPrompt === undefined) {
    ctx.ui.notify("Handoff cancelled", "info");
    return;
  }

  // Create new session with parent tracking
  const newSessionResult = await ctx.newSession({
    parentSession: currentSessionFile,
  });

  if (newSessionResult.cancelled) {
    ctx.ui.notify("New session cancelled", "info");
    return;
  }

  // Set the edited prompt in the main editor for submission
  ctx.ui.setEditorText(editedPrompt);
  ctx.ui.notify("Handoff ready. Submit when ready.", "info");
}

/**
 * Extraction result type
 */
interface ExtractionResult {
  success: boolean;
  extraction?: ReturnType<typeof processExtractionResponse>["normalized"];
  error?: string;
  completionMessage?: string;
}

/**
 * Generates the extraction by calling the LLM via pi subprocess with retry on parse failure
 */
async function generateExtraction(
  conversationText: string,
  goal: string,
  autoDetect: boolean,
  config: HandoffConfig,
  ctx: ExtensionCommandContext,
  overrideModelId: string | undefined,
): Promise<ExtractionResult> {
  // Build the system and user prompts
  const systemPrompt = autoDetect
    ? EXTRACTION_SYSTEM_PROMPT_AUTO_DETECT
    : EXTRACTION_SYSTEM_PROMPT;

  const userContent = autoDetect
    ? buildExtractionUserMessageAutoDetect(conversationText)
    : buildExtractionUserMessage(conversationText, goal);

  if (!ctx.hasUI) {
    // Non-UI mode: direct call without loader
    return await doExtractionCall(
      userContent, conversationText, systemPrompt, config, ctx, overrideModelId,
    );
  }

  // Interactive mode: show loader during extraction
  if (config.showProgressPhases) {
    return await ctx.ui.custom<ExtractionResult>((tui, theme, _kb, done) => {
      const phaseText = autoDetect
        ? "Analyzing conversation to detect next task..."
        : EXTRACTION_PHASES[0];
      const loader = new ProgressLoader(tui, theme, phaseText);
      loader.onAbort = () => {
        loader.dispose();
        done({ success: false, error: "Cancelled" });
      };

      doExtractionWithPhases(
        userContent, conversationText, systemPrompt, config,
        ctx, overrideModelId, loader.signal, (phase) => loader.setPhase(phase),
      )
        .then((result) => {
          const completionMessage = loader.getCompletionMessage();
          loader.dispose();
          done({ ...result, completionMessage });
        })
        .catch((err) => {
          loader.dispose();
          console.error("Handoff extraction failed:", err);
          done({ success: false, error: err.message ?? "Unknown error" });
        });

      return loader;
    });
  } else {
    return await ctx.ui.custom<ExtractionResult>((tui, theme, _kb, done) => {
      const loaderText = autoDetect
        ? "Analyzing conversation to detect next task..."
        : "Generating handoff context...";
      const loader = new BorderedLoader(tui, theme, loaderText);
      loader.onAbort = () => done({ success: false, error: "Cancelled" });

      doExtractionCall(
        userContent, conversationText, systemPrompt, config, ctx, overrideModelId, loader.signal,
      )
        .then(done)
        .catch((err) => {
          console.error("Handoff extraction failed:", err);
          done({ success: false, error: err.message ?? "Unknown error" });
        });

      return loader;
    });
  }
}

/**
 * Core extraction call with retry, delegating to llm.ts subprocess call.
 */
async function doExtractionCall(
  userContent: string,
  conversationText: string,
  systemPrompt: string,
  config: HandoffConfig,
  ctx: ExtensionCommandContext,
  overrideModelId: string | undefined,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  // Temporarily override model if needed
  const originalModel = ctx.model;
  if (overrideModelId) {
    // We pass the model via pi --model flag in callLlm, no need to mutate ctx
  }

  const result = await callLlmWithRetry(
    userContent,
    systemPrompt,
    EXTRACTION_RETRY_PROMPT,
    conversationText,
    (text) => processExtractionResponse(text, config, conversationText),
    ctx,
    signal,
  );

  if (result.success && result.normalized) {
    return { success: true, extraction: result.normalized as ExtractionResult["extraction"] };
  }

  return { success: false, error: result.error };
}

/**
 * Extraction with phase updates for progress UI.
 */
async function doExtractionWithPhases(
  userContent: string,
  conversationText: string,
  systemPrompt: string,
  config: HandoffConfig,
  ctx: ExtensionCommandContext,
  _overrideModelId: string | undefined,
  signal: AbortSignal,
  onPhase: (phase: string) => void,
): Promise<ExtractionResult> {
  onPhase(EXTRACTION_PHASES[0]);
  // Phase 1 is just a label — the real work happens in doExtractionCall

  onPhase(EXTRACTION_PHASES[1]);
  const result = await doExtractionCall(
    userContent, conversationText, systemPrompt, config, ctx, undefined, signal,
  );

  onPhase(EXTRACTION_PHASES[2]);
  return result;
}

/**
 * Main extension entry point
 */
export default function handoffExtension(pi: ExtensionAPI) {
  // Track last used skill
  let lastSkill: string | undefined;

  // Restore last skill from session on startup
  pi.on("session_start", async (_event, ctx) => {
    lastSkill = undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === SKILL_ENTRY_TYPE
      ) {
        const data = (entry as any).data as SkillEntry | undefined;
        if (data?.skillName) {
          lastSkill = data.skillName;
        }
      }
    }
  });

  // Track skill usage via input event
  pi.on("input", async (event, _ctx) => {
    const text = event.text.trim();

    // Check if this is a skill command
    if (text.startsWith("/skill:")) {
      const skillMatch = text.match(/^\/skill:([^\s]+)/);
      if (skillMatch) {
        const skillName = skillMatch[1];
        lastSkill = skillName;

        // Persist to session
        pi.appendEntry(SKILL_ENTRY_TYPE, {
          skillName,
          timestamp: Date.now(),
        } as SkillEntry);
      }
    }

    // Let the input continue processing
    return { action: "continue" };
  });

  // Register the /handoff command
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    handler: async (args, ctx) => {
      await runHandoffCommand(args, ctx, pi, lastSkill);
    },
  });
}
