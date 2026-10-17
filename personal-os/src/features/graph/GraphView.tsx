import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../core/repo/db';
import { ITEM_TYPES } from '../../core/domain/item';
import { tagMap } from '../../core/repo/tagRepo';
import type { Tag } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Empty } from '../../ui/primitives';

/**
 * 关系图谱：节点 = 笔记 / 日程 / 标签，边 = 双链与关联。
 * 力导向布局自己写的（几十 ~ 几百个节点足够，不引 d3）。
 */

interface Node {
  id: string;
  label: string;
  kind: 'note' | 'item' | 'tag';
  color: string;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Edge {
  a: string;
  b: string;
}

const W = 900;
const H = 600;

export function GraphView() {
  const revision = useUI((s) => s.revision);
  const openNote = useUI((s) => s.openNote);
  const openEdit = useUI((s) => s.openEdit);
  const setView = useUI((s) => s.setView);

  const notes = useLiveQuery(() => db.notes.toArray(), [revision]);
  const items = useLiveQuery(() => db.items.toArray(), [revision]);
  const links = useLiveQuery(() => db.links.toArray(), [revision]);
  const [tags, setTags] = useState<Map<string, Tag>>(new Map());
  const [showTags, setShowTags] = useState(true);
  const [isolated, setIsolated] = useState(true);

  useEffect(() => {
    void tagMap().then(setTags);
  }, [revision]);

  const { nodes, edges } = useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];
    const aliveNotes = (notes ?? []).filter((x) => !x.deletedAt);
    const aliveItems = (items ?? []).filter((x) => !x.deletedAt);

    for (const x of aliveNotes) {
      n.push({
        id: `note:${x.id}`,
        label: x.title,
        kind: 'note',
        color: '#5b8cff',
        r: 7,
        x: W / 2 + (Math.random() - 0.5) * 200,
        y: H / 2 + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
      });
    }
    for (const x of aliveItems) {
      n.push({
        id: `item:${x.id}`,
        label: x.title,
        kind: 'item',
        color: ITEM_TYPES[x.type].color,
        r: 6,
        x: W / 2 + (Math.random() - 0.5) * 200,
        y: H / 2 + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
      });
      // 条目 ↔ 笔记 关联
      for (const nid of x.noteIds) e.push({ a: `item:${x.id}`, b: `note:${nid}` });
      // 条目 ↔ 标签
      if (showTags) for (const t of x.tags) e.push({ a: `item:${x.id}`, b: `tag:${t}` });
    }
    for (const x of aliveNotes) {
      if (showTags) for (const t of x.tags) e.push({ a: `note:${x.id}`, b: `tag:${t}` });
    }
    // 双链
    for (const l of links ?? []) {
      if (l.deletedAt) continue;
      e.push({ a: `${l.fromType}:${l.fromId}`, b: `${l.toType}:${l.toId}` });
    }

    // 标签节点（补上被引用的）
    if (showTags) {
      const used = new Set<string>();
      for (const ee of e) {
        if (ee.a.startsWith('tag:')) used.add(ee.a);
        if (ee.b.startsWith('tag:')) used.add(ee.b);
      }
      for (const id of used) {
        const t = tags.get(id.slice(4));
        n.push({
          id,
          label: t?.name ?? '标签',
          kind: 'tag',
          color: '#b06cf0',
          r: 5,
          x: W / 2 + (Math.random() - 0.5) * 260,
          y: H / 2 + (Math.random() - 0.5) * 260,
          vx: 0,
          vy: 0,
        });
      }
    }

    // 只保留存在的节点的边
    const ids = new Set(n.map((x) => x.id));
    const edges2 = e.filter((x) => ids.has(x.a) && ids.has(x.b) && x.a !== x.b);

    let nodes2 = n;
    if (!isolated) {
      const linked = new Set<string>();
      for (const ee of edges2) {
        linked.add(ee.a);
        linked.add(ee.b);
      }
      nodes2 = n.filter((x) => linked.has(x.id));
    }
    return { nodes: nodes2, edges: edges2 };
  }, [notes, items, links, tags, showTags, isolated]);

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex items-end justify-between mb-3">
        <div>
          <h1 className="text-lg font-semibold">关系图谱</h1>
          <p className="text-xs text-fg-dim mt-0.5">
            节点是笔记、日程、标签；连线是双链与关联。纯本地计算，不联网。
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-fg-muted">
            <input type="checkbox" checked={showTags} onChange={(e) => setShowTags(e.target.checked)} />
            显示标签
          </label>
          <label className="flex items-center gap-1.5 text-fg-muted">
            <input type="checkbox" checked={isolated} onChange={(e) => setIsolated(e.target.checked)} />
            显示孤立节点
          </label>
        </div>
      </div>

      {nodes.length === 0 ? (
        <Empty text="还没有可绘制的内容" hint="写几篇笔记并用 [[双链]] 连起来就会出现" />
      ) : (
        <ForceGraph
          nodes={nodes}
          edges={edges}
          onPick={(id) => {
            if (id.startsWith('note:')) {
              setView('notes');
              openNote(id.slice(5));
            } else if (id.startsWith('item:')) {
              openEdit(id.slice(5));
            }
          }}
        />
      )}

      <div className="flex items-center gap-3 mt-2 text-[11px] text-fg-dim">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ background: '#5b8cff' }} /> 笔记
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ background: '#3fb984' }} /> 日程（按类型着色）
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ background: '#b06cf0' }} /> 标签
        </span>
        <span>· 拖动可平移，滚轮缩放</span>
      </div>
    </div>
  );
}

/** 力导向：斥力 + 弹簧 + 向心力，迭代若干次后静止 */
function ForceGraph({
  nodes,
  edges,
  onPick,
}: {
  nodes: Node[];
  edges: Edge[];
  onPick: (id: string) => void;
}) {
  const [state, setState] = useState<{ nodes: Node[]; iter: number }>({ nodes, iter: 0 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // 数据变化时重置
  useEffect(() => {
    setState({ nodes, iter: 0 });
  }, [nodes]);

  // 模拟迭代（最多 300 步，之后静止）
  useEffect(() => {
    if (state.iter >= 300) return;
    const timer = window.setTimeout(() => {
      setState((s) => {
        if (s.iter >= 300) return s;
        const ns = s.nodes.map((n) => ({ ...n }));
        const idx = new Map(ns.map((n, i) => [n.id, i]));

        for (let i = 0; i < ns.length; i += 1) {
          for (let j = i + 1; j < ns.length; j += 1) {
            const a = ns[i];
            const b = ns[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              d2 = 1;
            }
            const d = Math.sqrt(d2);
            const f = 900 / d2;
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }

        for (const e of edges) {
          const ia = idx.get(e.a);
          const ib = idx.get(e.b);
          if (ia === undefined || ib === undefined) continue;
          const a = ns[ia];
          const b = ns[ib];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.max(1, Math.hypot(dx, dy));
          const f = (d - 90) * 0.02;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }

        for (const n of ns) {
          n.vx += (W / 2 - n.x) * 0.004;
          n.vy += (H / 2 - n.y) * 0.004;
          n.vx *= 0.82;
          n.vy *= 0.82;
          n.x += Math.max(-12, Math.min(12, n.vx));
          n.y += Math.max(-12, Math.min(12, n.vy));
          n.x = Math.max(20, Math.min(W - 20, n.x));
          n.y = Math.max(20, Math.min(H - 20, n.y));
        }
        return { nodes: ns, iter: s.iter + 1 };
      });
    }, 16);
    return () => window.clearTimeout(timer);
  }, [state.iter, edges]);

  const idx = useMemo(() => new Map(state.nodes.map((n, i) => [n.id, i])), [state.nodes]);
  const hoverNode = hover ? state.nodes[idx.get(hover) ?? -1] : undefined;

  return (
    <div className="flex-1 min-h-0 card overflow-hidden relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-full"
        onWheel={(e) => {
          const k = view.k * (e.deltaY > 0 ? 0.92 : 1.08);
          setView((v) => ({ ...v, k: Math.max(0.4, Math.min(3, k)) }));
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setView((v) => ({
            ...v,
            x: drag.current!.vx + (e.clientX - drag.current!.x),
            y: drag.current!.vy + (e.clientY - drag.current!.y),
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {edges.map((e, i) => {
            const a = state.nodes[idx.get(e.a) ?? -1];
            const b = state.nodes[idx.get(e.b) ?? -1];
            if (!a || !b) return null;
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#2a3145"
                strokeWidth={0.8}
              />
            );
          })}
          {state.nodes.map((n) => (
            <g
              key={n.id}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover(null)}
              onClick={() => onPick(n.id)}
              style={{ cursor: 'pointer' }}
            >
              <circle cx={n.x} cy={n.y} r={n.r} fill={n.color} opacity={hover === n.id ? 1 : 0.85} />
              {(hover === n.id || n.r > 6) && (
                <text
                  x={n.x}
                  y={n.y - n.r - 4}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#e6e9f0"
                >
                  {n.label.length > 14 ? `${n.label.slice(0, 14)}…` : n.label}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>
      {hoverNode && (
        <div className="absolute left-2 bottom-2 card px-2 py-1 text-[11px]">
          {hoverNode.kind === 'note' ? '笔记' : hoverNode.kind === 'item' ? '日程' : '标签'}：
          {hoverNode.label}
        </div>
      )}
    </div>
  );
}
