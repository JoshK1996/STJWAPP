const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.AGENT_API_PORT || 8787);
const DATA_PATH = path.join(__dirname, "..", "data", "mock-school-data.json");

function readData() {
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
}

function auditEntry(actor, action, detail) {
  return {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor,
    action,
    detail,
    at: new Date().toISOString()
  };
}

function writeData(data, actor, action, detail) {
  const next = {
    ...data,
    version: data.version || "0.1.0",
    updated: new Date().toISOString(),
    auditLog: [...(data.auditLog || []), auditEntry(actor, action, detail)]
  };
  fs.writeFileSync(DATA_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function originFor(req) {
  const origin = req.headers.origin || "";
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ? origin : "http://127.0.0.1:5173";
}

function send(req, res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": originFor(req),
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type,x-agent-name",
    "vary": "origin"
  });
  res.end(JSON.stringify(value, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function normalizeStudentPatch(patch) {
  const allowed = [
    "firstName",
    "lastName",
    "grade",
    "homeroom",
    "advisor",
    "status",
    "attendanceRate",
    "tardies",
    "absences",
    "gpa",
    "missingAssignments",
    "behaviorPoints",
    "lunchBalance",
    "family",
    "primaryContact",
    "allergies",
    "activities",
    "notes"
  ];
  return Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
}

const writableCollections = new Set(["calendarItems", "messages", "teacherTasks", "schoolClasses", "accountProfiles"]);

function collectionPayload(body) {
  if (!Array.isArray(body.items)) throw new Error("Expected items array");
  return body.items;
}

function parseCsv(text) {
  const rows = [];
  let cell = "";
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function previewFactsCsv(data, csvText, table) {
  const rows = parseCsv(csvText);
  const existing = new Map((data.students || []).map((student) => [String(student.id).toLowerCase(), student]));
  const nameIndex = new Map((data.students || []).map((student) => [`${student.firstName} ${student.lastName}`.toLowerCase(), student]));
  const mappedRows = rows.map((row, index) => {
    const id = row.id || row.studentId || row["Student ID"] || row["FACTS Student ID"] || "";
    const firstName = row.firstName || row["First Name"] || row.First || "";
    const lastName = row.lastName || row["Last Name"] || row.Last || "";
    const nameKey = `${firstName} ${lastName}`.trim().toLowerCase();
    const match = existing.get(String(id).toLowerCase()) || nameIndex.get(nameKey);
    return {
      row: index + 2,
      action: match ? "update" : "create",
      matchId: match?.id || "",
      id,
      firstName,
      lastName,
      grade: row.grade || row.Grade || "",
      family: row.family || row.Family || "",
      primaryContact: row.primaryContact || row["Primary Contact"] || row.Contact || ""
    };
  });
  return {
    table,
    totalRows: rows.length,
    createCount: mappedRows.filter((row) => row.action === "create").length,
    updateCount: mappedRows.filter((row) => row.action === "update").length,
    columns: rows[0] ? Object.keys(rows[0]) : [],
    rows: mappedRows.slice(0, 25)
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(req, res, 200, { ok: true });
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const actor = String(req.headers["x-agent-name"] || "app");
    const data = readData();

    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(req, res, 200, { ok: true, version: data.version, updated: data.updated });
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      return send(req, res, 200, data);
    }

    if (req.method === "GET" && url.pathname === "/api/export") {
      return send(req, res, 200, data);
    }

    if (req.method === "GET" && url.pathname === "/api/audit") {
      return send(req, res, 200, { auditLog: [...(data.auditLog || [])].reverse().slice(0, 100) });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/collections/")) {
      const collection = decodeURIComponent(url.pathname.replace("/api/collections/", ""));
      if (!writableCollections.has(collection)) return send(req, res, 400, { error: "Collection is not writable" });
      const body = await readBody(req);
      const items = collectionPayload(body);
      const next = writeData({ ...data, [collection]: items }, actor, `${collection}.replace`, body.reason || `${items.length} items`);
      return send(req, res, 200, { items: next[collection], auditLog: next.auditLog, updated: next.updated });
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/students/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/students/", ""));
      const patch = normalizeStudentPatch(await readBody(req));
      let found = false;
      const students = (data.students || []).map((student) => {
        if (student.id !== id) return student;
        found = true;
        return { ...student, ...patch, id };
      });
      if (!found) return send(req, res, 404, { error: "Student not found" });
      const next = writeData({ ...data, students }, actor, "student.patch", id);
      return send(req, res, 200, { student: next.students.find((student) => student.id === id), updated: next.updated });
    }

    if (req.method === "POST" && url.pathname === "/api/attendance/submit") {
      const body = await readBody(req);
      const section = String(body.section || "Class");
      const date = String(body.date || new Date().toISOString().slice(0, 10));
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const submittedRecords = entries.map((entry) => ({
        id: `att-${date}-${entry.studentId}`,
        date,
        studentId: String(entry.studentId),
        code: entry.code || "Present",
        minutesLate: entry.code === "Tardy" ? Number(entry.minutesLate || 0) : 0,
        reason: entry.reason || "",
        excused: entry.code === "Present" || entry.excused === true
      }));
      const byKey = new Map((data.attendanceRecords || []).map((record) => [`${record.date}:${record.studentId}`, record]));
      for (const record of submittedRecords) byKey.set(`${record.date}:${record.studentId}`, record);
      const schoolClasses = (data.schoolClasses || []).map((item) => (
        item.name === section || item.id === body.classId
          ? { ...item, attendanceStatus: "Submitted", submittedAt: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) }
          : item
      ));
      const next = writeData(
        { ...data, attendanceRecords: [...byKey.values()], schoolClasses },
        actor,
        "attendance.submit",
        `${section}: ${submittedRecords.length} records`
      );
      return send(req, res, 200, { records: submittedRecords, schoolClasses: next.schoolClasses, updated: next.updated });
    }

    if (req.method === "POST" && url.pathname === "/api/facts/preview") {
      const body = await readBody(req);
      return send(req, res, 200, previewFactsCsv(data, String(body.csv || ""), String(body.table || "students")));
    }

    return send(req, res, 404, { error: "Not found" });
  } catch (error) {
    return send(req, res, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`School Ops API listening on http://127.0.0.1:${PORT}`);
});
