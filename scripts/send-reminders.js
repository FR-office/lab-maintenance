// send-reminders.js
// Runs in GitHub Actions on a schedule. Reads the lab-maintenance state from
// Firebase Realtime Database, finds tasks that are overdue AND marked with
// emailReminder = true, and sends one email per such task to its assignee
// via the EmailJS REST API.

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL; // e.g. https://lab-maintenance-e181d-default-rtdb.firebaseio.com
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

function freqLabel(f) {
  return f === 1 ? 'שבועי' : f === 2 ? 'דו-שבועי' : f === 4 ? 'חודשי' : f === 8 ? 'חודשיים' : `כל ${f} שב'`;
}

function isOverdue(task, completions) {
  const last = completions[task.id];
  if (!last) return false; // never done yet -> not "overdue" by this app's own definition
  const daysSince = (Date.now() - new Date(last.date)) / 86400000;
  return daysSince > task.freq * 7 * 1.5;
}

async function main() {
  if (!FIREBASE_DB_URL || !EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY) {
    console.error('Missing required environment variables/secrets.');
    process.exit(1);
  }

  const stateRes = await fetch(`${FIREBASE_DB_URL}/lab_fert_2024/state.json`);
  if (!stateRes.ok) throw new Error(`Failed to fetch state: ${stateRes.status}`);
  const state = await stateRes.json();

  const tasks = state?.tasks || [];
  const devices = state?.devices || [];
  const staff = state?.staff || [];
  const completions = state?.completions || {};

  const dueForReminder = tasks.filter(t => t.emailReminder && t.assigneeId && isOverdue(t, completions));

  if (!dueForReminder.length) {
    console.log('No overdue tasks with email reminders enabled. Nothing to send.');
    return;
  }

  console.log(`Found ${dueForReminder.length} task(s) to remind about.`);

  for (const task of dueForReminder) {
    const assignee = staff.find(s => s.id === task.assigneeId);
    if (!assignee || !assignee.email) {
      console.log(`Skipping task "${task.name}" — assignee has no email.`);
      continue;
    }
    const device = devices.find(d => d.id === task.deviceId);
    const last = completions[task.id];
    const daysOverdue = Math.floor((Date.now() - new Date(last.date)) / 86400000);

    const templateParams = {
      to_email: assignee.email,
      to_name: assignee.name,
      task_name: task.name,
      device_name: device ? device.name : 'כללי (ללא מכשיר)',
      freq_label: freqLabel(task.freq),
      days_overdue: daysOverdue,
      last_done_date: new Date(last.date).toLocaleDateString('he-IL'),
      instructions: task.instructions || ''
    };

    console.log(`Sending reminder for "${task.name}" to ${assignee.email}...`);

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
    } else {
      console.log(`Sent reminder for "${task.name}".`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
