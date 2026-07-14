/** Monogram avatar (no external images — keeps the app self-contained). */
export default function Avatar({
  name,
  size = 44,
  online = false,
  ring = true,
}: {
  name: string;
  size?: number;
  online?: boolean;
  ring?: boolean;
}) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: "linear-gradient(140deg, #f4a35f 0%, #e26985 130%)",
        boxShadow: ring ? "0 0 0 3px var(--color-surface)" : undefined,
      }}
      aria-hidden="true"
    >
      {initial}
      {online && (
        <span
          className="pulse-dot absolute bottom-0 right-0 h-3 w-3 rounded-full bg-accent-bright"
          style={{ boxShadow: "0 0 0 2.5px var(--color-surface)" }}
        />
      )}
    </span>
  );
}
