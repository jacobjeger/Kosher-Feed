import React from "react";
import { View, Text, Pressable, StyleSheet, Modal, ScrollView, Platform } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { lightHaptic } from "@/lib/haptics";

export interface PickerOption {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  selected?: boolean;
}

interface Props {
  visible: boolean;
  title: string;
  subtitle?: string;
  options: PickerOption[];
  onClose: () => void;
}

function OptionPickerModal({ visible, title, subtitle, options, onClose }: Props) {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.surface }]} onPress={(e) => e.stopPropagation()}>
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={10} style={[styles.closeBtn, { backgroundColor: colors.surfaceAlt }]}>
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text>
          ) : null}
          <ScrollView style={styles.optionsList} bounces={false}>
            {options.map((opt, i) => (
              <Pressable
                key={i}
                style={({ pressed }) => [
                  styles.optionRow,
                  { backgroundColor: pressed ? colors.surfaceAlt : "transparent", borderColor: colors.border },
                  i < options.length - 1 && styles.optionBorder,
                ]}
                onPress={() => {
                  lightHaptic();
                  opt.onPress();
                  onClose();
                }}
              >
                <Text
                  style={[
                    styles.optionText,
                    { color: opt.destructive ? "#ef4444" : opt.selected ? colors.accent : colors.text },
                    opt.selected && styles.optionTextSelected,
                  ]}
                >
                  {opt.label}
                </Text>
                {opt.selected && (
                  <Ionicons name="checkmark" size={20} color={colors.accent} />
                )}
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 20,
    paddingBottom: Platform.OS === "web" ? 34 : 40,
    maxHeight: "70%",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: "700" as const,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  subtitle: {
    fontSize: 13,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  optionsList: {
    marginTop: 8,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  optionBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionText: {
    fontSize: 16,
  },
  optionTextSelected: {
    fontWeight: "600" as const,
  },
});

export default React.memo(OptionPickerModal);
