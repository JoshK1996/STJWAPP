import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppRequest } from "./auth";
import type { Database, Queryable, Row } from "./db";
import { audit, digest, requireCondition, type Actor } from "./security";
import {
  unitChangeInput,
  unitSaveInput,
  type UnitChange,
} from "../shared/organization";

async function access(tx: Queryable, actor: Actor) {
  requireCondition(
    actor.mode === "password",
    403,
    "Password sign-in is required for organization settings.",
  );
  const current = (
    await tx.query(
      "SELECT active,role FROM users WHERE org_id=$1 AND id=$2 FOR SHARE",
      [actor.org_id, actor.id],
    )
  ).rows[0];
  requireCondition(
    current?.active && ["developer", "owner", "admin"].includes(current.role),
    403,
    "Owner or administrator access is required.",
  );
}
async function lock(tx: Queryable, actor: Actor) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "organization-structure:" + actor.org_id,
  ]);
  await access(tx, actor);
}
async function model(tx: Queryable, actor: Actor) {
  const units = (
    await tx.query(
      "SELECT id,name,kind,parent_id,description,version FROM units WHERE org_id=$1 ORDER BY name,id",
      [actor.org_id],
    )
  ).rows;
  const version =
    (
      await tx.query(
        "SELECT version FROM organization_structure_state WHERE org_id=$1",
        [actor.org_id],
      )
    ).rows[0]?.version ?? 0;
  return { units, version };
}
// The hierarchy is organizational metadata. It never expands user_units, roles,
// school-office grants, teacher assignments or agent token scope.
export function validateUnitForest(units: Row[]) {
  requireCondition(
    units.length <= 250,
    409,
    "This workspace supports up to 250 organization units. Contact the developer before expanding further.",
  );
  const byId = new Map(units.map((x) => [x.id, x])),
    names = new Set<string>();
  const paths = new Map<string, string[]>();
  for (const unit of units) {
    const name = unit.name.toLocaleLowerCase("en-US");
    requireCondition(
      !names.has(name),
      409,
      "Choose a unit name that is unique across this organization.",
    );
    names.add(name);
    const seen = new Set<string>(),
      path: string[] = [];
    let current: Row | undefined = unit;
    while (current) {
      requireCondition(
        !seen.has(current.id),
        409,
        "A unit cannot be inside itself or one of its subgroups.",
      );
      seen.add(current.id);
      path.unshift(current.name);
      requireCondition(
        path.length <= 8,
        409,
        "Use no more than eight levels in the organization hierarchy.",
      );
      if (!current.parent_id) break;
      const parent: Row | undefined = byId.get(current.parent_id);
      requireCondition(parent, 400, "Choose a parent in this organization.");
      current = parent;
    }
    paths.set(unit.id, path);
  }
  return paths;
}
function planFor(units: Row[], version: number, input: UnitChange) {
  const before = units.find((x) => x.id === input.id) ?? null;
  requireCondition(
    (before?.version ?? 0) === input.expectedVersion,
    409,
    "This unit changed. Reload before editing.",
  );
  const after = {
    id: input.id,
    name: input.name,
    kind: input.kind,
    parent_id: input.parentId,
    description: input.description,
    version: input.expectedVersion + 1,
  };
  const next = [...units.filter((x) => x.id !== input.id), after];
  const paths = validateUnitForest(next),
    previousPaths = validateUnitForest(units);
  const affected = next
    .filter(
      (x) =>
        JSON.stringify(paths.get(x.id)) !==
        JSON.stringify(previousPaths.get(x.id)),
    )
    .map((x) => ({
      id: x.id,
      beforePath: previousPaths.get(x.id) ?? null,
      afterPath: paths.get(x.id)!,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  requireCondition(
    !before ||
      before.name !== after.name ||
      before.kind !== after.kind ||
      before.parent_id !== after.parent_id ||
      before.description !== after.description,
    400,
    "Change at least one unit detail before saving.",
  );
  const plan = {
    before,
    after,
    affected,
    beforePath: previousPaths.get(input.id) ?? null,
    afterPath: paths.get(input.id)!,
    structureVersion: version,
    reason: input.reason,
    accessPolicy: "explicit_unit_assignments",
  };
  return { ...plan, previewHash: digest(JSON.stringify(plan)) };
}
export async function previewUnit(db: Database, actor: Actor, raw: unknown) {
  const input = unitChangeInput.parse(raw);
  return db.transaction(async (tx) => {
    await lock(tx, actor);
    const state = await model(tx, actor);
    return planFor(state.units, state.version, input);
  });
}
export async function saveUnit(db: Database, actor: Actor, raw: unknown) {
  const input = unitSaveInput.parse(raw),
    commandHash = digest(JSON.stringify(input));
  return db.transaction(async (tx) => {
    await lock(tx, actor);
    const command = (
      await tx.query(
        "SELECT fingerprint,result FROM organization_structure_commands WHERE org_id=$1 AND actor_id=$2 AND command_id=$3",
        [actor.org_id, actor.id, input.commandId],
      )
    ).rows[0];
    if (command) {
      requireCondition(
        command.fingerprint === commandHash,
        409,
        "This command was already used for a different change.",
      );
      return command.result;
    }
    const state = await model(tx, actor),
      change = unitChangeInput.parse({
        id: input.id,
        expectedVersion: input.expectedVersion,
        name: input.name,
        kind: input.kind,
        parentId: input.parentId,
        description: input.description,
        reason: input.reason,
      });
    requireCondition(
      state.version === input.structureVersion,
      409,
      "The organization structure changed. Review a fresh preview.",
    );
    const plan = planFor(state.units, state.version, change);
    requireCondition(
      plan.previewHash === input.previewHash,
      409,
      "Review this exact organization change before saving.",
    );
    const unit = plan.after;
    if (plan.before)
      await tx.query(
        "UPDATE units SET name=$1,kind=$2,parent_id=$3,description=$4,version=$5 WHERE id=$6 AND org_id=$7",
        [
          unit.name,
          unit.kind,
          unit.parent_id,
          unit.description,
          unit.version,
          unit.id,
          actor.org_id,
        ],
      );
    else
      await tx.query(
        "INSERT INTO units(id,org_id,name,kind,parent_id,description,version) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          unit.id,
          actor.org_id,
          unit.name,
          unit.kind,
          unit.parent_id,
          unit.description,
          unit.version,
        ],
      );
    const structureVersion = (
      await tx.query(
        "INSERT INTO organization_structure_state(org_id,version) VALUES($1,1) ON CONFLICT(org_id) DO UPDATE SET version=organization_structure_state.version+1 RETURNING version",
        [actor.org_id],
      )
    ).rows[0].version;
    await tx.query(
      "INSERT INTO organization_structure_history(id,org_id,unit_id,unit_version,structure_version,actor_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        actor.org_id,
        unit.id,
        unit.version,
        structureVersion,
        actor.id,
        JSON.stringify(plan),
      ],
    );
    const result = { unit, structureVersion, accessPolicy: plan.accessPolicy };
    await tx.query(
      "INSERT INTO organization_structure_commands(org_id,actor_id,command_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
      [
        actor.org_id,
        actor.id,
        input.commandId,
        commandHash,
        JSON.stringify(result),
      ],
    );
    await audit(
      tx,
      actor,
      plan.before ? "organization.unit_updated" : "organization.unit_created",
      unit.id,
      {
        unitVersion: unit.version,
        structureVersion,
        previewHash: plan.previewHash,
        affectedUnitIds: plan.affected.map((x) => x.id),
      },
    );
    return result;
  });
}
export function installOrganization(app: Express, db: Database) {
  const actor = (req: any) => (req as AppRequest).actor;
  app.get("/api/organization/structure", async (req, res) => {
    res.json(
      await db.transaction(async (tx) => {
        const who = actor(req);
        await lock(tx, who);
        const state = await model(tx, who),
          paths = validateUnitForest(state.units);
        const counts = (
          await tx.query(
            "SELECT n.id,(SELECT count(*)::integer FROM user_units m JOIN users u ON u.id=m.user_id AND u.active WHERE m.unit_id=n.id) AS staff_count,(SELECT count(*)::integer FROM jobs j WHERE j.unit_id=n.id AND j.active) AS job_count FROM units n WHERE n.org_id=$1",
            [who.org_id],
          )
        ).rows;
        return {
          ...state,
          units: state.units.map((x) => ({
            ...x,
            path: paths.get(x.id),
            ...counts.find((c) => c.id === x.id),
          })),
          accessPolicy: "explicit_unit_assignments",
          limits: { units: 250, depth: 8 },
        };
      }),
    );
  });
  app.post("/api/organization/units/preview", async (req, res) =>
    res.json(await previewUnit(db, actor(req), req.body)),
  );
  app.post("/api/organization/units/save", async (req, res) =>
    res.json(await saveUnit(db, actor(req), req.body)),
  );
  app.get("/api/organization/units/:id/history", async (req, res) => {
    const who = actor(req),
      id = z.uuid().parse(req.params.id);
    res.json(
      await db.transaction(async (tx) => {
        await access(tx, who);
        requireCondition(
          (
            await tx.query("SELECT id FROM units WHERE id=$1 AND org_id=$2", [
              id,
              who.org_id,
            ])
          ).rows.length,
          404,
          "Unit not found.",
        );
        return {
          rows: (
            await tx.query(
              "SELECT h.*,u.name AS actor_name FROM organization_structure_history h JOIN users u ON u.id=h.actor_id WHERE h.org_id=$1 AND h.unit_id=$2 ORDER BY h.unit_version DESC LIMIT 100",
              [who.org_id, id],
            )
          ).rows,
        };
      }),
    );
  });
}
