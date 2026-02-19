import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import * as storage from "./storage";

const expo = new Expo();

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
