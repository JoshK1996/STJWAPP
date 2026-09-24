import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "./components";
import { api } from "./api";
import { gradingPolicySchema } from "../shared/grading";
const units = (value: string) => {
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw new Error("Use a number with at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};
export { units as gradeUnits };
export const pointText = (value: number) => String(value / 100);
export default function GradingPolicy({
  unitId,
  settings,
  onClose,
  onSaved,
}: {
  unitId: string;
  settings: any;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const original = settings?.policy;
  const [categories, setCategories] = useState<any[]>(
    original?.categories.map((row: any) => ({
      ...row,
      weight: pointText(row.weight),
    })) ?? [{ id: crypto.randomUUID(), name: "", weight: "" }],
  );
  const [scale, setScale] = useState<any[]>(
    original?.scale.map((row: any) => ({
      ...row,
      minimum: pointText(row.minimum),
    })) ?? [],
  );
  const [method, setMethod] = useState(original?.calculation ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const policy = gradingPolicySchema.parse({
        name: data.get("name"),
        calculation: method,
        missing: data.get("missing"),
        emptyCategories: data.get("emptyCategories"),
        allowExtraCredit: data.get("extra") === "yes",
        capAt100: data.get("cap") === "yes",
        rounding: data.get("rounding"),
        decimals: Number(data.get("decimals")),
        categories: categories.map((row) => ({
          ...row,
          weight: method === "category_weighted" ? units(row.weight) : 0,
        })),
        scale: scale.map((row) => ({ ...row, minimum: units(row.minimum) })),
      });
      setBusy(true);
      await api(
        "/school/grading/settings",
        {
          unitId,
          version: settings?.version ?? 0,
          policy,
          confirmed: data.get("confirmed") === "on",
          reason: data.get("reason"),
        },
        "PUT",
      );
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="School grading policy"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="community-form grading-policy-form" onSubmit={submit}>
        <p className="school-notice">
          Configure the school’s actual rules. New gradebooks keep a copy of
          this policy; existing gradebooks retain their original version. No
          school grading scale is assumed.
        </p>
        <label>
          Policy name
          <input
            name="name"
            defaultValue={original?.name ?? ""}
            required
            minLength={3}
            maxLength={120}
            placeholder="Name this school-approved policy"
          />
        </label>
        <div className="community-form-grid">
          <label>
            Calculation method
            <select
              aria-label="Calculation method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              required
            >
              <option value="">Choose a method</option>
              <option value="total_points">
                Total earned points / possible points
              </option>
              <option value="category_weighted">
                Weighted assignment categories
              </option>
            </select>
          </label>
          <label>
            Recorded missing work
            <select
              name="missing"
              defaultValue={original?.missing ?? ""}
              required
            >
              <option value="">Choose a rule</option>
              <option value="zero">Count as zero</option>
              <option value="exclude">Exclude from calculation</option>
            </select>
          </label>
          <label>
            Empty weighted categories
            <select
              name="emptyCategories"
              defaultValue={original?.emptyCategories ?? ""}
              required
            >
              <option value="">Choose a rule</option>
              <option value="renormalize">
                Use weights of populated categories
              </option>
              <option value="incomplete">
                No overall grade until populated
              </option>
            </select>
          </label>
          <label>
            Extra credit
            <select
              name="extra"
              defaultValue={
                original ? (original.allowExtraCredit ? "yes" : "no") : ""
              }
              required
            >
              <option value="">Choose a rule</option>
              <option value="no">Scores cannot exceed possible points</option>
              <option value="yes">Allow scores above possible points</option>
            </select>
          </label>
          <label>
            Overall grade above 100%
            <select
              name="cap"
              defaultValue={original ? (original.capAt100 ? "yes" : "no") : ""}
              required
            >
              <option value="">Choose a rule</option>
              <option value="yes">Cap the overall grade at 100%</option>
              <option value="no">Keep the calculated percentage</option>
            </select>
          </label>
          <label>
            Display rounding
            <select
              name="rounding"
              defaultValue={original?.rounding ?? ""}
              required
            >
              <option value="">Choose a rule</option>
              <option value="nearest">Round to nearest (halves up)</option>
              <option value="floor">Round down</option>
            </select>
          </label>
          <label>
            Displayed decimal places
            <select
              name="decimals"
              defaultValue={original?.decimals ?? ""}
              required
            >
              <option value="">Choose precision</option>
              <option value="0">0</option>
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
          </label>
        </div>
        <fieldset className="grading-editor-group">
          <legend>Assignment categories</legend>
          <p>
            {method === "category_weighted"
              ? "Weights must total exactly 100%."
              : "Categories organize assignments; total points determine the result."}
          </p>
          {categories.map((row, index) => (
            <div className="grading-policy-row" key={row.id}>
              <label>
                Category {index + 1}
                <input
                  aria-label={`Category ${index + 1}`}
                  value={row.name}
                  required
                  maxLength={60}
                  onChange={(e) =>
                    setCategories((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, name: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              {method === "category_weighted" && (
                <label>
                  Weight %
                  <input
                    aria-label={`Category ${index + 1} weight`}
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    required
                    value={row.weight}
                    onChange={(e) =>
                      setCategories((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, weight: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </label>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove category ${index + 1}`}
                disabled={categories.length === 1}
                onClick={() =>
                  setCategories((rows) => rows.filter((_, i) => i !== index))
                }
              >
                <Trash2 size={17} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button secondary small"
            disabled={categories.length >= 20}
            onClick={() =>
              setCategories((rows) => [
                ...rows,
                { id: crypto.randomUUID(), name: "", weight: "" },
              ])
            }
          >
            <Plus size={15} />
            Add category
          </button>
        </fieldset>
        <fieldset className="grading-editor-group">
          <legend>Grade labels (optional)</legend>
          <p>
            Leave empty for numeric percentages only. Otherwise enter thresholds
            from highest to lowest, ending at 0%. Labels use the exact
            calculation before display rounding.
          </p>
          {scale.map((row, index) => (
            <div className="grading-policy-row" key={index}>
              <label>
                Label {index + 1}
                <input
                  aria-label={`Grade label ${index + 1}`}
                  value={row.label}
                  required
                  maxLength={20}
                  onChange={(e) =>
                    setScale((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, label: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Minimum %
                <input
                  aria-label={`Grade threshold ${index + 1}`}
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={row.minimum}
                  required
                  onChange={(e) =>
                    setScale((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, minimum: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove grade label ${index + 1}`}
                onClick={() =>
                  setScale((rows) => rows.filter((_, i) => i !== index))
                }
              >
                <Trash2 size={17} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button secondary small"
            disabled={scale.length >= 20}
            onClick={() =>
              setScale((rows) => [...rows, { label: "", minimum: "" }])
            }
          >
            <Plus size={15} />
            Add grade label
          </button>
        </fieldset>
        <label className="school-toggle">
          <input type="checkbox" name="confirmed" defaultChecked={false} />
          The school has reviewed and confirmed these grading rules.
        </label>
        <label>
          Reason for this policy version
          <textarea name="reason" required minLength={10} maxLength={2000} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save grading policy"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
