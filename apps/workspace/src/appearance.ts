import type { Preferences } from "../shared/preferences";

export const palettes = [
  {
    id: "cobalt",
    label: "Cobalt",
    color: "#4655ce",
    description: "Indigo & apricot",
  },
  {
    id: "lagoon",
    label: "Lagoon",
    color: "#087c80",
    description: "Turquoise & coral",
  },
  {
    id: "sunset",
    label: "Sunset",
    color: "#b94732",
    description: "Terracotta & lilac",
  },
  {
    id: "forest",
    label: "Forest",
    color: "#16714e",
    description: "Evergreen & mint",
  },
  { id: "ocean", label: "Ocean", color: "#096b96", description: "Blue & sky" },
  {
    id: "violet",
    label: "Violet",
    color: "#6941c6",
    description: "Purple & lilac",
  },
  { id: "rose", label: "Rose", color: "#a52d59", description: "Berry & blush" },
  { id: "amber", label: "Amber", color: "#916006", description: "Gold & sand" },
  {
    id: "slate",
    label: "Slate",
    color: "#475569",
    description: "Graphite & silver",
  },
] as const;

export function applyAppearance(preferences: Preferences) {
  const root = document.documentElement;
  root.dataset.theme =
    preferences.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preferences.theme;
  root.dataset.accent = preferences.accent;
  root.dataset.contrast = preferences.contrast;
  root.dataset.textSize = preferences.textSize;
  root.dataset.compact = String(preferences.compact);
  root.dataset.navigation = preferences.navigation;
  root.dataset.corners = preferences.corners;
  root.dataset.reducedMotion = String(preferences.reducedMotion);
  root.dataset.artwork = preferences.artwork;
  root.dataset.depth = String(preferences.depth);
  const tokens = [
    "--accent",
    "--accent-hover",
    "--accent-soft",
    "--accent-deep",
    "--accent-text",
    "--on-accent",
    "--scene-color",
    "--scene-light",
  ];
  for (const token of tokens) root.style.removeProperty(token);
  if (preferences.accent === "custom") {
    const dark = root.dataset.theme === "dark";
    const color = preferences.customColor;
    const blend = (target: string, ratio: number) => {
      const channels = [1, 3, 5].map((offset) =>
        Math.round(
          parseInt(color.slice(offset, offset + 2), 16) * (1 - ratio) +
            parseInt(target.slice(offset, offset + 2), 16) * ratio,
        ),
      );
      return (
        "#" +
        channels.map((value) => value.toString(16).padStart(2, "0")).join("")
      );
    };
    const luminance = (hex: string) =>
      [1, 3, 5]
        .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce(
          (sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const contrast = (a: string, b: string) =>
      (Math.max(luminance(a), luminance(b)) + 0.05) /
      (Math.min(luminance(a), luminance(b)) + 0.05);
    const soft = blend(dark ? "#182133" : "#ffffff", dark ? 0.82 : 0.92);
    let foreground = color;
    for (let step = 0; step <= 20 && contrast(foreground, soft) < 7; step++)
      foreground = blend(dark ? "#ffffff" : "#000000", step / 20);
    const backgroundForeground =
      contrast(color, "#ffffff") >= contrast(color, "#000000")
        ? "#ffffff"
        : "#000000";
    const values = [
      color,
      blend(backgroundForeground === "#ffffff" ? "#000000" : "#ffffff", 0.12),
      soft,
      blend("#101620", 0.68),
      foreground,
      backgroundForeground,
      color,
      soft,
    ];
    tokens.forEach((token, index) =>
      root.style.setProperty(token, values[index]),
    );
  }
}
