import type { RescueStep, RescueStepState } from "../data/fixtures";

const STATE_STYLE: Record<
  RescueStepState,
  { dot: string; ring: string; badge: string; label: string }
> = {
  active: {
    dot: "bg-accent",
    ring: "ring-accent/25",
    badge: "bg-accent-soft text-accent-ink",
    label: "Active",
  },
  armed: {
    dot: "bg-warn",
    ring: "ring-warn/25",
    badge: "bg-warn/15 text-warn",
    label: "Armed",
  },
  ready: {
    dot: "bg-ink-muted",
    ring: "ring-line",
    badge: "bg-line/70 text-ink-muted",
    label: "Ready",
  },
};

/** Vertical timeline of the rescue playbook, dot + connecting rail per step. */
export default function RescueTimeline({ steps }: { steps: RescueStep[] }) {
  return (
    <ol className="relative">
      {steps.map((step, i) => {
        const s = STATE_STYLE[step.state];
        const isLast = i === steps.length - 1;
        return (
          <li key={step.title} className="relative flex gap-3.5 pb-5 last:pb-0">
            {/* Rail */}
            {!isLast && (
              <span
                aria-hidden
                className="absolute left-[7px] top-5 h-full w-px bg-line"
              />
            )}
            {/* Dot */}
            <span className="relative z-10 mt-1 flex h-3.5 w-3.5 shrink-0">
              <span
                className={
                  "h-3.5 w-3.5 rounded-full ring-4 " + s.dot + " " + s.ring
                }
              />
              {step.state === "active" && (
                <span
                  className={
                    "pulse-dot absolute inset-0 h-3.5 w-3.5 rounded-full " +
                    s.dot
                  }
                />
              )}
            </span>
            {/* Body */}
            <div className="-mt-0.5 min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-[14.5px] font-semibold text-ink">
                  {step.title}
                </h3>
                <span
                  className={
                    "rounded-full px-2 py-0.5 text-[10.5px] font-semibold " +
                    s.badge
                  }
                >
                  {s.label}
                </span>
              </div>
              <p className="mt-0.5 text-[12.5px] leading-snug text-ink-muted">
                {step.detail}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
