# Runtime, installation, and MCP

## Claude Code versus Claude.ai

Claude Code can build a normal local React project with installed dependencies. Its output can be a local preview, bundled HTML, or source component. Creating files does not automatically create or publish an artifact in Claude.ai.

Claude.ai runs artifacts in a managed preview. Test the actual import and required styling there; packages and capabilities can change. A successful npm install elsewhere does not prove preview support. MCP configuration does not add React packages to a preview.

For a single-file React artifact, keep one default export, inline helpers/styles, and supported imports only. For a project, retain its framework, component paths, configuration, and package manager. For offline HTML, bundle JavaScript, styles, and fonts instead of silently relying on CDNs.

## Personal installation

Copy the complete skill directory to `~/.claude/skills/build-visual-artifacts/`. Use `/build-visual-artifacts` in a new local Claude Code session. Repository scope uses `.claude/skills/build-visual-artifacts/`.

To apply the preference to all visual artifacts, append this managed block to `~/.claude/CLAUDE.md`, preserving existing content:

```markdown
<!-- visual-artifacts-default:start -->
For every new or revised visual React/HTML artifact, use the build-visual-artifacts skill. Default to a readable dark theme, generous spacing, accessible interaction, and one active panel for multi-stage carousel explanations. Verify the target runtime before choosing imports. Follow explicit user style requests and existing project design systems. Apply this rule to visual artifacts, not unrelated documents or backend work.
<!-- visual-artifacts-default:end -->
```

The supplied installer adds the block by default and backs up changed files. `--skill-only` skips the block. A local installation does not upload the skill to Claude.ai. Cloud and Cowork sessions load skills differently; use account skill settings or the documented repository mechanism for that environment.

- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/memory
- https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them

## Optional MCP servers

MCP improves documentation lookup, component selection, and testing. The artifact should render without an MCP server after it is built. Do not configure accounts or install servers just because this skill is read. Add them when requested or already authorized for the task.

| Server | Purpose | Free/open-source boundary |
| --- | --- | --- |
| [shadcn MCP](https://ui.shadcn.com/docs/mcp), [source](https://github.com/shadcn-ui/ui) | Find and add components | MIT tool; use the free registry and check third-party licenses. |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Exercise controls, inspect accessibility, and inspect local browser output | Apache-2.0; requires a browser runtime. |
| [Motion AI kit](https://github.com/motiondivision/ai-kit), [setup](https://motion.dev/docs/ai-kit-install) | Official skill and docs/example metadata MCP | MIT installer/skill; free docs server needs no account. Motion+ premium source/tools are separate. |
| [Context7](https://github.com/upstash/context7), [setup](https://context7.com/docs/clients/claude-code) | Current library documentation | MIT repository; hosted authentication and usage limits are separate. Optional for a free local stack. |

For the first two servers, use these user-scope commands based on official stdio setup:

```bash
claude mcp add --scope user shadcn -- npx -y shadcn@latest mcp
claude mcp add --scope user playwright -- npx -y @playwright/mcp@latest
claude mcp list
```

For Motion's free official agent setup:

```bash
npx motion-ai
```

Choose Claude Code and the intended scope. Avoid paid options unless requested. The free docs endpoint is `https://mcp.motion.dev`; use official current setup for manual configuration. Context7's setup page owns its current login and quota requirements; do not invent an API key.

The `@latest` commands follow upstream quick starts. For managed team setup, select a reviewed version and pin it. Existing Node.js/npm and Claude Code are prerequisites. Reopen the session if necessary and use `/mcp` to check connections. No MCP server is required for the design rules or bundled React shell.
