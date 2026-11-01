# Library guide

Verified against primary project sources on 22 October 2026. Check APIs against the actual installed version. These are selected recommendations, not a benchmark ranking or a promise of Claude.ai package availability.

| Library and repository | Package | License | Role and tradeoff |
| --- | --- | --- | --- |
| [React Flow](https://github.com/xyflow/xyflow) | `@xyflow/react` | MIT | Interactive nodes, edges, dragging, pan/zoom, custom workflow cards. Free core is enough; Pro examples/support are separate. |
| [Dagre](https://github.com/dagrejs/dagre) | `@dagrejs/dagre` | MIT | Directed graph node placement. Pair with a renderer; it is not a React component or edge router. |
| [Nivo](https://github.com/plouc/nivo) | `@nivo/sankey` | MIT | High-level React Sankey with themes and interaction. Responsive components require a sized container. |
| [D3 Sankey](https://github.com/d3/d3-sankey) | `d3-sankey` | BSD-3-Clause | Low-level acyclic flow layout. Render output with React/SVG; implement interaction and accessibility. |
| [Recharts](https://github.com/recharts/recharts) | `recharts` | MIT | Familiar React SVG charts; also offers Sankey. Configure text, tooltips, sizing, and colors explicitly. |
| [visx](https://github.com/airbnb/visx) | Selected `@visx/*` packages | MIT | Custom visualization primitives; requires more engineering than Nivo. It is not a complete Sankey layout engine. |
| [Mermaid](https://github.com/mermaid-js/mermaid) | `mermaid` | MIT | Text-defined flowcharts, sequence and state diagrams. JavaScript engine, not a React component library. |
| [Motion](https://github.com/motiondivision/motion) | `motion` | MIT | React entrance, exit, layout, and SVG animation. Import from `motion/react`. Free library is separate from Motion+. |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | Source components via `shadcn` CLI | MIT | Panels, dialogs, tabs, tooltips, buttons, carousels. Added to project source; do not assume `@/components/ui/*` exists in an artifact. |
| [Embla](https://github.com/davidjerleke/embla-carousel) | `embla-carousel-react` | MIT | Touch-friendly carousel engine. Add semantic controls, focus, and reduced-motion behavior. |
| [Lucide](https://github.com/lucide-icons/lucide) | `lucide-react` | ISC | Consistent line icons. Label icon buttons; hide decorative icons from assistive technology. |
| [Inter](https://github.com/rsms/inter) | Font files or a verified font package | SIL OFL 1.1 | Screen-focused font with tabular numerals. Bundle font files and license for offline projects; otherwise use system fonts. |

## Minimal combinations

- Workflow: React + React Flow + Dagre. Add Motion only for necessary transitions.
- Sankey: React + Nivo Sankey. Replace Nivo with D3 Sankey for custom rendering; do not install both by default.
- Narrative: React + existing UI + CSS, or Motion + Embla when supported.
- Constrained preview: React + inline CSS/SVG, using only imports verified there.

## Primary documentation

- React Flow: https://reactflow.dev/learn and https://reactflow.dev/learn/customization/theming
- Nivo Sankey: https://nivo.rocks/sankey/
- Recharts: https://recharts.github.io/
- Motion React: https://motion.dev/docs/react
- shadcn carousel: https://ui.shadcn.com/docs/components/carousel
- Embla React: https://www.embla-carousel.com/get-started/react/
- Mermaid: https://mermaid.js.org/config/theming.html

Dark mode, fonts, and spacing belong to the full artifact design, not just the chart. Retain required notices when redistributing bundled or copied third-party material.
