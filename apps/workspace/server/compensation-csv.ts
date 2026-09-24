import { parse } from "csv-parse/sync";
import { randomUUID } from "node:crypto";
import {
  compensationCsvColumns,
  compensationRate,
  type CompensationRate,
} from "../shared/compensation";
import { requireCondition, Problem } from "./security";
import { amountText, amountUnits } from "./finance-engine";

export function parseCompensationCsv(
  csv: string,
  context: {
    userId: string;
    jobId: string;
    expectedVersion: number;
    previous: CompensationRate[];
  },
  supplied?: CompensationRate[],
) {
  requireCondition(
    Buffer.byteLength(csv, "utf8") <= 64000,
    400,
    "Pay templates are limited to 64,000 UTF-8 bytes.",
  );
  let data: string[][];
  try {
    data = parse(csv, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 10000,
    }) as string[][];
  } catch {
    throw new Problem(
      400,
      "The pay CSV could not be parsed. Use the editable pay template and consistent columns.",
    );
  }
  requireCondition(
    data.length >= 2 && data.length <= 201,
    400,
    "Include between 1 and 200 pay-rate rows.",
  );
  const headers = data[0].map((x) => x.trim());
  requireCondition(
    headers.length === compensationCsvColumns.length &&
      new Set(headers).size === headers.length &&
      compensationCsvColumns.every((x) => headers.includes(x)),
    400,
    "Use exactly the editable pay template column names.",
  );
  if (supplied)
    requireCondition(
      supplied.length === data.length - 1,
      400,
      "The imported source and proposed rates differ.",
    );
  return data.slice(1).map((values, index) => {
    requireCondition(
      values.length === headers.length,
      400,
      `CSV row ${index + 2} has inconsistent columns.`,
    );
    const row = Object.fromEntries(
      headers.map((k, i) => [k, values[i].trim()]),
    );
    requireCondition(
      row.userId === context.userId &&
        row.jobId === context.jobId &&
        row.recordVersion === String(context.expectedVersion),
      409,
      `CSV row ${index + 2} belongs to a different employee, job or record version. Download its current template.`,
    );
    requireCondition(
      row.voided === "true" || row.voided === "false",
      400,
      `CSV row ${index + 2}: voided must be true or false.`,
    );
    const id = row.rateId || supplied?.[index].id || randomUUID(),
      old = context.previous.find((x) => x.id === id);
    requireCondition(
      row.rateId || !old,
      400,
      "A new CSV row cannot reuse an existing rate identity.",
    );
    let note = row.note;
    if (old && /^[\s]*[=+@\-\t\r\0]/.test(old.note) && note === "'" + old.note)
      note = old.note;
    const result = compensationRate.safeParse({
      id,
      startsOn: row.startsOn,
      endsOn: row.endsOn || null,
      amount: row.amount,
      currency: row.currency,
      basis: row.basis,
      voided: row.voided === "true",
      note,
    });
    requireCondition(
      result.success,
      400,
      `CSV row ${index + 2}: ${result.error?.issues.map((x) => x.message).join(" ") ?? "Invalid rate."}`,
    );
    const rate = {
      ...result.data,
      amount: amountText(amountUnits(result.data.amount)),
    };
    if (supplied) {
      const proposed = {
        ...compensationRate.parse(supplied[index]),
        amount: amountText(amountUnits(supplied[index].amount)),
      };
      requireCondition(
        JSON.stringify(rate) === JSON.stringify(proposed),
        400,
        `CSV row ${index + 2} does not match the proposed rate.`,
      );
    }
    return rate;
  });
}
