// send-reminders.js
// סקריפט מעודכן לתמיכה בעובדים מרובים ותזמוני תזכורת משתנים

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL; 
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

function freqLabel(f) {
  return f === 1 ? 'שבועי' : f === 2 ? 'דו-שבועי' : f === 4 ? 'חודשי' : f === 8 ? 'חודשיים' : `כל ${f} שב'`;
}

async function main() {
  if (!FIREBASE_DB_URL || !EMAILJS_SERVICE_ID) {
    console.error("Missing environment variables!");
    process.exit(1);
  }

  console.log("Fetching state from Firebase...");
  const res = await fetch(`${FIREBASE_DB_URL}/state.json`);
  const state = await res.json();

  if (!state || !state.tasks) {
    console.log("No tasks found.");
    return;
  }

  const tasks = state.tasks || [];
  const devices = state.devices || [];
  const completions = state.completions || {};
  const workers = state.workers || []; // משיכת רשימת העובדים

  // הגדרת תאריך של היום (מאופס לשעת חצות כדי למנוע בעיות של שעות קטנות)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const task of tasks) {
    // 1. האם יש למשימה אחראי מוגדר עם אימייל?
    if (!task.assigneeId) continue;
    const assignee = workers.find(w => w.id === task.assigneeId);
    if (!assignee || !assignee.email) continue;

    // 2. האם הוגדר תזמון תזכורת?
    const timing = task.reminderTiming || 'none';
    if (timing === 'none') continue;

    // 3. מציאת הביצוע האחרון וחישוב תאריך היעד הבא
    const last = completions[task.id];
    if (!last || !last.date) continue; // אם מעולם לא בוצע, כרגע לא נשלח התראה

    const lastDate = new Date(last.date);
    lastDate.setHours(0, 0, 0, 0);
    
    // הוספת ימים (תדירות בשבועות * 7 ימים)
    const nextDueDate = new Date(lastDate.getTime() + task.freq * 7 * 24 * 60 * 60 * 1000);
    
    // חישוב ההפרש בימים בין היום לתאריך היעד
    const diffTime = nextDueDate.getTime() - today.getTime();
    const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    // 4. לוגיקת שליחת התזכורת בהתאם לבחירה בטופס
    let shouldSend = false;
    
    // אם המשימה באיחור (עבר תאריך היעד) - נשלח התראה בכל מקרה
    if (daysRemaining <= 0) {
        shouldSend = true;
    } else {
        // אם המשימה עתידית, נבדוק אם הגענו לנקודת הזמן הספציפית לתזכורת
        if (timing === '1_day_before' && daysRemaining === 1) shouldSend = true;
        else if (timing === '3_days_before' && daysRemaining === 3) shouldSend = true;
        else if (timing === '1_week_before' && daysRemaining === 7) shouldSend = true;
    }

    if (!shouldSend) continue;

    // 5. הכנת הנתונים ושליחת המייל
    const device = devices.find(d => d.id === task.deviceId);
    const daysOverdue = daysRemaining < 0 ? Math.abs(daysRemaining) : 0;

    const templateParams = {
      to_email: assignee.email,
      to_name: assignee.name,
      task_name: task.name,
      device_name: device ? device.name : 'כללי (ללא מכשיר)',
      freq_label: freqLabel(task.freq),
      days_overdue: daysOverdue,
      last_done_date: lastDate.toLocaleDateString('he-IL'),
      instructions: task.instructions || 'אין הנחיות מיוחדות'
    };

    console.log(`Sending reminder for "${task.name}" to ${assignee.email}... (Days remaining to target: ${daysRemaining})`);

    try {
      const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
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

      if (!emailRes.ok) {
        const err = await emailRes.text();
        console.error('EmailJS Error:', err);
      } else {
        console.log('Email sent successfully!');
      }
    } catch (e) {
      console.error("Failed to send email", e);
    }
  }
}

main();
