import { Expo, type ExpoPushMessage, type ExpoPushTicket, type ExpoPushReceipt } from "expo-server-sdk";
import * as storage from "./storage";

const expo = new Expo();

export async function checkPushReceipts(ticketIds: string[]): Promise<{ receipts: Record<string, any>; errors: string[] }> {
  const errors: string[] = [];
  const receipts: Record<string, any> = {};

  try {
    const receiptIdChunks = expo.chunkPushNotificationReceiptIds(ticketIds);
    for (const chunk of receiptIdChunks) {
      try {
        const receiptChunk = await expo.getPushNotificationReceiptsAsync(chunk);
        for (const [id, receipt] of Object.entries(receiptChunk)) {
          receipts[id] = receipt;
          if ((receipt as any).status === "error") {
            const r = receipt as any;
            errors.push(`Ticket ${id}: ${r.message || "unknown error"} (${r.details?.error || "no details"})`);
          }
        }
      } catch (e: any) {
        errors.push(`Receipt fetch error: ${e.message}`);
      }
    }
  } catch (e: any) {
    errors.push(`Receipt check failed: ${e.message}`);
  }

  return { receipts, errors };
}

const PUSHY_API_KEY = process.env.PUSHY_API_KEY || "";

async function sendPushyNotification(tokens: string[], title: string, body: string, data: Record<string, any>) {
  if (!PUSHY_API_KEY) {
    console.warn("Pushy API key not configured, skipping Pushy notifications");
    return;
  }
  if (tokens.length === 0) return;

  try {
    const response = await fetch("https://api.pushy.me/push?api_key=" + PUSHY_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: tokens,
        notification: {
          title,
          body,
          sound: "default",
          badge: 1,
        },
        data: { ...data, title, body },
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error("Pushy notification failed:", result);
    } else {
      console.log(`Pushy notification sent to ${tokens.length} device(s)`);
    }
  } catch (e) {
    console.error("Pushy notification error:", e);
  }
}

export async function sendCustomPush(
  title: string,
  body: string,
  targetDeviceId?: string
): Promise<{ sent: number; failed: number; details: string[] }> {
  const details: string[] = [];
  let sent = 0;
  let failed = 0;

  try {
    const allTokens = await storage.getAllPushTokens();
    const tokens = targetDeviceId
      ? allTokens.filter((t: any) => (t.device_id || t.deviceId) === targetDeviceId)
      : allTokens;

    if (tokens.length === 0) {
      details.push("No devices found");
      return { sent: 0, failed: 0, details };
    }

    const expoMessages: ExpoPushMessage[] = [];
    const pushyTokenList: string[] = [];

    for (const t of tokens) {
      if (t.provider === "pushy") {
        pushyTokenList.push(t.token);
        continue;
      }
      if (!Expo.isExpoPushToken(t.token)) {
        details.push(`Invalid Expo token: ${t.token.substring(0, 20)}...`);
        failed++;
        continue;
      }
      expoMessages.push({
        to: t.token,
        sound: "default",
        title,
        body,
        data: { type: "custom" },
        priority: "high",
        channelId: "default",
      });
    }

    if (expoMessages.length > 0) {
      const chunks = expo.chunkPushNotifications(expoMessages);
      for (const chunk of chunks) {
        try {
          const ticketChunk: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);
          for (let i = 0; i < ticketChunk.length; i++) {
            const ticket = ticketChunk[i];
            if (ticket.status === "ok") {
              sent++;
              details.push(`Expo push sent (ticket: ${ticket.id})`);
            } else {
              failed++;
              details.push(`Expo push error: ${ticket.message}`);
              if (ticket.details?.error === "DeviceNotRegistered") {
                const msg = chunk[i];
                const tokenStr = typeof msg.to === "string" ? msg.to : msg.to[0];
                await storage.removePushToken(tokenStr);
                details.push(`Removed invalid token: ${tokenStr.substring(0, 20)}...`);
              }
            }
          }
        } catch (e: any) {
          failed += chunk.length;
          details.push(`Expo chunk error: ${e.message}`);
        }
      }
    }

    if (pushyTokenList.length > 0) {
      if (!PUSHY_API_KEY) {
        details.push(`Skipped ${pushyTokenList.length} Pushy device(s) — no API key`);
        failed += pushyTokenList.length;
      } else {
        try {
          await sendPushyNotification(pushyTokenList, title, body, { type: "custom" });
          sent += pushyTokenList.length;
          details.push(`Pushy push sent to ${pushyTokenList.length} device(s)`);
        } catch (e: any) {
          failed += pushyTokenList.length;
          details.push(`Pushy error: ${e.message}`);
        }
      }
    }
  } catch (e: any) {
    details.push(`Error: ${e.message}`);
  }

  return { sent, failed, details };
}

export async function sendNewEpisodePushes(
  feedId: string,
  episode: { title: string; id: string },
  feedTitle?: string
) {
  try {
    const tokens = await storage.getSubscribersForFeed(feedId);
    if (tokens.length === 0) return;

    const displayTitle = feedTitle ? `New from ${feedTitle}` : "New Episode Available";

    const expoMessages: ExpoPushMessage[] = [];
    const pushyTokens: string[] = [];

    for (const t of tokens) {
      if (t.provider === "pushy") {
        pushyTokens.push(t.token);
        continue;
      }

      if (!Expo.isExpoPushToken(t.token)) {
        console.warn(`Invalid Expo push token: ${t.token}, removing`);
        await storage.removePushToken(t.token);
        continue;
      }
      expoMessages.push({
        to: t.token,
        sound: "default",
        title: displayTitle,
        body: episode.title,
        data: { episodeId: episode.id, feedId, type: "new_episode" },
        priority: "high",
        channelId: "new-episodes",
      });
    }

    if (expoMessages.length > 0) {
      const chunks = expo.chunkPushNotifications(expoMessages);
      for (const chunk of chunks) {
        try {
          const ticketChunk: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);
          for (let i = 0; i < ticketChunk.length; i++) {
            const ticket = ticketChunk[i];
            if (ticket.status === "error") {
              console.error(`Push notification error: ${ticket.message}`);
              if (ticket.details?.error === "DeviceNotRegistered") {
                const msg = chunk[i];
                const tokenStr = typeof msg.to === "string" ? msg.to : msg.to[0];
                await storage.removePushToken(tokenStr);
              }
            }
          }
        } catch (e) {
          console.error("Error sending Expo push notification chunk:", e);
        }
      }
    }

    if (pushyTokens.length > 0) {
      await sendPushyNotification(
        pushyTokens,
        displayTitle,
        episode.title,
        { episodeId: episode.id, feedId, type: "new_episode" }
      );
    }
  } catch (e) {
    console.error("sendNewEpisodePushes error:", e);
  }
}
