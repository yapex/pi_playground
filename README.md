# Pi Playground

A collection of [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) extensions.

## Installation

### From GitHub (Recommended)

```bash
# Install globally
pi install git:github.com/yapex/pi_playground

# Or install to current project
pi install -l git:github.com/yapex/pi_playground
```

### Try without installing

```bash
pi -e git:github.com/yapex/pi_playground
```

### Manual (for development)

Clone this repo and reference it in your `settings.json`:

```json
{
  "packages": ["/path/to/pi_playground"]
}
```

## Extensions

### handoff.ts

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

### Setup

```bash
git clone https://github.com/yapex/pi_playground.git
cd pi_playground
npm install  # For TypeScript type checking
```

**Note:** Extensions are loaded directly by pi using [jiti](https://github.com/unjs/jiti) - no compilation required.

### Project Structure

```
pi_playground/
├── extensions/          # Pi extensions (auto-discovered)
│   └── handoff.ts       # Context transfer command
├── package.json         # Pi manifest + dev dependencies
├── tsconfig.json        # TypeScript configuration
└── README.md            # This file
```

### Adding New Extensions

Add a new `.ts` file to `extensions/`:

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

### Type Checking

```bash
npx tsc --noEmit
```

## Resources

- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)
- [Extension documentation](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/extensions.md)
- [Package documentation](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/packages.md)
