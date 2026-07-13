import React from "react";
import { View, Text, Pressable, StyleSheet, Modal, Platform } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { lightHaptic } from "@/lib/haptics";
import FocusableView from "@/components/FocusableView";

// Fine-grained playback-speed control. Replaces the old tap-to-cycle
// button + coarse 7-item list: a −/+ stepper adjusts in 0.05
// increments across 0.5×–3.0×, with preset chips for the common speeds.
// Changes apply live (onSetRate on every tap) so the listener hears the
// new speed immediately; the sheet stays open for further fine-tuning.

const MIN_RATE = 0.5;
const MAX_RATE = 3.0;
const STEP = 0.05;
const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// Round to the nearest step and clamp — also kills float drift like 1.0500000001.
function normalize(rate: number): number {
  const stepped = Math.round(rate / STEP) * STEP;
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, stepped));
  return Math.round(clamped * 100) / 100;
}

// "1", "1.25", "1.5" — no trailing zeros.
function fmt(rate: number): string {
  return parseFloat(normalize(rate).toFixed(2)).toString();
}

interface Props {
  visible: boolean;
  rate: number;
  onSetRate: (rate: number) => void | Promise<void>;
  onClose: () => void;
}

function SpeedControlModal({ visible, rate, onSetRate, onClose }: Props) {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  const current = normalize(rate);
  const atMin = current <= MIN_RATE;
  const atMax = current >= MAX_RATE;

  const apply = (next: number) => {
    const n = normalize(next);
    if (n === current) return;
    lightHaptic();
    onSetRate(n);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.surface }]}
          onPress={(e) => e.stopPropagation()}
          accessibilityViewIsModal={true}
        >
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: colors.text }]}>Playback Speed</Text>
            <FocusableView onPress={onClose} hitSlop={10} style={[styles.closeBtn, { backgroundColor: colors.surfaceAlt }]} focusRadius={15}>
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </FocusableView>
          </View>

          {/* −  1.25×  + */}
          <View style={styles.stepperRow}>
            <FocusableView
              onPress={() => apply(current - STEP)}
              disabled={atMin}
              focusRadius={40}
              style={[styles.stepBtn, { backgroundColor: colors.surfaceAlt, opacity: atMin ? 0.35 : 1 }]}
            >
              <Ionicons name="remove" size={30} color={colors.text} />
            </FocusableView>

            <View style={styles.valueWrap}>
              <Text style={[styles.value, { color: colors.text }]}>
                {fmt(current)}<Text style={[styles.valueX, { color: colors.textSecondary }]}>×</Text>
              </Text>
            </View>

            <FocusableView
              onPress={() => apply(current + STEP)}
              disabled={atMax}
              focusRadius={40}
              style={[styles.stepBtn, { backgroundColor: colors.surfaceAlt, opacity: atMax ? 0.35 : 1 }]}
            >
              <Ionicons name="add" size={30} color={colors.text} />
            </FocusableView>
          </View>

          <Text style={[styles.hint, { color: colors.textTertiary }]}>
            Tap − / + for fine {fmt(STEP)}× steps
          </Text>

          {/* preset chips */}
          <View style={styles.presets}>
            {PRESETS.map((p) => {
              const selected = normalize(p) === current;
              return (
                <FocusableView
                  key={p}
                  onPress={() => apply(p)}
                  focusRadius={12}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: selected ? colors.accent : colors.surfaceAlt,
                      borderColor: selected ? colors.accent : colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: selected ? "#ffffff" : colors.text }]}>
                    {fmt(p)}×
                  </Text>
                </FocusableView>
              );
            })}
          </View>

          <FocusableView
            onPress={onClose}
            focusRadius={16}
            style={[styles.doneBtn, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.doneText}>Done</Text>
          </FocusableView>
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
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === "web" ? 34 : 40,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
  },
  stepBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  valueWrap: {
    flex: 1,
    alignItems: "center",
  },
  value: {
    fontSize: 52,
    fontWeight: "800" as const,
    letterSpacing: -1,
  },
  valueX: {
    fontSize: 34,
    fontWeight: "700" as const,
  },
  hint: {
    fontSize: 13,
    textAlign: "center",
    marginTop: 10,
  },
  presets: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 10,
    marginTop: 22,
  },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1,
    minWidth: 62,
    alignItems: "center",
  },
  chipText: {
    fontSize: 15,
    fontWeight: "700" as const,
  },
  doneBtn: {
    marginTop: 24,
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: "center",
  },
  doneText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700" as const,
  },
});

export default React.memo(SpeedControlModal);
