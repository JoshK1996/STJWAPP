import { z } from "zod";

export const dashboardWidgets = [
  {
    id: "metrics",
    label: "At a glance",
    description: "Clock status, recorded hours, requests, and schedules.",
  },
  {
    id: "clock",
    label: "My time clock",
    description: "Clock in, change jobs, and take a break.",
  },
  {
    id: "people",
    label: "People & activity",
    description: "Your permitted live staff board or personal work summary.",
  },
  {
    id: "requests",
    label: "Requests to review",
    description: "Pending time-off and adjustment requests.",
  },
  {
    id: "hours",
    label: "Recorded hours",
    description: "Your weekly hours chart.",
  },
  {
    id: "community",
    label: "School & community",
    description: "Workspace information and planned capabilities.",
  },
] as const;
export const widgetIds = [
  "metrics",
  "clock",
  "people",
  "requests",
  "hours",
  "community",
] as const;
const widgetSchema = z.enum(widgetIds);
export const workspaceNavigationIds = [
  "overview", "clock", "time-records", "payroll", "staff", "schedule",
  "calendar", "messages", "requests", "reports",
] as const;
export const organizationNavigationIds = [
  "school", "care", "dismissal", "workspace", "audit", "settings",
] as const;
export type WorkspaceNavigationId = (typeof workspaceNavigationIds)[number];
export type OrganizationNavigationId = (typeof organizationNavigationIds)[number];

// Keep legacy validation/defaulting separate: an old saved object must not lose
// its existing choices merely because a new navigation field needs repair.
const legacyPreferencesSchema = z
  .object({
    theme: z.enum(["light", "dark", "system"]).default("system"),
    accent: z
      .enum([
        "cobalt",
        "lagoon",
        "sunset",
        "forest",
        "ocean",
        "violet",
        "rose",
        "amber",
        "slate",
        "custom",
      ])
      .default("cobalt"),
    customColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Choose a six-digit hex color.")
      .default("#5260e8"),
    artwork: z.enum(["full", "subtle", "none"]).default("full"),
    depth: z.boolean().default(true),
    contrast: z.enum(["standard", "high"]).default("standard"),
    textSize: z.enum(["standard", "large"]).default("standard"),
    compact: z.boolean().default(false),
    navigation: z.enum(["full", "rail"]).default("full"),
    corners: z.enum(["soft", "crisp"]).default("soft"),
    reducedMotion: z.boolean().default(false),
    home: z.enum(["overview", "clock", "reports"]).default("overview"),
    widgetOrder: z
      .array(widgetSchema)
      .length(widgetIds.length)
      .refine(
        (ids) => new Set(ids).size === widgetIds.length,
        "Include each dashboard card exactly once.",
      )
      .default([...widgetIds]),
    hiddenWidgets: z
      .array(widgetSchema)
      .max(widgetIds.length - 1)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "A card cannot be hidden twice.",
      )
      .default([]),
  })
  .strict();
export const preferencesSchema = legacyPreferencesSchema.extend({
  workspaceNavOrder: z.array(z.enum(workspaceNavigationIds))
    .length(workspaceNavigationIds.length)
    .refine(ids => new Set(ids).size === workspaceNavigationIds.length, "Include each workspace menu item exactly once.")
    .default(() => [...workspaceNavigationIds]),
  organizationNavOrder: z.array(z.enum(organizationNavigationIds))
    .length(organizationNavigationIds.length)
    .refine(ids => new Set(ids).size === organizationNavigationIds.length, "Include each organization menu item exactly once.")
    .default(() => [...organizationNavigationIds]),
}).strict();
// Zod defaults also run inside optional fields. Strip defaults before making a
// PATCH schema so changing one preference cannot reset unrelated saved choices.
export const preferencesPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(preferencesSchema.shape).map(([key, schema]) => [
        key,
        schema.removeDefault().optional(),
      ]),
    ),
  )
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export type WidgetId = (typeof widgetIds)[number];
function storedOrder<T extends string>(value: unknown, defaults: readonly T[]): T[] {
  const allowed = new Set<string>(defaults), seen = new Set<string>(), result: T[] = [];
  for (const candidate of Array.isArray(value) ? value : []) {
    if (typeof candidate === "string" && allowed.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate); result.push(candidate as T);
    }
  }
  for (const id of defaults) if (!seen.has(id)) result.push(id);
  return result;
}
export function normalizePreferences(value: unknown): Preferences {
  const stored = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const { workspaceNavOrder, organizationNavOrder, ...legacy } = stored ?? {};
  const result = legacyPreferencesSchema.safeParse(stored ? legacy : value ?? {});
  return {
    ...(result.success ? result.data : legacyPreferencesSchema.parse({})),
    workspaceNavOrder: storedOrder(workspaceNavOrder, workspaceNavigationIds),
    organizationNavOrder: storedOrder(organizationNavOrder, organizationNavigationIds),
  };
}
