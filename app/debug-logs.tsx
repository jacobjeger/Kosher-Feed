import React, { useSyncExternalStore, useCallback, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Alert,
  Share,
  Platform,
} from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { safeGoBack } from "@/lib/safe-back";
import Colors from "@/constants/colors";
import {
  subscribeLogs,
  getLogsSnapshot,
  clearLogs,
  type LogEntry,
} from "@/lib/error-logger";

const LEVEL_COLORS = {
  error: "#ef4444",
  warn: "#f59e0b",
  info: "#3b82f6",
};

const LEVEL_ICONS: Record<string, any> = {
  error: "close-circle",
  warn: "warning",
  info: "information-circle",
};

function LogItem({
  item,
  colors,
}: {
  item: LogEntry;
  colors: any;
}) {
  const [expanded, setExpanded] = useState(false);
  const levelColor = LEVEL_COLORS[item.level];
  const time = new Date(item.timestamp);
  const timeStr = `${time.getHours().toString().padStart(2, "0")}:${time.getMinutes().toString().padStart(2, "0")}:${time.getSeconds().toString().padStart(2, "0")}`;

  return (
    <Pressable
      style={[styles.logItem, { borderColor: colors.border }]}
      onPress={() => setExpanded(!expanded)}
    >
      <View style={styles.logHeader}>
        <Ionicons
          name={LEVEL_ICONS[item.level]}
          size={16}
          color={levelColor}
        />
        <Text style={[styles.logLevel, { color: levelColor }]}>
          {item.level.toUpperCase()}
        </Text>
        <Text style={[styles.logTime, { color: colors.textSecondary }]}>
          {timeStr}
        </Text>
        {item.source && (
          <Text style={[styles.logSource, { color: colors.textSecondary }]}>
            {item.source}
          </Text>
        )}
      </View>
      <Text
        style={[styles.logMessage, { color: colors.text }]}
        numberOfLines={expanded ? undefined : 3}
      >
        {item.message}
      </Text>
      {expanded && item.stack && (
        <Text
          style={[styles.logStack, { color: colors.textSecondary }]}
          selectable
        >
          {item.stack}
        </Text>
      )}
      {(item.stack || item.message.length > 120) && (
        <Text style={[styles.expandHint, { color: colors.accent }]}>
          {expanded ? "Tap to collapse" : "Tap to expand"}
        </Text>
      )}
    </Pressable>
  );
}

export default function DebugLogsScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const logs = useSyncExternalStore(subscribeLogs, getLogsSnapshot, getLogsSnapshot);

  const handleClear = useCallback(() => {
    if (Platform.OS === "web") {
      clearLogs();
    } else {
      Alert.alert("Clear Logs", "Remove all logged entries?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => clearLogs(),
        },
      ]);
    }
  }, []);

  const handleShare = useCallback(async () => {
    const text = logs
      .map(
        (l) =>
          `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.source ? `(${l.source}) ` : ""}${l.message}${l.stack ? `\n${l.stack}` : ""}`
      )
      .join("\n\n");

    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(text);
        Alert.alert("Copied", "Logs copied to clipboard");
      } catch {
        Alert.alert("Error", "Could not copy logs");
      }
    } else {
      try {
        await Share.share({ message: text, title: "ShiurPod Debug Logs" });
      } catch {}
    }
  }, [logs]);

  const errorCount = logs.filter((l) => l.level === "error").length;
  const warnCount = logs.filter((l) => l.level === "warn").length;

  const renderItem = useCallback(
    ({ item }: { item: LogEntry }) => <LogItem item={item} colors={colors} />,
    [colors]
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          { paddingTop: Platform.OS === "web" ? 12 : insets.top + 8 },
        ]}
      >
        <Pressable onPress={() => safeGoBack()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          Debug Logs
        </Text>
        <View style={styles.headerActions}>
          <Pressable onPress={handleShare} hitSlop={12} style={styles.headerBtn}>
            <Ionicons
              name={Platform.OS === "web" ? "copy-outline" : "share-outline"}
              size={20}
              color={colors.text}
            />
          </Pressable>
          <Pressable onPress={handleClear} hitSlop={12} style={styles.headerBtn}>
            <Ionicons name="trash-outline" size={20} color="#ef4444" />
          </Pressable>
        </View>
      </View>

      <View style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: "#ef4444" }]}>
            {errorCount}
          </Text>
          <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
            Errors
          </Text>
        </View>
        <View style={[styles.summaryDivider, { backgroundColor: colors.border }]} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: "#f59e0b" }]}>
            {warnCount}
          </Text>
          <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
            Warnings
          </Text>
        </View>
        <View style={[styles.summaryDivider, { backgroundColor: colors.border }]} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryCount, { color: colors.text }]}>
            {logs.length}
          </Text>
          <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
            Total
          </Text>
        </View>
      </View>

      {logs.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons
            name="checkmark-circle-outline"
            size={48}
            color={colors.textSecondary}
          />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            No logs yet
          </Text>
          <Text style={[styles.emptySubtext, { color: colors.textSecondary }]}>
            Errors and warnings will appear here automatically
          </Text>
        </View>
      ) : (
        <FlatList
          data={logs}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + 20 },
          ]}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "700",
    flex: 1,
  },
  headerActions: {
    flexDirection: "row",
    gap: 8,
  },
  headerBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  summary: {
    flexDirection: "row",
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    marginBottom: 12,
  },
  summaryItem: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  summaryCount: {
    fontSize: 20,
    fontWeight: "700",
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: "500",
  },
  summaryDivider: {
    width: 1,
  },
  list: {
    paddingHorizontal: 16,
    gap: 8,
  },
  logItem: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  logHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  logLevel: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  logTime: {
    fontSize: 11,
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
  },
  logSource: {
    fontSize: 10,
    fontStyle: "italic",
  },
  logMessage: {
    fontSize: 13,
    lineHeight: 18,
  },
  logStack: {
    fontSize: 10,
    lineHeight: 15,
    marginTop: 4,
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
  },
  expandHint: {
    fontSize: 11,
    fontWeight: "600",
    marginTop: 2,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 40,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: "600",
  },
  emptySubtext: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
});
