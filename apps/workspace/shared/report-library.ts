import { attendanceReportColumns } from "./attendance-reports";
import { z } from "zod";
import { dateOnly } from "./contracts";

export const reportSources = [
  "workforce",
  "care",
  "grades",
  "attendance",
  "finance",
  "compensation",
] as const;
export type ReportSource = (typeof reportSources)[number];
export type ReportColumn = { key: string; label: string };
const columns = (items: string[][]): ReportColumn[] =>
  items.map(([key, label]) => ({ key, label }));
export const sourceCatalog = {
  compensation: {
    label: "Employee pay rates",
    detail: "Recorded rates effective during the selected dates. Owner, administrator or finance access required.",
    columns: columns([
      ["employee_name", "Employee"], ["unit_name", "Community"], ["job_title", "Job"],
      ["amount", "Rate amount"], ["currency", "Currency"], ["basis", "Rate basis"],
      ["starts_on", "Effective from"], ["ends_on", "Effective through"],
      ["voided", "Voided"], ["record_version", "Pay record version"],
      ["record_id", "Pay record ID"], ["rate_id", "Rate entry ID"],
      ["employee_email", "Employee email"], ["employee_active", "Employee active now"],
      ["job_active", "Job active now"], ["assigned", "Job assigned now"],
      ["record_updated_at", "Record updated (UTC)"], ["note", "Rate note"],
      ["user_id", "Employee ID"], ["job_id", "Job ID"], ["unit_id", "Community ID"],
    ]),
    groups: columns([["employee", "Employee"], ["unit", "Community"], ["job", "Job"], ["currency", "Currency"], ["basis", "Rate basis"]]),
  },
  finance: {
    label: "Financial report",
    detail:
      "One published source version, with exact amounts and retained import evidence.",
    columns: columns([
      ["line_code", "Line code"],
      ["line_label", "Line"],
      ["group", "Source group"],
      ["row_kind", "Row kind"],
      ["amount", "Amount"],
      ["currency", "Currency"],
      ["report_title", "Source report"],
      ["report_version", "Source version"],
      ["period_from", "Period from"],
      ["period_through", "Period through"],
      ["note", "Source line note"],
    ]),
    groups: columns([
      ["group", "Source group"],
      ["line", "Line"],
    ]),
  },
  workforce: {
    label: "Employee time",
    detail: "Current shift revisions, with exact work and break durations.",
    columns: columns([
      ["employee_name", "Employee"],
      ["unit_name", "Community"],
      ["job_title", "Job"],
      ["kind", "Work / break"],
      ["started_at", "Started at (UTC)"],
      ["ended_at", "Ended at (UTC)"],
      ["duration_ms", "Duration (milliseconds)"],
      ["shift_id", "Shift ID"],
      ["id", "Segment ID"],
      ["revision", "Shift revision"],
    ]),
    groups: columns([
      ["employee", "Employee"],
      ["unit", "Community"],
      ["job", "Job"],
      ["kind", "Work / break"],
    ]),
  },
  care: {
    label: "Childcare time",
    detail:
      "Child attendance sessions and recorded handoff evidence. School office access required.",
    columns: columns([
      ["student_name", "Child"],
      ["student_number", "Student number"],
      ["program_name", "Program"],
      ["room", "Room"],
      ["checked_in_at", "Arrived at (UTC)"],
      ["checked_out_at", "Departed at (UTC)"],
      ["duration_ms", "Duration in range (milliseconds)"],
      ["status", "Session status"],
      ["arrival_name", "Arriving adult"],
      ["pickup_name", "Collecting adult"],
      ["entered_by", "Receiving staff"],
      ["released_by", "Releasing staff"],
      ["identity_method", "Identity check"],
      ["release_note", "Release note"],
      ["id", "Session ID"],
      ["student_id", "Student ID"],
      ["program_version", "Program version"],
    ]),
    groups: columns([
      ["student", "Child"],
      ["status", "Session status"],
    ]),
  },
  attendance: {
    label: "School attendance",
    detail:
      "Submitted class-period marks with original code snapshots, source revisions and current roster indicators.",
    columns: attendanceReportColumns,
    groups: columns([
      ["student", "Student"],
      ["class", "Class"],
      ["category", "Recorded category"],
      ["date", "Date"],
    ]),
  },
  grades: {
    label: "Class grades",
    detail:
      "Current results for one class and term, with grading and roster status.",
    columns: columns([
      ["student_name", "Student"],
      ["student_number", "Student number"],
      ["class_name", "Class"],
      ["term", "Term"],
      ["percentage", "Percentage"],
      ["grade", "Grade"],
      ["pending", "Pending scores"],
      ["missing", "Missing scores"],
      ["incomplete", "Incomplete"],
      ["provisional", "Provisional"],
      ["book_status", "Gradebook status"],
      ["book_version", "Gradebook version"],
      ["policy_version", "Policy version"],
      ["roster_current", "Roster current"],
      ["student_id", "Student ID"],
      ["book_id", "Gradebook ID"],
    ]),
    groups: columns([
      ["grade", "Grade"],
      ["status", "Result status"],
    ]),
  },
} satisfies Record<
  ReportSource,
  {
    label: string;
    detail: string;
    columns: ReportColumn[];
    groups: ReportColumn[];
  }
>;
export const dateWindow = z.discriminatedUnion("preset", [
  z
    .object({
      preset: z.enum([
        "today",
        "this_week",
        "this_month",
        "this_year",
        "last_month",
      ]),
    })
    .strict(),
  z
    .object({ preset: z.literal("custom"), from: dateOnly, to: dateOnly })
    .strict()
    .refine((x) => x.to >= x.from, "End date must follow start date."),
]);
const common = {
  columns: z
    .array(z.string().min(1).max(50))
    .min(1)
    .max(25)
    .refine((x) => new Set(x).size === x.length, "Choose each column once."),
  layout: z.enum(["details", "summary"]),
  groupBy: z.string().max(30),
  sort: z
    .object({ key: z.string().max(50), direction: z.enum(["asc", "desc"]) })
    .strict(),
};
/** Frozen legacy definition semantics: absence of precisionVersion stays absent. */
export const reportDefinitionV1 = z
  .discriminatedUnion("source", [
    z.object({
      ...common, source: z.literal("compensation"), range: dateWindow,
      unitId: z.uuid().optional(), includeVoided: z.boolean(),
    }).strict(),
    z
      .object({
        ...common,
        source: z.literal("finance"),
        unitId: z.uuid(),
        financialReportId: z.uuid(),
        financialVersion: z.number().int().positive(),
        rowKinds: z.enum(["detail", "all"]),
      })
      .strict(),
    z
      .object({
        ...common,
        source: z.literal("workforce"),
        range: dateWindow,
        unitId: z.uuid().optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        source: z.literal("care"),
        range: dateWindow,
        programId: z.uuid(),
      })
      .strict(),
    z
      .object({
        ...common,
        source: z.literal("attendance"),
        unitId: z.uuid(),
        yearId: z.uuid(),
        period: z.string().trim().min(1).max(40),
        sectionIds: z
          .array(z.uuid())
          .max(50)
          .default([])
          .refine(
            (x) => new Set(x).size === x.length,
            "Choose each class once.",
          ),
        studentNumber: z.string().trim().max(40).default(""),
        range: dateWindow,
      })
      .strict(),
    z
      .object({ ...common, source: z.literal("grades"), bookId: z.uuid() })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (
      value.source === "finance" &&
      value.layout === "summary" &&
      value.rowKinds !== "detail"
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Financial summaries use detail lines only to avoid counting imported totals twice.",
      });
    const catalog = sourceCatalog[value.source];
    if (value.columns.some((k) => !catalog.columns.some((c) => c.key === k)))
      ctx.addIssue({
        code: "custom",
        message: "Choose supported columns for this report.",
      });
    if (!catalog.groups.some((g) => g.key === value.groupBy))
      ctx.addIssue({ code: "custom", message: "Choose a supported grouping." });
    if (!outputColumnsV1(value).some((c) => c.key === value.sort.key))
      ctx.addIssue({
        code: "custom",
        message: "Sort by a column included in the report.",
      });
  });
export function outputColumnsV1(value: {
  source: ReportSource;
  layout: string;
  columns: string[];
}): ReportColumn[] {
  if (value.layout === "summary")
    return columns([
      ["group_name", "Group"],
      ["group_id", "Group ID"],
      ["record_count", "Records"],
      ...(["grades", "attendance", "finance", "compensation"].includes(value.source)
        ? []
        : [["duration_ms", "Duration (milliseconds)"]]),
      ...(value.source === "workforce"
        ? [
            ["work_ms", "Work (milliseconds)"],
            ["break_ms", "Break (milliseconds)"],
          ]
        : []),
      ...(value.source === "finance"
        ? [
            ["amount", "Detail amount"],
            ["currency", "Currency"],
          ]
        : []),
    ]);
  return value.columns
    .map((k) => sourceCatalog[value.source].columns.find((c) => c.key === k)!)
    .filter(Boolean);
}

export const workforceV2Catalog = {
  label: "Employee time (microseconds)",
  detail: "Exact recorded UTC boundaries and contributions clipped to the selected dates and source observation.",
  columns: columns([
    ["employee_name", "Employee"], ["unit_name", "Community"], ["job_title", "Job"], ["kind", "Work / break"],
    ["started_at", "Recorded start (UTC)"], ["ended_at", "Recorded end (UTC)"],
    ["duration_microseconds", "Duration in range (microseconds)"], ["recorded_duration_microseconds", "Recorded duration (microseconds)"],
    ["clipped_started_at", "Contribution start (UTC)"], ["clipped_ended_at", "Contribution end (UTC)"],
    ["shift_id", "Shift ID"], ["id", "Segment ID"], ["revision", "Shift revision"],
  ]),
  groups: sourceCatalog.workforce.groups,
};
export function outputColumnsV2(value: { layout: string; columns: string[] }): ReportColumn[] {
  if (value.layout === "summary") return columns([
    ["group_name", "Group"], ["group_id", "Group ID"], ["record_count", "Records"],
    ["duration_microseconds", "Duration in range (microseconds)"], ["work_microseconds", "Work in range (microseconds)"], ["break_microseconds", "Break in range (microseconds)"],
  ]);
  return value.columns.map(key => workforceV2Catalog.columns.find(column => column.key === key)!).filter(Boolean);
}
export const workforceReportDefinitionV2 = z.object({
  ...common, source: z.literal("workforce"), precisionVersion: z.literal(2), range: dateWindow, unitId: z.uuid().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.columns.some(key => !workforceV2Catalog.columns.some(column => column.key === key))) ctx.addIssue({code:"custom",message:"Choose supported microsecond columns for this report."});
  if (!workforceV2Catalog.groups.some(group => group.key === value.groupBy)) ctx.addIssue({code:"custom",message:"Choose a supported grouping."});
  if (!outputColumnsV2(value).some(column => column.key === value.sort.key)) ctx.addIssue({code:"custom",message:"Sort by a column included in the report."});
});
export const reportDefinition = z.union([reportDefinitionV1, workforceReportDefinitionV2]);
export type ReportDefinition = z.infer<typeof reportDefinition>;
export function outputColumns(value: {source: ReportSource; layout: string; columns: string[]; precisionVersion?: 2}): ReportColumn[] {
  return value.source === "workforce" && value.precisionVersion === 2 ? outputColumnsV2(value) : outputColumnsV1(value);
}
export function initialWorkforceDefinitionV2(): z.infer<typeof workforceReportDefinitionV2> {
  return {source:"workforce",precisionVersion:2,range:{preset:"this_week"},columns:workforceV2Catalog.columns.slice(0,7).map(column=>column.key),layout:"details",groupBy:"employee",sort:{key:"employee_name",direction:"asc"}};
}
export const saveReportInput = z
  .object({
    id: z.uuid(),
    version: z.number().int().nonnegative(),
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500),
    definition: reportDefinition,
    archived: z.boolean(),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export function initialDefinition(source: ReportSource): ReportDefinition {
  const common = {
    source,
    columns: sourceCatalog[source].columns.slice(0, 7).map((c) => c.key),
    layout: "details" as const,
    groupBy: sourceCatalog[source].groups[0].key,
    sort: {
      key: sourceCatalog[source].columns[0].key,
      direction: "asc" as const,
    },
  };
  if (source === "workforce")
    return { ...common, source, range: { preset: "this_week" } };
  if (source === "compensation")
    return { ...common, source, columns: sourceCatalog.compensation.columns.slice(0,12).map(c=>c.key), range: { preset: "today" }, includeVoided: false };
  if (source === "finance")
    return {
      ...common,
      source,
      unitId: "",
      financialReportId: "",
      financialVersion: 1,
      rowKinds: "detail",
    };
  if (source === "care")
    return {
      ...common,
      source,
      range: { preset: "this_month" },
      programId: "",
    };
  if (source === "attendance")
    return {
      ...common,
      source,
      unitId: "",
      yearId: "",
      period: "",
      sectionIds: [],
      studentNumber: "",
      range: { preset: "this_month" },
    };
  return { ...common, source, bookId: "" };
}
