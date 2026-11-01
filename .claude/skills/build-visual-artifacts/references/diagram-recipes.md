# Diagram recipes

Use these patterns only in a compatible project or after verifying the target preview. Check exact props against the installed library. Add the artifact theme and meaningful data labels.

## React Flow

```jsx
import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

export function Workflow({ nodes, edges, theme = 'dark' }) {
  return (
    <div style={{ width: '100%', height: 520, minWidth: 0 }}>
      <ReactFlow nodes={nodes} edges={edges} colorMode={theme} fitView
        nodesDraggable={false} nodesConnectable={false}>
        <Background gap={24} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
```

This is a read-only explanation with navigation. For editing, use controlled state and change handlers. Follow the installed documentation's stylesheet order when using Tailwind. React Flow does not automatically calculate layout: use Dagre or another helper. Account for node dimensions and route directions when translating Dagre centers to React Flow top-left coordinates.

## Nivo Sankey

```jsx
import { ResponsiveSankey } from '@nivo/sankey';

export function QuantityFlow({ data }) {
  return (
    <div style={{ width: '100%', height: 520, minWidth: 0 }}>
      <ResponsiveSankey data={data}
        margin={{ top: 24, right: 140, bottom: 24, left: 140 }}
        nodeThickness={18} nodeSpacing={28}
        theme={{ text: { fill: '#f1f5f9', fontSize: 14 },
          tooltip: { container: { background: '#172033', color: '#f1f5f9' } } }}
      />
    </div>
  );
}
```

Measure width and adjust margins or layout on narrow screens. Add value formatting with units and the installed version's tooltip APIs. Include an accessible exact-value table; do not depend on hover. Parent dimensions must be nonzero at measurement time.

## D3 Sankey with React SVG

```jsx
import { sankey, sankeyLinkHorizontal } from 'd3-sankey';

const layout = sankey().nodeId(d => d.id)
  .nodeWidth(18).nodePadding(28)
  .extent([[120, 24], [width - 120, height - 24]]);
const graph = layout({
  nodes: data.nodes.map(node => ({ ...node })),
  links: data.links.map(link => ({ ...link })),
});
// Render in an SVG with these dimensions:
// graph.links.map(link => <path d={sankeyLinkHorizontal()(link)}
//   fill="none" stroke={color} strokeWidth={link.width} />)
```

Calculate after the container has dimensions. Skip zero-width links visually while retaining them in the table. Use computed width exactly: a minimum-width stroke exaggerates small values. Change opacity or outlines for selection, not encoded quantity. Clone source data before calling the mutating layout.

## Motion

```jsx
import { motion, useReducedMotion } from 'motion/react';

export function Reveal({ children }) {
  const reduceMotion = useReducedMotion();
  return <motion.div initial={reduceMotion ? false : { opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: reduceMotion ? 0 : 0.2 }}>
    {children}
  </motion.div>;
}
```

Mount/key deliberately for stage changes. Avoid remounting a graph if it loses important state. Keep a CSS-only path when the package is unavailable.
