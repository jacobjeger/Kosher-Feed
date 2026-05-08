// YTC: navy / gold / cream palette. Hex values match the website
// (alumni.ytchaim.com) globals.css token block verbatim.
//
// SEMANTIC tokens (bg, surface, text, etc) flip between light + dark
// variants based on the user's preference (contexts/YtcThemeContext).
// LITERAL tokens (navy, gold, cream...) stay constant — they're the
// brand colors. Components reference the semantic tokens via the
// useYtcColors() hook; static StyleSheet.create can keep using the
// literal `ytcColors` constant for layout/border-radius style props
// that don't change with theme.

// Use a non-`as const` declaration here so the dark variant can hold
// different string values without TS rejecting them as literal-type
// mismatches. The shape is captured by `YtcColorPalette`.
export const ytcColors: {
  readonly navy: string; readonly navyLight: string; readonly navyLighter: string;
  readonly gold: string; readonly goldDark: string; readonly goldLight: string;
  readonly cream: string; readonly creamDark: string;
  readonly white: string; readonly black: string; readonly error: string;
  readonly bg: string; readonly surface: string; readonly surfaceAlt: string;
  readonly text: string; readonly textMuted: string; readonly textFaint: string; readonly border: string;
  readonly navyOpacity70: string; readonly navyOpacity50: string;
  readonly navyOpacity30: string; readonly navyOpacity10: string; readonly navyOpacity05: string;
  readonly goldOpacity30: string; readonly goldOpacity15: string; readonly creamOpacity70: string;
} = {
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
  // Semantic — light values
  bg: "#faf8f3",            // cream
  surface: "#FFFFFF",       // white card
  surfaceAlt: "#f0ebe0",    // cream-dark
  text: "#0a1628",          // navy
  textMuted: "rgba(10, 22, 40, 0.7)",
  textFaint: "rgba(10, 22, 40, 0.5)",
  border: "#d4c5b0",        // matches website's --border in light
  navyOpacity70: "rgba(10, 22, 40, 0.7)",
  navyOpacity50: "rgba(10, 22, 40, 0.5)",
  navyOpacity30: "rgba(10, 22, 40, 0.3)",
  navyOpacity10: "rgba(10, 22, 40, 0.1)",
  navyOpacity05: "rgba(10, 22, 40, 0.05)",
  goldOpacity30: "rgba(212, 175, 55, 0.3)",
  goldOpacity15: "rgba(212, 175, 55, 0.15)",
  creamOpacity70: "rgba(250, 248, 243, 0.7)",
};

// Dark palette — token names match `ytcColors` so a runtime swap is
// type-safe via the YtcColorPalette type. Hex values match the
// website's .dark block in globals.css:
//   background: navy, foreground: cream, card: #1a2847
//   primary: gold, secondary: #2a3f5f
export const ytcDarkColors: typeof ytcColors = {
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
  error: "#ef4444",
  // Semantic — dark values
  bg: "#0a1628",            // navy as bg
  surface: "#1a2847",       // dark card
  surfaceAlt: "#2a3f5f",    // dark muted
  text: "#faf8f3",          // cream as fg
  textMuted: "rgba(250, 248, 243, 0.78)",
  textFaint: "rgba(250, 248, 243, 0.55)",
  border: "#2a3f5f",
  navyOpacity70: "rgba(10, 22, 40, 0.7)",
  navyOpacity50: "rgba(10, 22, 40, 0.5)",
  navyOpacity30: "rgba(10, 22, 40, 0.3)",
  navyOpacity10: "rgba(10, 22, 40, 0.1)",
  navyOpacity05: "rgba(10, 22, 40, 0.05)",
  goldOpacity30: "rgba(212, 175, 55, 0.3)",
  goldOpacity15: "rgba(212, 175, 55, 0.15)",
  creamOpacity70: "rgba(250, 248, 243, 0.7)",
};

export type YtcColorPalette = typeof ytcColors;
