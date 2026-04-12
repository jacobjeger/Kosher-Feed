import { Resend } from "resend";

const ALERT_EMAIL = "akivajeger@gmail.com";
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // Don't send more than 1 alert per 30 min
const SPIKE_THRESHOLD = 10; // errors in the window to trigger alert
const SPIKE_WINDOW_MS = 5 * 60 * 1000; // 5-minute sliding window

let lastAlertSentAt = 0;
const recentErrors: number[] = []; // timestamps of recent errors

export function trackErrorForAlert(error: { level: string; message: string; source?: string; platform?: string; appVersion?: string }) {
  if (error.level !== "error") return;

  const now = Date.now();
  recentErrors.push(now);

  // Trim old entries outside the window
  while (recentErrors.length > 0 && recentErrors[0] < now - SPIKE_WINDOW_MS) {
    recentErrors.shift();
  }

  // Check if we should alert
  if (recentErrors.length >= SPIKE_THRESHOLD && now - lastAlertSentAt > ALERT_COOLDOWN_MS) {
    lastAlertSentAt = now;
    sendErrorAlert(recentErrors.length, error).catch(e => {
      console.error("Failed to send error alert email:", e.message);
    });
  }
}

async function sendErrorAlert(errorCount: number, latestError: { message: string; source?: string; platform?: string; appVersion?: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("Error alert: RESEND_API_KEY not set, skipping email");
    return;
  }

  const resend = new Resend(apiKey);

  const subject = `⚠️ ShiurPod: ${errorCount} errors in last 5 minutes`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#ef4444;margin-bottom:16px;">Error Spike Detected</h2>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:16px;">
        <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#991b1b;">${errorCount} errors</p>
        <p style="margin:0;color:#7f1d1d;">in the last 5 minutes</p>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
        <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Latest Error</p>
        <p style="margin:0;font-size:14px;color:#1e293b;font-family:monospace;word-break:break-all;">${escHtml(latestError.message.substring(0, 500))}</p>
        <p style="margin:8px 0 0;font-size:12px;color:#94a3b8;">
          Source: ${escHtml(latestError.source || "unknown")} ·
          Platform: ${escHtml(latestError.platform || "unknown")} ·
          Version: ${escHtml(latestError.appVersion || "unknown")}
        </p>
      </div>
      <a href="https://kosher-feed-production.up.railway.app/admin"
         style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">
        View Error Reports →
      </a>
      <p style="margin-top:16px;font-size:11px;color:#94a3b8;">
        This alert won't fire again for 30 minutes. Threshold: ${SPIKE_THRESHOLD} errors in ${SPIKE_WINDOW_MS / 60000} minutes.
      </p>
    </div>
  `;

  await resend.emails.send({
    from: "ShiurPod Alerts <alerts@shiurpod.com>",
    to: ALERT_EMAIL,
    subject,
    html,
  });

  console.log(`Error alert email sent: ${errorCount} errors in last 5 min`);
}

export async function sendFeedbackNotification(feedback: {
  type: string; subject: string; message: string;
  contactInfo?: string | null; deviceId?: string | null;
  deviceModel?: string | null; deviceBrand?: string | null;
  platform?: string | null; osVersion?: string | null;
  appVersion?: string | null; country?: string | null;
  city?: string | null; deviceLogs?: string | null;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const resend = new Resend(apiKey);
  const typeLabel = feedback.type === "shiur_request" ? "🎵 Shiur Request" : "🔧 Technical Issue";
  const typeColor = feedback.type === "shiur_request" ? "#3b82f6" : "#f59e0b";

  const deviceInfo = [
    feedback.deviceBrand && feedback.deviceModel ? `${feedback.deviceBrand} ${feedback.deviceModel}` : feedback.deviceModel,
    feedback.platform,
    feedback.osVersion ? `OS ${feedback.osVersion}` : null,
    feedback.appVersion ? `v${feedback.appVersion}` : null,
  ].filter(Boolean).join(" · ");

  const location = [feedback.city, feedback.country].filter(Boolean).join(", ");

  // Format device logs (parse JSON, show last 10 entries)
  let logsHtml = "";
  if (feedback.deviceLogs) {
    try {
      const logs = JSON.parse(feedback.deviceLogs);
      if (Array.isArray(logs) && logs.length > 0) {
        const entries = logs.slice(0, 15).map((l: any) => {
          const time = new Date(l.timestamp).toLocaleTimeString();
          const color = l.level === "error" ? "#ef4444" : l.level === "warn" ? "#f59e0b" : "#94a3b8";
          return `<div style="padding:4px 0;border-bottom:1px solid #f1f5f9;font-size:12px;"><span style="color:${color};font-weight:600;">[${l.level}]</span> <span style="color:#64748b;">${time}</span> ${escHtml((l.message || "").substring(0, 200))}</div>`;
        }).join("");
        logsHtml = `
          <div style="margin-top:16px;">
            <p style="font-size:13px;font-weight:600;color:#1e293b;margin:0 0 8px;">Device Logs (${logs.length} entries)</p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-family:monospace;max-height:400px;overflow-y:auto;">${entries}</div>
          </div>`;
      }
    } catch {}
  }

  await resend.emails.send({
    from: "ShiurPod Alerts <alerts@shiurpod.com>",
    to: ALERT_EMAIL,
    subject: `${typeLabel}: ${feedback.subject.substring(0, 80)}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="display:inline-block;background:${typeColor};color:#fff;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600;margin-bottom:12px;">${typeLabel}</div>
        <h2 style="margin:0 0 16px;color:#1e293b;">${escHtml(feedback.subject)}</h2>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
          <p style="margin:0;font-size:14px;color:#475569;white-space:pre-wrap;line-height:1.6;">${escHtml(feedback.message.substring(0, 3000))}</p>
        </div>
        <table style="width:100%;font-size:13px;color:#475569;border-collapse:collapse;margin-bottom:16px;">
          ${feedback.contactInfo ? `<tr><td style="padding:4px 0;color:#94a3b8;width:80px;">Contact</td><td style="padding:4px 0;"><a href="mailto:${escHtml(feedback.contactInfo)}" style="color:#3b82f6;">${escHtml(feedback.contactInfo)}</a></td></tr>` : ""}
          ${deviceInfo ? `<tr><td style="padding:4px 0;color:#94a3b8;">Device</td><td style="padding:4px 0;">${escHtml(deviceInfo)}</td></tr>` : ""}
          ${location ? `<tr><td style="padding:4px 0;color:#94a3b8;">Location</td><td style="padding:4px 0;">${escHtml(location)}</td></tr>` : ""}
          ${feedback.deviceId ? `<tr><td style="padding:4px 0;color:#94a3b8;">Device ID</td><td style="padding:4px 0;font-family:monospace;font-size:11px;">${escHtml(feedback.deviceId)}</td></tr>` : ""}
        </table>
        ${logsHtml}
        <div style="margin-top:20px;">
          <a href="https://kosher-feed-production.up.railway.app/admin"
             style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">
            View in Admin →
          </a>
        </div>
      </div>
    `,
  }).catch(e => console.error("Failed to send feedback notification:", e.message));
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
