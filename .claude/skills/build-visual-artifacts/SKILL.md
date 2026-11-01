---
name: build-visual-artifacts
description: Create or improve React and HTML visual artifacts, animated diagrams, agent workflows, flowcharts, Sankey flows, interactive architecture explanations, and carousel presentations. Apply readable dark themes, generous spacing, accessible controls, and verified free open-source components. Use for new visual artifacts and visual revisions in Claude Code or Claude Artifacts; honor explicit user styles and existing project design systems.
---

# Build visual artifacts

Create a working, readable artifact with a clear purpose. Default to a dark theme and one active carousel stage for multi-stage explanations. Prefer a single view for one small diagram. Apply these defaults to visual artifacts, not ordinary documents or backend work. Let explicit user requests and established project design systems override these defaults.

## 1. Identify the runtime before choosing imports

- Inspect the current app, package manifest, lockfile, available preview tools, and existing components.
- Distinguish a local React project built with Claude Code from an artifact running inside the Claude.ai preview. A local skill does not change the preview's package list, network permissions, or account settings.
- Read [runtime-and-mcp.md](references/runtime-and-mcp.md) before producing a Claude.ai artifact, adding dependencies, configuring MCP, or installing this skill elsewhere.
- In a normal project, use its package manager and add only the packages the requested view needs. Retain its framework and lockfile.
- In a constrained preview, verify imports with a small render. Do not assume npm installation, arbitrary CDN access, CSS imports, browser storage, or file downloads are supported.
- If a package cannot run there, use React plus scoped CSS and inline SVG for small diagrams. For a complex editable graph, deliver a local React project and explain the preview limitation. Do not replace real data with a decorative approximation.
- Produce one default-exported component for a single-file React artifact. Inline helper components and required styles; remove project-only path aliases. Do not rely on unprovided companion files.

## 2. Select the smallest suitable stack

Read [library-guide.md](references/library-guide.md) for verified repositories, licenses, and setup details. Check current primary documentation when package APIs or compatibility are uncertain.

| Need | Preferred tool | Alternative |
| --- | --- | --- |
| Editable nodes, workflows, architecture, agent graphs | React Flow (`@xyflow/react`) | Inline SVG for a small explanatory graph |
| Automatic directed graph placement | Dagre (`@dagrejs/dagre`) with React Flow | Measured manual layout for a small graph |
| Quantitative Sankey chart | Nivo (`@nivo/sankey`) | `d3-sankey` for custom SVG; Recharts if already available |
| Common dashboard charts | Recharts | Existing project chart system |
| Fully custom visualization | visx plus the required layout helper | Direct SVG |
| Text-maintained flow/sequence/state diagram | Mermaid | React Flow for richer interaction |
| Short transitions and stage changes | Motion (`motion/react`) | CSS with reduced-motion support |
| Panels, buttons, tabs, tooltips, accessible shell | Existing shadcn/ui components | Semantic HTML plus scoped CSS |
| Touch-friendly full-panel carousel | Embla or the existing shadcn carousel | `assets/CarouselShell.jsx` for discrete stages |
| Consistent icons and typography | Lucide + Inter | Existing icons and system sans-serif |

Use free core features. Do not require React Flow Pro, Motion+, paid templates, paid registries, or paid hosted diagram services. Keep licenses and attribution for third-party source copied into the artifact. MCP tools assist development; they are not React rendering dependencies.

## 3. Apply a readable visual system

- Start from `assets/theme.css`; scope styles under the artifact root. In a single-file artifact, embed the CSS in a `<style>` element. Use a visible theme switch when appropriate.
- Use Inter when it is already available or can be bundled legitimately. Otherwise use `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Setting a CSS font name does not install the font.
- Set body text to 16–18 px with line-height 1.5–1.65. Use 14–16 px for diagram labels. Use 12 px only for nonessential metadata. Keep normal text contrast at least 4.5:1 and meaningful graphical controls at least 3:1.
- Use a spacing scale of 8, 12, 16, 24, 32, and 48 px. Give cards 24–32 px padding on desktop and 16–20 px on small screens. Keep paragraphs about 60–75 characters wide.
- Use restrained borders, a small number of semantic colors, and consistent corner radii. Use text or symbols alongside colors. Avoid glowing body text and competing gradients behind dense labels.
- Choose one primary diagram per stage. Keep about 4–8 major nodes in an explanatory overview; split a larger graph into named groups or stages. Allow graph exploration when all nodes must remain available.
- Reserve real space for labels and tooltips. Never shrink an entire graph until labels become unreadable. Use measured layout, wrapping, pan/zoom, or a larger view instead.

## 4. Build a clear carousel when there are several stages

Use `assets/CarouselShell.jsx` as a dependency-light starting point. Use Embla when swipe behavior is needed. Default to named stages such as Overview, Workflow, Flow of values, and Evidence; adapt the names to the actual content.

- Show exactly one primary panel at a time. Do not show neighboring panels as partially visible slides.
- Provide named stage selectors, Previous/Next buttons, a stage count, and a clear active state. Disable boundary buttons. Do not autoplay or wrap around by default.
- Let the panel grow vertically. For long content, use normal vertical scrolling; avoid nested scroll areas and fixed 16:9 slides that crop text.
- Keep controls stable between stages. Preserve stage filters and selected nodes if they matter when the user returns.
- Support keyboard navigation on carousel controls. Do not capture arrow keys used by inputs, sliders, or graph canvases. Provide visible focus and meaningful button names.
- On a touch carousel containing a draggable graph, prevent the two drag handlers from competing. Disable outer swiping over the graph or use explicit stage buttons.

## 5. Make the diagram useful

For workflows:

- Derive topology from supplied implementation or evidence. Label assumptions and unknowns. Do not invent a successful path or precise trace URL.
- Use short verb labels on edges and readable node titles. Distinguish normal, fallback, error, and asynchronous paths using labels plus line style.
- In React Flow, provide its required stylesheet, a parent with explicit dimensions, stable IDs, and `fitView`. Use `colorMode="dark"` or the selected theme. Keep node renderers stable and fit again when an initially hidden slide becomes visible.
- Provide zoom/reset controls and a selected-node details panel for a complex graph. Give important hover details a click or keyboard equivalent.

For Sankey charts:

- Use link width only for a stated nonnegative quantity. Include units, period, source, and a legend. Preserve zero as zero; never add fake minimum values to thicken links.
- Use one mutually exclusive breakdown. Reconcile totals with a documented tolerance. Validate unique IDs, known endpoints, finite nonnegative link values, and the acyclic structure expected by the selected layout.
- Run `python3 <skill-directory>/scripts/validate_sankey.py data.json` when data follows its schema. Read its help for an example. The script reports imbalances; investigate every unapproved imbalance. Intermediate nodes should balance unless accumulation, leakage, or another change is explicitly modeled and explained.
- Do not use negative link widths for losses or credits. Add a clearly labeled adjustment node only when that transformation is valid, or use a waterfall instead.
- Read [diagram-recipes.md](references/diagram-recipes.md). Clone data before passing it to a layout helper that mutates objects. Give responsive charts an explicitly sized, visible parent; remeasure after stage changes.
- Pair the chart with an accessible table or list of exact values. Preserve full labels and units in details.

For animation:

- Use motion to explain a state change, path, or progression. Favor opacity and small transforms; use about 160–240 ms for interface changes and 300–500 ms for a deliberate diagram reveal.
- Animate only the active stage. Avoid continuous motion unless it communicates real behavior; provide pause when continuous animation is needed.
- Honor `prefers-reduced-motion` in CSS and Motion's reduced-motion APIs. Keep labels readable through transitions. Use `motion/react` only when supported; retain `framer-motion` if the runtime provides that package instead.

## 6. Verify and deliver

- Run the project's relevant type check and build. Use browser tools, including Playwright MCP when available, to render the actual result.
- Check at approximately 390, 768, and 1440 px wide, including a narrow artifact panel. Test every stage, boundary button, theme change, graph selection, zoom reset, tooltip, and empty/error state that exists.
- Check keyboard-only use, focus visibility, 200% zoom, long labels, reduced motion, and diagram/data consistency. Check that a chart on a later stage gets dimensions after it is shown.
- Check the console for missing modules and rendering errors. Inspect screenshots to confirm that text, labels, and controls are not clipped or overlapping.
- If browser tools or the target Claude.ai preview are unavailable, say exactly which checks were completed. Never claim that a local browser test proves Claude.ai compatibility or that a skill guarantees perfect output.
- Deliver the runnable artifact or project with dependencies, relevant checks, and remaining runtime limitations. Include sources for factual or financial diagrams and label example data.

## Installation and default behavior

Install this directory as `~/.claude/skills/build-visual-artifacts/` for personal Claude Code use, or `.claude/skills/build-visual-artifacts/` for a repository. The `SKILL.md`, `references`, `assets`, and `scripts` directories are portable; `agents/openai.yaml` is optional metadata for other compatible clients.

Invoke `/build-visual-artifacts` explicitly for reliable selection. For all new visual artifacts, add the short rule from [runtime-and-mcp.md](references/runtime-and-mcp.md) to the applicable `CLAUDE.md`; preserve existing instructions. These preferences guide the agent and do not enforce quality mechanically. Local installation does not upload the skill to Claude.ai or configure its chat interface.
