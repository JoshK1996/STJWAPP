import { z } from "zod";
import { dateOnly } from "./contracts";
const version = z.number().int().positive(),
  reason = z.string().trim().min(10).max(2000);
export const gradingPolicySchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    calculation: z.enum(["total_points", "category_weighted"]),
    missing: z.enum(["zero", "exclude"]),
    emptyCategories: z.enum(["renormalize", "incomplete"]),
    allowExtraCredit: z.boolean(),
    capAt100: z.boolean(),
    decimals: z.number().int().min(0).max(2),
    rounding: z.enum(["nearest", "floor"]),
    categories: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().trim().min(1).max(60),
            weight: z.number().int().min(0).max(10000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    scale: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(20),
            minimum: z.number().int().min(0).max(10000),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (
      new Set(policy.categories.map((row) => row.id)).size !==
        policy.categories.length ||
      new Set(policy.categories.map((row) => row.name.toLowerCase())).size !==
        policy.categories.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Categories must have unique identities and names.",
      });
    if (
      policy.calculation === "category_weighted" &&
      (policy.categories.some((row) => row.weight === 0) ||
        policy.categories.reduce((sum, row) => sum + row.weight, 0) !== 10000)
    )
      ctx.addIssue({
        code: "custom",
        message: "Category weights must be positive and total 100%.",
      });
    if (
      policy.scale.length &&
      (policy.scale.at(-1)!.minimum !== 0 ||
        policy.scale.some(
          (row, index) =>
            index > 0 && row.minimum >= policy.scale[index - 1].minimum,
        ) ||
        new Set(policy.scale.map((row) => row.label)).size !==
          policy.scale.length)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Use unique grade labels with strictly descending thresholds ending at zero.",
      });
  });
export const gradingSettingsInput = z
  .object({
    unitId: z.uuid(),
    version: z.number().int().nonnegative(),
    confirmed: z.boolean(),
    policy: gradingPolicySchema,
    reason,
  })
  .strict();
export const gradebookOpenInput = z
  .object({ sectionId: z.uuid(), termId: z.uuid() })
  .strict();
export const gradeAssignmentInput = z
  .object({
    bookId: z.uuid(),
    bookVersion: version,
    commandId: z.uuid(),
    title: z.string().trim().min(2).max(150),
    instructions: z.string().trim().max(8000),
    categoryId: z.uuid(),
    dueOn: dateOnly,
    maxPointsUnits: z.number().int().min(1).max(1000000),
  })
  .strict();
export const gradeAssignmentEditInput = gradeAssignmentInput
  .omit({ bookId: true, commandId: true })
  .extend({ version, archived: z.boolean(), reason })
  .strict();
export const scoreStatuses = [
  "ungraded",
  "scored",
  "missing",
  "exempt",
  "incomplete",
] as const;
export const gradeScoreInput = z
  .object({
    studentId: z.uuid(),
    status: z.enum(scoreStatuses),
    pointsUnits: z.number().int().min(0).max(1000000).nullable(),
    note: z.string().trim().max(1000),
  })
  .strict()
  .refine(
    (row) => (row.status === "scored") === (row.pointsUnits !== null),
    "Enter points only for a scored assignment.",
  );
export const gradeScoresInput = z
  .object({
    version,
    bookVersion: version,
    scores: z.array(gradeScoreInput).max(200),
    reason: z.string().trim().min(5).max(2000),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.scores.map((row) => row.studentId)).size ===
      input.scores.length,
    "Each student must appear once.",
  );
export const gradebookReviewInput = z
  .object({
    version,
    action: z.enum(["submit", "lock", "reopen"]),
    acknowledgeMissing: z.boolean().default(false),
    acknowledgeNoGrade: z.boolean().default(false),
    reason,
  })
  .strict();
export const gradebookReconcileInput = z.object({ version, reason }).strict();
export type GradingPolicy = z.infer<typeof gradingPolicySchema>;
export type GradeContribution = {
  categoryId: string;
  maxPointsUnits: number;
  status: (typeof scoreStatuses)[number];
  pointsUnits: number | null;
};

// Exact rational arithmetic keeps category weighting and threshold comparisons
// independent of display rounding. No AI participates in grade calculation.
type Fraction = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
function fraction(n: bigint, d: bigint): Fraction {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
function add(a: Fraction, b: Fraction): Fraction {
  return fraction(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function calculateGrade(
  policy: GradingPolicy,
  entries: GradeContribution[],
) {
  const categories = policy.categories.map((category) => {
    const rows = entries.filter((row) => row.categoryId === category.id);
    let earned = 0n,
      possible = 0n;
    for (const row of rows)
      if (
        row.status === "scored" ||
        (row.status === "missing" && policy.missing === "zero")
      ) {
        earned += BigInt(row.pointsUnits ?? 0);
        possible += BigInt(row.maxPointsUnits);
      }
    return { ...category, earned, possible };
  });
  let ratio: Fraction | null = null;
  const usable = categories.filter((row) => row.possible > 0n);
  const pending = entries.filter(
    (row) => row.status === "ungraded" || row.status === "incomplete",
  ).length;
  const missing = entries.filter((row) => row.status === "missing").length;
  const incomplete =
    entries.some((row) => row.status === "incomplete") ||
    (policy.calculation === "category_weighted" &&
      policy.emptyCategories === "incomplete" &&
      usable.length < categories.length);
  if (usable.length) {
    if (policy.calculation === "total_points")
      ratio = fraction(
        usable.reduce((sum, row) => sum + row.earned, 0n),
        usable.reduce((sum, row) => sum + row.possible, 0n),
      );
    else {
      const weight = usable.reduce((sum, row) => sum + BigInt(row.weight), 0n);
      ratio = usable.reduce(
        (sum, row) =>
          add(
            sum,
            fraction(row.earned * BigInt(row.weight), row.possible * weight),
          ),
        { n: 0n, d: 1n },
      );
    }
  }
  if (ratio && policy.capAt100 && ratio.n > ratio.d) ratio = { n: 1n, d: 1n };
  let percentage: string | null = null,
    label: string | null = null;
  if (ratio && !incomplete) {
    const multiplier = 10n ** BigInt(policy.decimals),
      numerator = ratio.n * 100n * multiplier;
    const rounded =
      policy.rounding === "nearest"
        ? (numerator * 2n + ratio.d) / (2n * ratio.d)
        : numerator / ratio.d;
    const raw = rounded.toString().padStart(policy.decimals + 1, "0");
    percentage = policy.decimals
      ? raw.slice(0, -policy.decimals) + "." + raw.slice(-policy.decimals)
      : raw;
    label =
      policy.scale.find(
        (band) => ratio!.n * 10000n >= BigInt(band.minimum) * ratio!.d,
      )?.label ?? null;
  }
  return {
    percentage,
    label,
    pending,
    missing,
    incomplete,
    hasEvidence: entries.length > 0,
    provisional: pending > 0,
    categoryTotals: categories.map((row) => ({
      id: row.id,
      name: row.name,
      earnedUnits: Number(row.earned),
      possibleUnits: Number(row.possible),
      weight: row.weight,
    })),
  };
}
