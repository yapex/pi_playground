/**
 * Files Extension
 *
 * /files command lists files in the current git tree (plus session-referenced files)
 * and offers quick actions like reveal, open, edit, or diff.
 * /diff is kept as an alias to the same picker.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	fuzzyMatch,
	getEditorKeybindings,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";

type ContentBlock = {
	type?: string;
	text?: string;
	arguments?: Record<string, unknown>;
};

type FileReference = {
	path: string;
	display: string;
	exists: boolean;
	isDirectory: boolean;
};

type FileEntry = {
	canonicalPath: string;
	resolvedPath: string;
	displayPath: string;
	exists: boolean;
	isDirectory: boolean;
	status?: string;
	inRepo: boolean;
	isTracked: boolean;
	isReferenced: boolean;
	hasSessionChange: boolean;
	lastTimestamp: number;
};

type GitStatusEntry = {
	status: string;
	exists: boolean;
	isDirectory: boolean;
};

type FileToolName = "write" | "edit";

type GroupedSelectItem = SelectItem & {
	disabled?: boolean;
	separator?: string;
};

type GroupedSelectListTheme = {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	separator: (text: string) => string;
};

class GroupedSelectList {
	private items: GroupedSelectItem[] = [];
	private filteredItems: GroupedSelectItem[] = [];
	private selectedIndex = 0;
	private maxVisible = 5;
	private theme: GroupedSelectListTheme;

	onSelect?: (item: GroupedSelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: GroupedSelectItem) => void;

	constructor(items: GroupedSelectItem[], maxVisible: number, theme: GroupedSelectListTheme) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		this.selectedIndex = 0;
		this.skipDisabled();
	}

	setItems(items: GroupedSelectItem[]): void {
		this.items = items;
		this.filteredItems = items;
		this.selectedIndex = 0;
		this.skipDisabled();
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
		this.skipDisabled();
	}

	invalidate(): void {}

	private skipDisabled(): void {
		if (this.filteredItems.length === 0) return;

		if (this.filteredItems[this.selectedIndex]?.disabled) {
			const nextSelectable = this.findNextSelectable(this.selectedIndex, 1);
			if (nextSelectable !== -1) {
				this.selectedIndex = nextSelectable;
			} else {
				const prevSelectable = this.findNextSelectable(this.selectedIndex, -1);
				if (prevSelectable !== -1) {
					this.selectedIndex = prevSelectable;
				}
			}
		}
	}

	private findNextSelectable(from: number, direction: 1 | -1): number {
		let index = from + direction;
		while (index >= 0 && index < this.filteredItems.length) {
			if (!this.filteredItems[index].disabled) {
				return index;
			}
			index += direction;
		}
		return -1;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching files"));
			return lines;
		}

		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible));
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// Find which separators are relevant for the visible range
		const visibleSeparators = new Set<string>();
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (item && !item.disabled && item.value) {
				// Find the separator for this item
				for (let j = i - 1; j >= 0; j--) {
					const prevItem = this.filteredItems[j];
					if (prevItem?.disabled && prevItem.separator) {
						visibleSeparators.add(prevItem.separator);
						break;
					}
				}
			}
		}

		// Render sticky separators at the top if their content is visible but the separator itself is not
		for (const sep of visibleSeparators) {
			const sepIndex = this.filteredItems.findIndex((item) => item.disabled && item.separator === sep);
			if (sepIndex !== -1 && sepIndex < startIndex) {
				const separatorText = `── ${sep} ${"─".repeat(Math.max(0, width - sep.length - 6))}`;
				lines.push(this.theme.separator(separatorText));
			}
		}

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			if (item.disabled && item.separator) {
				const separatorText = `── ${item.separator} ${"─".repeat(Math.max(0, width - item.separator.length - 6))}`;
				lines.push(this.theme.separator(separatorText));
				continue;
			}

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? item.description.replace(/[\r\n]+/g, " ").trim() : undefined;
			let line = "";

			if (isSelected) {
				const prefixWidth = 2;
				const displayValue = item.label || item.value;
				if (descriptionSingleLine && width > 40) {
					const maxValueWidth = Math.min(30, width - prefixWidth - 4);
					const truncatedValue = displayValue.length > maxValueWidth ? displayValue.slice(0, maxValueWidth) : displayValue;
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					const descriptionStart = prefixWidth + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2;
					if (remainingWidth > 10) {
						const truncatedDesc = descriptionSingleLine.length > remainingWidth ? descriptionSingleLine.slice(0, remainingWidth) : descriptionSingleLine;
						line = this.theme.selectedText(`→ ${truncatedValue}${spacing}${truncatedDesc}`);
					} else {
						const maxWidth = width - prefixWidth - 2;
						const truncated = displayValue.length > maxWidth ? displayValue.slice(0, maxWidth) : displayValue;
						line = this.theme.selectedText(`→ ${truncated}`);
					}
				} else {
					const maxWidth = width - prefixWidth - 2;
					const truncated = displayValue.length > maxWidth ? displayValue.slice(0, maxWidth) : displayValue;
					line = this.theme.selectedText(`→ ${truncated}`);
				}
			} else {
				const displayValue = item.label || item.value;
				const prefix = "  ";
				if (descriptionSingleLine && width > 40) {
					const maxValueWidth = Math.min(30, width - prefix.length - 4);
					const truncatedValue = displayValue.length > maxValueWidth ? displayValue.slice(0, maxValueWidth) : displayValue;
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					const descriptionStart = prefix.length + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2;
					if (remainingWidth > 10) {
						const truncatedDesc = descriptionSingleLine.length > remainingWidth ? descriptionSingleLine.slice(0, remainingWidth) : descriptionSingleLine;
						const descText = this.theme.description(spacing + truncatedDesc);
						line = prefix + truncatedValue + descText;
					} else {
						const maxWidth = width - prefix.length - 2;
						const truncated = displayValue.length > maxWidth ? displayValue.slice(0, maxWidth) : displayValue;
						line = prefix + truncated;
					}
				} else {
					const maxWidth = width - prefix.length - 2;
					const truncated = displayValue.length > maxWidth ? displayValue.slice(0, maxWidth) : displayValue;
					line = prefix + truncated;
				}
			}
			lines.push(line);
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			lines.push(this.theme.scrollInfo(scrollText.length > width - 2 ? scrollText.slice(0, width - 2) : scrollText));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectUp")) {
			const newIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.selectedIndex = newIndex;
			this.skipDisabled();
			this.notifySelectionChange();
		} else if (kb.matches(keyData, "selectDown")) {
			const newIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.selectedIndex = newIndex;
			this.skipDisabled();
			this.notifySelectionChange();
		} else if (kb.matches(keyData, "selectConfirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && !selectedItem.disabled && this.onSelect) {
				this.onSelect(selectedItem);
			}
		} else if (kb.matches(keyData, "selectCancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): GroupedSelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item && !item.disabled ? item : null;
	}
}

const groupedFuzzyFilter = (
	items: GroupedSelectItem[],
	query: string,
	getText: (item: GroupedSelectItem) => string,
): GroupedSelectItem[] => {
	if (!query.trim()) {
		return items;
	}

	const tokens = query.trim().split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) {
		return items;
	}

	const results: { item: GroupedSelectItem; totalScore: number }[] = [];
	const separators: GroupedSelectItem[] = [];

	for (const item of items) {
		if (item.disabled && item.separator) {
			separators.push(item);
			continue;
		}

		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);

	if (results.length === 0) {
		return [];
	}

	const filteredItems = results.map((r) => r.item);

	if (separators.length > 0) {
		const hasChanged = filteredItems.some((item) => item.value.startsWith("changed:"));
		const hasUnchanged = filteredItems.some((item) => item.value.startsWith("unchanged:"));

		const finalItems: GroupedSelectItem[] = [];

		if (hasChanged) {
			const changedSeparator = separators.find((s) => s.separator === "Changed");
			if (changedSeparator) {
				finalItems.push(changedSeparator);
			}
			finalItems.push(...filteredItems.filter((item) => item.value.startsWith("changed:")));
		}

		if (hasUnchanged) {
			const unchangedSeparator = separators.find((s) => s.separator === "Other files");
			if (unchangedSeparator) {
				finalItems.push(unchangedSeparator);
			}
			finalItems.push(...filteredItems.filter((item) => !item.value.startsWith("changed:") && !item.disabled));
		}

		return finalItems;
	}

	return filteredItems;
};

type SessionFileChange = {
	operations: Set<FileToolName>;
	lastTimestamp: number;
};

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

const MAX_EDIT_BYTES = 40 * 1024 * 1024;

const extractFileReferencesFromText = (text: string): string[] => {
	const refs: string[] = [];

	for (const match of text.matchAll(FILE_TAG_REGEX)) {
		refs.push(match[1]);
	}

	for (const match of text.matchAll(FILE_URL_REGEX)) {
		refs.push(match[0]);
	}

	for (const match of text.matchAll(PATH_REGEX)) {
		refs.push(match[1]);
	}

	return refs;
};

const extractPathsFromToolArgs = (args: unknown): string[] => {
	if (!args || typeof args !== "object") {
		return [];
	}

	const refs: string[] = [];
	const record = args as Record<string, unknown>;
	const directKeys = ["path", "file", "filePath", "filepath", "fileName", "filename"] as const;
	const listKeys = ["paths", "files", "filePaths"] as const;

	for (const key of directKeys) {
		const value = record[key];
		if (typeof value === "string") {
			refs.push(value);
		}
	}

	for (const key of listKeys) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") {
					refs.push(item);
				}
			}
		}
	}

	return refs;
};

const extractFileReferencesFromContent = (content: unknown): string[] => {
	if (typeof content === "string") {
		return extractFileReferencesFromText(content);
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const refs: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;

		if (block.type === "text" && typeof block.text === "string") {
			refs.push(...extractFileReferencesFromText(block.text));
		}

		if (block.type === "toolCall") {
			refs.push(...extractPathsFromToolArgs(block.arguments));
		}
	}

	return refs;
};

const extractFileReferencesFromEntry = (entry: SessionEntry): string[] => {
	if (entry.type === "message") {
		return extractFileReferencesFromContent(entry.message.content);
	}

	if (entry.type === "custom_message") {
		return extractFileReferencesFromContent(entry.content);
	}

	return [];
};

const sanitizeReference = (raw: string): string => {
	let value = raw.trim();
	value = value.replace(/^["'`(<\[]+/, "");
	value = value.replace(/[>"'`,;).\]]+$/, "");
	value = value.replace(/[.,;:]+$/, "");
	return value;
};

const isCommentLikeReference = (value: string): boolean => value.startsWith("//");

const stripLineSuffix = (value: string): string => {
	let result = value.replace(/#L\d+(C\d+)?$/i, "");
	const lastSeparator = Math.max(result.lastIndexOf("/"), result.lastIndexOf("\\"));
	const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
	const segment = result.slice(segmentStart);
	const colonIndex = segment.indexOf(":");
	if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
		result = result.slice(0, segmentStart + colonIndex);
		return result;
	}

	const lastColon = result.lastIndexOf(":");
	if (lastColon > lastSeparator) {
		const suffix = result.slice(lastColon + 1);
		if (/^\d+(?::\d+)?$/.test(suffix)) {
			result = result.slice(0, lastColon);
		}
	}
	return result;
};

const normalizeReferencePath = (raw: string, cwd: string): string | null => {
	let candidate = sanitizeReference(raw);
	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return null;
		}
	}

	candidate = stripLineSuffix(candidate);
	if (!candidate || isCommentLikeReference(candidate)) {
		return null;
	}

	if (candidate.startsWith("~")) {
		candidate = path.join(os.homedir(), candidate.slice(1));
	}

	if (!path.isAbsolute(candidate)) {
		candidate = path.resolve(cwd, candidate);
	}

	candidate = path.normalize(candidate);
	const root = path.parse(candidate).root;
	if (candidate.length > root.length) {
		candidate = candidate.replace(/[\\/]+$/, "");
	}

	return candidate;
};

const formatDisplayPath = (absolutePath: string, cwd: string): string => {
	const normalizedCwd = path.resolve(cwd);
	if (absolutePath.startsWith(normalizedCwd + path.sep)) {
		return path.relative(normalizedCwd, absolutePath);
	}

	return absolutePath;
};

const collectRecentFileReferences = (entries: SessionEntry[], cwd: string, limit: number): FileReference[] => {
	const results: FileReference[] = [];
	const seen = new Set<string>();

	for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
		const refs = extractFileReferencesFromEntry(entries[i]);
		for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
			const normalized = normalizeReferencePath(refs[j], cwd);
			if (!normalized || seen.has(normalized)) {
				continue;
			}

			seen.add(normalized);

			let exists = false;
			let isDirectory = false;
			if (existsSync(normalized)) {
				exists = true;
				const stats = statSync(normalized);
				isDirectory = stats.isDirectory();
			}

			results.push({
				path: normalized,
				display: formatDisplayPath(normalized, cwd),
				exists,
				isDirectory,
			});
		}
	}

	return results;
};

const findLatestFileReference = (entries: SessionEntry[], cwd: string): FileReference | null => {
	const refs = collectRecentFileReferences(entries, cwd, 100);
	return refs.find((ref) => ref.exists) ?? null;
};

const toCanonicalPath = (inputPath: string): { canonicalPath: string; isDirectory: boolean } | null => {
	if (!existsSync(inputPath)) {
		return null;
	}

	try {
		const canonicalPath = realpathSync(inputPath);
		const stats = statSync(canonicalPath);
		return { canonicalPath, isDirectory: stats.isDirectory() };
	} catch {
		return null;
	}
};

const toCanonicalPathMaybeMissing = (
	inputPath: string,
): { canonicalPath: string; isDirectory: boolean; exists: boolean } | null => {
	const resolvedPath = path.resolve(inputPath);
	if (!existsSync(resolvedPath)) {
		return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: false };
	}

	try {
		const canonicalPath = realpathSync(resolvedPath);
		const stats = statSync(canonicalPath);
		return { canonicalPath, isDirectory: stats.isDirectory(), exists: true };
	} catch {
		return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: true };
	}
};

const collectSessionFileChanges = (entries: SessionEntry[], cwd: string): Map<string, SessionFileChange> => {
	const toolCalls = new Map<string, { path: string; name: FileToolName }>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const name = block.name as FileToolName;
					if (name === "write" || name === "edit") {
						const filePath = block.arguments?.path;
						if (filePath && typeof filePath === "string") {
							toolCalls.set(block.id, { path: filePath, name });
						}
					}
				}
			}
		}
	}

	const fileMap = new Map<string, SessionFileChange>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "toolResult") {
			const toolCall = toolCalls.get(msg.toolCallId);
			if (!toolCall) continue;

			const resolvedPath = path.isAbsolute(toolCall.path)
				? toolCall.path
				: path.resolve(cwd, toolCall.path);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) {
				continue;
			}

			const existing = fileMap.get(canonical.canonicalPath);
			if (existing) {
				existing.operations.add(toolCall.name);
				if (msg.timestamp > existing.lastTimestamp) {
					existing.lastTimestamp = msg.timestamp;
				}
			} else {
				fileMap.set(canonical.canonicalPath, {
					operations: new Set([toolCall.name]),
					lastTimestamp: msg.timestamp,
				});
			}
		}
	}

	return fileMap;
};

const splitNullSeparated = (value: string): string[] => value.split("\0").filter(Boolean);

const getGitRoot = async (pi: ExtensionAPI, cwd: string): Promise<string | null> => {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) {
		return null;
	}

	const root = result.stdout.trim();
	return root ? root : null;
};

const getGitStatusMap = async (pi: ExtensionAPI, cwd: string): Promise<Map<string, GitStatusEntry>> => {
	const statusMap = new Map<string, GitStatusEntry>();
	const statusResult = await pi.exec("git", ["status", "--porcelain=1", "-z"], { cwd });
	if (statusResult.code !== 0 || !statusResult.stdout) {
		return statusMap;
	}

	const entries = splitNullSeparated(statusResult.stdout);
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry || entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const statusLabel = status.replace(/\s/g, "") || status.trim();
		let filePath = entry.slice(3);
		if ((status.startsWith("R") || status.startsWith("C")) && entries[i + 1]) {
			filePath = entries[i + 1];
			i += 1;
		}
		if (!filePath) continue;

		const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
		const canonical = toCanonicalPathMaybeMissing(resolved);
		if (!canonical) continue;
		statusMap.set(canonical.canonicalPath, {
			status: statusLabel,
			exists: canonical.exists,
			isDirectory: canonical.isDirectory,
		});
	}

	return statusMap;
};

const getGitFiles = async (
	pi: ExtensionAPI,
	gitRoot: string,
): Promise<{ tracked: Set<string>; files: Array<{ canonicalPath: string; isDirectory: boolean }> }> => {
	const tracked = new Set<string>();
	const files: Array<{ canonicalPath: string; isDirectory: boolean }> = [];

	const trackedResult = await pi.exec("git", ["ls-files", "-z"], { cwd: gitRoot });
	if (trackedResult.code === 0 && trackedResult.stdout) {
		for (const relativePath of splitNullSeparated(trackedResult.stdout)) {
			const resolvedPath = path.resolve(gitRoot, relativePath);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) continue;
			tracked.add(canonical.canonicalPath);
			files.push(canonical);
		}
	}

	const untrackedResult = await pi.exec("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: gitRoot });
	if (untrackedResult.code === 0 && untrackedResult.stdout) {
		for (const relativePath of splitNullSeparated(untrackedResult.stdout)) {
			const resolvedPath = path.resolve(gitRoot, relativePath);
			const canonical = toCanonicalPath(resolvedPath);
			if (!canonical) continue;
			files.push(canonical);
		}
	}

	return { tracked, files };
};

const buildFileEntries = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<{ files: FileEntry[]; gitRoot: string | null }> => {
	const entries = ctx.sessionManager.getBranch();
	const sessionChanges = collectSessionFileChanges(entries, ctx.cwd);
	const gitRoot = await getGitRoot(pi, ctx.cwd);
	const statusMap = gitRoot ? await getGitStatusMap(pi, gitRoot) : new Map<string, GitStatusEntry>();

	let trackedSet = new Set<string>();
	let gitFiles: Array<{ canonicalPath: string; isDirectory: boolean }> = [];
	if (gitRoot) {
		const gitListing = await getGitFiles(pi, gitRoot);
		trackedSet = gitListing.tracked;
		gitFiles = gitListing.files;
	}

	const fileMap = new Map<string, FileEntry>();

	const upsertFile = (data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean }) => {
		const existing = fileMap.get(data.canonicalPath);
		const displayPath = data.displayPath ?? formatDisplayPath(data.canonicalPath, ctx.cwd);

		if (existing) {
			fileMap.set(data.canonicalPath, {
				...existing,
				...data,
				displayPath,
				exists: data.exists ?? existing.exists,
				isDirectory: data.isDirectory ?? existing.isDirectory,
				isReferenced: existing.isReferenced || data.isReferenced === true,
				inRepo: existing.inRepo || data.inRepo === true,
				isTracked: existing.isTracked || data.isTracked === true,
				hasSessionChange: existing.hasSessionChange || data.hasSessionChange === true,
				lastTimestamp: Math.max(existing.lastTimestamp, data.lastTimestamp ?? 0),
			});
			return;
		}

		fileMap.set(data.canonicalPath, {
			canonicalPath: data.canonicalPath,
			resolvedPath: data.resolvedPath ?? data.canonicalPath,
			displayPath,
			exists: data.exists ?? true,
			isDirectory: data.isDirectory,
			status: data.status,
			inRepo: data.inRepo ?? false,
			isTracked: data.isTracked ?? false,
			isReferenced: data.isReferenced ?? false,
			hasSessionChange: data.hasSessionChange ?? false,
			lastTimestamp: data.lastTimestamp ?? 0,
		});
	};

	for (const file of gitFiles) {
		upsertFile({
			canonicalPath: file.canonicalPath,
			resolvedPath: file.canonicalPath,
			isDirectory: file.isDirectory,
			exists: true,
			status: statusMap.get(file.canonicalPath)?.status,
			inRepo: true,
			isTracked: trackedSet.has(file.canonicalPath),
		});
	}

	for (const [canonicalPath, statusEntry] of statusMap.entries()) {
		if (fileMap.has(canonicalPath)) {
			continue;
		}

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonicalPath));

		upsertFile({
			canonicalPath,
			resolvedPath: canonicalPath,
			isDirectory: statusEntry.isDirectory,
			exists: statusEntry.exists,
			status: statusEntry.status,
			inRepo,
			isTracked: trackedSet.has(canonicalPath) || statusEntry.status !== "??",
		});
	}

	const references = collectRecentFileReferences(entries, ctx.cwd, 200).filter((ref) => ref.exists);
	for (const ref of references) {
		const canonical = toCanonicalPath(ref.path);
		if (!canonical) continue;

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonical.canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));

		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			status: statusMap.get(canonical.canonicalPath)?.status,
			inRepo,
			isTracked: trackedSet.has(canonical.canonicalPath),
			isReferenced: true,
		});
	}

	for (const [canonicalPath, change] of sessionChanges.entries()) {
		const canonical = toCanonicalPath(canonicalPath);
		if (!canonical) continue;

		const inRepo =
			gitRoot !== null &&
			!path.relative(gitRoot, canonical.canonicalPath).startsWith("..") &&
			!path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));

		upsertFile({
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			isDirectory: canonical.isDirectory,
			exists: true,
			status: statusMap.get(canonical.canonicalPath)?.status,
			inRepo,
			isTracked: trackedSet.has(canonical.canonicalPath),
			hasSessionChange: true,
			lastTimestamp: change.lastTimestamp,
		});
	}

	const files = Array.from(fileMap.values()).sort((a, b) => {
		const aDirty = Boolean(a.status);
		const bDirty = Boolean(b.status);
		if (aDirty !== bDirty) {
			return aDirty ? -1 : 1;
		}
		if (a.inRepo !== b.inRepo) {
			return a.inRepo ? -1 : 1;
		}
		if (a.hasSessionChange !== b.hasSessionChange) {
			return a.hasSessionChange ? -1 : 1;
		}
		if (a.lastTimestamp !== b.lastTimestamp) {
			return b.lastTimestamp - a.lastTimestamp;
		}
		if (a.isReferenced !== b.isReferenced) {
			return a.isReferenced ? -1 : 1;
		}
		return a.displayPath.localeCompare(b.displayPath);
	});

	return { files, gitRoot };
};

type EditCheckResult = {
	allowed: boolean;
	reason?: string;
	content?: string;
};

const getEditableContent = (target: FileEntry): EditCheckResult => {
	if (!existsSync(target.resolvedPath)) {
		return { allowed: false, reason: "File not found" };
	}

	const stats = statSync(target.resolvedPath);
	if (stats.isDirectory()) {
		return { allowed: false, reason: "Directories cannot be edited" };
	}

	if (stats.size >= MAX_EDIT_BYTES) {
		return { allowed: false, reason: "File is too large" };
	}

	const buffer = readFileSync(target.resolvedPath);
	if (buffer.includes(0)) {
		return { allowed: false, reason: "File contains null bytes" };
	}

	return { allowed: true, content: buffer.toString("utf8") };
};

const showActionSelector = async (
	ctx: ExtensionContext,
	options: { canQuickLook: boolean; canEdit: boolean; canDiff: boolean },
): Promise<"reveal" | "quicklook" | "open" | "edit" | "addToPrompt" | "diff" | null> => {
	const actions: SelectItem[] = [
		...(options.canDiff ? [{ value: "diff", label: "Diff in VS Code" }] : []),
		{ value: "reveal", label: "Reveal in Finder" },
		{ value: "open", label: "Open" },
		{ value: "addToPrompt", label: "Add to prompt" },
		...(options.canQuickLook ? [{ value: "quicklook", label: "Open in Quick Look" }] : []),
		...(options.canEdit ? [{ value: "edit", label: "Edit" }] : []),
	];

	return ctx.ui.custom<"reveal" | "quicklook" | "open" | "edit" | "addToPrompt" | "diff" | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Choose action"))));

		const selectList = new SelectList(actions, actions.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(item.value as "reveal" | "quicklook" | "open" | "edit" | "addToPrompt" | "diff");
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

const openPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const command = process.platform === "darwin" ? "open" : "xdg-open";
	const result = await pi.exec(command, [target.resolvedPath]);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to open ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const openExternalEditor = (tui: TUI, editorCmd: string, content: string): string | null => {
	const tmpFile = path.join(os.tmpdir(), `pi-files-edit-${Date.now()}.txt`);

	try {
		writeFileSync(tmpFile, content, "utf8");
		tui.stop();

		const [editor, ...editorArgs] = editorCmd.split(" ");
		const result = spawnSync(editor, [...editorArgs, tmpFile], { stdio: "inherit" });

		if (result.status === 0) {
			return readFileSync(tmpFile, "utf8").replace(/\n$/, "");
		}

		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
		}
		tui.start();
		tui.requestRender(true);
	}
};

const editPath = async (ctx: ExtensionContext, target: FileEntry, content: string): Promise<void> => {
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd) {
		ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
		return;
	}

	const updated = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const status = new Text(theme.fg("dim", `Opening ${editorCmd}...`));

		queueMicrotask(() => {
			const result = openExternalEditor(tui, editorCmd, content);
			done(result);
		});

		return status;
	});

	if (updated === null) {
		ctx.ui.notify("Edit cancelled", "info");
		return;
	}

	try {
		writeFileSync(target.resolvedPath, updated, "utf8");
	} catch {
		ctx.ui.notify(`Failed to save ${target.displayPath}`, "error");
	}
};

const revealPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.resolvedPath).isDirectory();
	let command = "open";
	let args: string[] = [];

	if (process.platform === "darwin") {
		args = isDirectory ? [target.resolvedPath] : ["-R", target.resolvedPath];
	} else {
		command = "xdg-open";
		args = [isDirectory ? target.resolvedPath : path.dirname(target.resolvedPath)];
	}

	const result = await pi.exec(command, args);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to reveal ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const quickLookPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry): Promise<void> => {
	if (process.platform !== "darwin") {
		ctx.ui.notify("Quick Look is only available on macOS", "warning");
		return;
	}

	if (!existsSync(target.resolvedPath)) {
		ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.resolvedPath).isDirectory();
	if (isDirectory) {
		ctx.ui.notify("Quick Look only works on files", "warning");
		return;
	}

	const result = await pi.exec("qlmanage", ["-p", target.resolvedPath]);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to Quick Look ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const openDiff = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileEntry, gitRoot: string | null): Promise<void> => {
	if (!gitRoot) {
		ctx.ui.notify("Git repository not found", "warning");
		return;
	}

	const relativePath = path.relative(gitRoot, target.resolvedPath).split(path.sep).join("/");
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-files-"));
	const tmpFile = path.join(tmpDir, path.basename(target.displayPath));

	const existsInHead = await pi.exec("git", ["cat-file", "-e", `HEAD:${relativePath}`], { cwd: gitRoot });
	if (existsInHead.code === 0) {
		const result = await pi.exec("git", ["show", `HEAD:${relativePath}`], { cwd: gitRoot });
		if (result.code !== 0) {
			const errorMessage = result.stderr?.trim() || `Failed to diff ${target.displayPath}`;
			ctx.ui.notify(errorMessage, "error");
			return;
		}
		writeFileSync(tmpFile, result.stdout ?? "", "utf8");
	} else {
		writeFileSync(tmpFile, "", "utf8");
	}

	let workingPath = target.resolvedPath;
	if (!existsSync(target.resolvedPath)) {
		workingPath = path.join(tmpDir, `pi-files-working-${path.basename(target.displayPath)}`);
		writeFileSync(workingPath, "", "utf8");
	}

	const openResult = await pi.exec("code", ["--diff", tmpFile, workingPath], { cwd: gitRoot });
	if (openResult.code !== 0) {
		const errorMessage = openResult.stderr?.trim() || `Failed to open diff for ${target.displayPath}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const addFileToPrompt = (ctx: ExtensionContext, target: FileEntry): void => {
	const mentionTarget = target.displayPath || target.resolvedPath;
	const mention = `@${mentionTarget}`;
	const current = ctx.ui.getEditorText();
	const separator = current && !current.endsWith(" ") ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}${mention}`);
	ctx.ui.notify(`Added ${mention} to prompt`, "info");
};

const showFileSelector = async (
	ctx: ExtensionContext,
	files: FileEntry[],
	selectedPath?: string | null,
	gitRoot?: string | null,
): Promise<{ selected: FileEntry | null; quickAction: "diff" | null }> => {
	const changedFiles = files.filter((f) => Boolean(f.status));
	const unchangedFiles = files.filter((f) => !f.status);

	const items: GroupedSelectItem[] = [];

	if (changedFiles.length > 0) {
		items.push({
			value: "separator:changed",
			label: "Changed",
			disabled: true,
			separator: "Changed",
		});
		for (const file of changedFiles) {
			const directoryLabel = file.isDirectory ? " [directory]" : "";
			items.push({
				value: `changed:${file.canonicalPath}`,
				label: `${file.displayPath}${directoryLabel}`,
				description: file.status ? `[${file.status}]` : undefined,
			});
		}
	}

	if (unchangedFiles.length > 0) {
		items.push({
			value: "separator:unchanged",
			label: "Other files",
			disabled: true,
			separator: "Other files",
		});
		for (const file of unchangedFiles) {
			const directoryLabel = file.isDirectory ? " [directory]" : "";
			items.push({
				value: `unchanged:${file.canonicalPath}`,
				label: `${file.displayPath}${directoryLabel}`,
				description: file.status ? `[${file.status}]` : undefined,
			});
		}
	}

	const extractCanonicalPath = (value: string): string => {
		if (value.startsWith("changed:") || value.startsWith("unchanged:")) {
			return value.slice(value.indexOf(":") + 1);
		}
		return value;
	};

	let quickAction: "diff" | null = null;
	const selection = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(" Select file")), 0, 0));

		const searchInput = new Input();
		container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(
			new Text(theme.fg("dim", "Type to filter • enter to select • ctrl+shift+d diff • esc to cancel"), 0, 0),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		let filteredItems = items;
		let selectList: GroupedSelectList | null = null;

		const updateList = () => {
			listContainer.clear();
			if (filteredItems.length === 0) {
				listContainer.addChild(new Text(theme.fg("warning", "  No matching files"), 0, 0));
				selectList = null;
				return;
			}

			selectList = new GroupedSelectList(filteredItems, Math.min(filteredItems.length, 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
				separator: (text) => theme.fg("dim", text),
			});

			if (selectedPath) {
				const index = filteredItems.findIndex((item) => {
					if (item.disabled) return false;
					return extractCanonicalPath(item.value) === selectedPath;
				});
				if (index >= 0) {
					selectList.setSelectedIndex(index);
				}
			}

			selectList.onSelect = (item) => {
				const canonicalPath = extractCanonicalPath(item.value);
				done(canonicalPath);
			};
			selectList.onCancel = () => done(null);

			listContainer.addChild(selectList);
		};

		const applyFilter = () => {
			const query = searchInput.getValue();
			filteredItems = query
				? groupedFuzzyFilter(items, query, (item) => `${item.label} ${extractCanonicalPath(item.value)} ${item.description ?? ""}`)
				: items;
			updateList();
		};

		applyFilter();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "ctrl+shift+d")) {
					const selected = selectList?.getSelectedItem();
					if (selected) {
						const canonicalPath = extractCanonicalPath(selected.value);
						const file = files.find((entry) => entry.canonicalPath === canonicalPath);
						const canDiff = file?.isTracked && !file.isDirectory && Boolean(gitRoot);
						if (!canDiff) {
							ctx.ui.notify("Diff is only available for tracked files", "warning");
							return;
						}
						quickAction = "diff";
						done(canonicalPath);
						return;
					}
				}

				const kb = getEditorKeybindings();
				if (
					kb.matches(data, "selectUp") ||
					kb.matches(data, "selectDown") ||
					kb.matches(data, "selectConfirm") ||
					kb.matches(data, "selectCancel")
				) {
					if (selectList) {
						selectList.handleInput(data);
					} else if (kb.matches(data, "selectCancel")) {
						done(null);
					}
					tui.requestRender();
					return;
				}

				searchInput.handleInput(data);
				applyFilter();
				tui.requestRender();
			},
		};
	});

	const selected = selection ? files.find((file) => file.canonicalPath === selection) ?? null : null;
	return { selected, quickAction };
};

const runFileBrowser = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (!ctx.hasUI) {
		ctx.ui.notify("Files requires interactive mode", "error");
		return;
	}

	const { files, gitRoot } = await buildFileEntries(pi, ctx);
	if (files.length === 0) {
		ctx.ui.notify("No files found", "info");
		return;
	}

	let lastSelectedPath: string | null = null;
	while (true) {
		const { selected, quickAction } = await showFileSelector(ctx, files, lastSelectedPath, gitRoot);
		if (!selected) {
			ctx.ui.notify("Files cancelled", "info");
			return;
		}

		lastSelectedPath = selected.canonicalPath;

		const canQuickLook = process.platform === "darwin" && !selected.isDirectory;
		const editCheck = getEditableContent(selected);
		const canDiff = selected.isTracked && !selected.isDirectory && Boolean(gitRoot);

		if (quickAction === "diff") {
			await openDiff(pi, ctx, selected, gitRoot);
			continue;
		}

		const action = await showActionSelector(ctx, {
			canQuickLook,
			canEdit: editCheck.allowed,
			canDiff,
		});
		if (!action) {
			continue;
		}

		switch (action) {
			case "quicklook":
				await quickLookPath(pi, ctx, selected);
				break;
			case "open":
				await openPath(pi, ctx, selected);
				break;
			case "edit":
				if (!editCheck.allowed || editCheck.content === undefined) {
					ctx.ui.notify(editCheck.reason ?? "File cannot be edited", "warning");
					break;
				}
				await editPath(ctx, selected, editCheck.content);
				break;
			case "addToPrompt":
				addFileToPrompt(ctx, selected);
				break;
			case "diff":
				await openDiff(pi, ctx, selected, gitRoot);
				break;
			default:
				await revealPath(pi, ctx, selected);
				break;
		}
	}
};

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("files", {
		description: "Browse files with git status and session references",
		handler: async (_args, ctx) => {
			await runFileBrowser(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Browse files mentioned in the session",
		handler: async (ctx) => {
			await runFileBrowser(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+f", {
		description: "Reveal the latest file reference in Finder",
		handler: async (ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				ctx.ui.notify("No file reference found in the session", "warning");
				return;
			}

			const canonical = toCanonicalPath(latest.path);
			if (!canonical) {
				ctx.ui.notify(`File not found: ${latest.display}`, "error");
				return;
			}

			await revealPath(pi, ctx, {
				canonicalPath: canonical.canonicalPath,
				resolvedPath: canonical.canonicalPath,
				displayPath: latest.display,
				exists: true,
				isDirectory: canonical.isDirectory,
				status: undefined,
				inRepo: false,
				isTracked: false,
				isReferenced: true,
				hasSessionChange: false,
				lastTimestamp: 0,
			});
		},
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Quick Look the latest file reference",
		handler: async (ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				ctx.ui.notify("No file reference found in the session", "warning");
				return;
			}

			const canonical = toCanonicalPath(latest.path);
			if (!canonical) {
				ctx.ui.notify(`File not found: ${latest.display}`, "error");
				return;
			}

			await quickLookPath(pi, ctx, {
				canonicalPath: canonical.canonicalPath,
				resolvedPath: canonical.canonicalPath,
				displayPath: latest.display,
				exists: true,
				isDirectory: canonical.isDirectory,
				status: undefined,
				inRepo: false,
				isTracked: false,
				isReferenced: true,
				hasSessionChange: false,
				lastTimestamp: 0,
			});
		},
	});
}
