import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ArrowUpRight, BookOpen, CalendarDays, Sparkles } from "lucide-react";

/** Decorative imagery never carries status, permissions, or actionable data. */
export function WorkspaceArt({
  scene = "day",
  className = "",
  eager = false,
}: {
  scene?: "day" | "community";
  className?: string;
  eager?: boolean;
}) {
  const rig = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const [visible, setVisible] = useState(
    document.documentElement.dataset.artwork !== "none",
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setVisible(root.dataset.artwork !== "none");
      reset();
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-artwork", "data-reduced-motion", "data-depth"],
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, []);
  function reset() {
    cancelAnimationFrame(frame.current);
    rig.current?.style.setProperty("--tilt-x", "0deg");
    rig.current?.style.setProperty("--tilt-y", "0deg");
  }
  function tilt(event: PointerEvent<HTMLDivElement>) {
    const root = document.documentElement;
    if (
      event.pointerType !== "mouse" ||
      root.dataset.depth === "false" ||
      root.dataset.reducedMotion === "true" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(
      -1,
      Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1),
    );
    const y = Math.max(
      -1,
      Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1),
    );
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      rig.current?.style.setProperty("--tilt-x", `${-y * 6}deg`);
      rig.current?.style.setProperty("--tilt-y", `${x * 8}deg`);
    });
  }
  if (!visible) return null;
  return (
    <div
      className={`workspace-art art-${scene} ${className}`}
      aria-hidden="true"
      onPointerMove={tilt}
      onPointerLeave={reset}
    >
      <div className="art-orbit orbit-one" />
      <div className="art-orbit orbit-two" />
      <div className="art-rig" ref={rig}>
        <div className="art-image-layer">
          <img
            src={`/art/stjw-${scene}.webp`}
            alt=""
            width={scene === "day" ? 1254 : 1536}
            height={scene === "day" ? 1254 : 1024}
            decoding="async"
            loading={eager ? "eager" : "lazy"}
            draggable={false}
          />
        </div>
        <div className="art-solid solid-book">
          {["front", "back", "left", "right", "top", "bottom"].map((face) => (
            <span className={`solid-face ${face}`} key={face}>
              {face === "front" && <BookOpen size={24} />}
            </span>
          ))}
        </div>
        <div className="art-solid solid-calendar">
          {["front", "back", "left", "right", "top", "bottom"].map((face) => (
            <span className={`solid-face ${face}`} key={face}>
              {face === "front" && <CalendarDays size={22} />}
            </span>
          ))}
        </div>
        <span className="art-pearl pearl-one" />
        <span className="art-pearl pearl-two" />
      </div>
    </div>
  );
}

export function WorkspaceHero({
  school = false,
  onCustomize,
}: {
  school?: boolean;
  onCustomize: () => void;
}) {
  return (
    <section
      className={`workspace-hero ${school ? "school-hero" : ""}`}
      aria-label={school ? "School community" : "Your connected workspace"}
    >
      <div className="workspace-hero-copy">
        <span className="hero-kicker">
          <Sparkles size={15} />
          {school ? "FAITH. LEARNING. COMMUNITY." : "A LITTLE MORE CONNECTED."}
        </span>
        <h2>
          {school ? (
            <>
              A place to learn.
              <br />
              <em>A community to grow.</em>
            </>
          ) : (
            <>
              Make room for
              <br />
              <em>a brighter day.</em>
            </>
          )}
        </h2>
        <p>
          {school
            ? "Students, families and the people who help them flourish."
            : "Your people, your plans, your time. Bring it all together in a space that feels like you."}
        </p>
        <button className="hero-personalize" onClick={onCustomize}>
          Make this space yours <ArrowUpRight size={16} />
        </button>
      </div>
      <WorkspaceArt scene={school ? "community" : "day"} eager />
      <div className="hero-caption">
        <span />
        {school
          ? "School · Early childhood · Parish"
          : "Made for the people who make a difference."}
      </div>
    </section>
  );
}
