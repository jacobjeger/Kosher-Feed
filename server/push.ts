import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import * as storage from "./storage";

const expo = new Expo();

export async function sendNewEpisodePushes(
  feedId: string,
  episode: { title: string; id: string },
  feedTitle?: string
) {
  try {
    const tokens = await storage.getSubscribersForFeed(feedId);
    if (tokens.length === 0) return;

    const displayTitle = feedTitle ? `New from ${feedTitle}` : "New Episode Available";

    const messages: ExpoPushMessage[] = [];
    for (const t of tokens) {
      if (!Expo.isExpoPushToken(t.token)) {
        console.warn(`Invalid Expo push token: ${t.token}, removing`);
        await storage.removePushToken(t.token);
        continue;
      }
      messages.push({
        to: t.token,
        sound: "default",
        title: displayTitle,
        body: episode.title,
        data: { episodeId: episode.id, feedId, type: "new_episode" },
        priority: "high",
        channelId: "new-episodes",
      });
    }

    if (messages.length === 0) return;

    const chunks = expo.chunkPushNotifications(messages);
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
        console.error("Error sending push notification chunk:", e);
      }
    }
  } catch (e) {
    console.error("sendNewEpisodePushes error:", e);
  }
}
