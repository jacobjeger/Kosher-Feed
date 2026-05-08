// YTC: navy / gold / cream palette. Hex values match the website
// (alumni.ytchaim.com) globals.css token block verbatim:
//   --navy: #0a1628;        --gold: #d4af37;
//   --navy-light: #1a2f4a;  --gold-dark: #b8962e;
//   --navy-lighter: #2a4262; --gold-light: #e8c96f;
//   --cream: #faf8f3;       --cream-dark: #f0ebe0;
// The rgba helpers are derived from the same hex values so opacity
// ramps stay consistent with the website's CSS rgba() usage.
export const ytcColors = {
  navy: "#0a1628",
  navyLight: "#1a2f4a",
  navyLighter: "#2a4262",
  gold: "#d4af37",
  goldDark: "#b8962e",
  goldLight: "#e8c96f",
  cream: "#faf8f3",
  creamDark: "#f0ebe0",
  white: "#FFFFFF",
  black: "#000000",
  error: "#DC2626",
  navyOpacity70: "rgba(10, 22, 40, 0.7)",
  navyOpacity50: "rgba(10, 22, 40, 0.5)",
  navyOpacity30: "rgba(10, 22, 40, 0.3)",
  navyOpacity10: "rgba(10, 22, 40, 0.1)",
  navyOpacity05: "rgba(10, 22, 40, 0.05)",
  goldOpacity30: "rgba(212, 175, 55, 0.3)",
  goldOpacity15: "rgba(212, 175, 55, 0.15)",
  creamOpacity70: "rgba(250, 248, 243, 0.7)",
} as const;
