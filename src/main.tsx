import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import "./styles.css";

type Role = "Admin" | "Office" | "Teacher" | "Cafeteria" | "Parent" | "Student";
type StudentStatus = "Active" | "Watch" | "Intervention";
type AttendanceCode = "Present" | "Absent" | "Tardy" | "Early Dismissal";
type Tone = "green" | "red" | "gold" | "blue" | "purple" | "gray";
type ModuleId = "overview" | "teacherAttendance" | "teacherCalendar" | "masterCalendar" | "messages" | "tasks" | "security" | "attendanceMonitor" | "classes" | "attendance" | "students" | "people" | "academics" | "behavior" | "lunch" | "staff" | "admin" | "integrations" | "reports" | "charts" | "agentApi" | "sync" | "enrollment" | "health" | "familyPortal";
type ChartMetric = "attendanceRate" | "absences" | "tardies" | "gpa" | "missingAssignments" | "behaviorPoints" | "lunchBalance";
type ChartKind = "bar" | "horizontal" | "line" | "pie" | "donut" | "stacked" | "kpi";

type Student = {
  id: string;
  firstName: string;
  lastName: string;
  grade: string;
  homeroom: string;
  advisor: string;
  status: StudentStatus;
  attendanceRate: number;
  tardies: number;
  absences: number;
  gpa: number;
  missingAssignments: number;
  behaviorPoints: number;
  lunchBalance: number;
  family: string;
  primaryContact: string;
  allergies: string;
  activities: string[];
  notes: string;
};

type Guardian = {
  id: string;
  studentId: string;
  name: string;
  relationship: string;
  email: string;
  phone: string;
  address: string;
  pickupApproved: boolean;
  portalStatus: "Active" | "Invite Pending" | "Needs Setup";
};

type StudentDocument = {
  id: string;
  studentId: string;
  title: string;
  category: string;
  status: "Complete" | "Missing" | "Expiring";
  updated: string;
};

type StudentService = {
  id: string;
  studentId: string;
  type: string;
  provider: string;
  notes: string;
  reviewDate: string;
};

type CommunicationLog = {
  id: string;
  studentId: string;
  date: string;
  channel: "Phone" | "Email" | "Meeting" | "Portal";
  subject: string;
  staff: string;
  outcome: string;
};

type SchoolClass = {
  id: string;
  name: string;
  grade: string;
  teacher: string;
  room: string;
  period: string;
  rosterIds: string[];
  attendanceStatus: "Submitted" | "Missing" | "In Progress";
  submittedAt?: string;
};

type CalendarItem = {
  id: string;
  owner: string;
  type: "Time Off" | "Sick Day" | "School Event" | "Coverage" | "Admin Block";
  title: string;
  date: string;
  time: string;
  status: "Draft" | "Pending" | "Approved" | "Denied" | "Needs Coverage";
  visibility: "Private" | "Staff" | "Admin";
  warning?: string;
};

type MessageItem = {
  id: string;
  from: string;
  audience: string;
  subject: string;
  body: string;
  priority: "Normal" | "Important" | "Required Ack";
  excluded: string[];
  acknowledged: string[];
};

type TeacherTask = {
  id: string;
  owner: string;
  title: string;
  due: string;
  status: "Not Started" | "In Progress" | "Blocked" | "Done";
  priority: "Low" | "Normal" | "High";
  linkedStudent?: string;
};

type StudentProfileData = {
  guardians: Guardian[];
  siblings: Student[];
  documents: StudentDocument[];
  services: StudentService[];
  communications: CommunicationLog[];
  timeline: TimelineEvent[];
};

type AccountProfile = {
  id: string;
  name: string;
  type: "Staff" | "Parent" | "Student";
  email: string;
  role: string;
  status: "Active" | "Invite Pending" | "Needs Setup";
  linkedTo: string;
};

type AttendanceRecord = {
  id: string;
  date: string;
  studentId: string;
  code: AttendanceCode;
  minutesLate: number;
  reason: string;
  excused: boolean;
};

type TimelineEvent = {
  id: string;
  studentId: string;
  date: string;
  type: "Attendance" | "Academic" | "Behavior" | "Lunch" | "Family";
  title: string;
  detail: string;
};

type StaffMember = {
  id: string;
  name: string;
  role: string;
  department: string;
  coverageNeed: string;
  tasksOpen: number;
  room: string;
};

type SavedView = {
  id: string;
  name: string;
  module: ModuleId;
  query: string;
  grade: string;
  riskOnly: boolean;
  description: string;
};

type ReportTemplate = {
  id: string;
  name: string;
  description: string;
  module: ModuleId;
  fields: string[];
  automation: string;
  category: "Attendance" | "Student" | "Academic" | "Behavior" | "Lunch" | "Staff" | "Family" | "Admin" | "Custom";
};

type InboxItem = {
  id: string;
  module: ModuleId;
  title: string;
  detail: string;
  count: number;
  tone: Tone;
};

type FactsEndpoint = {
  id: string;
  label: string;
  status: "Waiting" | "Mapped" | "Ready";
  localTable: string;
  notes: string;
};

type BootstrapData = {
  version?: string;
  updated?: string;
  students?: Student[];
  attendanceRecords?: AttendanceRecord[];
  schoolClasses?: SchoolClass[];
  calendarItems?: CalendarItem[];
  messages?: MessageItem[];
  teacherTasks?: TeacherTask[];
  accountProfiles?: AccountProfile[];
  guardians?: Guardian[];
  documents?: StudentDocument[];
  services?: StudentService[];
  communicationLogs?: CommunicationLog[];
  timelineEvents?: TimelineEvent[];
  auditLog?: { id: string; actor: string; action: string; detail: string; at: string }[];
};

type AuditEntry = { id: string; actor: string; action: string; detail: string; at: string };

type FactsPreview = {
  table: string;
  totalRows: number;
  createCount: number;
  updateCount: number;
  columns: string[];
  rows: Record<string, string | number>[];
};

const today = "2026-05-08";
const apiBase = "http://127.0.0.1:8787";

const modules: { id: ModuleId; label: string; hint: string }[] = [
  { id: "overview", label: "Command", hint: "Operating summary" },
  { id: "teacherAttendance", label: "Take Attendance", hint: "Teacher roster check-in" },
  { id: "teacherCalendar", label: "My Calendar", hint: "Teacher schedule and requests" },
  { id: "masterCalendar", label: "Master Calendar", hint: "Admin calendar oversight" },
  { id: "messages", label: "Messages", hint: "Boards and acknowledgements" },
  { id: "tasks", label: "Tasks", hint: "Teacher task system" },
  { id: "security", label: "Security Gates", hint: "Roles, approvals, audit" },
  { id: "attendanceMonitor", label: "Attendance Monitor", hint: "Submission dashboard" },
  { id: "classes", label: "Classes", hint: "Sections and rosters" },
  { id: "attendance", label: "Attendance", hint: "Daily codes and trends" },
  { id: "students", label: "Students", hint: "Profiles and families" },
  { id: "people", label: "People", hint: "Staff, parents, students" },
  { id: "enrollment", label: "Enrollment", hint: "Inquiry to enrolled" },
  { id: "health", label: "Health & Safety", hint: "Care plans and medication" },
  { id: "familyPortal", label: "Family Portal", hint: "One home for families" },
  { id: "academics", label: "Academics", hint: "Grades and missing work" },
  { id: "behavior", label: "Behavior", hint: "Conduct and recognition" },
  { id: "lunch", label: "Lunch", hint: "Meals, allergies, balances" },
  { id: "staff", label: "Staff", hint: "Coverage and tasks" },
  { id: "admin", label: "Admin", hint: "Accounts and permissions" },
  { id: "integrations", label: "Integrations", hint: "Google and external systems" },
  { id: "reports", label: "Reports", hint: "Build, save, export" },
  { id: "charts", label: "Charts", hint: "Compare and chart data" },
  { id: "agentApi", label: "Agent API", hint: "Programmatic data access" },
  { id: "sync", label: "FACTS Sync", hint: "Endpoint mapping" }
];

const navGroups: { title: string; description: string; items: ModuleId[] }[] = [
  { title: "Daily Work", description: "Morning tasks, attendance, reports", items: ["overview", "teacherAttendance", "attendanceMonitor", "attendance", "tasks", "reports"] },
  { title: "Calendars", description: "Teacher requests and admin oversight", items: ["teacherCalendar", "masterCalendar", "messages"] },
  { title: "Community", description: "Student and family lifecycle", items: ["students", "people", "enrollment", "familyPortal"] },
  { title: "Student Success", description: "Learning, wellbeing, and care", items: ["classes", "academics", "behavior", "health", "lunch", "charts"] },
  { title: "Operations", description: "Staff, accounts, and controls", items: ["staff", "admin"] },
  { title: "Systems", description: "Security, Google, agents, FACTS sync", items: ["security", "integrations", "agentApi", "sync"] }
];

const roles: Role[] = ["Admin", "Office", "Teacher", "Cafeteria", "Parent", "Student"];
const grades = ["All", "PS", "PK", "JK", "K", "1", "2", "3", "4", "5", "6", "7", "8"];
const chartMetrics: { id: ChartMetric; label: string; tone: Tone }[] = [
  { id: "attendanceRate", label: "Attendance %", tone: "green" },
  { id: "absences", label: "Absences", tone: "red" },
  { id: "tardies", label: "Tardies", tone: "gold" },
  { id: "gpa", label: "GPA", tone: "blue" },
  { id: "missingAssignments", label: "Missing Work", tone: "purple" },
  { id: "behaviorPoints", label: "Behavior", tone: "gray" },
  { id: "lunchBalance", label: "Lunch Balance", tone: "green" }
];

const chartKinds: { id: ChartKind; label: string; use: string }[] = [
  { id: "bar", label: "Bar", use: "Compare values across students or grades." },
  { id: "horizontal", label: "Horizontal", use: "Read long names and ranked lists." },
  { id: "line", label: "Line", use: "See movement across grades or dates." },
  { id: "pie", label: "Pie", use: "Show share of a total." },
  { id: "donut", label: "Donut", use: "Show proportions with a center total." },
  { id: "stacked", label: "Stacked", use: "Compare multiple categories per group." },
  { id: "kpi", label: "KPI Cards", use: "Make a board for quick scanning." }
];

const students: Student[] = [
  { id: "s001", firstName: "Ava", lastName: "Martin", grade: "K", homeroom: "K-A", advisor: "Mrs. Kelly", status: "Active", attendanceRate: 98, tardies: 1, absences: 2, gpa: 3.8, missingAssignments: 0, behaviorPoints: 14, lunchBalance: 26.5, family: "Martin", primaryContact: "Grace Martin", allergies: "Peanut", activities: ["Choir"], notes: "Bus 4. Peanut allergy." },
  { id: "s002", firstName: "Noah", lastName: "Reed", grade: "1", homeroom: "1-A", advisor: "Ms. Wolfe", status: "Watch", attendanceRate: 93, tardies: 7, absences: 6, gpa: 3.1, missingAssignments: 2, behaviorPoints: 4, lunchBalance: 8.25, family: "Reed", primaryContact: "Colin Reed", allergies: "None", activities: ["Art Club"], notes: "Tardy pattern on Mondays." },
  { id: "s003", firstName: "Mia", lastName: "Santos", grade: "2", homeroom: "2-B", advisor: "Mrs. Hoff", status: "Active", attendanceRate: 99, tardies: 0, absences: 1, gpa: 3.9, missingAssignments: 0, behaviorPoints: 18, lunchBalance: 31, family: "Santos", primaryContact: "Lena Santos", allergies: "None", activities: ["Choir", "Reading Team"], notes: "Strong peer helper." },
  { id: "s004", firstName: "Lucas", lastName: "Kline", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Intervention", attendanceRate: 88, tardies: 11, absences: 12, gpa: 2.4, missingAssignments: 9, behaviorPoints: -6, lunchBalance: -4.5, family: "Kline", primaryContact: "Sarah Kline", allergies: "Dairy", activities: ["Robotics"], notes: "Attendance meeting requested." },
  { id: "s005", firstName: "Emma", lastName: "Nguyen", grade: "4", homeroom: "4-A", advisor: "Mrs. Brown", status: "Active", attendanceRate: 97, tardies: 2, absences: 3, gpa: 3.7, missingAssignments: 1, behaviorPoints: 12, lunchBalance: 14.75, family: "Nguyen", primaryContact: "Tom Nguyen", allergies: "None", activities: ["Math Club"], notes: "Math enrichment." },
  { id: "s006", firstName: "Ethan", lastName: "Cole", grade: "5", homeroom: "5-B", advisor: "Mr. James", status: "Watch", attendanceRate: 91, tardies: 8, absences: 8, gpa: 2.9, missingAssignments: 5, behaviorPoints: 1, lunchBalance: 3, family: "Cole", primaryContact: "Alicia Cole", allergies: "None", activities: ["Basketball"], notes: "Needs weekly work check." },
  { id: "s007", firstName: "Sophia", lastName: "Bennett", grade: "6", homeroom: "6-A", advisor: "Mrs. Grant", status: "Active", attendanceRate: 96, tardies: 3, absences: 4, gpa: 3.6, missingAssignments: 2, behaviorPoints: 10, lunchBalance: 18.1, family: "Bennett", primaryContact: "Mark Bennett", allergies: "Tree nuts", activities: ["Student Council"], notes: "Student council." },
  { id: "s008", firstName: "Liam", lastName: "Foster", grade: "7", homeroom: "7-B", advisor: "Mr. Clark", status: "Intervention", attendanceRate: 86, tardies: 14, absences: 15, gpa: 2.2, missingAssignments: 13, behaviorPoints: -11, lunchBalance: -12.35, family: "Foster", primaryContact: "Dana Foster", allergies: "None", activities: ["Soccer"], notes: "Behavior plan active." },
  { id: "s009", firstName: "Olivia", lastName: "Murphy", grade: "8", homeroom: "8-A", advisor: "Mrs. Walsh", status: "Active", attendanceRate: 95, tardies: 4, absences: 5, gpa: 3.5, missingAssignments: 1, behaviorPoints: 9, lunchBalance: 22.4, family: "Murphy", primaryContact: "Kevin Murphy", allergies: "None", activities: ["Drama"], notes: "Scholarship candidate." },
  { id: "s010", firstName: "James", lastName: "Patel", grade: "8", homeroom: "8-B", advisor: "Mrs. Walsh", status: "Watch", attendanceRate: 90, tardies: 9, absences: 9, gpa: 3.0, missingAssignments: 6, behaviorPoints: 2, lunchBalance: 5.2, family: "Patel", primaryContact: "Nina Patel", allergies: "Egg", activities: ["Science Fair"], notes: "Monitor science homework." }
];

const teacherRosterStudents: Student[] = [
  ...students.filter((student) => ["K", "1", "2", "3", "4"].includes(student.grade)),
  { id: "r011", firstName: "Ben", lastName: "Walters", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 98, tardies: 1, absences: 1, gpa: 3.4, missingAssignments: 0, behaviorPoints: 7, lunchBalance: 11, family: "Walters", primaryContact: "Beth Walters", allergies: "None", activities: ["Chess"], notes: "" },
  { id: "r012", firstName: "Chloe", lastName: "Diaz", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 96, tardies: 2, absences: 3, gpa: 3.6, missingAssignments: 1, behaviorPoints: 9, lunchBalance: 18, family: "Diaz", primaryContact: "Marco Diaz", allergies: "None", activities: ["Art"], notes: "" },
  { id: "r013", firstName: "Daniel", lastName: "Ross", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Watch", attendanceRate: 92, tardies: 5, absences: 6, gpa: 3.0, missingAssignments: 3, behaviorPoints: 3, lunchBalance: 7, family: "Ross", primaryContact: "Erin Ross", allergies: "None", activities: ["Soccer"], notes: "" },
  { id: "r014", firstName: "Ella", lastName: "Brooks", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 99, tardies: 0, absences: 1, gpa: 3.9, missingAssignments: 0, behaviorPoints: 15, lunchBalance: 21, family: "Brooks", primaryContact: "Amy Brooks", allergies: "None", activities: ["Choir"], notes: "" },
  { id: "r015", firstName: "Finn", lastName: "Young", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 97, tardies: 2, absences: 2, gpa: 3.3, missingAssignments: 1, behaviorPoints: 8, lunchBalance: 13, family: "Young", primaryContact: "Paul Young", allergies: "None", activities: ["Robotics"], notes: "" },
  { id: "r016", firstName: "Grace", lastName: "Hill", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 95, tardies: 3, absences: 4, gpa: 3.5, missingAssignments: 2, behaviorPoints: 6, lunchBalance: 16, family: "Hill", primaryContact: "Tara Hill", allergies: "Shellfish", activities: ["Drama"], notes: "" },
  { id: "r017", firstName: "Henry", lastName: "Scott", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 94, tardies: 4, absences: 5, gpa: 3.1, missingAssignments: 2, behaviorPoints: 4, lunchBalance: 9, family: "Scott", primaryContact: "Megan Scott", allergies: "None", activities: ["Baseball"], notes: "" },
  { id: "r018", firstName: "Isla", lastName: "Price", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 98, tardies: 1, absences: 2, gpa: 3.8, missingAssignments: 0, behaviorPoints: 12, lunchBalance: 24, family: "Price", primaryContact: "John Price", allergies: "None", activities: ["Math Club"], notes: "" },
  { id: "r019", firstName: "Jack", lastName: "Turner", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Watch", attendanceRate: 91, tardies: 6, absences: 7, gpa: 2.8, missingAssignments: 4, behaviorPoints: 1, lunchBalance: 4, family: "Turner", primaryContact: "Laura Turner", allergies: "None", activities: ["Basketball"], notes: "" },
  { id: "r020", firstName: "Kate", lastName: "Adams", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 97, tardies: 2, absences: 3, gpa: 3.7, missingAssignments: 1, behaviorPoints: 10, lunchBalance: 19, family: "Adams", primaryContact: "Sean Adams", allergies: "None", activities: ["Reading Team"], notes: "" },
  { id: "r021", firstName: "Leo", lastName: "Morris", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 96, tardies: 2, absences: 4, gpa: 3.2, missingAssignments: 1, behaviorPoints: 5, lunchBalance: 12, family: "Morris", primaryContact: "Kim Morris", allergies: "None", activities: ["Chess"], notes: "" },
  { id: "r022", firstName: "Nora", lastName: "Cooper", grade: "3", homeroom: "3-A", advisor: "Mr. Miller", status: "Active", attendanceRate: 99, tardies: 0, absences: 1, gpa: 3.9, missingAssignments: 0, behaviorPoints: 13, lunchBalance: 28, family: "Cooper", primaryContact: "Alex Cooper", allergies: "None", activities: ["Choir"], notes: "" }
];

const guardians: Guardian[] = [
  { id: "g1", studentId: "s001", name: "Grace Martin", relationship: "Mother", email: "grace.martin@example.com", phone: "610-555-0101", address: "Orefield, PA", pickupApproved: true, portalStatus: "Invite Pending" },
  { id: "g2", studentId: "s001", name: "Patrick Martin", relationship: "Father", email: "patrick.martin@example.com", phone: "610-555-0102", address: "Orefield, PA", pickupApproved: true, portalStatus: "Active" },
  { id: "g3", studentId: "s004", name: "Sarah Kline", relationship: "Mother", email: "sarah.kline@example.com", phone: "610-555-0114", address: "Orefield, PA", pickupApproved: true, portalStatus: "Active" },
  { id: "g4", studentId: "s004", name: "Robert Kline", relationship: "Emergency Contact", email: "robert.kline@example.com", phone: "610-555-0115", address: "Allentown, PA", pickupApproved: true, portalStatus: "Needs Setup" },
  { id: "g5", studentId: "s008", name: "Dana Foster", relationship: "Mother", email: "dana.foster@example.com", phone: "610-555-0128", address: "Orefield, PA", pickupApproved: true, portalStatus: "Active" },
  { id: "g6", studentId: "s008", name: "Michael Foster", relationship: "Father", email: "michael.foster@example.com", phone: "610-555-0129", address: "Orefield, PA", pickupApproved: false, portalStatus: "Invite Pending" }
];

const documents: StudentDocument[] = [
  { id: "d1", studentId: "s001", title: "Emergency Card", category: "Office", status: "Complete", updated: "2026-04-20" },
  { id: "d2", studentId: "s001", title: "Allergy Plan", category: "Health", status: "Complete", updated: "2026-03-18" },
  { id: "d3", studentId: "s004", title: "Attendance Intervention Plan", category: "Student Support", status: "Expiring", updated: "2026-02-14" },
  { id: "d4", studentId: "s004", title: "Emergency Card", category: "Office", status: "Missing", updated: "2025-09-08" },
  { id: "d5", studentId: "s008", title: "Behavior Plan", category: "Student Support", status: "Complete", updated: "2026-04-04" },
  { id: "d6", studentId: "s008", title: "Parent Meeting Notes", category: "Communication", status: "Complete", updated: "2026-05-01" }
];

const services: StudentService[] = [
  { id: "svc1", studentId: "s004", type: "Attendance Intervention", provider: "Office / Principal", notes: "Weekly attendance review with parent contact.", reviewDate: "2026-05-15" },
  { id: "svc2", studentId: "s008", type: "Behavior Plan", provider: "Middle School Team", notes: "Daily check-in/check-out and parent update Friday.", reviewDate: "2026-05-20" },
  { id: "svc3", studentId: "s006", type: "Academic Support", provider: "Advisor", notes: "Weekly missing-work check.", reviewDate: "2026-05-13" }
];

const communicationLogs: CommunicationLog[] = [
  { id: "c1", studentId: "s001", date: "2026-04-20", channel: "Email", subject: "Allergy plan confirmed", staff: "Office Team", outcome: "Parent confirmed current plan." },
  { id: "c2", studentId: "s004", date: "2026-05-06", channel: "Phone", subject: "Unexcused absence", staff: "Office Team", outcome: "Left voicemail; follow-up needed." },
  { id: "c3", studentId: "s004", date: "2026-04-29", channel: "Meeting", subject: "Attendance meeting", staff: "Principal", outcome: "Set weekly review plan." },
  { id: "c4", studentId: "s008", date: "2026-05-01", channel: "Meeting", subject: "Behavior plan review", staff: "Mr. Clark", outcome: "Plan continued for two weeks." },
  { id: "c5", studentId: "s008", date: "2026-04-25", channel: "Portal", subject: "Missing work update", staff: "Mr. Clark", outcome: "Parent viewed message." }
];

const schoolClasses: SchoolClass[] = [
  { id: "class-k-a", name: "K-A Homeroom", grade: "K", teacher: "Mrs. Kelly", room: "K-A", period: "Homeroom", rosterIds: ["s001", "s003", "r011", "r012"], attendanceStatus: "Submitted", submittedAt: "8:18 AM" },
  { id: "class-1-a", name: "1-A Homeroom", grade: "1", teacher: "Ms. Wolfe", room: "1-A", period: "Homeroom", rosterIds: ["s002", "r013", "r014", "r015"], attendanceStatus: "In Progress" },
  { id: "class-3-a", name: "3-A Homeroom", grade: "3", teacher: "Mr. Miller", room: "3-A", period: "Homeroom", rosterIds: teacherRosterStudents.map((student) => student.id), attendanceStatus: "Missing" },
  { id: "class-5-b", name: "5-B Advisory", grade: "5", teacher: "Mr. James", room: "5-B", period: "Advisory", rosterIds: ["s006", "r016", "r017", "r018"], attendanceStatus: "Submitted", submittedAt: "8:21 AM" },
  { id: "class-8-a", name: "8-A Period 1", grade: "8", teacher: "Mrs. Walsh", room: "8-A", period: "Period 1", rosterIds: ["s009", "s010", "r019", "r020", "r021", "r022"], attendanceStatus: "Missing" }
];

const calendarSeed: CalendarItem[] = [
  { id: "cal1", owner: "Mrs. Kelly", type: "School Event", title: "Kindergarten prayer service", date: "2026-05-08", time: "9:15 AM", status: "Approved", visibility: "Staff" },
  { id: "cal2", owner: "Ms. Wolfe", type: "Time Off", title: "Personal day request", date: "2026-05-10", time: "All day", status: "Pending", visibility: "Admin", warning: "Coverage needed for lunch duty." },
  { id: "cal3", owner: "Mr. Miller", type: "Sick Day", title: "Sick day request", date: "2026-05-07", time: "All day", status: "Needs Coverage", visibility: "Admin", warning: "Period 6 substitute not assigned." },
  { id: "cal4", owner: "Mrs. Walsh", type: "Coverage", title: "8th grade field trip prep", date: "2026-05-12", time: "1:30 PM", status: "Approved", visibility: "Staff" }
];

const messageSeed: MessageItem[] = [
  { id: "msg1", from: "Office Team", audience: "All Staff", subject: "Dismissal adjustment", body: "Use the rainy-day dismissal route today.", priority: "Required Ack", excluded: ["Parents", "Students"], acknowledged: ["Mrs. Kelly"] },
  { id: "msg2", from: "Principal", audience: "Teachers", subject: "Grades due Friday", body: "Please finalize grade comments by Friday afternoon.", priority: "Important", excluded: ["Parents", "Students"], acknowledged: [] },
  { id: "msg3", from: "Cafeteria", audience: "All Staff", subject: "Lunch menu change", body: "Pizza option replaces pasta today.", priority: "Normal", excluded: ["Parents"], acknowledged: [] }
];

const taskSeed: TeacherTask[] = [
  { id: "task1", owner: "Mrs. Kelly", title: "Confirm allergy plan for Ava", due: "2026-05-08", status: "In Progress", priority: "High", linkedStudent: "Ava Martin" },
  { id: "task2", owner: "Mr. Miller", title: "Call Lucas Kline family", due: "2026-05-07", status: "Blocked", priority: "High", linkedStudent: "Lucas Kline" },
  { id: "task3", owner: "Mrs. Walsh", title: "Prepare 8th grade scholarship notes", due: "2026-05-12", status: "Not Started", priority: "Normal", linkedStudent: "Olivia Murphy" }
];

const attendanceRecords: AttendanceRecord[] = [
  { id: "a1", date: today, studentId: "s001", code: "Present", minutesLate: 0, reason: "", excused: true },
  { id: "a2", date: today, studentId: "s002", code: "Tardy", minutesLate: 18, reason: "Late drop-off", excused: false },
  { id: "a3", date: today, studentId: "s003", code: "Present", minutesLate: 0, reason: "", excused: true },
  { id: "a4", date: today, studentId: "s004", code: "Absent", minutesLate: 0, reason: "Unexcused", excused: false },
  { id: "a5", date: today, studentId: "s005", code: "Present", minutesLate: 0, reason: "", excused: true },
  { id: "a6", date: today, studentId: "s006", code: "Early Dismissal", minutesLate: 0, reason: "Appointment", excused: true },
  { id: "a7", date: today, studentId: "s007", code: "Present", minutesLate: 0, reason: "", excused: true },
  { id: "a8", date: today, studentId: "s008", code: "Tardy", minutesLate: 24, reason: "No note", excused: false },
  { id: "a9", date: today, studentId: "s009", code: "Present", minutesLate: 0, reason: "", excused: true },
  { id: "a10", date: today, studentId: "s010", code: "Absent", minutesLate: 0, reason: "Parent called", excused: true }
];

const timelineEvents: TimelineEvent[] = students.flatMap((student, index) => [
  { id: `${student.id}-att`, studentId: student.id, date: "2026-05-07", type: "Attendance", title: student.attendanceRate < 92 ? "Attendance watch" : "Attendance stable", detail: `${student.absences} absences and ${student.tardies} tardies this year.` },
  { id: `${student.id}-acad`, studentId: student.id, date: "2026-05-06", type: "Academic", title: student.missingAssignments > 4 ? "Missing work follow-up" : "Academic check", detail: `${student.missingAssignments} missing assignments, GPA ${student.gpa.toFixed(1)}.` },
  { id: `${student.id}-beh`, studentId: student.id, date: `2026-05-${String(Math.max(1, 5 - (index % 4))).padStart(2, "0")}`, type: "Behavior", title: student.behaviorPoints < 0 ? "Behavior plan event" : "Recognition update", detail: `${student.behaviorPoints} behavior points.` }
]);

const staff: StaffMember[] = [
  { id: "t1", name: "Mrs. Kelly", role: "Teacher", department: "Primary", coverageNeed: "None", tasksOpen: 2, room: "K-A" },
  { id: "t2", name: "Ms. Wolfe", role: "Teacher", department: "Primary", coverageNeed: "Lunch duty swap", tasksOpen: 5, room: "1-A" },
  { id: "t3", name: "Mr. Miller", role: "Teacher", department: "Intermediate", coverageNeed: "Sub period 6", tasksOpen: 7, room: "3-A" },
  { id: "t4", name: "Mrs. Walsh", role: "Teacher", department: "Middle School", coverageNeed: "None", tasksOpen: 3, room: "8-A" },
  { id: "t5", name: "Office Team", role: "Office", department: "Administration", coverageNeed: "Afternoon pickup", tasksOpen: 11, room: "Office" }
];

const accountProfiles: AccountProfile[] = [
  { id: "acct1", name: "Mrs. Kelly", type: "Staff", email: "mkelly@stjwschool.org", role: "Teacher", status: "Active", linkedTo: "K-A" },
  { id: "acct2", name: "Office Team", type: "Staff", email: "office@stjwschool.org", role: "Office Admin", status: "Active", linkedTo: "Administration" },
  { id: "acct3", name: "Grace Martin", type: "Parent", email: "grace.martin@example.com", role: "Parent", status: "Invite Pending", linkedTo: "Ava Martin" },
  { id: "acct4", name: "Ava Martin", type: "Student", email: "ava.martin@student.stjwschool.org", role: "Student", status: "Needs Setup", linkedTo: "Martin family" },
  { id: "acct5", name: "Dana Foster", type: "Parent", email: "dana.foster@example.com", role: "Parent", status: "Active", linkedTo: "Liam Foster" }
];

const savedViewsSeed: SavedView[] = [
  { id: "sv1", name: "Today attendance issues", module: "attendance", query: "", grade: "All", riskOnly: true, description: "Absences, tardies, and early dismissals needing office follow-up." },
  { id: "sv2", name: "Middle school watchlist", module: "students", query: "", grade: "8", riskOnly: true, description: "Grade 8 students with academics, attendance, or balance risk." },
  { id: "sv3", name: "Lunch low balance", module: "lunch", query: "", grade: "All", riskOnly: true, description: "Families likely needing cafeteria balance notices." }
];

const reportTemplates: ReportTemplate[] = [
  { id: "daily-attendance", name: "Daily Attendance Register", category: "Attendance", description: "Present, absent, tardy, and early dismissal by grade.", module: "attendance", fields: ["Name", "Grade", "Homeroom", "Code", "Minutes Late", "Reason"], automation: "Send one-click CSV to office and principal." },
  { id: "chronic-absentee", name: "Chronic Absenteeism Watchlist", category: "Attendance", description: "Students below attendance threshold with notes and contacts.", module: "attendance", fields: ["Name", "Grade", "Attendance %", "Absences", "Tardies", "Contact", "Notes"], automation: "Flag students under 90% and build call list." },
  { id: "tardy-patterns", name: "Tardy Pattern Report", category: "Attendance", description: "Students with repeated tardies, minutes late, and parent contact fields.", module: "attendance", fields: ["Name", "Grade", "Homeroom", "Tardies", "Contact", "Notes"], automation: "Use for recurring tardy follow-up." },
  { id: "absence-calls", name: "Absence Call Sheet", category: "Attendance", description: "Call-ready list of absent students with family contact details.", module: "attendance", fields: ["Name", "Grade", "Code", "Reason", "Contact", "Notes"], automation: "Office can work down the list." },
  { id: "student-master", name: "Student Master List", category: "Student", description: "Core student demographics and school assignment fields.", module: "students", fields: ["Name", "Grade", "Homeroom", "Advisor", "Status", "Family", "Contact"], automation: "Export clean rosters for administration." },
  { id: "student-health", name: "Health and Allergy List", category: "Student", description: "Allergy and health-note view for classroom and cafeteria staff.", module: "students", fields: ["Name", "Grade", "Homeroom", "Allergies", "Notes"], automation: "Use before field trips and lunch workflows." },
  { id: "missing-work", name: "Missing Work Intervention", category: "Academic", description: "Students with open assignment load by homeroom.", module: "academics", fields: ["Name", "Grade", "Advisor", "Missing Work", "GPA", "Notes"], automation: "Group by advisor for weekly student check-ins." },
  { id: "gpa-watch", name: "GPA Watchlist", category: "Academic", description: "Students by GPA, missing work, advisor, and support status.", module: "academics", fields: ["Name", "Grade", "Advisor", "GPA", "Missing Work", "Status"], automation: "Prepare academic support review." },
  { id: "behavior", name: "Behavior and Recognition", category: "Behavior", description: "Discipline risk and positive behavior points.", module: "behavior", fields: ["Name", "Grade", "Behavior Points", "Status", "Notes"], automation: "Separate recognition list from intervention list." },
  { id: "behavior-intervention", name: "Behavior Intervention List", category: "Behavior", description: "Students with low behavior points and intervention notes.", module: "behavior", fields: ["Name", "Grade", "Advisor", "Behavior Points", "Status", "Notes"], automation: "Use for weekly support meetings." },
  { id: "lunch-balance", name: "Lunch Balance Alerts", category: "Lunch", description: "Negative and low balances for cafeteria follow-up.", module: "lunch", fields: ["Name", "Grade", "Family", "Balance", "Contact", "Allergies"], automation: "Export filtered family balance notices." },
  { id: "lunch-allergy", name: "Lunch Allergy Safety", category: "Lunch", description: "Allergies and notes for cafeteria service.", module: "lunch", fields: ["Name", "Grade", "Homeroom", "Allergies", "Notes"], automation: "Print for cafeteria safety checks." },
  { id: "family-directory", name: "Family Directory", category: "Family", description: "Searchable contacts and family groupings.", module: "students", fields: ["Family", "Name", "Grade", "Contact", "Notes"], automation: "Generate current phone tree and pickup references." },
  { id: "pickup-list", name: "Pickup and Emergency Contacts", category: "Family", description: "Family contact summary for office pickup workflows.", module: "students", fields: ["Name", "Grade", "Family", "Contact", "Notes"], automation: "Use at dismissal or emergency desk." },
  { id: "staff-load", name: "Staff Coverage and Tasks", category: "Staff", description: "Open tasks, coverage gaps, and department workload.", module: "staff", fields: ["Name", "Role", "Department", "Coverage Need", "Tasks Open"], automation: "Show coverage gaps before morning announcements." },
  { id: "account-setup", name: "Account Setup Status", category: "Admin", description: "Staff, parent, and student accounts by setup state.", module: "admin", fields: ["Name", "Role", "Status", "Contact", "Notes"], automation: "Track invitations and account readiness." },
  { id: "custom-student", name: "Custom Student Report", category: "Custom", description: "Start from all student fields and choose columns, sorting, and grouping.", module: "reports", fields: ["Name", "Grade", "Homeroom", "Advisor", "Status"], automation: "Use the builder to create one-off reports." }
];

const factsEndpoints: FactsEndpoint[] = [
  { id: "students", label: "Students / enrollments", status: "Waiting", localTable: "students", notes: "Map FACTS student id, family id, grade, homeroom, contacts." },
  { id: "attendance", label: "Attendance events", status: "Waiting", localTable: "attendanceRecords", notes: "Need daily attendance, tardy minutes, reasons, excused flags." },
  { id: "classes", label: "Classes / rosters", status: "Waiting", localTable: "sections", notes: "Use for teacher views, rosters, gradebook summaries." },
  { id: "grades", label: "Grades / assignments", status: "Waiting", localTable: "academicSnapshots", notes: "Keep billing last; start with missing work and GPA summaries." },
  { id: "behavior", label: "Discipline / conduct", status: "Waiting", localTable: "behaviorEvents", notes: "If API lacks this, support CSV import first." },
  { id: "lunch", label: "Cafeteria data", status: "Mapped", localTable: "lunchBalances", notes: "Can borrow patterns from CAFAPP for lunch menu and images later." }
];

function studentName(student: Student) {
  return `${student.firstName} ${student.lastName}`;
}

function currency(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function percent(value: number) {
  return `${Math.round(value)}%`;
}

function classNameForStatus(status: string) {
  return status.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function riskScore(student: Student) {
  return Math.max(0, 100 - student.attendanceRate) + student.tardies * 0.7 + student.missingAssignments * 1.4 + Math.max(0, -student.behaviorPoints) + Math.max(0, -student.lunchBalance) * 0.4;
}

function isRisk(student: Student) {
  return student.status !== "Active" || student.attendanceRate < 92 || student.missingAssignments > 4 || student.lunchBalance < 0 || student.behaviorPoints < 0;
}

function downloadFile(filename: string, content: string, type = "text/csv") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toCsv(rows: Record<string, string | number>[]) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
}

function buildStudentRows(visibleStudents: Student[], attendanceSource: AttendanceRecord[] = attendanceRecords) {
  return visibleStudents.map((student) => {
    const attendance = attendanceSource.find((record) => record.studentId === student.id);
    return {
      Name: studentName(student),
      Grade: student.grade,
      Homeroom: student.homeroom,
      Advisor: student.advisor,
      Code: attendance?.code ?? "Present",
      "Minutes Late": attendance?.minutesLate ?? 0,
      Reason: attendance?.reason ?? "",
      "Attendance %": percent(student.attendanceRate),
      Absences: student.absences,
      Tardies: student.tardies,
      GPA: student.gpa,
      "Missing Work": student.missingAssignments,
      "Behavior Points": student.behaviorPoints,
      Status: student.status,
      Family: student.family,
      Contact: student.primaryContact,
      Balance: currency(student.lunchBalance),
      Allergies: student.allergies,
      Notes: student.notes
    };
  });
}

function buildReportRows(templateId: string, visibleStudents: Student[], attendanceSource: AttendanceRecord[] = attendanceRecords, staffSource: StaffMember[] = staff) {
  if (templateId === "staff-load") {
    return staffSource.map((item) => ({
      Name: item.name,
      Role: item.role,
      Department: item.department,
      Room: item.room,
      "Coverage Need": item.coverageNeed,
      "Tasks Open": item.tasksOpen
    }));
  }
  return buildStudentRows(visibleStudents, attendanceSource);
}

function groupAverage(grade: string, metric: ChartMetric) {
  const group = students.filter((student) => student.grade === grade);
  if (!group.length) return 0;
  return Math.round((group.reduce((sum, student) => sum + Number(student[metric]), 0) / group.length) * 10) / 10;
}

function App() {
  const [studentRecords, setStudentRecords] = useState<Student[]>(students);
  const [attendanceData, setAttendanceData] = useState<AttendanceRecord[]>(attendanceRecords);
  const [classRecords, setClassRecords] = useState<SchoolClass[]>(schoolClasses);
  const [accountRecords, setAccountRecords] = useState<AccountProfile[]>(accountProfiles);
  const [guardianRecords, setGuardianRecords] = useState<Guardian[]>(guardians);
  const [documentRecords, setDocumentRecords] = useState<StudentDocument[]>(documents);
  const [serviceRecords, setServiceRecords] = useState<StudentService[]>(services);
  const [communicationRecords, setCommunicationRecords] = useState<CommunicationLog[]>(communicationLogs);
  const [timelineRecords, setTimelineRecords] = useState<TimelineEvent[]>(timelineEvents);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [apiStatus, setApiStatus] = useState("Loading local API...");
  const [activeModule, setActiveModule] = useState<ModuleId>("overview");
  const [activeRole, setActiveRole] = useState<Role>("Admin");
  const [currentUser, setCurrentUser] = useState<AccountProfile>(accountProfiles[1]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [calendarItems, setCalendarItems] = useState<CalendarItem[]>(calendarSeed);
  const [messages, setMessages] = useState<MessageItem[]>(messageSeed);
  const [teacherTasks, setTeacherTasks] = useState<TeacherTask[]>(taskSeed);
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("All");
  const [riskOnly, setRiskOnly] = useState(false);
  const [selectedReport, setSelectedReport] = useState(reportTemplates[0].id);
  const [selectedColumns, setSelectedColumns] = useState<string[]>(reportTemplates[0].fields);
  const [sortKey, setSortKey] = useState("Name");
  const [groupKey, setGroupKey] = useState("None");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("attendanceRate");
  const [chartKind, setChartKind] = useState<ChartKind>("pie");
  const [chartGroup, setChartGroup] = useState<"Students" | "Grades" | "Status">("Students");
  const [compareIds, setCompareIds] = useState<string[]>(["s004", "s008"]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView[]>(savedViewsSeed);
  const [favorites, setFavorites] = useState<ModuleId[]>(["overview", "teacherAttendance", "attendance", "reports", "charts"]);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [darkMode, setDarkMode] = useState(false);
  const [syncBaseUrl, setSyncBaseUrl] = useState("");
  const [syncKeyName, setSyncKeyName] = useState("FACTS_API_KEY");

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/bootstrap`)
      .then((response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return response.json() as Promise<BootstrapData>;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.students?.length) setStudentRecords(data.students);
        if (data.attendanceRecords?.length) setAttendanceData(data.attendanceRecords);
        if (data.schoolClasses?.length) setClassRecords(data.schoolClasses);
        if (data.calendarItems?.length) setCalendarItems(data.calendarItems);
        if (data.messages?.length) setMessages(data.messages);
        if (data.teacherTasks?.length) setTeacherTasks(data.teacherTasks);
        if (data.guardians) setGuardianRecords(data.guardians);
        if (data.documents) setDocumentRecords(data.documents);
        if (data.services) setServiceRecords(data.services);
        if (data.communicationLogs) setCommunicationRecords(data.communicationLogs);
        if (data.timelineEvents) setTimelineRecords(data.timelineEvents);
        if (data.accountProfiles?.length) {
          setAccountRecords(data.accountProfiles);
          setCurrentUser((current) => data.accountProfiles?.find((profile) => profile.id === current.id) ?? current);
        }
        if (data.auditLog) setAuditLog(data.auditLog);
        setApiStatus(`Saved data loaded${data.updated ? ` ${new Date(data.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}.`);
      })
      .catch((error: Error) => setApiStatus(`Using mock data. Start agent:api for persistence. ${error.message}`));
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleStudents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return studentRecords.filter((student) => {
      const text = [
        studentName(student),
        student.grade,
        student.homeroom,
        student.advisor,
        student.family,
        student.primaryContact,
        student.notes,
        student.status,
        student.allergies,
        student.activities.join(" ")
      ].join(" ").toLowerCase();
      const matchesQuery = !normalized || text.includes(normalized);
      const matchesGrade = grade === "All" || student.grade === grade;
      const matchesRisk = !riskOnly || isRisk(student);
      return matchesQuery && matchesGrade && matchesRisk;
    });
  }, [query, grade, riskOnly, studentRecords]);

  const stats = useMemo(() => {
    const present = attendanceData.filter((record) => record.code === "Present").length;
    const absent = attendanceData.filter((record) => record.code === "Absent").length;
    const tardy = attendanceData.filter((record) => record.code === "Tardy").length;
    const intervention = studentRecords.filter((student) => student.status === "Intervention").length;
    const lowLunch = studentRecords.filter((student) => student.lunchBalance < 10).length;
    const missingWork = studentRecords.reduce((sum, student) => sum + student.missingAssignments, 0);
    const unexcused = attendanceData.filter((record) => !record.excused).length;
    return { present, absent, tardy, intervention, lowLunch, missingWork, unexcused };
  }, [attendanceData, studentRecords]);

  const hasWriteRole = (allowed: Role[]) => allowed.includes(activeRole);

  const guardedWrite = (allowed: Role[], action: string) => {
    if (hasWriteRole(allowed)) return true;
    setApiStatus(`${action} blocked for ${currentUser.role}. Switch to an admin, office, or permitted staff profile.`);
    return false;
  };

  const inbox: InboxItem[] = [
    { id: "absent", module: "attendance", title: "Absence follow-up", detail: "Verify unexcused attendance before closeout.", count: stats.unexcused, tone: "red" },
    { id: "missing", module: "academics", title: "Missing work packets", detail: "Advisor packets can be exported now.", count: studentRecords.filter((student) => student.missingAssignments > 4).length, tone: "purple" },
    { id: "lunch", module: "lunch", title: "Lunch balance notices", detail: "Low and negative balances need cafeteria review.", count: stats.lowLunch, tone: "gold" },
    { id: "coverage", module: "staff", title: "Coverage needs", detail: "Open staff coverage or duty issues.", count: staff.filter((item) => item.coverageNeed !== "None").length, tone: "blue" }
  ];

  const selectedTemplate = reportTemplates.find((template) => template.id === selectedReport) ?? reportTemplates[0];
  const allReportRows: Record<string, string | number>[] = buildReportRows(selectedReport, visibleStudents, attendanceData, staff);
  const reportRows = useMemo(() => {
    const projected = allReportRows.map((row) => {
      const keys = selectedColumns.length ? selectedColumns : Object.keys(row);
      const typedRow = row as Record<string, string | number>;
      return Object.fromEntries(keys.filter((key) => key in typedRow).map((key) => [key, typedRow[key]])) as Record<string, string | number>;
    });
    return projected.sort((a, b) => String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""), undefined, { numeric: true }));
  }, [allReportRows, selectedColumns, sortKey]);

  const selectedStudent = profileId ? studentRecords.find((student) => student.id === profileId) ?? null : null;
  const selectedProfileData: StudentProfileData | null = selectedStudent ? {
    guardians: guardianRecords.filter((guardian) => guardian.studentId === selectedStudent.id),
    siblings: studentRecords.filter((student) => student.family === selectedStudent.family && student.id !== selectedStudent.id),
    documents: documentRecords.filter((document) => document.studentId === selectedStudent.id),
    services: serviceRecords.filter((service) => service.studentId === selectedStudent.id),
    communications: communicationRecords.filter((log) => log.studentId === selectedStudent.id),
    timeline: timelineRecords.filter((event) => event.studentId === selectedStudent.id)
  } : null;
  const comparedStudents = compareIds.map((id) => studentRecords.find((student) => student.id === id)).filter(Boolean) as Student[];
  const updateStudent = (id: string, patch: Partial<Student>) => {
    setStudentRecords((current) => current.map((student) => student.id === id ? { ...student, ...patch } : student));
    fetch(`${apiBase}/api/students/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-agent-name": currentUser.name },
      body: JSON.stringify(patch)
    })
      .then((response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return response.json() as Promise<{ student: Student; updated: string }>;
      })
      .then(({ student, updated }) => {
        setStudentRecords((current) => current.map((item) => item.id === id ? student : item));
        setApiStatus(`Saved ${studentName(student)} at ${new Date(updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
        refreshAuditLog();
      })
      .catch((error: Error) => setApiStatus(`Student edit is local only. ${error.message}`));
  };

  const refreshAuditLog = () => {
    fetch(`${apiBase}/api/audit`)
      .then((response) => response.ok ? response.json() as Promise<{ auditLog: AuditEntry[] }> : Promise.reject(new Error(`API ${response.status}`)))
      .then((data) => setAuditLog(data.auditLog))
      .catch(() => undefined);
  };

  const persistCollection = <T,>(collection: string, items: T[], reason: string) => {
    fetch(`${apiBase}/api/collections/${collection}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-name": currentUser.name },
      body: JSON.stringify({ items, reason })
    })
      .then((response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return response.json() as Promise<{ updated: string; auditLog: AuditEntry[] }>;
      })
      .then(({ updated, auditLog }) => {
        setAuditLog(auditLog);
        setApiStatus(`Saved ${collection} at ${new Date(updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
      })
      .catch((error: Error) => setApiStatus(`${collection} change is local only. ${error.message}`));
  };

  const updateCalendarItems: React.Dispatch<React.SetStateAction<CalendarItem[]>> = (value) => {
    setCalendarItems((current) => {
      if (!guardedWrite(["Admin", "Office", "Teacher"], "calendar workflow update")) return current;
      const next = typeof value === "function" ? value(current) : value;
      persistCollection("calendarItems", next, "calendar workflow update");
      return next;
    });
  };

  const updateMessages: React.Dispatch<React.SetStateAction<MessageItem[]>> = (value) => {
    setMessages((current) => {
      if (!guardedWrite(["Admin", "Office", "Teacher"], "message workflow update")) return current;
      const next = typeof value === "function" ? value(current) : value;
      persistCollection("messages", next, "message workflow update");
      return next;
    });
  };

  const updateTeacherTasks: React.Dispatch<React.SetStateAction<TeacherTask[]>> = (value) => {
    setTeacherTasks((current) => {
      if (!guardedWrite(["Admin", "Office", "Teacher"], "task workflow update")) return current;
      const next = typeof value === "function" ? value(current) : value;
      persistCollection("teacherTasks", next, "task workflow update");
      return next;
    });
  };

  const updateClassRecords: React.Dispatch<React.SetStateAction<SchoolClass[]>> = (value) => {
    setClassRecords((current) => {
      if (!guardedWrite(["Admin", "Office"], "class workflow update")) return current;
      const next = typeof value === "function" ? value(current) : value;
      persistCollection("schoolClasses", next, "class workflow update");
      return next;
    });
  };

  const updateAccountRecords: React.Dispatch<React.SetStateAction<AccountProfile[]>> = (value) => {
    setAccountRecords((current) => {
      if (!guardedWrite(["Admin", "Office"], "account workflow update")) return current;
      const next = typeof value === "function" ? value(current) : value;
      persistCollection("accountProfiles", next, "account workflow update");
      const refreshedUser = next.find((profile) => profile.id === currentUser.id);
      if (refreshedUser) setCurrentUser(refreshedUser);
      return next;
    });
  };

  const submitAttendance = async (section: string, entries: { studentId: string; code: AttendanceCode }[]) => {
    const response = await fetch(`${apiBase}/api/attendance/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-name": currentUser.name },
      body: JSON.stringify({ section, date: today, entries })
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
    const result = await response.json() as { records: AttendanceRecord[]; schoolClasses: SchoolClass[]; updated: string };
    setAttendanceData((current) => {
      const byKey = new Map(current.map((record) => [`${record.date}:${record.studentId}`, record]));
      result.records.forEach((record) => byKey.set(`${record.date}:${record.studentId}`, record));
      return [...byKey.values()];
    });
    setClassRecords(result.schoolClasses);
    setApiStatus(`Attendance saved at ${new Date(result.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
    refreshAuditLog();
    return result.records.length;
  };

  const setModule = (module: ModuleId) => {
    setActiveModule(module);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const applySavedView = (view: SavedView) => {
    setQuery(view.query);
    setGrade(view.grade);
    setRiskOnly(view.riskOnly);
    setModule(view.module);
  };

  const saveCurrentView = () => {
    const label = `${modules.find((module) => module.id === activeModule)?.label ?? "View"} ${grade}${riskOnly ? " watch" : ""}`;
    setSavedViews((current) => [
      { id: `sv${Date.now()}`, name: label, module: activeModule, query, grade, riskOnly, description: "Saved from the current filters." },
      ...current
    ].slice(0, 8));
  };

  const toggleFavorite = (module: ModuleId) => {
    setFavorites((current) => current.includes(module) ? current.filter((item) => item !== module) : [...current, module]);
  };

  const toggleCompare = (id: string) => {
    setCompareIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(-4));
  };

  const exportRows = (filename: string, rows = reportRows) => downloadFile(filename, toCsv(rows));
  const exportMockBackup = () => downloadFile(`stjw-backup-${today}.json`, JSON.stringify({ students: studentRecords, guardians: guardianRecords, attendanceRecords: attendanceData, schoolClasses: classRecords, accountProfiles: accountRecords, staff, timelineEvents: timelineRecords, savedViews }, null, 2), "application/json");

  const printReport = () => {
    const html = `<html><head><title>${selectedTemplate.name}</title><style>body{font-family:Arial,sans-serif;color:#17211d;padding:24px}h1{margin:0 0 4px}p{margin:0 0 18px;color:#66736d}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d7dfda;padding:7px;text-align:left}th{background:#edf3ef}</style></head><body><h1>${selectedTemplate.name}</h1><p>${today} - ${selectedTemplate.description}</p>${tableHtml(reportRows)}</body></html>`;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.print();
  };

  return (
    <div className={`appShell ${density} ${darkMode ? "darkMode" : ""}`}>
      <aside className="sidebar">
        <div className="brandBlock">
          <span>STJW</span>
          <strong>Blue Knight Ops</strong>
          <small>St. Joseph the Worker School - Orefield, PA</small>
        </div>
        <SidebarNav activeModule={activeModule} favorites={favorites} setModule={setModule} toggleFavorite={toggleFavorite} savedViews={savedViews} applySavedView={applySavedView} />
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p>Friday, May 8, 2026</p>
            <h1>{modules.find((module) => module.id === activeModule)?.label}</h1>
            <small>{apiStatus}</small>
          </div>
          <div className="headerTools">
            <label>Role<select value={activeRole} onChange={(event) => setActiveRole(event.target.value as Role)}>{roles.map((role) => <option key={role}>{role}</option>)}</select></label>
            <label>Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Student, family, note, teacher" /></label>
            <label>Grade<select value={grade} onChange={(event) => setGrade(event.target.value)}>{grades.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="checkLabel"><input checked={riskOnly} onChange={(event) => setRiskOnly(event.target.checked)} type="checkbox" /> Watch only</label>
            <button className="toolButton" onClick={saveCurrentView}>Save View</button>
            <button className="toolButton" onClick={() => setDensity(density === "comfortable" ? "compact" : "comfortable")}>{density === "comfortable" ? "Compact" : "Comfort"}</button>
            <button className="toolButton" onClick={() => setDarkMode(!darkMode)}>{darkMode ? "Light" : "Dark"}</button>
            <ProfileMenu accountProfiles={accountRecords} currentUser={currentUser} setCurrentUser={setCurrentUser} open={profileOpen} setOpen={setProfileOpen} setModule={setModule} />
          </div>
        </header>

        <ModuleIntro module={activeModule} />
        {activeModule === "overview" && <Overview stats={stats} inbox={inbox} visibleStudents={visibleStudents} allStudents={studentRecords} accountProfiles={accountRecords} setModule={setModule} setProfileId={setProfileId} toggleCompare={toggleCompare} />}
        {activeModule === "teacherAttendance" && <TeacherAttendanceView students={studentRecords} submitAttendance={submitAttendance} />}
        {activeModule === "teacherCalendar" && <TeacherCalendarView currentUser={currentUser} calendarItems={calendarItems} setCalendarItems={updateCalendarItems} />}
        {activeModule === "masterCalendar" && <MasterCalendarView calendarItems={calendarItems} setCalendarItems={updateCalendarItems} />}
        {activeModule === "messages" && <MessagesView currentUser={currentUser} messages={messages} setMessages={updateMessages} />}
        {activeModule === "tasks" && <TasksView currentUser={currentUser} teacherTasks={teacherTasks} setTeacherTasks={updateTeacherTasks} />}
        {activeModule === "security" && <SecurityView auditLog={auditLog} refreshAuditLog={refreshAuditLog} />}
        {activeModule === "attendanceMonitor" && <AttendanceMonitorView classes={classRecords} />}
        {activeModule === "classes" && <ClassesView classes={classRecords} setClasses={updateClassRecords} />}
        {activeModule === "attendance" && <AttendanceView visibleStudents={visibleStudents} attendanceRecords={attendanceData} setProfileId={setProfileId} toggleCompare={toggleCompare} exportRows={exportRows} />}
        {activeModule === "students" && <StudentsView visibleStudents={visibleStudents} setProfileId={setProfileId} toggleCompare={toggleCompare} compareIds={compareIds} exportRows={exportRows} updateStudent={updateStudent} />}
        {activeModule === "people" && <PeopleView accountProfiles={accountRecords} />}
        {activeModule === "enrollment" && <EnrollmentView />}
        {activeModule === "health" && <HealthView students={studentRecords} setProfileId={setProfileId} />}
        {activeModule === "familyPortal" && <FamilyPortalView students={studentRecords} setModule={setModule} />}
        {activeModule === "academics" && <AcademicsView visibleStudents={visibleStudents} setProfileId={setProfileId} exportRows={exportRows} updateStudent={updateStudent} />}
        {activeModule === "behavior" && <BehaviorView visibleStudents={visibleStudents} setProfileId={setProfileId} />}
        {activeModule === "lunch" && <LunchView visibleStudents={visibleStudents} exportRows={exportRows} />}
        {activeModule === "staff" && <StaffView />}
        {activeModule === "admin" && <AdminView accountProfiles={accountRecords} setAccountProfiles={updateAccountRecords} />}
        {activeModule === "integrations" && <IntegrationsView />}
        {activeModule === "reports" && (
          <ReportsView
            selectedReport={selectedReport}
            setSelectedReport={(id) => {
              setSelectedReport(id);
              setSelectedColumns(reportTemplates.find((template) => template.id === id)?.fields ?? []);
            }}
            selectedTemplate={selectedTemplate}
            selectedColumns={selectedColumns}
            setSelectedColumns={setSelectedColumns}
            sortKey={sortKey}
            setSortKey={setSortKey}
            groupKey={groupKey}
            setGroupKey={setGroupKey}
            reportRows={reportRows}
            allFields={Object.keys(allReportRows[0] ?? {})}
            exportReport={() => exportRows(`${selectedTemplate.id}-${today}.csv`)}
            printReport={printReport}
          />
        )}
        {activeModule === "charts" && <ChartsView chartMetric={chartMetric} setChartMetric={setChartMetric} chartKind={chartKind} setChartKind={setChartKind} chartGroup={chartGroup} setChartGroup={setChartGroup} comparedStudents={comparedStudents} visibleStudents={visibleStudents} />}
        {activeModule === "agentApi" && <AgentApiView />}
        {activeModule === "sync" && <SyncView syncBaseUrl={syncBaseUrl} setSyncBaseUrl={setSyncBaseUrl} syncKeyName={syncKeyName} setSyncKeyName={setSyncKeyName} />}

        {compareIds.length > 0 && <CompareTray students={comparedStudents} setModule={setModule} remove={toggleCompare} />}
        {selectedStudent && selectedProfileData && <ProfileDrawer student={selectedStudent} profileData={selectedProfileData} close={() => setProfileId(null)} toggleCompare={toggleCompare} updateStudent={updateStudent} />}
      </main>
    </div>
  );
}

function SidebarNav({ activeModule, favorites, setModule, toggleFavorite, savedViews, applySavedView }: {
  activeModule: ModuleId;
  favorites: ModuleId[];
  setModule: (module: ModuleId) => void;
  toggleFavorite: (module: ModuleId) => void;
  savedViews: SavedView[];
  applySavedView: (view: SavedView) => void;
}) {
  return (
    <section className="sidebarNav">
      <div className="quickAccess">
        <h2>Favorites</h2>
      <div className="quickPills">
        {favorites.map((module) => <button key={module} onClick={() => setModule(module)}>{modules.find((item) => item.id === module)?.label}</button>)}
      </div>
      <select onChange={(event) => {
        const view = savedViews.find((item) => item.id === event.target.value);
        if (view) applySavedView(view);
      }} defaultValue="">
        <option value="" disabled>Saved views</option>
        {savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </select>
      </div>
      <nav>
        {navGroups.map((group, index) => (
          <details key={group.title} open={index < 2 || group.items.includes(activeModule)}>
            <summary><span>{group.title}</span><small>{group.description}</small></summary>
            <div>
              {group.items.map((id) => {
                const module = modules.find((item) => item.id === id)!;
                return (
                  <button key={id} className={activeModule === id ? "active" : ""} onClick={() => setModule(id)}>
                    <span>{module.label}</span>
                    <small>{module.hint}</small>
                    <em onClick={(event) => { event.stopPropagation(); toggleFavorite(id); }}>{favorites.includes(id) ? "Pinned" : "Pin"}</em>
                  </button>
                );
              })}
            </div>
          </details>
        ))}
      </nav>
    </section>
  );
}

function ProfileMenu({ accountProfiles, currentUser, setCurrentUser, open, setOpen, setModule }: {
  accountProfiles: AccountProfile[];
  currentUser: AccountProfile;
  setCurrentUser: (user: AccountProfile) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  setModule: (module: ModuleId) => void;
}) {
  return (
    <div className="profileMenu">
      <button className="profileButton" onClick={() => setOpen(!open)}>
        <span>{currentUser.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</span>
        <div>
          <strong>{currentUser.name}</strong>
          <small>{currentUser.role}</small>
        </div>
      </button>
      {open && (
        <div className="profilePopover">
          <strong>Signed in as</strong>
          <span>{currentUser.email}</span>
          <label>Mock login<select value={currentUser.id} onChange={(event) => {
            const next = accountProfiles.find((profile) => profile.id === event.target.value);
            if (next) setCurrentUser(next);
          }}>{accountProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} - {profile.type}</option>)}</select></label>
          <button onClick={() => setModule("admin")}>Manage Accounts</button>
          <button onClick={() => setModule("integrations")}>Connect Google</button>
          <button onClick={() => setOpen(false)}>Close Menu</button>
          <small>Mock auth now. Later this becomes Google/local sign-in with role permissions.</small>
        </div>
      )}
    </div>
  );
}

function ModuleIntro({ module }: { module: ModuleId }) {
  const copy: Record<ModuleId, { title: string; body: string; bullets: string[] }> = {
    overview: { title: "Start here each morning.", body: "This page explains what needs attention before the school day settles: attendance closeout, high-risk students, staff coverage, and reports that can be generated immediately.", bullets: ["Use the alert buttons to jump to the work.", "Pin a student to compare them later.", "Open Grade Snapshot when you need grade-level context."] },
    teacherAttendance: { title: "Teacher-friendly attendance.", body: "Teachers can pull up a class roster, see student cards, and tap each student present, absent, tardy, or early dismissal. The workflow is designed to be fast on a classroom display.", bullets: ["Use large roster cards instead of spreadsheets.", "Submit once to update the school attendance queue.", "Designed for future Google Classroom or FACTS roster sync."] },
    teacherCalendar: { title: "Teacher schedule and requests.", body: "Teachers can see their schedule, request time off, mark sick days, and propose school events for admin approval.", bullets: ["Submit requests from one form.", "Warnings appear when coverage is needed.", "Approved items flow to the master calendar."] },
    masterCalendar: { title: "Admin master calendar.", body: "Administrators can oversee all teacher requests, school events, coverage needs, and calendar conflicts from one place.", bullets: ["Approve or deny requests.", "Watch coverage warnings.", "Prepare future Google Calendar sync."] },
    messages: { title: "Message board and acknowledgements.", body: "Users can message groups while excluding roles or people. Admin messages can require acknowledgement before users continue.", bullets: ["Send to staff, teachers, parents, or students.", "Exclude users or roles.", "Track required confirmations."] },
    tasks: { title: "Teacher task system.", body: "Teachers can create, edit, prioritize, and complete work items linked to students, classes, or school operations.", bullets: ["Track blocked tasks.", "Link to students.", "Use due dates and priority."] },
    security: { title: "Security gates.", body: "This page describes how data changes, syncs, approvals, and messages should be controlled by roles and audit logs.", bullets: ["Role gates for every workflow.", "Approval gates for risky actions.", "Audit logs for all writes and syncs."] },
    attendanceMonitor: { title: "Monitor class attendance submissions.", body: "Office staff can see which teachers submitted attendance, which classes are missing, and what will sync into the school attendance record.", bullets: ["Watch all class submission states.", "Open missing classes quickly.", "Review the sync destination and queue."] },
    classes: { title: "Manage classes and rosters.", body: "Create classes, assign teachers, manage rooms/periods, and review rosters before attendance or grade workflows depend on them.", bullets: ["Add or edit class sections.", "Review roster counts.", "Prepare Google Classroom or FACTS roster sync."] },
    attendance: { title: "Resolve attendance quickly.", body: "The register combines today’s attendance code with year-to-date patterns so office staff can see whether an absence or tardy is isolated or part of a larger trend.", bullets: ["Click a student name for the full profile.", "Export the closeout list for the office.", "Use the heatmap to compare grades."] },
    students: { title: "Read student context without digging.", body: "Student cards surface family, advisor, allergies, risk, and key metrics. The profile drawer adds the timeline so staff can understand the story behind the numbers.", bullets: ["Profile opens detailed context.", "Compare pins students to the bottom tray.", "Family groups prepare directory exports."] },
    people: { title: "Manage every person connected to the school.", body: "This combines staff, parents, and student profiles into one people directory so admins can find accounts, family links, invites, and role status quickly.", bullets: ["Filter by profile type.", "See account setup status.", "Prepare parent and student portal access."] },
    enrollment: { title: "Move every family from inquiry to first day.", body: "A visual admissions pipeline keeps applications, documents, decisions, contracts, and onboarding in one connected workflow.", bullets: ["See conversion and bottlenecks at a glance.", "Chase missing documents from one queue.", "Hand enrolled students directly into the school record."] },
    health: { title: "Put critical care information where staff need it.", body: "Health and safety combines allergy alerts, care plans, immunization compliance, medication schedules, and visit tracking with permission-aware access.", bullets: ["Surface urgent alerts without exposing unnecessary detail.", "Track medication administration and expiring forms.", "Prepare emergency and field-trip exports."] },
    familyPortal: { title: "Give families one calm, useful home.", body: "The family experience brings grades, attendance, schedules, messages, forms, and balances into a mobile-friendly action center.", bullets: ["Prioritize actions instead of duplicating the admin UI.", "Keep siblings under one household view.", "Respect each guardian's communication preferences."] },
    academics: { title: "Turn missing work into advisor action.", body: "This view highlights GPA, missing work, and recommended action. It is designed for weekly advisor packets and student check-ins.", bullets: ["Sort/export academic rows.", "Find grades with the highest missing-work load.", "Open profiles before contacting families."] },
    behavior: { title: "Separate recognition from intervention.", body: "Behavior points show both positive recognition and students who need follow-up. The goal is to help staff respond consistently instead of relying on memory.", bullets: ["Chart behavior patterns.", "Open follow-up students.", "Use timeline entries in the profile drawer."] },
    lunch: { title: "Make cafeteria work easier.", body: "Lunch balances and allergies are together so cafeteria staff can handle notices and safety checks in one view. Billing stays last, but balance workflow is ready.", bullets: ["Export low-balance notices.", "Watch allergy counts.", "Filter by grade or family."] },
    staff: { title: "See coverage before it becomes a problem.", body: "Staff coverage and open tasks are shown with a simple daily coverage list for the office and administration.", bullets: ["Review coverage needs.", "Check task load by department.", "Use this before morning announcements."] },
    admin: { title: "Create accounts and manage permissions.", body: "The admin system will control staff, parent, and student access. This mockup starts the workflow for invites, roles, profile linking, and permission review.", bullets: ["Create users in batches.", "Invite parents and staff.", "Assign role templates and audit access."] },
    integrations: { title: "Connect outside systems deliberately.", body: "Google account and Google Classroom connection steps are laid out as a real workflow. Live connection requires a Google Cloud project, OAuth consent screen, and credentials from the school domain.", bullets: ["Use Google Identity Services for browser consent.", "Use authorization code flow when a backend is added.", "Classroom can sync courses, rosters, coursework, and submissions."] },
    reports: { title: "Build the report you actually need.", body: "Reports can be selected, filtered, grouped, sorted, printed, or exported. This becomes the replacement for repetitive spreadsheet work.", bullets: ["Choose only the columns people need.", "Group by grade, advisor, status, or family.", "Export CSV or print a clean report."] },
    charts: { title: "Generate charts from any school data.", body: "Use this as the chart studio for the app. Pick a chart type, metric, and grouping, then use the same idea on attendance, academics, behavior, lunch, reports, and student comparisons.", bullets: ["Create pie, donut, line, bar, horizontal bar, stacked, and KPI views.", "Switch between student, grade, and status groupings.", "Use grade comparison for admin meetings."] },
    agentApi: { title: "Let agents work with data safely.", body: "This is the contract for local programmatic access. Agents should use explicit endpoints to read, patch, import, export, and generate reports instead of scraping the UI.", bullets: ["Run the local API server when needed.", "Use JSON for imports/exports.", "Keep audit logs for every write once security is added."] },
    sync: { title: "Prepare for FACTS without blocking progress.", body: "FACTS remains a mapping screen until endpoint URLs and authentication details are available. The local schema is being shaped now so live sync can land cleanly later.", bullets: ["Map each FACTS area to a local table.", "Support CSV snapshots first.", "Keep billing endpoints last."] }
  };
  const current = copy[module];
  return (
    <section className="moduleIntro">
      <div>
        <h2>{current.title}</h2>
        <p>{current.body}</p>
      </div>
      <ul>{current.bullets.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}

function QuickCommand({ inbox, setModule, exportMockBackup }: { inbox: InboxItem[]; setModule: (module: ModuleId) => void; exportMockBackup: () => void }) {
  return (
    <section className="commandStrip">
      <button onClick={() => setModule("attendance")}>Morning Closeout</button>
      <button onClick={() => setModule("reports")}>Build Report</button>
      <button onClick={() => setModule("charts")}>Compare Data</button>
      <button onClick={() => setModule("integrations")}>Connect Google</button>
      <button onClick={() => setModule("agentApi")}>Agent API</button>
      <button onClick={exportMockBackup}>Backup Mock Data</button>
      <div>
        {inbox.map((item) => <button key={item.id} className={`miniAlert ${item.tone}`} onClick={() => setModule(item.module)}>{item.count} {item.title}</button>)}
      </div>
    </section>
  );
}

function Overview({ stats, inbox, visibleStudents, allStudents, accountProfiles, setModule, setProfileId, toggleCompare }: {
  stats: { present: number; absent: number; tardy: number; intervention: number; lowLunch: number; missingWork: number; unexcused: number };
  inbox: InboxItem[];
  visibleStudents: Student[];
  allStudents: Student[];
  accountProfiles: AccountProfile[];
  setModule: (module: ModuleId) => void;
  setProfileId: (id: string) => void;
  toggleCompare: (id: string) => void;
}) {
  const risk = visibleStudents.filter(isRisk).sort((a, b) => riskScore(b) - riskScore(a));
  return (
    <section className="humanWorkspace">
      <div className="focusHero">
        <div>
          <span>Today at a glance</span>
          <h2>What do you need to do?</h2>
          <p>Pick the job first. The app will show the right data after that, instead of making you read every dashboard at once.</p>
        </div>
        <StudentLookup students={allStudents} setProfileId={setProfileId} />
      </div>
      <div className="jobGrid">
        <button onClick={() => setModule("teacherAttendance")}>
          <strong>Take attendance</strong>
          <span>{stats.present} present, {stats.absent} absent, {stats.tardy} tardy</span>
        </button>
        <button onClick={() => setModule("attendance")}>
          <strong>Close out office attendance</strong>
          <span>{stats.unexcused} unexcused items need review</span>
        </button>
        <button onClick={() => setModule("students")}>
          <strong>Find or edit a student</strong>
          <span>{allStudents.length} student records available</span>
        </button>
        <button onClick={() => setModule("reports")}>
          <strong>Build a report</strong>
          <span>Attendance, family, academic, lunch, staff</span>
        </button>
        <button onClick={() => setModule("charts")}>
          <strong>Chart or compare data</strong>
          <span>Pie, donut, line, bar, KPI boards</span>
        </button>
        <button onClick={() => setModule("admin")}>
          <strong>Manage accounts</strong>
          <span>{accountProfiles.filter((profile) => profile.status !== "Active").length} accounts need setup</span>
        </button>
      </div>
      <EcosystemMap setModule={setModule} />
      <div className="focusRow">
        <section>
          <h3>Needs attention</h3>
          <InboxList inbox={inbox.slice(0, 3)} setModule={setModule} />
        </section>
        <section>
          <h3>Highest priority students</h3>
          <StudentList students={risk.slice(0, 3)} setProfileId={setProfileId} toggleCompare={toggleCompare} compact />
        </section>
      </div>
    </section>
  );
}

function EcosystemMap({ setModule }: { setModule: (module: ModuleId) => void }) {
  const hubs: { id: ModuleId; eyebrow: string; title: string; detail: string }[] = [
    { id: "enrollment", eyebrow: "Welcome", title: "Admissions", detail: "Inquiry · application · onboarding" },
    { id: "academics", eyebrow: "Grow", title: "Student success", detail: "Learning · attendance · wellbeing" },
    { id: "familyPortal", eyebrow: "Connect", title: "Family experience", detail: "Messages · forms · schedules" },
    { id: "reports", eyebrow: "Decide", title: "Intelligence", detail: "Dashboards · trends · reports" }
  ];
  return (
    <section className="ecosystemPanel" aria-labelledby="ecosystem-title">
      <div className="ecosystemHeading">
        <div><span>Connected school</span><h3 id="ecosystem-title">One record. Four clear journeys.</h3></div>
        <p>Every workflow returns to the same student, family, and school record—so people see context, not disconnected screens.</p>
      </div>
      <div className="ecosystemMap">
        <div className="ecosystemCore"><small>STJW IQ</small><strong>Unified<br />school record</strong><span>63 students · live operations</span></div>
        {hubs.map((hub, index) => (
          <button key={hub.id} className={`ecosystemHub hub${index + 1}`} onClick={() => setModule(hub.id)}>
            <small>{hub.eyebrow}</small><strong>{hub.title}</strong><span>{hub.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function EnrollmentView() {
  const stages = [
    { name: "Inquiries", count: 28, change: "+6 this month", tone: "blue" },
    { name: "Applications", count: 19, change: "68% conversion", tone: "purple" },
    { name: "Accepted", count: 14, change: "3 awaiting reply", tone: "gold" },
    { name: "Enrolled", count: 11, change: "79% yield", tone: "green" }
  ];
  return (
    <section className="moduleWorkspace">
      <div className="pipeline" aria-label="Enrollment funnel">
        {stages.map((stage, index) => <article key={stage.name} className={stage.tone}><small>0{index + 1}</small><strong>{stage.count}</strong><h3>{stage.name}</h3><span>{stage.change}</span></article>)}
      </div>
      <div className="workspaceGrid">
        <section className="panel actionQueue"><div className="panelHeader"><div><span>Priority queue</span><h2>Families needing attention</h2></div><button>Send reminder</button></div>
          {[['Lopez family','Birth certificate missing','Due today'],['Miller family','Tuition agreement unsigned','2 days'],['Chen family','Schedule welcome meeting','This week']].map(([name,task,due]) => <div className="actionRow" key={name}><span className="avatarToken">{name[0]}</span><div><strong>{name}</strong><span>{task}</span></div><em>{due}</em><button>Open</button></div>)}
        </section>
        <section className="panel journeyCard"><div className="panelHeader"><div><span>Workflow health</span><h2>Application journey</h2></div></div><div className="journeyLine"><i className="done"/><i className="done"/><i className="active"/><i/></div><ol><li>Inquiry received</li><li>Application reviewed</li><li>Family decision</li><li>Student onboarding</li></ol><p>Most delay happens between acceptance and signed enrollment. Automate a friendly reminder after 48 hours.</p></section>
      </div>
    </section>
  );
}

function HealthView({ students, setProfileId }: { students: Student[]; setProfileId: (id: string) => void }) {
  const alerts = students.filter((student) => student.allergies && student.allergies !== "None").slice(0, 6);
  return (
    <section className="moduleWorkspace">
      <div className="healthHero"><div><span>Today's care desk</span><h2>Safety information, made actionable.</h2><p>Critical alerts stay visible while detailed health records remain permission controlled.</p></div><div className="healthPulse"><strong>{alerts.length}</strong><span>active allergy alerts</span></div></div>
      <div className="healthMetrics"><article><span>Medication due</span><strong>3</strong><small>Next at 11:30 AM</small></article><article><span>Forms expiring</span><strong>7</strong><small>Within 30 days</small></article><article><span>Immunization</span><strong>94%</strong><small>School compliance</small></article><article><span>Nurse visits</span><strong>4</strong><small>Today</small></article></div>
      <section className="panel"><div className="panelHeader"><div><span>Safety roster</span><h2>Student care alerts</h2></div><button>Emergency export</button></div><div className="careGrid">{alerts.map((student) => <button key={student.id} onClick={() => setProfileId(student.id)}><span className="careIcon">!</span><div><strong>{studentName(student)}</strong><span>Grade {student.grade} · {student.homeroom}</span><em>{student.allergies}</em></div><small>View care profile →</small></button>)}</div></section>
    </section>
  );
}

function FamilyPortalView({ students, setModule }: { students: Student[]; setModule: (module: ModuleId) => void }) {
  const child = students[0];
  return (
    <section className="familyPortalPreview">
      <div className="familyWelcome"><div><span>Good morning, Martin family</span><h2>Everything Ava needs, in one place.</h2><p>Friday, May 8 · 3 actions this week</p></div><div className="familyAvatar">AM</div></div>
      <div className="familyActionGrid"><button onClick={() => setModule("messages")}><span>1</span><strong>New message</strong><small>From Mrs. Kelly</small></button><button onClick={() => setModule("attendance")}><span>98%</span><strong>Attendance</strong><small>On track this term</small></button><button onClick={() => setModule("academics")}><span>{child?.gpa ?? 3.8}</span><strong>Learning snapshot</strong><small>No missing work</small></button><button onClick={() => setModule("lunch")}><span>$26.50</span><strong>Lunch balance</strong><small>Balance is healthy</small></button></div>
      <div className="workspaceGrid"><section className="panel"><div className="panelHeader"><div><span>Next up</span><h2>Family timeline</h2></div></div><div className="familyTimeline"><article><time>Today · 2:15 PM</time><strong>Early dismissal reminder</strong><span>Pickup at the main office</span></article><article><time>Monday · 8:00 AM</time><strong>Library books due</strong><span>2 books checked out</span></article><article><time>May 15</time><strong>Field trip permission</strong><span className="needsAction">Signature needed</span></article></div></section><section className="panel"><div className="panelHeader"><div><span>Quick actions</span><h2>What would you like to do?</h2></div></div><div className="portalActions"><button>Report an absence</button><button>Message a teacher</button><button>Complete a form</button><button>View full calendar</button></div></section></div>
    </section>
  );
}

function AttendanceView({ visibleStudents, attendanceRecords, setProfileId, toggleCompare, exportRows }: {
  visibleStudents: Student[];
  attendanceRecords: AttendanceRecord[];
  setProfileId: (id: string) => void;
  toggleCompare: (id: string) => void;
  exportRows: (filename: string, rows?: Record<string, string | number>[]) => void;
}) {
  const rows = visibleStudents.map((student) => ({ student, record: attendanceRecords.find((item) => item.studentId === student.id) }));
  const attendanceRows = rows.map(({ student, record }) => ({
    Name: studentName(student),
    Grade: student.grade,
    Code: record?.code ?? "Present",
    Late: record?.minutesLate ?? 0,
    Reason: record?.reason ?? "",
    Excused: record?.excused ? "Yes" : "No"
  }));
  return (
    <section className="taskPage">
      <TaskHeader title="Attendance workbench" body="Start with the attendance job you need. The register and watchlist are below when you need detail." />
      <TaskGrid tasks={[
        { title: "Review today", detail: `${attendanceRows.length} students in the current view` },
        { title: "Resolve exceptions", detail: `${attendanceRecords.filter((record) => !record.excused).length} unexcused items` },
        { title: "Export closeout", detail: "Create the office attendance CSV", onClick: () => exportRows(`attendance-${today}.csv`, attendanceRows) }
      ]} />
      <PageSummary items={[
        ["Unexcused", String(attendanceRecords.filter((item) => !item.excused).length)],
        ["Tardy Minutes", String(attendanceRecords.reduce((sum, item) => sum + item.minutesLate, 0))],
        ["Closeout", "4 tasks"]
      ]} />
      <div className="splitGrid wideLeft">
        <Panel title="Daily Register" action="Export" onAction={() => exportRows(`attendance-${today}.csv`, attendanceRows)}>
          <DataTable rows={attendanceRows} onNameClick={(name) => {
            const student = visibleStudents.find((item) => studentName(item) === name);
            if (student) setProfileId(student.id);
          }} />
        </Panel>
        <Panel title="Patterns">
          <MiniHeatmap />
          <div className="ruleGrid compactRules">
            <Rule title="Chronic absentee" value="< 90%" detail="Principal review." />
            <Rule title="Tardy pattern" value="5+" detail="Build call list." />
          </div>
        </Panel>
      </div>
      <Panel title="Attendance Watchlist">
        <StudentList students={visibleStudents.filter((student) => student.attendanceRate < 92 || student.tardies > 7).slice(0, 4)} setProfileId={setProfileId} toggleCompare={toggleCompare} />
      </Panel>
    </section>
  );
}

function StudentLookup({ students: items, setProfileId }: { students: Student[]; setProfileId: (id: string) => void }) {
  const [lookup, setLookup] = useState("");
  const matches = items
    .filter((student) => studentName(student).toLowerCase().includes(lookup.toLowerCase()) || student.family.toLowerCase().includes(lookup.toLowerCase()) || student.grade === lookup)
    .slice(0, 6);
  return (
    <div className="studentLookup">
      <input value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="Search student, family, or grade" />
      <div>
        {matches.map((student) => (
          <button key={student.id} onClick={() => setProfileId(student.id)}>
            <strong>{studentName(student)}</strong>
            <span>Grade {student.grade} - {student.family}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function StudentsView({ visibleStudents, setProfileId, toggleCompare, compareIds, exportRows, updateStudent }: {
  visibleStudents: Student[];
  setProfileId: (id: string) => void;
  toggleCompare: (id: string) => void;
  compareIds: string[];
  exportRows: (filename: string, rows?: Record<string, string | number>[]) => void;
  updateStudent: (id: string, patch: Partial<Student>) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <section className="taskPage">
      <TaskHeader title="Student records" body="Find, review, or edit student information without digging through every data point at once." />
      <TaskGrid tasks={[
        { title: "Open profile", detail: "Use the Profile button for full student details" },
        { title: "Quick edit", detail: "Update status, contact, allergies, lunch, and notes" },
        { title: "Export directory", detail: "Generate family and student CSV", onClick: () => exportRows(`family-directory-${today}.csv`, buildStudentRows(visibleStudents)) }
      ]} />
      <PageSummary items={[["Visible", String(visibleStudents.length)], ["Families", String(new Set(visibleStudents.map((student) => student.family)).size)], ["Compare Tray", String(compareIds.length)]]} />
      <div className="studentGrid">
        {visibleStudents.map((student) => (
          <article className="studentCard" key={student.id}>
            <div className="cardTop">
              <div><strong>{studentName(student)}</strong><span>Grade {student.grade} - {student.homeroom}</span></div>
              <StatusPill label={student.status} />
            </div>
            <dl>
              <div><dt>Advisor</dt><dd>{student.advisor}</dd></div>
              <div><dt>Contact</dt><dd>{student.primaryContact}</dd></div>
              <div><dt>Attendance</dt><dd>{percent(student.attendanceRate)}</dd></div>
              <div><dt>Lunch</dt><dd>{currency(student.lunchBalance)}</dd></div>
              <div><dt>Allergies</dt><dd>{student.allergies}</dd></div>
              <div><dt>Risk</dt><dd>{Math.round(riskScore(student))}</dd></div>
            </dl>
            <p>{student.notes}</p>
            <div className="cardActions">
              <button onClick={() => setProfileId(student.id)}>Profile</button>
              <button onClick={() => setEditingId(editingId === student.id ? null : student.id)}>{editingId === student.id ? "Done" : "Quick Edit"}</button>
              <button onClick={() => toggleCompare(student.id)}>{compareIds.includes(student.id) ? "Remove Compare" : "Compare"}</button>
            </div>
            {editingId === student.id && <StudentQuickEdit student={student} updateStudent={updateStudent} />}
          </article>
        ))}
      </div>
      <Panel title="Family Directory Preview" action="Export Families" onAction={() => exportRows(`family-directory-${today}.csv`, buildStudentRows(visibleStudents))}>
        <FamilyGroups visibleStudents={visibleStudents.slice(0, 6)} />
      </Panel>
    </section>
  );
}

function StudentQuickEdit({ student, updateStudent }: { student: Student; updateStudent: (id: string, patch: Partial<Student>) => void }) {
  return (
    <div className="quickEdit">
      <label>Status<select value={student.status} onChange={(event) => updateStudent(student.id, { status: event.target.value as StudentStatus })}><option>Active</option><option>Watch</option><option>Intervention</option></select></label>
      <label>Contact<input value={student.primaryContact} onChange={(event) => updateStudent(student.id, { primaryContact: event.target.value })} /></label>
      <label>Allergies<input value={student.allergies} onChange={(event) => updateStudent(student.id, { allergies: event.target.value })} /></label>
      <label>Lunch<input type="number" value={student.lunchBalance} onChange={(event) => updateStudent(student.id, { lunchBalance: Number(event.target.value) })} /></label>
      <label className="wideField">Notes<input value={student.notes} onChange={(event) => updateStudent(student.id, { notes: event.target.value })} /></label>
    </div>
  );
}

function TeacherAttendanceView({ students, submitAttendance }: { students: Student[]; submitAttendance: (section: string, entries: { studentId: string; code: AttendanceCode }[]) => Promise<number> }) {
  const roster = students.filter((student) => ["K", "1", "2", "3", "4"].includes(student.grade));
  const [section, setSection] = useState("3-A Homeroom");
  const [attendance, setAttendance] = useState<Record<string, AttendanceCode>>(() => Object.fromEntries(roster.map((student) => [student.id, "Present"])));
  const [submitStatus, setSubmitStatus] = useState("");
  const counts = {
    present: Object.values(attendance).filter((code) => code === "Present").length,
    absent: Object.values(attendance).filter((code) => code === "Absent").length,
    tardy: Object.values(attendance).filter((code) => code === "Tardy").length,
    early: Object.values(attendance).filter((code) => code === "Early Dismissal").length
  };
  const rows = roster.map((student) => ({ Name: studentName(student), Grade: student.grade, Homeroom: student.homeroom, Status: attendance[student.id] ?? "Present" }));
  return (
    <section className="taskPage">
      <TaskHeader title="Take classroom attendance" body="Teachers only need three things: pick the class, tap each student, and submit the clean roster." />
      <TaskGrid tasks={[
        { title: "Pick class", detail: section },
        { title: "Mark roster", detail: `${roster.length} students loaded` },
        { title: "Submit once", detail: `${counts.present} present, ${counts.absent} absent, ${counts.tardy} tardy` }
      ]} />
      <div className="teacherHero">
        <KnightScene />
        <div>
          <span>Classroom Mode</span>
          <h2>Tap each student, submit once, and the office gets a clean attendance record.</h2>
          <p>Roster cards are large, readable, and kid-friendly for classroom displays. When Google Classroom or FACTS rosters are connected, this screen can load the teacher’s actual sections automatically.</p>
        </div>
        <div className="classPicker">
          <label>Class Section<select value={section} onChange={(event) => setSection(event.target.value)}><option>3-A Homeroom</option><option>K-A Morning</option><option>5-B Advisory</option><option>8-A Period 1</option></select></label>
        </div>
      </div>
      <PageSummary items={[["Present", String(counts.present)], ["Absent", String(counts.absent)], ["Tardy", String(counts.tardy)]]} />
      <div className="rosterGrid">
        {roster.map((student, index) => (
          <article className={`rosterCard ${classNameForStatus(attendance[student.id] ?? "Present")}`} key={student.id}>
            <KidAvatar name={student.firstName} index={index} />
            <div>
              <strong>{student.firstName}</strong>
              <span>{student.lastName} - Grade {student.grade}</span>
              <small>{student.allergies !== "None" ? `Allergy: ${student.allergies}` : student.homeroom}</small>
            </div>
            <div className="attendanceButtons">
              {(["Present", "Absent", "Tardy", "Early Dismissal"] as AttendanceCode[]).map((code) => (
                <button key={code} className={attendance[student.id] === code ? "active" : ""} onClick={() => setAttendance((current) => ({ ...current, [student.id]: code }))}>{code === "Early Dismissal" ? "Early" : code}</button>
              ))}
            </div>
          </article>
        ))}
      </div>
      <div className="splitGrid">
        <Panel title="Submission Preview">
          <DataTable rows={rows} />
        </Panel>
        <Panel title="Send Attendance">
          <div className="submitBox">
            <strong>{section}</strong>
            <p>{counts.present} present, {counts.absent} absent, {counts.tardy} tardy, {counts.early} early dismissal.</p>
            <button onClick={() => {
              setSubmitStatus("Saving attendance...");
              submitAttendance(section, roster.map((student) => ({ studentId: student.id, code: attendance[student.id] ?? "Present" })))
                .then((count) => setSubmitStatus(`Saved ${count} attendance records for ${section}.`))
                .catch((error: Error) => setSubmitStatus(`Could not save attendance. ${error.message}`));
            }}>
              Submit to Attendance Queue
            </button>
            {submitStatus && <small className="actionStatus">{submitStatus}</small>}
            <small>Posts to the local API now; FACTS writeback stays behind the sync gate.</small>
          </div>
        </Panel>
      </div>
    </section>
  );
}

function KidAvatar({ name, index }: { name: string; index: number }) {
  const colors = ["#f4b37a", "#d98b6a", "#9d6b4e", "#f1c27d", "#7b4b35"];
  const shirts = ["#0a2f66", "#c8a24a", "#21835d", "#c13b35", "#7257a7"];
  return (
    <div className="kidAvatar" style={{ ["--skin" as string]: colors[index % colors.length], ["--shirt" as string]: shirts[index % shirts.length] }}>
      <i />
      <span>{name.slice(0, 1)}</span>
      <b />
    </div>
  );
}

function KnightScene() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!mountRef.current) return;
    const mount = mountRef.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(220, 160);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    const group = new THREE.Group();
    scene.add(group);
    const shield = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 0.72, 1.8, 5), new THREE.MeshStandardMaterial({ color: 0x0a2f66, metalness: 0.25, roughness: 0.42 }));
    shield.rotation.z = Math.PI;
    group.add(shield);
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.25, 0.08), new THREE.MeshStandardMaterial({ color: 0xc8a24a, metalness: 0.4, roughness: 0.35 }));
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 0.08), new THREE.MeshStandardMaterial({ color: 0xc8a24a, metalness: 0.4, roughness: 0.35 }));
    crossV.position.z = 0.5;
    crossH.position.z = 0.51;
    group.add(crossV, crossH);
    scene.add(new THREE.AmbientLight(0xffffff, 1.3));
    const light = new THREE.DirectionalLight(0xffffff, 1.8);
    light.position.set(2, 3, 4);
    scene.add(light);
    let frame = 0;
    let running = true;
    const animate = () => {
      if (!running) return;
      frame += 0.012;
      group.rotation.y = Math.sin(frame) * 0.35;
      group.rotation.x = Math.cos(frame * 0.7) * 0.1;
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    animate();
    return () => {
      running = false;
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);
  return <div className="knightScene" ref={mountRef} aria-label="Animated STJW shield" />;
}

function PeopleView({ accountProfiles }: { accountProfiles: AccountProfile[] }) {
  const [type, setType] = useState<"All" | AccountProfile["type"]>("All");
  const rows = accountProfiles
    .filter((profile) => type === "All" || profile.type === type)
    .map((profile) => ({ Name: profile.name, Type: profile.type, Email: profile.email, Role: profile.role, Status: profile.status, Linked: profile.linkedTo }));
  return (
    <section className="taskPage">
      <TaskHeader title="People directory" body="Manage staff, parents, and student accounts from one clean directory." />
      <TaskGrid tasks={[
        { title: "Staff profiles", detail: `${accountProfiles.filter((item) => item.type === "Staff").length} staff accounts` },
        { title: "Parent profiles", detail: `${accountProfiles.filter((item) => item.type === "Parent").length} parent accounts` },
        { title: "Student profiles", detail: `${accountProfiles.filter((item) => item.type === "Student").length} student accounts` }
      ]} />
      <PageSummary items={[["Staff", String(accountProfiles.filter((item) => item.type === "Staff").length)], ["Parents", String(accountProfiles.filter((item) => item.type === "Parent").length)], ["Students", String(accountProfiles.filter((item) => item.type === "Student").length)]]} />
      <Panel title="People Directory">
        <div className="segmented">
          {(["All", "Staff", "Parent", "Student"] as const).map((item) => <button key={item} className={type === item ? "active" : ""} onClick={() => setType(item)}>{item}</button>)}
        </div>
        <DataTable rows={rows} />
      </Panel>
    </section>
  );
}

function TeacherCalendarView({ currentUser, calendarItems, setCalendarItems }: { currentUser: AccountProfile; calendarItems: CalendarItem[]; setCalendarItems: React.Dispatch<React.SetStateAction<CalendarItem[]>> }) {
  const owner = currentUser.name;
  const myItems = calendarItems.filter((item) => item.owner === owner || currentUser.type !== "Staff");
  const [status, setStatus] = useState("");
  const addRequest = (type: CalendarItem["type"]) => {
    const item: CalendarItem = { id: `cal-${Date.now()}`, owner, type, title: `${type} request`, date: "2026-05-14", time: type === "School Event" ? "10:00 AM" : "All day", status: "Pending", visibility: "Admin", warning: type === "Sick Day" || type === "Time Off" ? "Admin must assign coverage." : undefined };
    setCalendarItems((current) => [item, ...current]);
    setStatus(`${type} request added for admin review.`);
  };
  return (
    <section className="taskPage">
      <TaskHeader title="My calendar and requests" body="Teachers can submit schedule requests, sick days, and school events from one place. Admins approve items into the master calendar." />
      <TaskGrid tasks={[
        { title: "Time off", detail: "Submit personal or planned absence", onClick: () => addRequest("Time Off") },
        { title: "Sick day", detail: "Send immediate coverage request", onClick: () => addRequest("Sick Day") },
        { title: "School event", detail: "Request an event on the school calendar", onClick: () => addRequest("School Event") }
      ]} />
      {status && <p className="actionStatus">{status}</p>}
      <Panel title="My Calendar Items">
        <CalendarBoard items={myItems} />
      </Panel>
    </section>
  );
}

function MasterCalendarView({ calendarItems, setCalendarItems }: { calendarItems: CalendarItem[]; setCalendarItems: React.Dispatch<React.SetStateAction<CalendarItem[]>> }) {
  const pending = calendarItems.filter((item) => item.status === "Pending" || item.status === "Needs Coverage");
  const updateCalendarItem = (id: string, patch: Partial<CalendarItem>) => setCalendarItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  return (
    <section className="taskPage">
      <TaskHeader title="Master calendar" body="Admins can see all requests, warnings, and events that affect staffing, coverage, and school operations." />
      <TaskGrid tasks={[
        { title: "Pending review", detail: `${pending.length} calendar items need admin action` },
        { title: "Coverage warnings", detail: `${calendarItems.filter((item) => item.warning).length} items have warnings` },
        { title: "Approved events", detail: `${calendarItems.filter((item) => item.status === "Approved").length} on calendar` }
      ]} />
      <Panel title="Admin Review Queue">
        <div className="calendarReview">
          {pending.map((item) => (
            <article key={item.id}>
              <div><strong>{item.title}</strong><span>{item.owner} - {item.date} - {item.time}</span>{item.warning && <small>{item.warning}</small>}</div>
              <div><button onClick={() => updateCalendarItem(item.id, { status: "Approved", warning: undefined })}>Approve</button><button onClick={() => updateCalendarItem(item.id, { status: "Denied" })}>Deny</button><button onClick={() => updateCalendarItem(item.id, { status: "Needs Coverage", warning: "Coverage assignment required." })}>Needs Coverage</button></div>
            </article>
          ))}
        </div>
      </Panel>
      <Panel title="Master Calendar">
        <CalendarBoard items={calendarItems} />
      </Panel>
    </section>
  );
}

function CalendarBoard({ items }: { items: CalendarItem[] }) {
  return (
    <div className="calendarBoard">
      {items.map((item) => (
        <article key={item.id} className={classNameForStatus(item.status)}>
          <span>{item.date} - {item.time}</span>
          <strong>{item.title}</strong>
          <small>{item.owner} - {item.type}</small>
          <StatusPill label={item.status} />
          {item.warning && <em>{item.warning}</em>}
        </article>
      ))}
    </div>
  );
}

function MessagesView({ currentUser, messages, setMessages }: { currentUser: AccountProfile; messages: MessageItem[]; setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>> }) {
  const [status, setStatus] = useState("");
  const sendMessage = (priority: MessageItem["priority"]) => {
    const message: MessageItem = { id: `msg-${Date.now()}`, from: currentUser.name, audience: "Teachers", subject: priority === "Required Ack" ? "Required acknowledgement" : "New staff message", body: "Message drafted from the school message board.", priority, excluded: ["Students"], acknowledged: [] };
    setMessages((current) => [message, ...current]);
    setStatus(`${priority} message posted to Teachers, excluding Students.`);
  };
  const acknowledge = (id: string) => setMessages((current) => current.map((message) => message.id === id ? { ...message, acknowledged: Array.from(new Set([...message.acknowledged, currentUser.name])) } : message));
  return (
    <section className="taskPage">
      <TaskHeader title="Messages and required acknowledgements" body="Send messages to groups, exclude users or roles, and require confirmation for critical notices." />
      <TaskGrid tasks={[
        { title: "Send normal message", detail: "Post a standard message", onClick: () => sendMessage("Normal") },
        { title: "Send important message", detail: "Highlight for staff", onClick: () => sendMessage("Important") },
        { title: "Require acknowledgement", detail: "Popup-style confirmation workflow", onClick: () => sendMessage("Required Ack") }
      ]} />
      {status && <p className="actionStatus">{status}</p>}
      <Panel title="Message Board">
        <div className="messageBoard">
          {messages.map((message) => (
            <article key={message.id}>
              <div><strong>{message.subject}</strong><span>{message.from} to {message.audience}</span><p>{message.body}</p><small>Excluded: {message.excluded.join(", ") || "None"}</small></div>
              <div><StatusPill label={message.priority} /><small>{message.acknowledged.length} acknowledged</small>{message.priority === "Required Ack" && !message.acknowledged.includes(currentUser.name) && <button onClick={() => acknowledge(message.id)}>Acknowledge</button>}</div>
            </article>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function TasksView({ currentUser, teacherTasks, setTeacherTasks }: { currentUser: AccountProfile; teacherTasks: TeacherTask[]; setTeacherTasks: React.Dispatch<React.SetStateAction<TeacherTask[]>> }) {
  const [status, setStatus] = useState("");
  const addTask = () => {
    const task: TeacherTask = { id: `task-${Date.now()}`, owner: currentUser.name, title: "New teacher task", due: "2026-05-14", status: "Not Started", priority: "Normal" };
    setTeacherTasks((current) => [task, ...current]);
    setStatus("Task created. Edit status and priority in the list.");
  };
  const updateTask = (id: string, patch: Partial<TeacherTask>) => setTeacherTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch } : task));
  return (
    <section className="taskPage">
      <TaskHeader title="Teacher tasks" body="Create, edit, prioritize, and complete tasks connected to students, classes, calendar work, or daily operations." />
      <TaskGrid tasks={[
        { title: "Create task", detail: "Add a new teacher work item", onClick: addTask },
        { title: "Blocked work", detail: `${teacherTasks.filter((task) => task.status === "Blocked").length} tasks blocked` },
        { title: "Due soon", detail: `${teacherTasks.filter((task) => task.due <= "2026-05-08").length} tasks due now` }
      ]} />
      {status && <p className="actionStatus">{status}</p>}
      <Panel title="Task Board">
        <div className="taskBoard">
          {teacherTasks.map((task) => (
            <article key={task.id}>
              <input value={task.title} onChange={(event) => updateTask(task.id, { title: event.target.value })} />
              <label>Status<select value={task.status} onChange={(event) => updateTask(task.id, { status: event.target.value as TeacherTask["status"] })}><option>Not Started</option><option>In Progress</option><option>Blocked</option><option>Done</option></select></label>
              <label>Priority<select value={task.priority} onChange={(event) => updateTask(task.id, { priority: event.target.value as TeacherTask["priority"] })}><option>Low</option><option>Normal</option><option>High</option></select></label>
              <label>Due<input type="date" value={task.due} onChange={(event) => updateTask(task.id, { due: event.target.value })} /></label>
              <small>{task.owner}{task.linkedStudent ? ` - ${task.linkedStudent}` : ""}</small>
            </article>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function SecurityView({ auditLog, refreshAuditLog }: { auditLog: AuditEntry[]; refreshAuditLog: () => void }) {
  const gates = [
    { Gate: "Authentication", Purpose: "Every user must sign in before seeing school data.", Owner: "Admin", Status: "Mock" },
    { Gate: "Role permissions", Purpose: "Teachers, parents, students, staff, and admins see different data.", Owner: "Admin", Status: "Planned" },
    { Gate: "Approval workflows", Purpose: "Time off, events, required messages, and sync changes need approvals.", Owner: "Admin", Status: "Designed" },
    { Gate: "Audit logs", Purpose: "Every edit, import, export, sync, and acknowledgement is tracked.", Owner: "System", Status: "Planned" },
    { Gate: "Sync locks", Purpose: "FACTS/Google writes require explicit review before running.", Owner: "System", Status: "Designed" }
  ];
  return (
    <section className="taskPage">
      <TaskHeader title="Security gates and approvals" body="Every workflow that changes data should pass through sign-in, role checks, approvals, and audit logs." />
      <TaskGrid tasks={[
        { title: "Role gates", detail: "Different people see different data" },
        { title: "Approval gates", detail: "Requests and syncs need review" },
        { title: "Audit gates", detail: `${auditLog.length} recent writes tracked`, onClick: refreshAuditLog }
      ]} />
      <Panel title="Security Gate Map">
        <DataTable rows={gates} />
      </Panel>
      <Panel title="Audit Log" action="Refresh" onAction={refreshAuditLog}>
        <DataTable rows={(auditLog.length ? auditLog : [{ at: "-", actor: "-", action: "No audited writes loaded", detail: "-" }]).map((entry) => ({
          Time: entry.at === "-" ? "-" : new Date(entry.at).toLocaleString(),
          Actor: entry.actor,
          Action: entry.action,
          Detail: entry.detail
        }))} />
      </Panel>
    </section>
  );
}

function AttendanceMonitorView({ classes }: { classes: SchoolClass[] }) {
  const submitted = classes.filter((item) => item.attendanceStatus === "Submitted").length;
  const missing = classes.filter((item) => item.attendanceStatus === "Missing").length;
  const inProgress = classes.filter((item) => item.attendanceStatus === "In Progress").length;
  const rows = classes.map((item) => ({
    Class: item.name,
    Teacher: item.teacher,
    Room: item.room,
    Period: item.period,
    Students: item.rosterIds.length,
    Status: item.attendanceStatus,
    Submitted: item.submittedAt ?? "-"
  }));
  return (
    <section className="taskPage">
      <TaskHeader title="Live attendance monitor" body="This is the office dashboard for attendance collection. It shows which classes have submitted and what will sync to the attendance record." />
      <TaskGrid tasks={[
        { title: "Submitted", detail: `${submitted} classes complete` },
        { title: "Missing", detail: `${missing} classes still need attendance` },
        { title: "Sync target", detail: "Local attendance queue, then FACTS when connected" }
      ]} />
      <div className="monitorHero">
        <ChartCanvas kind="donut" data={[
          { label: "Submitted", value: submitted, tone: "green" },
          { label: "In Progress", value: inProgress, tone: "gold" },
          { label: "Missing", value: missing, tone: "red" }
        ]} tone="blue" metricLabel="Classes" />
        <div className="syncFlow">
          <h3>Attendance Sync Flow</h3>
          <ol>
            <li><strong>Teacher submits roster</strong><span>Class attendance lands in the local attendance queue.</span></li>
            <li><strong>Office reviews exceptions</strong><span>Missing classes, tardies, absences, and early dismissals are checked.</span></li>
            <li><strong>System records daily attendance</strong><span>Local records update immediately; FACTS sync runs later when endpoints exist.</span></li>
          </ol>
        </div>
      </div>
      <Panel title="Class Submission Dashboard">
        <DataTable rows={rows} />
      </Panel>
    </section>
  );
}

function ClassesView({ classes, setClasses }: { classes: SchoolClass[]; setClasses: React.Dispatch<React.SetStateAction<SchoolClass[]>> }) {
  const [classStatus, setClassStatus] = useState("");
  const [draft, setDraft] = useState({ name: "", teacher: "", grade: "3", room: "", period: "Homeroom" });
  const saveClass = () => {
    const name = draft.name.trim() || `${draft.grade}-${draft.room || "A"} ${draft.period}`;
    const item: SchoolClass = {
      id: `class-${Date.now()}`,
      name,
      grade: draft.grade,
      teacher: draft.teacher.trim() || "Unassigned",
      room: draft.room.trim() || draft.grade,
      period: draft.period.trim() || "Homeroom",
      rosterIds: [],
      attendanceStatus: "Missing"
    };
    setClasses((current) => [item, ...current]);
    setClassStatus(`${name} saved to the local API.`);
  };
  const updateClass = (id: string, patch: Partial<SchoolClass>) => {
    setClasses((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    setClassStatus("Class update saved.");
  };
  const deleteClass = (id: string) => {
    setClasses((current) => current.filter((item) => item.id !== id));
    setClassStatus("Class deleted from the local API.");
  };
  const rows = classes.map((item) => ({
    Class: item.name,
    Grade: item.grade,
    Teacher: item.teacher,
    Room: item.room,
    Period: item.period,
    Students: item.rosterIds.length,
    Attendance: item.attendanceStatus
  }));
  return (
    <section className="taskPage">
      <TaskHeader title="Classes and rosters" body="Classes drive attendance, teacher dashboards, rosters, grade workflows, and future Google Classroom/FACTS sync." />
      <TaskGrid tasks={[
        { title: "Class sections", detail: `${classes.length} active sections` },
        { title: "Roster coverage", detail: `${classes.reduce((sum, item) => sum + item.rosterIds.length, 0)} roster placements` },
        { title: "Add class", detail: "Create a persisted class section", onClick: saveClass }
      ]} />
      {classStatus && <p className="actionStatus">{classStatus}</p>}
      <div className="adminGrid">
        <Panel title="Add or Edit Class">
          <div className="accountForm">
            <label>Class Name<input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="3-A Homeroom" /></label>
            <label>Teacher<input value={draft.teacher} onChange={(event) => setDraft((current) => ({ ...current, teacher: event.target.value }))} placeholder="Teacher name" /></label>
            <label>Grade<select value={draft.grade} onChange={(event) => setDraft((current) => ({ ...current, grade: event.target.value }))}><option>K</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option><option>7</option><option>8</option></select></label>
            <label>Room<input value={draft.room} onChange={(event) => setDraft((current) => ({ ...current, room: event.target.value }))} placeholder="Room" /></label>
            <label>Period<input value={draft.period} onChange={(event) => setDraft((current) => ({ ...current, period: event.target.value }))} placeholder="Homeroom / Period 1" /></label>
            <button onClick={saveClass}>Save Class</button>
          </div>
        </Panel>
        <Panel title="Roster Tools">
          <div className="adminTools">
            <button onClick={() => setClassStatus("Roster import staged. This will accept CSV, Google Classroom, or FACTS rosters.")}>Import Roster</button>
            <button onClick={() => setClassStatus("Roster balancing view staged.")}>Balance Rosters</button>
            <button onClick={() => setClassStatus("Teacher assignment review staged.")}>Review Teachers</button>
          </div>
        </Panel>
      </div>
      <Panel title="Class Directory">
        <DataTable rows={rows} />
        <div className="taskBoard">
          {classes.map((item) => (
            <article key={item.id}>
              <input value={item.name} onChange={(event) => updateClass(item.id, { name: event.target.value })} />
              <label>Teacher<input value={item.teacher} onChange={(event) => updateClass(item.id, { teacher: event.target.value })} /></label>
              <label>Room<input value={item.room} onChange={(event) => updateClass(item.id, { room: event.target.value })} /></label>
              <label>Period<input value={item.period} onChange={(event) => updateClass(item.id, { period: event.target.value })} /></label>
              <label>Status<select value={item.attendanceStatus} onChange={(event) => updateClass(item.id, { attendanceStatus: event.target.value as SchoolClass["attendanceStatus"] })}><option>Submitted</option><option>Missing</option><option>In Progress</option></select></label>
              <button onClick={() => deleteClass(item.id)}>Delete Class</button>
            </article>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function AdminView({ accountProfiles, setAccountProfiles }: { accountProfiles: AccountProfile[]; setAccountProfiles: React.Dispatch<React.SetStateAction<AccountProfile[]>> }) {
  const [adminStatus, setAdminStatus] = useState("");
  const [draft, setDraft] = useState({ name: "", email: "", type: "Staff" as AccountProfile["type"], role: "Teacher", linkedTo: "" });
  const createInvite = () => {
    const name = draft.name.trim();
    const email = draft.email.trim();
    if (!name || !email) {
      setAdminStatus("Name and email are required before creating an invite.");
      return;
    }
    const profile: AccountProfile = {
      id: `acct-${Date.now()}`,
      name,
      email,
      type: draft.type,
      role: draft.role,
      status: "Invite Pending",
      linkedTo: draft.linkedTo.trim() || "Unlinked"
    };
    setAccountProfiles((current) => [profile, ...current]);
    setAdminStatus(`Invite created for ${name}.`);
  };
  const updateAccount = (id: string, patch: Partial<AccountProfile>) => {
    setAccountProfiles((current) => current.map((profile) => profile.id === id ? { ...profile, ...patch } : profile));
    setAdminStatus("Account update saved.");
  };
  const bulkInviteParents = () => {
    setAccountProfiles((current) => current.map((profile) => profile.type === "Parent" && profile.status === "Needs Setup" ? { ...profile, status: "Invite Pending" } : profile));
    setAdminStatus("Parent accounts needing setup moved to invite pending.");
  };
  const auditRows = accountProfiles.map((profile) => ({ Name: profile.name, Type: profile.type, Role: profile.role, Status: profile.status, Linked: profile.linkedTo }));
  return (
    <section className="taskPage">
      <TaskHeader title="Admin management" body="Create accounts, assign roles, invite families, and review access from one place." />
      <TaskGrid tasks={[
        { title: "Create invite", detail: "Start with name, email, profile type, and role" },
        { title: "Bulk setup", detail: "Invite parents or link siblings in batches" },
        { title: "Audit access", detail: "Review who has access and why" }
      ]} />
      <PageSummary items={[["Active Accounts", String(accountProfiles.filter((item) => item.status === "Active").length)], ["Pending Invites", String(accountProfiles.filter((item) => item.status === "Invite Pending").length)], ["Needs Setup", String(accountProfiles.filter((item) => item.status === "Needs Setup").length)]]} />
      <div className="adminGrid">
        <Panel title="Create Account">
          <div className="accountForm">
            <label>Name<input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Full name" /></label>
            <label>Email<input value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} placeholder="email@stjwschool.org" /></label>
            <label>Profile Type<select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as AccountProfile["type"] }))}><option>Staff</option><option>Parent</option><option>Student</option></select></label>
            <label>Role Template<select value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))}><option>Teacher</option><option>Office Admin</option><option>Parent</option><option>Student</option></select></label>
            <label>Linked To<input value={draft.linkedTo} onChange={(event) => setDraft((current) => ({ ...current, linkedTo: event.target.value }))} placeholder="Student, family, class, or department" /></label>
            <button onClick={createInvite}>Create Invite</button>
          </div>
        </Panel>
        <Panel title="Admin QOL Tools">
          <div className="adminTools">
            <button onClick={bulkInviteParents}>Bulk Invite Parents</button>
            <button onClick={() => setAdminStatus("Sibling linking review staged.")}>Link Siblings</button>
            <button onClick={() => setAdminStatus("Permission review opened in the account table below.")}>Review Permissions</button>
            <button onClick={() => downloadFile(`account-audit-${today}.csv`, toCsv(auditRows))}>Export Account Audit</button>
          </div>
          {adminStatus && <p className="actionStatus">{adminStatus}</p>}
        </Panel>
      </div>
      <Panel title="Account Management">
        <DataTable rows={auditRows} />
        <div className="taskBoard">
          {accountProfiles.map((profile) => (
            <article key={profile.id}>
              <input value={profile.name} onChange={(event) => updateAccount(profile.id, { name: event.target.value })} />
              <label>Status<select value={profile.status} onChange={(event) => updateAccount(profile.id, { status: event.target.value as AccountProfile["status"] })}><option>Active</option><option>Invite Pending</option><option>Needs Setup</option></select></label>
              <label>Role<input value={profile.role} onChange={(event) => updateAccount(profile.id, { role: event.target.value })} /></label>
              <label>Linked<input value={profile.linkedTo} onChange={(event) => updateAccount(profile.id, { linkedTo: event.target.value })} /></label>
              <small>{profile.email} - {profile.type}</small>
            </article>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function AcademicsView({ visibleStudents, setProfileId, exportRows, updateStudent }: { visibleStudents: Student[]; setProfileId: (id: string) => void; exportRows: (filename: string, rows?: Record<string, string | number>[]) => void; updateStudent: (id: string, patch: Partial<Student>) => void }) {
  const rows = visibleStudents.map((student) => ({ Name: studentName(student), Grade: student.grade, Advisor: student.advisor, GPA: student.gpa, "Missing Work": student.missingAssignments, Action: student.missingAssignments > 4 ? "Advisor check-in" : "Monitor" }));
  return (
    <section className="taskPage">
      <TaskHeader title="Academic follow-up" body="Focus on missing work and advisor action first. Edit GPA and missing assignment counts only when needed." />
      <TaskGrid tasks={[
        { title: "Advisor packets", detail: `${visibleStudents.filter((student) => student.missingAssignments > 4).length} students need follow-up` },
        { title: "Review GPA", detail: "Spot students below expected range" },
        { title: "Export academics", detail: "Create an academic snapshot CSV", onClick: () => exportRows(`academics-${today}.csv`, rows) }
      ]} />
      <PageSummary items={[["Avg GPA", (visibleStudents.reduce((sum, item) => sum + item.gpa, 0) / Math.max(1, visibleStudents.length)).toFixed(2)], ["Missing Work", String(visibleStudents.reduce((sum, item) => sum + item.missingAssignments, 0))], ["Advisor Packets", String(visibleStudents.filter((item) => item.missingAssignments > 4).length)]]} />
      <div className="splitGrid">
        <Panel title="Academic Snapshot" action="Export" onAction={() => exportRows(`academics-${today}.csv`, rows)}>
          <DataTable rows={rows} onNameClick={(name) => {
            const student = students.find((item) => studentName(item) === name);
            if (student) setProfileId(student.id);
          }} />
        </Panel>
        <Panel title="Missing Work by Grade">
          <BarChart data={grades.filter((item) => item !== "All").map((item) => ({ label: `Grade ${item}`, value: students.filter((student) => student.grade === item).reduce((sum, student) => sum + student.missingAssignments, 0), tone: "purple" }))} />
        </Panel>
      </div>
      <Panel title="Quick Academic Edits">
        <div className="academicEditGrid">
          {visibleStudents.slice(0, 8).map((student) => (
            <div key={student.id}>
              <strong>{studentName(student)}</strong>
              <label>GPA<input type="number" step="0.1" value={student.gpa} onChange={(event) => updateStudent(student.id, { gpa: Number(event.target.value) })} /></label>
              <label>Missing<input type="number" value={student.missingAssignments} onChange={(event) => updateStudent(student.id, { missingAssignments: Number(event.target.value) })} /></label>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function BehaviorView({ visibleStudents, setProfileId }: { visibleStudents: Student[]; setProfileId: (id: string) => void }) {
  return (
    <section className="taskPage">
      <TaskHeader title="Behavior and recognition" body="Separate students who need support from students who should be recognized for positive behavior." />
      <TaskGrid tasks={[
        { title: "Follow up", detail: `${visibleStudents.filter((student) => student.behaviorPoints < 3).length} students below behavior threshold` },
        { title: "Recognize positives", detail: `${visibleStudents.filter((student) => student.behaviorPoints >= 10).length} students above recognition threshold` },
        { title: "Open profiles", detail: "Use profile views to see context and communications" }
      ]} />
      <div className="splitGrid">
      <Panel title="Recognition and Discipline">
        <BarChart data={visibleStudents.map((student) => ({ label: student.lastName, value: Math.max(0, student.behaviorPoints + 12), tone: (student.behaviorPoints < 0 ? "red" : "green") as Tone })).slice(0, 10)} />
      </Panel>
      <Panel title="Behavior Follow-Up">
        <StudentList students={visibleStudents.filter((student) => student.behaviorPoints < 3)} setProfileId={setProfileId} toggleCompare={() => undefined} />
      </Panel>
      </div>
    </section>
  );
}

function LunchView({ visibleStudents, exportRows }: { visibleStudents: Student[]; exportRows: (filename: string, rows?: Record<string, string | number>[]) => void }) {
  const rows = visibleStudents.map((student) => ({ Name: studentName(student), Family: student.family, Grade: student.grade, Balance: currency(student.lunchBalance), Allergies: student.allergies, Status: student.lunchBalance < 0 ? "Negative" : student.lunchBalance < 10 ? "Low" : "Ok" }));
  return (
    <section className="taskPage">
      <TaskHeader title="Lunch operations" body="Start with safety and simple cafeteria follow-up: allergies, low balances, and family notices." />
      <TaskGrid tasks={[
        { title: "Review allergies", detail: `${visibleStudents.filter((student) => student.allergies !== "None").length} visible students have allergy notes` },
        { title: "Low balances", detail: `${visibleStudents.filter((student) => student.lunchBalance < 10).length} visible balances need review` },
        { title: "Export notices", detail: "Create low-balance/allergy CSV", onClick: () => exportRows(`lunch-balances-${today}.csv`, rows) }
      ]} />
      <PageSummary items={[["Negative", String(visibleStudents.filter((item) => item.lunchBalance < 0).length)], ["Low", String(visibleStudents.filter((item) => item.lunchBalance >= 0 && item.lunchBalance < 10).length)], ["Allergies", String(visibleStudents.filter((item) => item.allergies !== "None").length)]]} />
      <Panel title="Lunch Balances and Allergies" action="Export Notices" onAction={() => exportRows(`lunch-balances-${today}.csv`, rows)}>
        <DataTable rows={rows} />
      </Panel>
    </section>
  );
}

function StaffView() {
  const rows = staff.map((item) => ({ Name: item.name, Role: item.role, Department: item.department, Room: item.room, Coverage: item.coverageNeed, Tasks: item.tasksOpen }));
  return (
    <section className="taskPage">
      <TaskHeader title="Staff coverage" body="See coverage needs and staff workload before the school day gets busy." />
      <TaskGrid tasks={[
        { title: "Coverage gaps", detail: `${staff.filter((item) => item.coverageNeed !== "None").length} open coverage needs` },
        { title: "Task load", detail: `${staff.reduce((sum, item) => sum + item.tasksOpen, 0)} open staff tasks` },
        { title: "Daily coverage", detail: "Review duty and substitute notes" }
      ]} />
      <PageSummary items={[["Coverage Needs", String(staff.filter((item) => item.coverageNeed !== "None").length)], ["Open Tasks", String(staff.reduce((sum, item) => sum + item.tasksOpen, 0))], ["Departments", String(new Set(staff.map((item) => item.department)).size)]]} />
      <div className="splitGrid">
        <Panel title="Staff Workload"><DataTable rows={rows} /></Panel>
        <Panel title="Coverage Calendar">
          <div className="calendarList">
            <div><strong>Today</strong><span>Lunch duty swap - Ms. Wolfe</span></div>
            <div><strong>Period 6</strong><span>Sub coverage - Mr. Miller</span></div>
            <div><strong>Dismissal</strong><span>Office team pickup support</span></div>
          </div>
        </Panel>
      </div>
    </section>
  );
}

function IntegrationsView() {
  const [connectStatus, setConnectStatus] = useState("");
  const classroomScopes = [
    "classroom.courses.readonly",
    "classroom.rosters.readonly",
    "classroom.coursework.students.readonly",
    "classroom.student-submissions.students.readonly"
  ];
  const syncObjects = [
    { Area: "Google Account", Data: "User identity, email, profile", Use: "Staff sign-in and consent ownership", Status: "Design ready" },
    { Area: "Classroom Courses", Data: "Courses, sections, teachers", Use: "Match classes to homerooms and teachers", Status: "Mock only" },
    { Area: "Classroom Rosters", Data: "Students and teachers per course", Use: "Build teacher views and class filters", Status: "Mock only" },
    { Area: "Coursework", Data: "Assignments, due dates, materials", Use: "Missing-work dashboards", Status: "Mock only" },
    { Area: "Submissions", Data: "Turned in, late, missing states", Use: "Academic intervention reports", Status: "Mock only" }
  ];
  return (
    <section className="taskPage">
      <TaskHeader title="Integrations" body="Connect outside systems deliberately. Google and Classroom setup stay separate from daily school workflows." />
      <TaskGrid tasks={[
        { title: "Connect Google", detail: "Prepare OAuth and Google Identity Services" },
        { title: "Sync Classroom", detail: "Courses, rosters, coursework, submissions" },
        { title: "Review scopes", detail: "Keep access limited and readable" }
      ]} />
      <div className="integrationHero">
        <div>
          <span>Google Workspace</span>
          <h2>Connect Google accounts and Classroom when credentials are ready.</h2>
          <p>The app will use mock data until your school creates a Google Cloud project, enables Classroom API, configures OAuth consent, and provides a web client ID. For production, the browser should request an authorization code and a local backend should exchange it for tokens.</p>
        </div>
        <div className="connectCard">
          <strong>Connection State</strong>
          <StatusPill label="Not Connected" />
          <button onClick={() => setConnectStatus("Google connection needs a school Google Cloud client ID before live sign-in can start.")}>Connect Google Account</button>
          {connectStatus && <small className="actionStatus">{connectStatus}</small>}
          <small>Disabled until client ID and backend token endpoint are configured.</small>
        </div>
      </div>
      <div className="splitGrid">
        <Panel title="Setup Checklist">
          <ol className="stepList">
            <li><strong>Create Google Cloud project</strong><span>Use the school-owned Google Cloud project, not a personal project.</span></li>
            <li><strong>Enable Google Classroom API</strong><span>Classroom data is unavailable until this API is enabled.</span></li>
            <li><strong>Configure OAuth consent</strong><span>Limit scopes to the minimum needed for rosters, coursework, and submissions.</span></li>
            <li><strong>Create web OAuth client</strong><span>Add the local app redirect URL once we add the backend callback.</span></li>
            <li><strong>Add backend token exchange</strong><span>Authorization code flow keeps refresh tokens off the browser.</span></li>
          </ol>
        </Panel>
        <Panel title="Requested Classroom Scopes">
          <div className="scopeList">
            {classroomScopes.map((scope) => <code key={scope}>{scope}</code>)}
          </div>
          <p className="panelNote">These are starting read-only scopes. Write scopes should be added only after the read sync is stable and approved by administration.</p>
        </Panel>
      </div>
      <Panel title="Google Data Map">
        <DataTable rows={syncObjects} />
      </Panel>
    </section>
  );
}

function AgentApiView() {
  const endpoints = [
    { Method: "GET", Endpoint: "/api/health", Purpose: "Confirm local API server is running.", Input: "None", Output: "Status and version" },
    { Method: "GET", Endpoint: "/api/export", Purpose: "Export all mock data as JSON.", Input: "None", Output: "Full dataset" },
    { Method: "POST", Endpoint: "/api/import", Purpose: "Replace or merge local mock data.", Input: "JSON dataset", Output: "Import summary" },
    { Method: "GET", Endpoint: "/api/students", Purpose: "List students with optional filters.", Input: "query, grade, riskOnly", Output: "Student array" },
    { Method: "PATCH", Endpoint: "/api/students/:id", Purpose: "Update a student record.", Input: "Partial student JSON", Output: "Updated student" },
    { Method: "POST", Endpoint: "/api/reports", Purpose: "Generate report rows.", Input: "templateId, filters, columns", Output: "Report rows" },
    { Method: "POST", Endpoint: "/api/query", Purpose: "Agent-friendly search across local tables.", Input: "text and table names", Output: "Matches" }
  ];
  const payload = `{
  "templateId": "daily-attendance",
  "filters": { "grade": "All", "riskOnly": true },
  "columns": ["Name", "Grade", "Code", "Reason"]
}`;
  return (
    <section className="taskPage">
      <TaskHeader title="Agent API" body="Give automation a clean JSON contract so agents do not scrape the UI or click around like humans." />
      <TaskGrid tasks={[
        { title: "Health check", detail: "GET /api/health" },
        { title: "Export/import", detail: "Move data as JSON" },
        { title: "Patch records", detail: "Update only changed fields" }
      ]} />
      <div className="apiHero">
        <div>
          <span>Local Agent API</span>
          <h2>Agents should connect through explicit JSON endpoints.</h2>
          <p>This keeps automation predictable: agents can read, filter, patch, import, export, and generate reports without clicking through the UI or scraping tables.</p>
        </div>
        <div className="connectCard">
          <strong>Run Command</strong>
          <code>npm run agent:api</code>
          <small>Server target: http://127.0.0.1:8787</small>
        </div>
      </div>
      <Panel title="Endpoint Contract">
        <DataTable rows={endpoints} />
      </Panel>
      <div className="splitGrid">
        <Panel title="Example Report Request">
          <pre>{payload}</pre>
        </Panel>
        <Panel title="Agent Rules">
          <ol className="stepList">
            <li><strong>Read before write</strong><span>Fetch current data before sending patches.</span></li>
            <li><strong>Patch only changed fields</strong><span>Avoid replacing full records unless importing a full backup.</span></li>
            <li><strong>Prefer reports endpoint</strong><span>Generate report rows through the API instead of scraping the UI.</span></li>
            <li><strong>Keep audit data</strong><span>When security is added, every write should include actor, reason, and timestamp.</span></li>
          </ol>
        </Panel>
      </div>
    </section>
  );
}

function ReportsView({ selectedReport, setSelectedReport, selectedTemplate, selectedColumns, setSelectedColumns, sortKey, setSortKey, groupKey, setGroupKey, reportRows, allFields, exportReport, printReport }: {
  selectedReport: string;
  setSelectedReport: (id: string) => void;
  selectedTemplate: ReportTemplate;
  selectedColumns: string[];
  setSelectedColumns: (columns: string[]) => void;
  sortKey: string;
  setSortKey: (key: string) => void;
  groupKey: string;
  setGroupKey: (key: string) => void;
  reportRows: Record<string, string | number>[];
  allFields: string[];
  exportReport: () => void;
  printReport: () => void;
}) {
  const [reportSearch, setReportSearch] = useState("");
  const [reportCategory, setReportCategory] = useState<ReportTemplate["category"] | "All">("All");
  const categories: (ReportTemplate["category"] | "All")[] = ["All", "Attendance", "Student", "Academic", "Behavior", "Lunch", "Family", "Staff", "Admin", "Custom"];
  const filteredTemplates = reportTemplates.filter((template) => {
    const text = `${template.name} ${template.description} ${template.category}`.toLowerCase();
    return (reportCategory === "All" || template.category === reportCategory) && (!reportSearch || text.includes(reportSearch.toLowerCase()));
  });
  return (
    <section className="taskPage">
      <TaskHeader title="Report builder" body="Choose the report first, then refine columns, sorting, and grouping only when needed." />
      <TaskGrid tasks={[
        { title: "Pick report", detail: selectedTemplate.name },
        { title: "Refine columns", detail: `${selectedColumns.length} columns selected` },
        { title: "Export or print", detail: `${reportRows.length} rows ready`, onClick: exportReport }
      ]} />
      <div className="reportsLayout">
      <Panel title="Report Library">
        <div className="reportTools">
          <input value={reportSearch} onChange={(event) => setReportSearch(event.target.value)} placeholder="Search reports" />
          <select value={reportCategory} onChange={(event) => setReportCategory(event.target.value as ReportTemplate["category"] | "All")}>
            {categories.map((category) => <option key={category}>{category}</option>)}
          </select>
        </div>
        <div className="reportPicker">
          {filteredTemplates.map((template) => (
            <button key={template.id} className={selectedReport === template.id ? "active" : ""} onClick={() => setSelectedReport(template.id)}>
              <strong>{template.name}</strong>
              <em>{template.category}</em>
              <span>{template.description}</span>
            </button>
          ))}
        </div>
      </Panel>
      <Panel title={selectedTemplate.name} action="Export CSV" onAction={exportReport} secondAction="Print" onSecondAction={printReport}>
        <p className="panelNote">{selectedTemplate.automation}</p>
        <div className="customReportSummary">
          <strong>Custom Builder</strong>
          <span>Choose fields, sort, group, then export. This works for standard templates and one-off custom reports.</span>
        </div>
        <div className="builderTools">
          <label>Sort<select value={sortKey} onChange={(event) => setSortKey(event.target.value)}>{allFields.map((field) => <option key={field}>{field}</option>)}</select></label>
          <label>Group<select value={groupKey} onChange={(event) => setGroupKey(event.target.value)}><option>None</option>{allFields.map((field) => <option key={field}>{field}</option>)}</select></label>
          <div className="columnPicker">
            {allFields.map((field) => (
              <label key={field}><input type="checkbox" checked={selectedColumns.includes(field)} onChange={(event) => setSelectedColumns(event.target.checked ? [...selectedColumns, field] : selectedColumns.filter((item) => item !== field))} />{field}</label>
            ))}
          </div>
        </div>
        {groupKey !== "None" ? <GroupedPreview rows={reportRows} groupKey={groupKey} /> : <DataPreview rows={reportRows} />}
      </Panel>
      </div>
    </section>
  );
}

function ChartsView({ chartMetric, setChartMetric, chartKind, setChartKind, chartGroup, setChartGroup, comparedStudents, visibleStudents }: {
  chartMetric: ChartMetric;
  setChartMetric: (metric: ChartMetric) => void;
  chartKind: ChartKind;
  setChartKind: (kind: ChartKind) => void;
  chartGroup: "Students" | "Grades" | "Status";
  setChartGroup: (group: "Students" | "Grades" | "Status") => void;
  comparedStudents: Student[];
  visibleStudents: Student[];
}) {
  const metric = chartMetrics.find((item) => item.id === chartMetric) ?? chartMetrics[0];
  const chartData = chartRows(visibleStudents, chartMetric, chartGroup);
  return (
    <section className="taskPage">
      <TaskHeader title="Chart studio" body="Make one useful chart at a time. Pick chart type, metric, and grouping, then compare only if you need more detail." />
      <TaskGrid tasks={[
        { title: "Chart type", detail: chartKinds.find((kind) => kind.id === chartKind)?.label ?? chartKind },
        { title: "Metric", detail: metric.label },
        { title: "Grouping", detail: chartGroup }
      ]} />
      <Panel title="Chart Studio">
        <div className="chartBuilder">
          <div>
            <span>Chart Type</span>
            <div className="chartControls">
              {chartKinds.map((item) => <button key={item.id} title={item.use} className={chartKind === item.id ? "active" : ""} onClick={() => setChartKind(item.id)}>{item.label}</button>)}
            </div>
          </div>
          <div>
            <span>Metric</span>
            <div className="chartControls">
              {chartMetrics.map((item) => <button key={item.id} className={chartMetric === item.id ? "active" : ""} onClick={() => setChartMetric(item.id)}>{item.label}</button>)}
            </div>
          </div>
          <div>
            <span>Group By</span>
            <div className="chartControls">
              {(["Students", "Grades", "Status"] as const).map((item) => <button key={item} className={chartGroup === item ? "active" : ""} onClick={() => setChartGroup(item)}>{item}</button>)}
            </div>
          </div>
        </div>
        <ChartCanvas kind={chartKind} data={chartData} tone={metric.tone} metricLabel={metric.label} />
      </Panel>
      <div className="splitGrid">
          <Panel title="Grade Comparison">
          <ChartCanvas kind="line" data={grades.filter((item) => item !== "All").map((item) => ({ label: `Grade ${item}`, value: groupAverage(item, chartMetric), tone: metric.tone }))} tone={metric.tone} metricLabel={metric.label} />
          </Panel>
          <Panel title="Pinned Student Comparison">
            <CompareTable students={comparedStudents} />
          </Panel>
      </div>
    </section>
  );
}

function chartRows(visibleStudents: Student[], metric: ChartMetric, group: "Students" | "Grades" | "Status") {
  if (group === "Students") {
    return visibleStudents.slice(0, 12).map((student) => ({ label: student.lastName, value: Number(student[metric]), tone: chartMetrics.find((item) => item.id === metric)?.tone ?? "blue" }));
  }
  if (group === "Grades") {
    return grades.filter((item) => item !== "All").map((item) => ({ label: `Grade ${item}`, value: groupAverage(item, metric), tone: chartMetrics.find((chart) => chart.id === metric)?.tone ?? "blue" }));
  }
  return ["Active", "Watch", "Intervention"].map((status) => {
    const groupStudents = visibleStudents.filter((student) => student.status === status);
    const value = groupStudents.length ? Math.round((groupStudents.reduce((sum, student) => sum + Number(student[metric]), 0) / groupStudents.length) * 10) / 10 : 0;
    return { label: status, value, tone: status === "Active" ? "green" as Tone : status === "Watch" ? "gold" as Tone : "red" as Tone };
  });
}

function ChartCanvas({ kind, data, tone, metricLabel }: { kind: ChartKind; data: { label: string; value: number; tone: Tone }[]; tone: Tone; metricLabel: string }) {
  if (kind === "bar") return <BarChart data={data.map((item) => ({ ...item, tone }))} />;
  if (kind === "horizontal") return <HorizontalChart data={data.map((item) => ({ ...item, tone }))} />;
  if (kind === "line") return <LineChart data={data} tone={tone} />;
  if (kind === "pie") return <PieChart data={data} donut={false} />;
  if (kind === "donut") return <PieChart data={data} donut />;
  if (kind === "stacked") return <StackedChart data={data} />;
  return <KpiChart data={data} metricLabel={metricLabel} />;
}

function SyncView({ syncBaseUrl, setSyncBaseUrl, syncKeyName, setSyncKeyName }: {
  syncBaseUrl: string;
  setSyncBaseUrl: (value: string) => void;
  syncKeyName: string;
  setSyncKeyName: (value: string) => void;
}) {
  const [syncStatus, setSyncStatus] = useState("");
  const [csvText, setCsvText] = useState("id,First Name,Last Name,Grade,Family,Primary Contact\ns001,Ava,Martin,K,Martin,Grace Martin\nfacts-998,New,Student,3,Student,New Guardian");
  const [preview, setPreview] = useState<FactsPreview | null>(null);
  const previewCsv = () => {
    setSyncStatus("Previewing CSV snapshot...");
    fetch(`${apiBase}/api/facts/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-name": "FACTS Sync" },
      body: JSON.stringify({ table: "students", csv: csvText })
    })
      .then((response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return response.json() as Promise<FactsPreview>;
      })
      .then((result) => {
        setPreview(result);
        setSyncStatus(`Preview ready: ${result.createCount} creates, ${result.updateCount} updates.`);
      })
      .catch((error: Error) => setSyncStatus(`Preview failed. ${error.message}`));
  };
  return (
    <section className="taskPage">
      <TaskHeader title="FACTS sync setup" body="Keep endpoint mapping technical and controlled until the school provides API URLs and credentials." />
      <TaskGrid tasks={[
        { title: "Set base URL", detail: syncBaseUrl || "Waiting for endpoint" },
        { title: "Set credential name", detail: syncKeyName },
        { title: "Map local tables", detail: `${factsEndpoints.length} areas tracked` }
      ]} />
      <Panel title="FACTS API Setup">
        <div className="syncForm">
          <label>Base URL<input value={syncBaseUrl} onChange={(event) => setSyncBaseUrl(event.target.value)} placeholder="Paste FACTS API base URL when available" /></label>
          <label>Credential env name<input value={syncKeyName} onChange={(event) => setSyncKeyName(event.target.value)} /></label>
          <button onClick={() => setSyncStatus(syncBaseUrl ? `Connection test staged for ${syncBaseUrl}.` : "Add a FACTS base URL before testing.")}>Test Connection</button>
          <button onClick={previewCsv}>Preview CSV Snapshot</button>
        </div>
        {syncStatus && <p className="actionStatus">{syncStatus}</p>}
      </Panel>
      <Panel title="CSV Import Preview">
        <div className="syncForm">
          <label className="wideField">FACTS student CSV<textarea value={csvText} onChange={(event) => setCsvText(event.target.value)} rows={6} /></label>
          <button onClick={previewCsv}>Run Preview</button>
        </div>
        {preview && (
          <>
            <PageSummary items={[["Rows", String(preview.totalRows)], ["Create", String(preview.createCount)], ["Update", String(preview.updateCount)]]} />
            <DataTable rows={preview.rows} />
          </>
        )}
      </Panel>
      <Panel title="Endpoint Map">
        <DataTable rows={factsEndpoints.map((endpoint) => ({ "FACTS Area": endpoint.label, "Local Table": endpoint.localTable, Status: endpoint.status, Notes: endpoint.notes }))} />
      </Panel>
    </section>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: string | number; detail: string; tone: Tone }) {
  return <article className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function TaskHeader({ title, body }: { title: string; body: string }) {
  return (
    <header className="taskHeader">
      <span>Workspace</span>
      <h2>{title}</h2>
      <p>{body}</p>
    </header>
  );
}

function TaskGrid({ tasks }: { tasks: { title: string; detail: string; onClick?: () => void }[] }) {
  return (
    <div className="taskGrid">
      {tasks.map((task) => task.onClick ? (
        <button key={task.title} onClick={task.onClick}>
          <strong>{task.title}</strong>
          <span>{task.detail}</span>
        </button>
      ) : (
        <article key={task.title}>
          <strong>{task.title}</strong>
          <span>{task.detail}</span>
        </article>
      ))}
    </div>
  );
}

function Panel({ title, action, onAction, secondAction, onSecondAction, children }: {
  title: string;
  action?: string;
  onAction?: () => void;
  secondAction?: string;
  onSecondAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>{title}</h2>
        <div>
          {secondAction && <button onClick={onSecondAction}>{secondAction}</button>}
          {action && <button onClick={onAction}>{action}</button>}
        </div>
      </div>
      {children}
    </section>
  );
}

function StatusPill({ label }: { label: string }) {
  return <span className={`statusPill ${classNameForStatus(label)}`}>{label}</span>;
}

function PageSummary({ items }: { items: [string, string][] }) {
  return <div className="pageSummary">{items.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>;
}

function StudentList({ students: items, setProfileId, toggleCompare, compact = false }: { students: Student[]; setProfileId: (id: string) => void; toggleCompare: (id: string) => void; compact?: boolean }) {
  if (!items.length) return <p className="emptyText">No students match the current filters.</p>;
  return (
    <div className={compact ? "studentList compact" : "studentList"}>
      {items.map((student) => (
        <div key={student.id}>
          <button onClick={() => setProfileId(student.id)}>{studentName(student)}</button>
          <span>Grade {student.grade} - {student.advisor}</span>
          <small>{percent(student.attendanceRate)} attendance - {student.missingAssignments} missing - risk {Math.round(riskScore(student))}</small>
          <button className="smallLink" onClick={() => toggleCompare(student.id)}>Compare</button>
        </div>
      ))}
    </div>
  );
}

function DataTable({ rows, onNameClick }: { rows: Record<string, string | number>[]; onNameClick?: (name: string) => void }) {
  if (!rows.length) return <p className="emptyText">No rows match the current filters.</p>;
  const headers = Object.keys(rows[0]);
  return (
    <div className="tableScroller">
      <table>
        <thead><tr>{headers.map((header, index) => <th key={header} className={index === 0 ? "stickyCol" : ""}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>{headers.map((header, columnIndex) => (
              <td key={header} className={columnIndex === 0 ? "stickyCol" : ""}>
                {header === "Name" && onNameClick ? <button className="tableLink" onClick={() => onNameClick(String(row[header]))}>{row[header]}</button> : String(row[header])}
              </td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DataPreview({ rows }: { rows: Record<string, string | number>[] }) {
  return <DataTable rows={rows.slice(0, 14)} />;
}

function GroupedPreview({ rows, groupKey }: { rows: Record<string, string | number>[]; groupKey: string }) {
  const groups = rows.reduce<Record<string, Record<string, string | number>[]>>((acc, row) => {
    const key = String(row[groupKey] ?? "Unassigned");
    acc[key] = [...(acc[key] ?? []), row];
    return acc;
  }, {});
  return <div className="groupedPreview">{Object.entries(groups).map(([group, groupRows]) => <section key={group}><h3>{group} <span>{groupRows.length}</span></h3><DataPreview rows={groupRows} /></section>)}</div>;
}

function BarChart({ data }: { data: { label: string; value: number; tone: Tone }[] }) {
  const max = Math.max(1, ...data.map((item) => Math.abs(item.value)));
  return (
    <div className="barChart">
      {data.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <div><i className={item.tone} style={{ width: `${Math.max(5, (Math.abs(item.value) / max) * 100)}%` }} /></div>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function HorizontalChart({ data }: { data: { label: string; value: number; tone: Tone }[] }) {
  const max = Math.max(1, ...data.map((item) => Math.abs(item.value)));
  return (
    <div className="horizontalChart">
      {data.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <div><i className={item.tone} style={{ width: `${Math.max(5, (Math.abs(item.value) / max) * 100)}%` }} /></div>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function LineChart({ data, tone }: { data: { label: string; value: number }[]; tone: Tone }) {
  const width = 760;
  const height = 260;
  const max = Math.max(1, ...data.map((item) => item.value));
  const min = Math.min(0, ...data.map((item) => item.value));
  const range = Math.max(1, max - min);
  const points = data.map((item, index) => {
    const x = data.length === 1 ? width / 2 : 36 + (index / (data.length - 1)) * (width - 72);
    const y = height - 34 - ((item.value - min) / range) * (height - 68);
    return { ...item, x, y };
  });
  return (
    <div className="svgChart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${tone} line chart`}>
        <polyline className={`lineStroke ${tone}`} points={points.map((point) => `${point.x},${point.y}`).join(" ")} />
        {points.map((point) => <g key={point.label}><circle className={`dot ${tone}`} cx={point.x} cy={point.y} r="5" /><text x={point.x} y={height - 10} textAnchor="middle">{point.label.replace("Grade ", "")}</text><text x={point.x} y={point.y - 10} textAnchor="middle">{point.value}</text></g>)}
      </svg>
    </div>
  );
}

function PieChart({ data, donut }: { data: { label: string; value: number; tone: Tone }[]; donut: boolean }) {
  const total = Math.max(1, data.reduce((sum, item) => sum + Math.max(0, item.value), 0));
  let running = 0;
  const colors = ["#0b2f63", "#1f6f55", "#c58b21", "#bd3f35", "#7257a7", "#2775a7", "#708078"];
  const [hovered, setHovered] = useState<{ label: string; value: number; percent: number; color: string } | null>(null);
  return (
    <div className="pieWrap">
      <div className="pieStage">
      <svg viewBox="0 0 220 220" role="img" aria-label={donut ? "donut chart" : "pie chart"}>
        {data.map((item, index) => {
          const value = Math.max(0, item.value);
          const start = (running / total) * Math.PI * 2;
          running += value;
          const end = (running / total) * Math.PI * 2;
          const color = colors[index % colors.length];
          const percentValue = Math.round((value / total) * 1000) / 10;
          return (
            <path
              key={item.label}
              d={arcPath(110, 110, donut ? 82 : 0, 100, start, end)}
              fill={color}
              onMouseEnter={() => setHovered({ label: item.label, value, percent: percentValue, color })}
              onMouseLeave={() => setHovered(null)}
            />
          );
        })}
        {donut && <circle cx="110" cy="110" r="54" className="donutHole" />}
        {donut && <text x="110" y="104" textAnchor="middle" className="donutTotal">{Math.round(total)}</text>}
        {donut && <text x="110" y="126" textAnchor="middle" className="donutLabel">total</text>}
      </svg>
      {hovered && <div className="pieTooltip"><i style={{ background: hovered.color }} /><strong>{hovered.label}</strong><span>{hovered.value} - {hovered.percent}%</span></div>}
      </div>
      <div className="legend">{data.map((item, index) => <span key={item.label}><i style={{ background: colors[index % colors.length] }} />{item.label}: {item.value}</span>)}</div>
    </div>
  );
}

function arcPath(cx: number, cy: number, innerR: number, outerR: number, start: number, end: number) {
  const large = end - start > Math.PI ? 1 : 0;
  const outerStart = polar(cx, cy, outerR, end);
  const outerEnd = polar(cx, cy, outerR, start);
  if (innerR === 0) return `M ${cx} ${cy} L ${outerStart.x} ${outerStart.y} A ${outerR} ${outerR} 0 ${large} 0 ${outerEnd.x} ${outerEnd.y} Z`;
  const innerStart = polar(cx, cy, innerR, start);
  const innerEnd = polar(cx, cy, innerR, end);
  return `M ${outerStart.x} ${outerStart.y} A ${outerR} ${outerR} 0 ${large} 0 ${outerEnd.x} ${outerEnd.y} L ${innerStart.x} ${innerStart.y} A ${innerR} ${innerR} 0 ${large} 1 ${innerEnd.x} ${innerEnd.y} Z`;
}

function polar(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + r * Math.cos(angle - Math.PI / 2), y: cy + r * Math.sin(angle - Math.PI / 2) };
}

function StackedChart({ data }: { data: { label: string; value: number }[] }) {
  const total = Math.max(1, data.reduce((sum, item) => sum + Math.max(0, item.value), 0));
  const colors = ["#0b2f63", "#1f6f55", "#c58b21", "#bd3f35", "#7257a7", "#2775a7"];
  return (
    <div className="stackedChart">
      <div>{data.map((item, index) => <i key={item.label} style={{ width: `${(Math.max(0, item.value) / total) * 100}%`, background: colors[index % colors.length] }} title={`${item.label}: ${item.value}`} />)}</div>
      <div className="legend">{data.map((item, index) => <span key={item.label}><i style={{ background: colors[index % colors.length] }} />{item.label}: {item.value}</span>)}</div>
    </div>
  );
}

function KpiChart({ data, metricLabel }: { data: { label: string; value: number }[]; metricLabel: string }) {
  return <div className="kpiChart">{data.map((item) => <article key={item.label}><span>{item.label}</span><strong>{item.value}</strong><small>{metricLabel}</small></article>)}</div>;
}

function Rule({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <article className="ruleCard"><span>{title}</span><strong>{value}</strong><p>{detail}</p></article>;
}

function InboxList({ inbox, setModule }: { inbox: InboxItem[]; setModule: (module: ModuleId) => void }) {
  return <div className="inboxList">{inbox.map((item) => <button key={item.id} className={item.tone} onClick={() => setModule(item.module)}><strong>{item.count}</strong><span>{item.title}</span><small>{item.detail}</small></button>)}</div>;
}

function GradeMatrix({ compact = false }: { compact?: boolean }) {
  const gradeList = compact ? grades.filter((item) => item !== "All").slice(0, 6) : grades.filter((item) => item !== "All");
  return (
    <div className={compact ? "gradeMatrix compactGradeMatrix" : "gradeMatrix"}>
      {gradeList.map((grade) => {
        const group = students.filter((student) => student.grade === grade);
        const riskCount = group.filter(isRisk).length;
        return <div key={grade}><strong>{grade}</strong><span>{group.length} students</span><small>{riskCount} watch</small></div>;
      })}
    </div>
  );
}

function MiniHeatmap() {
  return <div className="heatmap">{grades.filter((item) => item !== "All").map((grade) => <div key={grade} style={{ opacity: 0.45 + groupAverage(grade, "absences") / 20 }}><span>{grade}</span></div>)}</div>;
}

function FamilyGroups({ visibleStudents }: { visibleStudents: Student[] }) {
  const groups = visibleStudents.reduce<Record<string, Student[]>>((acc, student) => {
    acc[student.family] = [...(acc[student.family] ?? []), student];
    return acc;
  }, {});
  return <div className="familyGroups">{Object.entries(groups).map(([family, group]) => <div key={family}><strong>{family}</strong><span>{group.map(studentName).join(", ")}</span><small>{group[0].primaryContact}</small></div>)}</div>;
}

function CompareTray({ students: compared, setModule, remove }: { students: Student[]; setModule: (module: ModuleId) => void; remove: (id: string) => void }) {
  return (
    <aside className="compareTray">
      <div><strong>Compare Tray</strong><button onClick={() => setModule("charts")}>Open Charts</button></div>
      {compared.map((student) => <span key={student.id}>{studentName(student)} <button onClick={() => remove(student.id)}>Remove</button></span>)}
    </aside>
  );
}

function CompareTable({ students: compared }: { students: Student[] }) {
  if (!compared.length) return <p className="emptyText">Pin students from any list to compare them here.</p>;
  return <DataTable rows={compared.map((student) => ({ Name: studentName(student), Grade: student.grade, Attendance: percent(student.attendanceRate), GPA: student.gpa, Missing: student.missingAssignments, Behavior: student.behaviorPoints, Lunch: currency(student.lunchBalance), Risk: Math.round(riskScore(student)) }))} />;
}

function ProfileDrawer({ student, profileData, close, toggleCompare, updateStudent }: { student: Student; profileData: StudentProfileData; close: () => void; toggleCompare: (id: string) => void; updateStudent: (id: string, patch: Partial<Student>) => void }) {
  const [editing, setEditing] = useState(false);
  const [followUpStatus, setFollowUpStatus] = useState("");
  return (
    <div className="drawerBackdrop">
      <aside className="profileDrawer">
        <div className="drawerTop">
          <div><span>Student Profile</span><h2>{studentName(student)}</h2><p>Grade {student.grade} - {student.homeroom} - {student.advisor}</p></div>
          <button onClick={close}>Close</button>
        </div>
        <PageSummary items={[["Attendance", percent(student.attendanceRate)], ["GPA", student.gpa.toFixed(1)], ["Risk", String(Math.round(riskScore(student)))]]} />
        <div className="drawerActions"><button onClick={() => setEditing(!editing)}>{editing ? "Done Editing" : "Edit Student"}</button><button onClick={() => toggleCompare(student.id)}>Toggle Compare</button><button onClick={() => setFollowUpStatus(`Follow-up staged for ${studentName(student)}.`)}>Create Follow-Up</button></div>
        {followUpStatus && <p className="actionStatus">{followUpStatus}</p>}
        {editing ? (
          <div className="profileEditForm">
            <label>First name<input value={student.firstName} onChange={(event) => updateStudent(student.id, { firstName: event.target.value })} /></label>
            <label>Last name<input value={student.lastName} onChange={(event) => updateStudent(student.id, { lastName: event.target.value })} /></label>
            <label>Grade<input value={student.grade} onChange={(event) => updateStudent(student.id, { grade: event.target.value })} /></label>
            <label>Homeroom<input value={student.homeroom} onChange={(event) => updateStudent(student.id, { homeroom: event.target.value })} /></label>
            <label>Advisor<input value={student.advisor} onChange={(event) => updateStudent(student.id, { advisor: event.target.value })} /></label>
            <label>Status<select value={student.status} onChange={(event) => updateStudent(student.id, { status: event.target.value as StudentStatus })}><option>Active</option><option>Watch</option><option>Intervention</option></select></label>
            <label>Family<input value={student.family} onChange={(event) => updateStudent(student.id, { family: event.target.value })} /></label>
            <label>Primary contact<input value={student.primaryContact} onChange={(event) => updateStudent(student.id, { primaryContact: event.target.value })} /></label>
            <label>Allergies<input value={student.allergies} onChange={(event) => updateStudent(student.id, { allergies: event.target.value })} /></label>
            <label>Lunch balance<input type="number" value={student.lunchBalance} onChange={(event) => updateStudent(student.id, { lunchBalance: Number(event.target.value) })} /></label>
            <label className="wideField">Notes<input value={student.notes} onChange={(event) => updateStudent(student.id, { notes: event.target.value })} /></label>
          </div>
        ) : (
          <dl className="profileFacts">
            <div><dt>Family</dt><dd>{student.family}</dd></div>
            <div><dt>Contact</dt><dd>{student.primaryContact}</dd></div>
            <div><dt>Allergies</dt><dd>{student.allergies}</dd></div>
            <div><dt>Activities</dt><dd>{student.activities.join(", ")}</dd></div>
          </dl>
        )}
        <ProfileSection title="Family and Contacts">
          <div className="profileCards">
            {profileData.guardians.map((guardian) => (
              <article key={guardian.id}>
                <strong>{guardian.name}</strong>
                <span>{guardian.relationship} - {guardian.portalStatus}</span>
                <small>{guardian.email}</small>
                <small>{guardian.phone}</small>
                <small>{guardian.address}</small>
                <StatusPill label={guardian.pickupApproved ? "Pickup Approved" : "No Pickup"} />
              </article>
            ))}
            {profileData.siblings.map((sibling) => (
              <article key={sibling.id}>
                <strong>{studentName(sibling)}</strong>
                <span>Sibling - Grade {sibling.grade}</span>
                <small>{sibling.homeroom} - {sibling.advisor}</small>
              </article>
            ))}
          </div>
        </ProfileSection>
        <ProfileSection title="Attendance and Transportation">
          <DataTable rows={[{
            "Attendance Rate": percent(student.attendanceRate),
            Absences: student.absences,
            Tardies: student.tardies,
            Homeroom: student.homeroom,
            Bus: student.notes.includes("Bus") ? student.notes : "Not set"
          }]} />
        </ProfileSection>
        <ProfileSection title="Health, Services, and Documents">
          <div className="profileCards">
            <article><strong>Health</strong><span>Allergies: {student.allergies}</span><small>Medication and immunization records will map here.</small></article>
            {profileData.services.map((service) => <article key={service.id}><strong>{service.type}</strong><span>{service.provider}</span><small>{service.notes}</small><small>Review: {service.reviewDate}</small></article>)}
            {profileData.documents.map((document) => <article key={document.id}><strong>{document.title}</strong><span>{document.category}</span><small>Updated {document.updated}</small><StatusPill label={document.status} /></article>)}
          </div>
        </ProfileSection>
        <ProfileSection title="Academics, Behavior, and Lunch">
          <DataTable rows={[{
            GPA: student.gpa,
            "Missing Work": student.missingAssignments,
            "Behavior Points": student.behaviorPoints,
            "Lunch Balance": currency(student.lunchBalance),
            Activities: student.activities.join(", ")
          }]} />
        </ProfileSection>
        <ProfileSection title="Communication History">
          <DataTable rows={profileData.communications.map((log) => ({ Date: log.date, Channel: log.channel, Subject: log.subject, Staff: log.staff, Outcome: log.outcome }))} />
        </ProfileSection>
        <ProfileSection title="Timeline">
          <div className="timeline">{profileData.timeline.map((event) => <div key={event.id}><span>{event.date} - {event.type}</span><strong>{event.title}</strong><p>{event.detail}</p></div>)}</div>
        </ProfileSection>
      </aside>
    </div>
  );
}

function ProfileSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="profileSection">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function tableHtml(rows: Record<string, string | number>[]) {
  if (!rows.length) return "<p>No rows.</p>";
  const headers = Object.keys(rows[0]);
  return `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((header) => `<td>${row[header]}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

createRoot(document.getElementById("root")!).render(<App />);
