import { TextStyle } from "react-native";

const Typography: Record<string, TextStyle> = {
  screenTitle: {
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: 32,
  },
  sectionTitle: {
    fontSize: 19,
    fontWeight: "700",
    letterSpacing: -0.2,
    lineHeight: 24,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 18,
  },
  cardSubtitle: {
    fontSize: 12,
    fontWeight: "500",
    lineHeight: 16,
  },
  body: {
    fontSize: 14,
    fontWeight: "400",
    lineHeight: 20,
  },
  caption: {
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 14,
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  meta: {
    fontSize: 11,
    fontWeight: "400",
    lineHeight: 14,
  },
};

export default Typography;
