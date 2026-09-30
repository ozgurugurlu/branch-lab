"use client";

import { useId } from "react";
import type { Actor, Relationship, Round } from "@/lib/types";

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("");
}
export function stanceLabel(stance: number) {
  return stance > 0.2
    ? "Supportive"
    : stance < -0.2
      ? "Skeptical"
      : "Undecided";
}

export function ActorNetwork({
  actors,
  relationships,
  selected,
  onSelect,
  preview = false,
}: {
  actors: Actor[];
  relationships: Relationship[];
  selected: string | null;
  onSelect: (id: string) => void;
  preview?: boolean;
}) {
  const patternId = useId().replace(/:/g, "");
  const positions = actors.map((actor, i) => {
    const angle = (i / actors.length) * Math.PI * 2 - Math.PI / 2;
    const outer = i % 2 === 0 ? 1 : 0.79;
    return {
      ...actor,
      x: 400 + Math.cos(angle) * 255 * outer,
      y: 270 + Math.sin(angle) * 187 * outer,
    };
  });
  const byId = new Map(positions.map((p) => [p.id, p]));
  return (
    <svg
      className={`actor-network ${preview ? "network-preview" : ""}`}
      viewBox="0 0 800 560"
      role="group"
      aria-label="Actor relationship network. Select an actor to inspect their perspective."
    >
      <defs>
        <pattern
          id={patternId}
          width="22"
          height="22"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".7" fill="currentColor" opacity=".14" />
        </pattern>
      </defs>
      <rect width="800" height="560" fill={`url(#${patternId})`} />
      <circle cx="400" cy="270" r="212" fill="none" className="orbit" />
      <circle
        cx="400"
        cy="270"
        r="133"
        fill="none"
        className="orbit orbit-inner"
      />
      {relationships.map((rel, i) => {
        const from = byId.get(rel.from),
          to = byId.get(rel.to);
        if (!from || !to) return null;
        const active = selected === from.id || selected === to.id;
        return (
          <path
            key={`${rel.from}-${rel.to}-${i}`}
            d={`M${from.x},${from.y} Q400,270 ${to.x},${to.y}`}
            className={`network-edge ${active ? "is-active" : ""}`}
            strokeWidth={active ? 1.7 : 1}
            opacity={selected && !active ? 0.18 : 0.55}
          >
            <title>
              {from.name} → {to.name}: {rel.label}
            </title>
          </path>
        );
      })}
      <g className="network-center" transform="translate(400 270)">
        <circle r="34" />
        <path d="M-9 13V-12m0 14 19-14M-9 2l19 11" />
        <circle className="center-point" cx="-9" cy="-13" r="3" />
        <circle className="center-point" cx="12" cy="-13" r="3" />
        <circle className="center-point" cx="12" cy="14" r="3" />
      </g>
      {positions.map((actor, index) => (
        <g
          key={actor.id}
          className={`network-actor ${selected === actor.id ? "is-selected" : ""} ${actor.stance < -0.2 ? "is-skeptical" : actor.stance > 0.2 ? "is-supportive" : "is-undecided"}`}
          style={{ animationDelay: `${index * 45}ms` }}
          transform={`translate(${actor.x} ${actor.y})`}
          role="button"
          tabIndex={0}
          aria-label={`${actor.name}, ${actor.role}, ${stanceLabel(actor.stance)}`}
          aria-pressed={selected === actor.id}
          onClick={() => onSelect(actor.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(actor.id);
            }
          }}
        >
          <circle className="actor-halo" r="34" />
          <circle className="actor-face" r="25" />
          <text className="actor-initials" y="5" textAnchor="middle">
            {initials(actor.name)}
          </text>
          <circle className="stance-dot" cx="19" cy="18" r="5" />
          <text className="actor-name" textAnchor="middle" y="47">
            {actor.name}
          </text>
          <text className="actor-role" textAnchor="middle" y="63">
            {actor.role.length > 24
              ? `${actor.role.slice(0, 22)}…`
              : actor.role}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function Trajectory({ rounds }: { rounds: Round[] }) {
  const width = 560,
    height = 75,
    pad = 7;
  const points = rounds.map(
    (round, i) =>
      `${pad + (i / Math.max(1, rounds.length - 1)) * (width - 2 * pad)},${height - pad - (Math.max(0, Math.min(100, round.metrics.support)) / 100) * (height - 2 * pad)}`,
  );
  return (
    <div className="trajectory">
      <div className="trajectory-label">
        <span>Simulated support over time</span>
        <span>
          {rounds.length
            ? `ROUND 01 — ${String(rounds.length).padStart(2, "0")}`
            : "AWAITING FIRST ROUND"}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          rounds.length
            ? `Support by round: ${rounds.map((r) => `${r.number}: ${Math.round(r.metrics.support)}%`).join(", ")}`
            : "Support chart will appear after the first round"
        }
      >
        {[0.25, 0.5, 0.75].map((v) => (
          <line
            key={v}
            x1="0"
            x2={width}
            y1={v * height}
            y2={v * height}
            className="chart-grid"
          />
        ))}
        {points.length > 1 && (
          <polyline points={points.join(" ")} className="chart-line" />
        )}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.split(",")[0]}
            cy={p.split(",")[1]}
            r={i === points.length - 1 ? 3.8 : 2.4}
            className="chart-dot"
          >
            <title>
              Round {rounds[i].number}: {Math.round(rounds[i].metrics.support)}%
              simulated support
            </title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

export const PREVIEW_ACTORS: Actor[] = [
  ["Maya Chen", "Design lead", 0.65],
  ["James Park", "Client partner", -0.6],
  ["Leila Haddad", "People lead", 0.8],
  ["Oliver Reed", "Operations", -0.35],
  ["Sofia Costa", "Product designer", 0.6],
  ["Noah Williams", "Founder", 0.1],
  ["Amara Okafor", "Customer support", -0.15],
  ["Ethan Brooks", "Team lead", 0.35],
].map((a, i) => ({
  id: `preview-${i}`,
  name: a[0] as string,
  role: a[1] as string,
  stance: a[2] as number,
  description: "Illustrative actor",
  goal: "",
  influence: 0.5,
  sourceIds: [],
  memory: [],
}));
export const PREVIEW_RELATIONSHIPS: Relationship[] = PREVIEW_ACTORS.flatMap(
  (actor, i) =>
    [1, 3].map((offset) => ({
      from: actor.id,
      to: PREVIEW_ACTORS[(i + offset) % PREVIEW_ACTORS.length].id,
      label: "Illustrative relationship",
      weight: 0.5,
    })),
);
