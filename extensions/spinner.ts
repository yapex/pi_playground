/**
 * Spinner extension - customize the loading spinner animation
 *
 * Patches the global Loader component to use a custom spinner style.
 * Currently uses "scanline" effect: ▏▎▍▌▋▊▉█▉▊▋▌▍▎
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Loader } from "@mariozechner/pi-tui";

const SCANLINE_FRAMES = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎"];

let spinnerPatched = false;

function patchGlobalLoaderSpinner(): void {
	if (spinnerPatched) return;

	const proto = Loader.prototype as any;
	const originalUpdateDisplay = proto.updateDisplay;

	if (typeof originalUpdateDisplay !== "function") {
		console.error("Spinner extension: Loader.updateDisplay not found");
		return;
	}

	proto.updateDisplay = function patchedUpdateDisplay(this: any, ...args: unknown[]) {
		// Replace spinner frames with scanline style
		this.frames = [...SCANLINE_FRAMES];

		// Ensure frame index is valid for new frames array
		const current = Number(this.currentFrame ?? 0);
		this.currentFrame = Number.isFinite(current) ? current % SCANLINE_FRAMES.length : 0;

		return originalUpdateDisplay.apply(this, args);
	};

	spinnerPatched = true;
}

export default function (pi: ExtensionAPI) {
	// Patch the global Loader spinner on extension load
	patchGlobalLoaderSpinner();
}
