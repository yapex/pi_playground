/**
 * Spinner extension - customize the loading spinner animation
 *
 * Usage:
 *   /spinner - Open spinner selector with preview
 *
 * Patches the global Loader component to use a custom spinner style.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Loader, Key, matchesKey } from "@mariozechner/pi-tui";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SPINNER_PRESETS = {
	scanline: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎"],
	moon: ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"],
	weather: ["☀️", "🌤️", "⛅", "☁️", "🌧️", "⛈️", "🌂", "🌈"],
	binary: ["   1", "  10", " 101", "0101", "1010", "0100", "1001", "0011", "0110", "1101", "101 ", "01  ", "1   "],
	pi: ["   3", "  3.", " 3.1", "3.14", ".141", "1415", "4159", "1592", "5926", "9265", "2653", "6535", "5358", "3589", "5897", "8979", "9793", "7932", "9323", "3238", "2384", "3846", "8462", "4626", "6264", "2643", "6433", "4338", "3383", "3832", "8327", "3279", "2795", "7950", "9502", "5028", "0288", "2884", "8841", "8419", "4197", "1971", "971 ", "71  ", "1   "],
} as const;

type SpinnerPresetId = keyof typeof SPINNER_PRESETS;

const SPINNER_ORDER: SpinnerPresetId[] = ["scanline", "moon", "weather", "binary", "pi"];

const SPINNER_LABELS: Record<SpinnerPresetId, string> = {
	scanline: "Scanline",
	moon: "Moon",
	weather: "Weather",
	binary: "Binary Flip",
	pi: "π",
};

interface SpinnerConfig {
	preset: SpinnerPresetId;
}

const DEFAULT_CONFIG: SpinnerConfig = {
	preset: "scanline",
};

// Use globalThis to persist config across module reloads
declare global {
	// eslint-disable-next-line no-var
	var __pi_spinner_config: SpinnerConfig | undefined;
	// eslint-disable-next-line no-var
	var __pi_spinner_patched: boolean | undefined;
}

function getConfig(): SpinnerConfig {
	if (!globalThis.__pi_spinner_config) {
		globalThis.__pi_spinner_config = { ...DEFAULT_CONFIG };
	}
	return globalThis.__pi_spinner_config;
}

const FRAME_INTERVAL_MS = 100;

function getSpinnerFrames(preset: SpinnerPresetId): readonly string[] {
	return SPINNER_PRESETS[preset];
}

function patchGlobalLoaderSpinner(): void {
	if (globalThis.__pi_spinner_patched) return;

	const proto = Loader.prototype as any;
	const originalUpdateDisplay = proto.updateDisplay;

	if (typeof originalUpdateDisplay !== "function") {
		console.error("Spinner extension: Loader.updateDisplay not found");
		return;
	}

	proto.updateDisplay = function patchedUpdateDisplay(this: any, ...args: unknown[]) {
		const frames = getSpinnerFrames(getConfig().preset);
		this.frames = [...frames];
		const current = Number(this.currentFrame ?? 0);
		this.currentFrame = Number.isFinite(current) ? current % frames.length : 0;
		return originalUpdateDisplay.apply(this, args);
	};

	globalThis.__pi_spinner_patched = true;
}

function getSettingsPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

async function loadConfig(): Promise<void> {
	try {
		const settingsPath = getSettingsPath();
		const text = await fs.readFile(settingsPath, "utf-8");
		const parsed = JSON.parse(text) as Record<string, unknown>;
		const spinner = (parsed?.spinner ?? {}) as { preset?: string };

		if (spinner.preset && (SPINNER_ORDER as string[]).includes(spinner.preset)) {
			getConfig().preset = spinner.preset as SpinnerPresetId;
		}
	} catch {
		// Ignore errors
	}
}

async function saveConfig(): Promise<void> {
	const settingsPath = getSettingsPath();
	const dir = path.dirname(settingsPath);

	let parsed: Record<string, unknown> = {};
	try {
		const text = await fs.readFile(settingsPath, "utf-8");
		parsed = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		parsed = {};
	}

	parsed.spinner = { preset: getConfig().preset };

	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(settingsPath, JSON.stringify(parsed, null, 2), "utf-8");
}

async function openSpinnerSelector(ctx: ExtensionCommandContext) {
	if (!ctx.hasUI) return;

	await loadConfig();

	return ctx.ui.custom<SpinnerPresetId | null>((tui, theme, _kb, done) => {
		let selectedIndex = SPINNER_ORDER.indexOf(getConfig().preset);
		let previewFrameIndex = 0;

		const previewTicker = setInterval(() => {
			previewFrameIndex++;
			tui.requestRender();
		}, FRAME_INTERVAL_MS);

		const finish = (result: SpinnerPresetId | null) => {
			clearInterval(previewTicker);
			done(result);
		};

		function currentPreviewFrame(): string {
			const frames = getSpinnerFrames(SPINNER_ORDER[selectedIndex]);
			return frames[previewFrameIndex % frames.length];
		}

		function render(width: number): string[] {
			const lines: string[] = [];
			const hr = theme.fg("accent", "─".repeat(Math.max(8, width)));

			lines.push(hr);
			lines.push(theme.fg("accent", theme.bold(" Spinner Selector")));
			lines.push(theme.fg("muted", " ↑/↓ move • Enter select • Esc cancel"));
			lines.push("");

			for (let i = 0; i < SPINNER_ORDER.length; i++) {
				const presetId = SPINNER_ORDER[i];
				const focused = i === selectedIndex;
				const prefix = focused ? theme.fg("accent", "> ") : "  ";
				const label = SPINNER_LABELS[presetId];
				const sample = getSpinnerFrames(presetId).slice(0, 4).join(" ");
				const line = `${label.padEnd(16)} [${sample}]`;
				lines.push(prefix + (focused ? theme.fg("accent", line) : line));
			}

			lines.push("");
			lines.push(theme.fg("muted", " Preview"));
			const frame = currentPreviewFrame();
			lines.push(` ${theme.fg("accent", frame)} ${theme.fg("text", "Loading...")}`);
			lines.push("");
			lines.push(hr);

			return lines;
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.up)) {
				selectedIndex = (selectedIndex - 1 + SPINNER_ORDER.length) % SPINNER_ORDER.length;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				selectedIndex = (selectedIndex + 1) % SPINNER_ORDER.length;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				finish(SPINNER_ORDER[selectedIndex]);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				finish(null);
			}
		}

		return {
			render,
			invalidate: () => undefined,
			handleInput,
		};
	});
}

export default function (pi: ExtensionAPI) {
	patchGlobalLoaderSpinner();
	loadConfig();

	pi.registerCommand("spinner", {
		description: "Open spinner selector",
		handler: async (_args, ctx) => {
			const result = await openSpinnerSelector(ctx);

			if (result) {
				getConfig().preset = result;
				await saveConfig();
				ctx.ui.notify(`Spinner set to: ${SPINNER_LABELS[result]}`, "info");
			}
		},
	});
}
