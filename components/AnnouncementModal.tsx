import React from "react";
import { View, Text, Pressable, Modal, StyleSheet, ScrollView } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";

interface Announcement {
  id: string;
  title: string;
  body: string;
  imageUrl?: string | null;
  actionLabel?: string | null;
  actionUrl?: string | null;
}

interface Props {
  announcement: Announcement | null;
  visible: boolean;
  onDismiss: () => void;
}

export default function AnnouncementModal({ announcement, visible, onDismiss }: Props) {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  if (!announcement) return null;

  const handleAction = () => {
    if (!announcement.actionUrl) return;
    if (announcement.actionUrl.startsWith("/")) {
      router.push(announcement.actionUrl as any);
      onDismiss();
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.overlay}>
        <View style={[styles.modal, { backgroundColor: colors.card }]}>
          <Pressable style={styles.closeBtn} onPress={onDismiss} hitSlop={12}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </Pressable>

          {announcement.imageUrl && (
            <Image
              source={{ uri: announcement.imageUrl }}
              style={styles.image}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          )}

          <ScrollView style={styles.content} bounces={false}>
            <Text style={[styles.title, { color: colors.text }]}>{announcement.title}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>{announcement.body}</Text>
          </ScrollView>

          {announcement.actionLabel && announcement.actionUrl && announcement.actionUrl.startsWith("/") && (
            <Pressable
              style={[styles.actionBtn, { backgroundColor: colors.accent }]}
              onPress={handleAction}
            >
              <Text style={styles.actionBtnText}>{announcement.actionLabel}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 30,
  },
  modal: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 20,
    overflow: "hidden",
    maxHeight: "80%",
  },
  closeBtn: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.1)",
  },
  image: {
    width: "100%",
    height: 180,
  },
  content: {
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 10,
    paddingRight: 30,
  },
  body: {
    fontSize: 14,
    lineHeight: 21,
  },
  actionBtn: {
    marginHorizontal: 20,
    marginBottom: 20,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  actionBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
});
