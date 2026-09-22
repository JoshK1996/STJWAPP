const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const ROOT = path.join(__dirname, "..");
const STUDENT_PDF = path.join(ROOT, "docs", "SchoolData", "Student_Info", "May-2026.pdf");
const CLASS_PDF = path.join(ROOT, "docs", "SchoolData", "ClassList", "Class-List-25-26.pdf");
const DATA_PATH = path.join(ROOT, "data", "mock-school-data.json");

async function pdfText(file) {
  const parser = new PDFParse({ data: fs.readFileSync(file) });
  const result = await parser.getText();
  await parser.destroy();
  return result.text;
}

function clean(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function cleanEmail(value = "") {
  return clean(value).replace(/\s*@\s*/g, "@").replace(/\s*\.\s*/g, ".");
}

function normalizeGrade(value = "") {
  const raw = clean(value).split(/\s+/)[0] || "";
  if (!raw) return "";
  if (/^0\d$/.test(raw)) return String(Number(raw));
  if (/^\d+$/.test(raw)) return String(Number(raw));
  return raw.replace(/^0+/, "") || raw;
}

function splitCells(line = "") {
  return line.split(/\t| {2,}/).map(clean).filter(Boolean);
}

function valueAfter(section, label, stopLabel) {
  if (label !== "Email") {
    const stopRe = new RegExp(stopLabel);
    const labelRe = new RegExp(`^.*?${label}\\s*`);
    const line = section.split(/\r?\n/).find((item) => item.includes(label) && stopRe.test(item));
    if (line) return clean(line.split(stopRe)[0].replace(labelRe, ""));
  }
  const pattern = new RegExp(`${label}\\s+([\\s\\S]*?)\\s+(?:${stopLabel})`);
  const match = section.match(pattern);
  return match ? clean(match[1]) : "";
}

function lineValue(section, label) {
  const match = section.match(new RegExp(`^${label}\\s+(.+)$`, "m"));
  return match ? String(match[1]).trim() : "";
}

function parentValues(parentSection, label) {
  const value = lineValue(parentSection, label);
  return splitCells(value);
}

function parseStudents(text) {
  const blocks = text
    .split(/\n-- \d+ of \d+ --\n/g)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("Student Information"));

  const students = [];
  const guardians = [];
  const accountProfiles = [];
  const timelineEvents = [];

  blocks.forEach((block, index) => {
    const firstName = valueAfter(block, "First Name", "Address");
    const middleName = valueAfter(block, "Middle Name", "City State Zip");
    const lastName = valueAfter(block, "Last Name", "Gender");
    const address = valueAfter(block, "Address", "Enroll Date");
    const cityStateZip = valueAfter(block, "City State Zip", "Withdraw Date");
    const gender = valueAfter(block, "Gender", "Graduation Date");
    const birthdate = valueAfter(block, "Birthdate", "Status");
    const statusRaw = valueAfter(block, "Status", "Enrolled");
    const grade = normalizeGrade(valueAfter(block, "Grade", "Home Phone"));
    const nextYear = normalizeGrade((block.match(/Next Year\s+[\s\S]*?Grade\s+\S+\s+(\S+)/) || [])[1] || "");
    const homePhone = valueAfter(block, "Home Phone", "Primary Lang\\.");
    const studentEmail = cleanEmail(valueAfter(block, "Email", "Citizenship"));
    const religion = clean((block.match(/Religion\s+([\s\S]*?)\nCustodial Parents/) || [])[1] || "");
    const family = lastName.replace(/,.*$/, "");
    const id = `stu-${String(index + 1).padStart(3, "0")}`;
    const parentSection = (block.split("Custodial Parents")[1] || "").split("Additional Emergency Contacts")[0] || "";
    const pFirst = parentValues(parentSection, "First Name");
    const pLast = parentValues(parentSection, "Last Name");
    const pRelation = parentValues(parentSection, "Relation");
    const pHome = parentValues(parentSection, "Home Phone");
    const pCell = parentValues(parentSection, "Cell Phone");
    const pEmailMatches = [...parentSection.matchAll(/[A-Z0-9._%+-]+\s*@\s*[A-Z0-9.-]+\s*\.\s*[A-Z]{2,}/gi)].map((match) => cleanEmail(match[0]));

    const primaryContact = pFirst[0] && pLast[0] ? `${pFirst[0]} ${pLast[0]}` : "";
    students.push({
      id,
      firstName,
      lastName,
      grade,
      homeroom: grade ? `Grade ${grade}` : "Unassigned",
      advisor: "",
      status: statusRaw === "Enrolled" ? "Active" : "Watch",
      attendanceRate: 100,
      tardies: 0,
      absences: 0,
      gpa: 0,
      missingAssignments: 0,
      behaviorPoints: 0,
      lunchBalance: 0,
      family,
      primaryContact,
      allergies: "None",
      activities: [],
      notes: [
        "Imported from Student_Info/May-2026.pdf.",
        middleName ? `Middle: ${middleName}.` : "",
        gender ? `Gender: ${gender}.` : "",
        birthdate ? `Birthdate: ${birthdate}.` : "",
        nextYear ? `Next year grade: ${nextYear}.` : "",
        studentEmail ? `Student email: ${studentEmail}.` : "",
        religion ? `Religion: ${religion}.` : "",
        address || cityStateZip ? `Address: ${clean(`${address}, ${cityStateZip}`)}.` : "",
        homePhone ? `Home phone: ${homePhone}.` : ""
      ].filter(Boolean).join(" ")
    });

    accountProfiles.push({
      id: `acct-student-${id}`,
      name: `${firstName} ${lastName}`,
      type: "Student",
      email: studentEmail || `${id}@student.local`,
      role: "Student",
      status: studentEmail ? "Active" : "Needs Setup",
      linkedTo: family
    });

    timelineEvents.push({
      id: `${id}-import`,
      studentId: id,
      date: "2026-05-08",
      type: "Family",
      title: "Student information imported",
      detail: "Imported from May 2026 student information PDF."
    });

    const parentCount = Math.max(pFirst.length, pLast.length, pRelation.length, pEmailMatches.length, pCell.length, pHome.length);
    for (let i = 0; i < parentCount; i += 1) {
      const name = clean(`${pFirst[i] || ""} ${pLast[i] || ""}`);
      if (!name) continue;
      const phone = pCell[i] || pHome[i] || homePhone || "";
      const email = pEmailMatches[i] || "";
      const guardianId = `guard-${String(guardians.length + 1).padStart(3, "0")}`;
      guardians.push({
        id: guardianId,
        studentId: id,
        name,
        relationship: pRelation[i] || "Guardian",
        email,
        phone,
        address: address || cityStateZip ? clean(`${address}, ${cityStateZip}`) : "",
        pickupApproved: true,
        portalStatus: email ? "Invite Pending" : "Needs Setup"
      });
      accountProfiles.push({
        id: `acct-${guardianId}`,
        name,
        type: "Parent",
        email: email || `${guardianId}@guardian.local`,
        role: "Parent",
        status: email ? "Invite Pending" : "Needs Setup",
        linkedTo: `${firstName} ${lastName}`
      });
    }
  });

  return { students, guardians, accountProfiles, timelineEvents };
}

function instructorFrom(lines, index, rawInstructor) {
  let instructor = clean(rawInstructor);
  if (instructor.endsWith(",") && lines[index + 1]) instructor = clean(`${instructor} ${lines[index + 1]}`);
  return instructor.replace(/,\s+/, ", ");
}

function gradeFromContext(lines, index) {
  for (let i = index; i >= Math.max(0, index - 8); i -= 1) {
    const line = clean(lines[i]);
    if (/^Kindergarten$/.test(line)) return "K";
    const grade = line.match(/^(\d+)(?:st|nd|rd|th) Grade$/);
    if (grade) return grade[1];
    if (/Preschool/.test(line)) return "PS";
    if (/Jr\. Kindergarten|Jr\.Kindergarten/.test(line)) return "JK";
    if (/Pre- Kindergarten|Pre-Kindergarten/.test(line)) return "PK";
  }
  return "";
}

function parseClasses(text) {
  const lines = text.split(/\r?\n/);
  const classes = [];
  lines.forEach((line, index) => {
    if (!line.includes("\t") || !/\bY\b/.test(line) || !/\bN\b/.test(line)) return;
    if (/DEPARTMENT|INSTRUCTOR|ROOM/.test(line)) return;
    const cells = line.split("\t").map(clean).filter(Boolean);
    if (cells.length < 10) return;
    const instructor = instructorFrom(lines, index, cells[cells.length - 1] || "");
    const title = cells[0].replace(/^\*+\s*/, "");
    const courseCode = cells[1] && !/^\d+$/.test(cells[1]) ? cells[1].replace(/^\*+\s*/, "") : title;
    const gradeFromCode = (courseCode.match(/^([1-8])\b/) || [])[1] || (/^K\b|\*K/.test(courseCode) ? "K" : "");
    const grade = gradeFromContext(lines, index) || gradeFromCode;
    const roomMatch = line.match(/\bN\s+(\d{2,3})\s+\t0\s+\t/);
    const room = roomMatch ? roomMatch[1] : "";
    const code = courseCode;
    const section = cells[2] && !/^\d+$/.test(cells[2]) ? cells[2] : cells[1] && cells[1] !== courseCode && !/^\d+$/.test(cells[1]) ? cells[1] : room || String(classes.length + 1);
    const enrollmentNumbers = cells.map((cell) => Number(cell)).filter((value) => Number.isFinite(value));
    const enrollment = enrollmentNumbers.length ? Math.max(...enrollmentNumbers.filter((value) => value < 200)) : 0;
    const id = `class-${String(classes.length + 1).padStart(3, "0")}`;
    classes.push({
      id,
      name: clean(`${grade ? `Grade ${grade}` : "Class"} ${title} ${section}`),
      grade,
      teacher: instructor,
      room: room || "Unassigned",
      period: code,
      rosterIds: [],
      attendanceStatus: "Missing",
      submittedAt: undefined,
      sourceEnrollment: enrollment
    });
  });
  const seen = new Set();
  return classes.filter((item) => {
    const key = `${item.name}|${item.teacher}|${item.room}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildAttendance(students) {
  return students.map((student, index) => ({
    id: `att-2026-05-13-${student.id}`,
    date: "2026-05-13",
    studentId: student.id,
    code: "Present",
    minutesLate: 0,
    reason: "",
    excused: true
  }));
}

(async () => {
  const [studentText, classText] = await Promise.all([pdfText(STUDENT_PDF), pdfText(CLASS_PDF)]);
  const parsed = parseStudents(studentText);
  const schoolClasses = parseClasses(classText).map(({ sourceEnrollment, ...item }) => item);
  const data = {
    version: "0.3.0",
    updated: new Date().toISOString(),
    source: {
      studentInfo: path.relative(ROOT, STUDENT_PDF).replace(/\\/g, "/"),
      classList: path.relative(ROOT, CLASS_PDF).replace(/\\/g, "/"),
      importedAt: new Date().toISOString()
    },
    students: parsed.students,
    guardians: parsed.guardians,
    attendanceRecords: buildAttendance(parsed.students),
    schoolClasses,
    calendarItems: [],
    messages: [],
    teacherTasks: [],
    accountProfiles: parsed.accountProfiles,
    documents: [],
    services: [],
    communicationLogs: [],
    timelineEvents: parsed.timelineEvents,
    auditLog: [
      {
        id: `audit-import-${Date.now()}`,
        actor: "SchoolData import",
        action: "schoolData.import",
        detail: `${parsed.students.length} students, ${parsed.guardians.length} guardians, ${schoolClasses.length} classes imported from docs/SchoolData`,
        at: new Date().toISOString()
      }
    ]
  };
  fs.writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Imported ${parsed.students.length} students`);
  console.log(`Imported ${parsed.guardians.length} guardians`);
  console.log(`Imported ${schoolClasses.length} classes`);
  console.log(`Wrote ${path.relative(ROOT, DATA_PATH)}`);
})();
