# Pi Playground

A collection of [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) extensions.

## Installation

```bash
pi install git:github.com/yapex/pi_playground      # Global (recommended)
pi install -l git:github.com/yapex/pi_playground   # Local to project
pi -e git:github.com/yapex/pi_playground           # Try without installing
```

For development, clone and add to `settings.json`: `{"packages": ["/path/to/pi_playground"]}`

## Extensions

### handoff.ts

Transfer conversation context to a new focused session - an alternative to lossy compaction.

**Usage:**
```
/handoff                           # Auto-detect next task from conversation
/handoff now implement this for teams as well
```

**How it works:** Extracts relevant context from the conversation, uses LLM to generate a focused prompt, opens it for review/editing, then starts a new session with that prompt.

## Development

```bash
git clone https://github.com/yapex/pi_playground.git
cd pi_playground
npm install  # For TypeScript type checking
```

**Structure:**
```
pi_playground/
├── extensions/          # Pi extensions (auto-discovered)
│   └── handoff.ts       # Context transfer command
├── package.json         # Pi manifest + dev dependencies
└── tsconfig.json        # TypeScript configuration
```

**Adding extensions** - Create `.ts` files in `extensions/`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("mycommand", {
    description: "What this command does",
    handler: async (args, ctx) => {
      // Your implementation
    },
  });
}
```

Extensions are loaded directly by pi using [jiti](https://github.com/unjs/jiti) - no compilation required. Run `npx tsc --noEmit` for type checking.

## Resources

- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) • [Extension docs](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/extensions.md) • [Package docs](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/packages.md)
