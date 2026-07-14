// send-reminders.js
// Runs in GitHub Actions on a daily schedule. For each task that has
// emailReminder = true and a due date, checks whether TODAY is the
// scheduled reminder day (due date minus reminderDaysBefore days).
// If so, sends an email to the assignee via the EmailJS REST API, and
// records that a reminder was already sent for that due-date cycle so
// it won't be sent again if the workflow runs more than once that day.

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL; // e.g. https://lab-maintenance-e181d-default-rtdb.firebaseio.com
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const TIMEZONE = 'Asia/Jerusalem'; // used only to decide which calendar day "today" is

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }); // yields YYYY-MM-DD

function toDateStr(d) {
  return dateFmt.format(d);
}

function freqLabel(f) {
  return f === 1 ? 'שבועי' : f === 2 ? 'דו-שבועי' : f === 4 ? 'חודשי' : f === 8 ? 'חודשיים' : `כל ${f} שב'`;
}

function reminderTimingLabel(days) {
  const d = days || 0;
  if (d === 0) return 'ביום היעד';
  if (d === 1) return 'יום לפני';
  if (d === 2) return 'יומיים לפני';
  return `${d} ימים לפני`;
}

function hasFixedWeekday(task) {
  return task.fixedWeekday !== undefined && task.fixedWeekday !== null && task.fixedWeekday !== '';
}

// Mirrors nextDueDate() in the web app: due date = last completion date + freq weeks,
// or — if the task has a fixed weekday set — the same weekday every cycle.
// "As-needed" tasks and never-completed tasks have no computable due date, so
// day-before/on-due-date email reminders don't apply to them (they're skipped here;
// as-needed tasks should rely on the app's own overdue safety-margin flag instead).
function nextDueDate(task, completions) {
  const last = completions[task.id];
  if (!last) return null;
  if (task.freqType === 'asneeded') return null;
  const lastDate = new Date(last.date);
  if (hasFixedWeekday(task)) {
    const day = lastDate.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const weekStart = new Date(lastDate);
    weekStart.setDate(weekStart.getDate() + diffToMonday);
    weekStart.setHours(0, 0, 0, 0);
    const targetWeekStart = new Date(weekStart);
    targetWeekStart.setDate(targetWeekStart.getDate() + task.freq * 7);
    const fw = parseInt(task.fixedWeekday);
    const offset = fw === 0 ? 6 : fw - 1;
    const due = new Date(targetWeekStart);
    due.setDate(due.getDate() + offset);
    return due;
  }
  const d = new Date(lastDate);
  d.setDate(d.getDate() + task.freq * 7);
  return d;
}

async function main() {
  if (!FIREBASE_DB_URL || !EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY) {
    console.error('Missing required environment variables/secrets.');
    process.exit(1);
  }

  const stateUrl = `${FIREBASE_DB_URL}/lab_fert_2024/state.json`;
  const stateRes = await fetch(stateUrl);
  if (!stateRes.ok) throw new Error(`Failed to fetch state: ${stateRes.status}`);
  const state = await stateRes.json();

  const tasks = state?.tasks || [];
  const devices = state?.devices || [];
  const staff = state?.staff || [];
  const completions = state?.completions || {};

  const today = new Date();
  const todayStr = toDateStr(today);

  let anyChanges = false;
  const toSend = [];

  for (const task of tasks) {
    if (!task.emailReminder || !task.assigneeId) continue;

    const due = nextDueDate(task, completions);
    if (!due) continue; // never completed yet — no baseline to count from

    const dueStr = toDateStr(due);
    const daysBefore = task.reminderDaysBefore || 0;
    const target = new Date(due);
    target.setDate(target.getDate() - daysBefore);
    const targetStr = toDateStr(target);

    if (targetStr !== todayStr) continue; // not the scheduled day yet
    if (task.lastReminderSentFor === dueStr) continue; // already sent for this cycle

    toSend.push({ task, dueStr });
  }

  if (!toSend.length) {
    console.log('No reminders scheduled for today. Nothing to send.');
    return;
  }

  console.log(`Found ${toSend.length} reminder(s) to send today (${todayStr}).`);

  for (const { task, dueStr } of toSend) {
    const assignee = staff.find(s => s.id === task.assigneeId);
    if (!assignee || !assignee.email) {
      console.log(`Skipping task "${task.name}" — assignee has no email.`);
      continue;
    }
    const device = devices.find(d => d.id === task.deviceId);

    const templateParams = {
      to_email: assignee.email,
      to_name: assignee.name,
      task_name: task.name,
      device_name: device ? device.name : 'כללי (ללא מכשיר)',
      freq_label: freqLabel(task.freq),
      due_date: new Date(dueStr).toLocaleDateString('he-IL'),
      timing_label: reminderTimingLabel(task.reminderDaysBefore),
      instructions: task.instructions || ''
    };

    console.log(`Sending reminder for "${task.name}" to ${assignee.email} (due ${dueStr})...`);

    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: templateParams
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Failed to send for task "${task.name}": ${res.status} ${text}`);
      continue; // don't mark as sent if it failed
    }

    console.log(`Sent reminder for "${task.name}".`);
    task.lastReminderSentFor = dueStr;
    anyChanges = true;
  }

  if (anyChanges) {
    console.log('Writing back updated state (lastReminderSentFor markers)...');
    const putRes = await fetch(stateUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!putRes.ok) {
      console.error(`Failed to write back state: ${putRes.status} ${await putRes.text()}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
