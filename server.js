const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const QUESTIONS = require("./questions");
 
// ===== SETTINGS =====
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me"; // set a real one!
const NUM_Q = 10;          // questions per quiz
const MINUTES = 10;        // quiz duration
const GRACE_SEC = 10;      // network delay allowance on submit
const ALLOW_RETAKE = false; // false = one attempt per roll number
 
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "quiz.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  roll_no TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  question_ids TEXT NOT NULL,
  answers TEXT,
  score INTEGER,
  total INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  submitted_at INTEGER
);`);
 
const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));
 
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
 
function grade(ids, answers) {
  let score = 0;
  const review = ids.map((id, i) => {
    const q = QUESTIONS[id];
    const yours = Number.isInteger(answers[i]) ? answers[i] : null;
    if (yours === q.a) score++;
    return { q: q.q, o: q.o, a: q.a, yours };
  });
  return { score, review };
}
 
function finalize(att, answers) {
  const g = grade(JSON.parse(att.question_ids), answers);
  db.prepare("UPDATE attempts SET answers=?, score=?, submitted_at=? WHERE id=?")
    .run(JSON.stringify(answers), g.score, Date.now(), att.id);
  return g;
}
 
// Start (or resume) a quiz
app.post("/api/start", (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 80);
  const roll = String(req.body.roll || "").trim().toUpperCase().slice(0, 30);
  if (!name || !roll) return res.status(400).json({ error: "Name and roll number are required" });
 
  let student = db.prepare("SELECT * FROM students WHERE roll_no=?").get(roll);
  if (!student) {
    const r = db.prepare("INSERT INTO students(name, roll_no) VALUES(?,?)").run(name, roll);
    student = { id: r.lastInsertRowid, name, roll_no: roll };
  } else if (student.name.toLowerCase() !== name.toLowerCase()) {
    return res.status(409).json({ error: "This roll number is registered under a different name" });
  }
 
  const now = Date.now(), dur = MINUTES * 60 * 1000;
  let open = db.prepare("SELECT * FROM attempts WHERE student_id=? AND submitted_at IS NULL ORDER BY id DESC").get(student.id);
  if (open && now > open.started_at + dur + GRACE_SEC * 1000) { finalize(open, []); open = null; }
 
  if (!open) {
    if (!ALLOW_RETAKE && db.prepare("SELECT 1 FROM attempts WHERE student_id=? AND submitted_at IS NOT NULL").get(student.id))
      return res.status(403).json({ error: "You have already taken this quiz" });
    const ids = shuffle(QUESTIONS.map((_, i) => i)).slice(0, NUM_Q);
    const r = db.prepare("INSERT INTO attempts(student_id, question_ids, total, started_at) VALUES(?,?,?,?)")
      .run(student.id, JSON.stringify(ids), ids.length, now);
    open = { id: r.lastInsertRowid, question_ids: JSON.stringify(ids), started_at: now };
  }
 
  const ids = JSON.parse(open.question_ids);
  res.json({
    attemptId: open.id,
    student: { name: student.name, roll_no: student.roll_no },
    remaining: Math.max(1, Math.floor((open.started_at + dur - now) / 1000)),
    questions: ids.map(i => ({ q: QUESTIONS[i].q, o: QUESTIONS[i].o })) // no answers sent
  });
});
 
// Submit answers; score is calculated on the server
app.post("/api/submit", (req, res) => {
  const att = db.prepare(
    "SELECT a.*, s.roll_no FROM attempts a JOIN students s ON s.id=a.student_id WHERE a.id=?"
  ).get(Number(req.body.attemptId));
  if (!att || att.roll_no !== String(req.body.roll || "").toUpperCase())
    return res.status(404).json({ error: "Attempt not found" });
  if (att.submitted_at) return res.status(409).json({ error: "Already submitted" });
 
  const late = Date.now() > att.started_at + (MINUTES * 60 + GRACE_SEC) * 1000;
  const answers = !late && Array.isArray(req.body.answers) ? req.body.answers : [];
  const g = finalize(att, answers);
  res.json({ score: g.score, total: att.total, review: g.review, late });
});
 
// Admin: view all results  ->  /api/admin/results?key=YOUR_KEY   (&format=csv)
app.get("/api/admin/results", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  const rows = db.prepare(`
    SELECT s.name, s.roll_no, a.score, a.total,
           datetime(a.started_at/1000,'unixepoch') AS started,
           datetime(a.submitted_at/1000,'unixepoch') AS submitted
    FROM attempts a JOIN students s ON s.id=a.student_id ORDER BY a.id DESC`).all();
  if (req.query.format === "csv") {
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = "name,roll_no,score,total,started,submitted";
    res.type("text/csv").send([head, ...rows.map(r => Object.values(r).map(esc).join(","))].join("\n"));
  } else res.json(rows);
});
 
app.listen(PORT, () => console.log(`Quiz portal running on http://localhost:${PORT}`));
 