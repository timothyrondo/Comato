import type { ReactNode } from "react";

/** Section title with an optional right-aligned action (e.g. "See all"). */
export default function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between px-1">
      <h2 className="text-[17px] font-bold tracking-tight text-ink">{title}</h2>
      {action}
    </div>
  );
}
