import React, { useState, useCallback, useRef, useEffect } from "react";
import { View, Text, FlatList, TextInput, Pressable, StyleSheet, Platform, ActivityIndicator, KeyboardAvoidingView } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";
import { getDeviceId } from "@/lib/device-id";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { safeGoBack } from "@/lib/safe-back";
import { useBackHandler } from "@/hooks/useBackHandler";
import FocusableView from "@/components/FocusableView";

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function MessagesScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const queryClient = useQueryClient();
  const [selectedConv, setSelectedConv] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  useBackHandler(useCallback(() => {
    if (selectedConv) { setSelectedConv(null); return true; }
    safeGoBack(); return true;
  }, [selectedConv]));

  const convsQuery = useQuery({
    queryKey: ["/api/conversations"],
    queryFn: async () => {
      const deviceId = await getDeviceId();
      const baseUrl = getApiUrl();
      const res = await fetch(`${baseUrl}/api/conversations/${deviceId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const msgsQuery = useQuery({
    queryKey: ["/api/conversations/messages", selectedConv],
    queryFn: async () => {
      if (!selectedConv) return [];
      const deviceId = await getDeviceId();
      const baseUrl = getApiUrl();
      const res = await fetch(`${baseUrl}/api/conversations/${deviceId}/${selectedConv}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    enabled: !!selectedConv,
    refetchInterval: 10000,
  });

  useEffect(() => {
    if (msgsQuery.data?.length) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 200);
    }
  }, [msgsQuery.data?.length]);

  const handleSend = useCallback(async () => {
    if (!newMessage.trim() || !selectedConv || sending) return;
    setSending(true);
    try {
      const baseUrl = getApiUrl();
      await fetch(`${baseUrl}/api/conversations/${selectedConv}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: newMessage.trim(), deviceId: await getDeviceId() }),
      });
      setNewMessage("");
      queryClient.invalidateQueries({ queryKey: ["/api/conversations/messages", selectedConv] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    } catch {}
    setSending(false);
  }, [newMessage, selectedConv, sending, queryClient]);

  // Message thread view
  if (selectedConv) {
    const conv = convsQuery.data?.find((c: any) => c.id === selectedConv);
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
          <FocusableView autoFocus onPress={() => setSelectedConv(null)} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </FocusableView>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{conv?.subject || "Conversation"}</Text>
          <View style={{ width: 24 }} />
        </View>

        <FlatList
          ref={flatListRef}
          data={msgsQuery.data || []}
          keyExtractor={(item: any) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
          renderItem={({ item }: { item: any }) => {
            const isAdmin = item.sender === "admin";
            return (
              <View style={[styles.bubble, isAdmin ? styles.bubbleAdmin : styles.bubbleUser, { backgroundColor: isAdmin ? colors.accent : colors.surfaceAlt }]}>
                <Text style={[styles.bubbleText, { color: isAdmin ? "#fff" : colors.text }]}>{item.message}</Text>
                <Text style={[styles.bubbleTime, { color: isAdmin ? "rgba(255,255,255,0.6)" : colors.textTertiary }]}>{formatTime(item.createdAt)}</Text>
              </View>
            );
          }}
          ListEmptyComponent={
            msgsQuery.isLoading ? <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} /> :
            <Text style={{ textAlign: "center", color: colors.textSecondary, marginTop: 40 }}>No messages yet</Text>
          }
        />

        <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8, backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surfaceAlt, color: colors.text }]}
            placeholder="Type a message..."
            placeholderTextColor={colors.textSecondary}
            value={newMessage}
            onChangeText={setNewMessage}
            multiline
            maxLength={2000}
          />
          <FocusableView
            onPress={handleSend}
            style={[styles.sendBtn, { backgroundColor: newMessage.trim() ? colors.accent : colors.surfaceAlt }]}
            focusRadius={20}
          >
            {sending ? <ActivityIndicator size={18} color="#fff" /> : <Ionicons name="send" size={18} color={newMessage.trim() ? "#fff" : colors.textSecondary} />}
          </FocusableView>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // Conversations list
  const totalUnread = (convsQuery.data || []).reduce((sum: number, c: any) => sum + (c.unreadCount || 0), 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
        <FocusableView autoFocus onPress={() => safeGoBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </FocusableView>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Messages {totalUnread > 0 ? `(${totalUnread})` : ""}</Text>
        <View style={{ width: 24 }} />
      </View>

      <FlatList
        data={convsQuery.data || []}
        keyExtractor={(item: any) => item.id}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }: { item: any }) => (
          <FocusableView
            focusRadius={12}
            onPress={() => setSelectedConv(item.id)}
            style={[styles.convItem, { backgroundColor: colors.surface, borderColor: item.unreadCount > 0 ? colors.accent : colors.cardBorder }]}
          >
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={[styles.convSubject, { color: colors.text }]} numberOfLines={1}>{item.subject}</Text>
                {item.unreadCount > 0 && (
                  <View style={[styles.badge, { backgroundColor: colors.accent }]}>
                    <Text style={styles.badgeText}>{item.unreadCount}</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.convPreview, { color: colors.textSecondary }]} numberOfLines={1}>{item.lastMessage || "No messages"}</Text>
              <Text style={[styles.convTime, { color: colors.textTertiary }]}>{formatTime(item.updatedAt)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
          </FocusableView>
        )}
        ListEmptyComponent={
          convsQuery.isLoading ? <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} /> :
          <View style={{ alignItems: "center", padding: 40 }}>
            <Ionicons name="chatbubbles-outline" size={48} color={colors.textSecondary} />
            <Text style={{ color: colors.textSecondary, marginTop: 12, textAlign: "center" }}>No messages yet.{"\n"}Submit feedback and we'll get back to you here.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  headerTitle: { fontSize: 18, fontWeight: "700", flex: 1, textAlign: "center" },
  convItem: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 8, gap: 12 },
  convSubject: { fontSize: 15, fontWeight: "600", flex: 1 },
  convPreview: { fontSize: 13, marginTop: 2 },
  convTime: { fontSize: 11, marginTop: 4 },
  badge: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  bubble: { maxWidth: "80%", padding: 10, borderRadius: 14, marginBottom: 8 },
  bubbleUser: { alignSelf: "flex-end", borderBottomRightRadius: 4 },
  bubbleAdmin: { alignSelf: "flex-start", borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 14, lineHeight: 20 },
  bubbleTime: { fontSize: 10, marginTop: 4, textAlign: "right" },
  inputBar: { flexDirection: "row", alignItems: "flex-end", padding: 8, paddingHorizontal: 12, borderTopWidth: 1, gap: 8 },
  input: { flex: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, maxHeight: 100 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
});
