# Pi Playground

A playground for exploring and developing [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) extensions.

## What's Here

### `.pi/extensions/` - Custom Extensions

This directory contains custom extensions that pi auto-discovers and loads on startup. Extensions are TypeScript files that use pi's Extension API.

#### handoff.ts

Transfer conversation context to a new focused session - an alternative to lossy compaction.

**Usage:**
```
/handoff                           # Auto-detect next task from conversation
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff check other places that need this fix
```

**How it works:**
1. Extracts relevant context from the current conversation (decisions, files, findings)
2. Uses LLM to generate a focused prompt for the next session
3. Opens the prompt in the editor for review/editing
4. Creates a new session with the prompt ready to submit

This is useful when context gets long and you want a fresh start without losing important information.

## Development

### Prerequisites

- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) installed globally
- Node.js (for optional type checking)

### Setup

```bash
# Install dev dependencies for TypeScript type checking
npm install
```

**Note:** Extensions are loaded directly by pi using [jiti](https://github.com/unjs/jiti) - no compilation required. The `package.json` and `tsconfig.json` are only for IDE support and type checking.

### Creating New Extensions

1. Add a new `.ts` file to `.pi/extensions/`
2. Export a default function that accepts `ExtensionAPI`:

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

3. Restart pi to load the new extension

### Type Checking

```bash
npx tsc --noEmit
```

## Project Structure

```
pi_playground/
├── .pi/
│   ├── extensions/      # Auto-discovered extensions
│   │   └── handoff.ts   # Context transfer command
│   └── todos/           # Pi todos storage
├── package.json         # Dev dependencies for TypeScript
├── tsconfig.json        # TypeScript configuration
└── README.md            # This file
```

## Resources

- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)
- [pi documentation](https://github.com/mariozechner/pi-coding-agent/tree/main/docs)
- [Extension examples](https://github.com/mariozechner/pi-coding-agent/tree/main/examples/extensions)
