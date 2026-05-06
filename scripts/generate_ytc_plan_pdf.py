"""
Generate the YTC Alumni -> ShiurPod integration plan as a self-contained PDF
briefing document. Designed so that a Claude instance with no prior context
can execute the integration end-to-end from the PDF alone.
"""
import os
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    PageBreak,
    Table,
    TableStyle,
    Preformatted,
    KeepTogether,
    ListFlowable,
    ListItem,
)
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


# --- Font registration (Unicode-capable so arrows/em-dashes render) ----------
BODY_FONT, BODY_BOLD, MONO_FONT = "Helvetica", "Helvetica-Bold", "Courier"
for ttf, btf, name, bname in [
    (r"C:\Windows\Fonts\segoeui.ttf",  r"C:\Windows\Fonts\segoeuib.ttf",  "SegoeUI",   "SegoeUI-Bold"),
    (r"C:\Windows\Fonts\arial.ttf",    r"C:\Windows\Fonts\arialbd.ttf",   "Arial",     "Arial-Bold"),
]:
    if os.path.exists(ttf) and os.path.exists(btf):
        try:
            pdfmetrics.registerFont(TTFont(name,  ttf))
            pdfmetrics.registerFont(TTFont(bname, btf))
            BODY_FONT, BODY_BOLD = name, bname
            break
        except Exception:
            continue
for ttf, name in [
    (r"C:\Windows\Fonts\consola.ttf", "Consolas"),
    (r"C:\Windows\Fonts\cour.ttf",    "CourierNew"),
]:
    if os.path.exists(ttf):
        try:
            pdfmetrics.registerFont(TTFont(name, ttf))
            MONO_FONT = name
            break
        except Exception:
            continue


OUT_PATH = r"C:\Users\Guest2\Documents\Kosher-Feed\.claude\worktrees\loving-matsumoto-ef9982\ytc-integration-plan.pdf"

NAVY  = colors.HexColor("#19263F")
GOLD  = colors.HexColor("#B8862F")
GREY  = colors.HexColor("#5A5A5A")
LIGHT = colors.HexColor("#F4F4F4")
ACCENT_BG = colors.HexColor("#FFF7E6")
ACCENT_BORDER = colors.HexColor("#E0B95F")


styles = getSampleStyleSheet()
title_style = ParagraphStyle("TitleX", parent=styles["Title"],
    fontName=BODY_BOLD, fontSize=22, leading=26, textColor=NAVY,
    spaceAfter=4, alignment=TA_LEFT)
subtitle_style = ParagraphStyle("SubtitleX", parent=styles["Normal"],
    fontName=BODY_FONT, fontSize=11, leading=14, textColor=GREY, spaceAfter=14)
h1 = ParagraphStyle("H1", parent=styles["Heading1"],
    fontName=BODY_BOLD, fontSize=15, leading=19, textColor=NAVY,
    spaceBefore=18, spaceAfter=8, keepWithNext=True)
h2 = ParagraphStyle("H2", parent=styles["Heading2"],
    fontName=BODY_BOLD, fontSize=12, leading=15, textColor=NAVY,
    spaceBefore=10, spaceAfter=4, keepWithNext=True)
h3 = ParagraphStyle("H3", parent=styles["Heading3"],
    fontName=BODY_BOLD, fontSize=10.5, leading=13, textColor=GOLD,
    spaceBefore=8, spaceAfter=3, keepWithNext=True)
body = ParagraphStyle("Body", parent=styles["BodyText"],
    fontName=BODY_FONT, fontSize=10, leading=14, textColor=colors.black,
    spaceAfter=5, alignment=TA_LEFT)
small = ParagraphStyle("Small", parent=body, fontSize=9, leading=12, textColor=GREY)
note  = ParagraphStyle("Note", parent=body, fontSize=9.5, leading=12.5,
    backColor=ACCENT_BG, borderColor=ACCENT_BORDER, borderWidth=0.5,
    borderPadding=6, leftIndent=4, rightIndent=4, spaceBefore=4, spaceAfter=8)
bullet_style = ParagraphStyle("Bullet", parent=body, leftIndent=14, bulletIndent=2, spaceAfter=2)
code_block = ParagraphStyle("CodeBlock", parent=body,
    fontName=MONO_FONT, fontSize=8.5, leading=11.5,
    backColor=LIGHT, borderColor=colors.lightgrey, borderWidth=0.5,
    borderPadding=6, leftIndent=2, rightIndent=2, spaceBefore=4, spaceAfter=8,
    textColor=colors.black)


def P(txt, style=body):
    return Paragraph(txt, style)


def bullets(items, style=bullet_style):
    return ListFlowable(
        [ListItem(Paragraph(t, style), leftIndent=12, bulletColor=NAVY) for t in items],
        bulletType="bullet", start="•", leftIndent=14,
        bulletFontName=BODY_FONT, bulletFontSize=10,
    )


def numbered(items, style=bullet_style):
    return ListFlowable(
        [ListItem(Paragraph(t, style), leftIndent=14) for t in items],
        bulletType="1", leftIndent=18,
        bulletFontName=BODY_FONT, bulletFontSize=10,
    )


def table(data, col_widths=None, header=True, font_size=9):
    t = Table(data, colWidths=col_widths, hAlign="LEFT")
    cmds = [
        ("FONTNAME",      (0, 0), (-1, -1), BODY_FONT),
        ("FONTSIZE",      (0, 0), (-1, -1), font_size),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 5),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 5),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("GRID",          (0, 0), (-1, -1), 0.25, colors.lightgrey),
    ]
    if header:
        cmds += [
            ("FONTNAME",   (0, 0), (-1, 0), BODY_BOLD),
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
        ]
    t.setStyle(TableStyle(cmds))
    return t


def code(text, font_size=8.5):
    """Preformatted code block."""
    style = ParagraphStyle(
        "CodeInline", parent=body, fontName=MONO_FONT,
        fontSize=font_size, leading=font_size + 3,
        backColor=LIGHT, borderColor=colors.lightgrey, borderWidth=0.5,
        borderPadding=5, leftIndent=2, rightIndent=2,
        spaceBefore=4, spaceAfter=8, textColor=colors.black,
    )
    return Preformatted(text, style)


def page_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(BODY_FONT, 8)
    canvas.setFillColor(GREY)
    canvas.drawString(0.7 * inch, 0.4 * inch,
        "YTC Alumni -> ShiurPod Integration Plan  |  Self-contained briefing")
    canvas.drawRightString(LETTER[0] - 0.7 * inch, 0.4 * inch,
        f"Page {doc.page}")
    canvas.restoreState()


# ============================================================================
# Document body
# ============================================================================
doc = SimpleDocTemplate(
    OUT_PATH, pagesize=LETTER,
    leftMargin=0.7 * inch, rightMargin=0.7 * inch,
    topMargin=0.7 * inch, bottomMargin=0.6 * inch,
    title="YTC Alumni -> ShiurPod Integration Plan (self-contained briefing)",
    author="ShiurPod planning",
)
story = []

# ============================================================================
# Cover
# ============================================================================
story.append(P("YTC Alumni → ShiurPod Integration Plan", title_style))
story.append(P("Self-contained briefing — sufficient to execute end-to-end with no prior conversation context.", subtitle_style))

story.append(P(
    "<b>How to use this document.</b> If you are a Claude instance opening this PDF cold, you have everything "
    "needed to execute the integration. Section 1 is a 60-second orientation. Section 2 lists every decision "
    "that has already been made — do not relitigate these unless the user explicitly asks. Section 3 is the "
    "ShiurPod codebase reference (file paths, line numbers, key APIs you will touch). Section 4 is the YTC "
    "source reference. Sections 6–13 are phase-by-phase build instructions with code snippets you can lift "
    "directly. Section 14 is the verification checklist. Appendices contain verbatim copy targets, Firebase "
    "config, and out-of-scope follow-ups.", note))

story.append(P("Table of contents", h2))
toc = [
    "1.  Brief for cold reader",
    "2.  Decisions already made (locked in)",
    "3.  ShiurPod codebase reference",
    "4.  YTC source reference",
    "5.  Architecture & file layout",
    "6.  Phase 0 — Pre-flight checks",
    "7.  Phase 1 — Dependencies & Metro config",
    "8.  Phase 2 — Unlock gate (RemoteConfig + dedicated route)",
    "9.  Phase 3 — Lazy Firebase service",
    "10. Phase 4 — YtcAuthContext + auth-gate layout",
    "11. Phase 5 — Route porting (refactor recipe)",
    "12. Phase 6 — Audio adapter (synthetic Episode/Feed)",
    "13. Phase 7 — Notifications (recommended: backend bridge)",
    "14. Phase 8 — Verification checklist",
    "15. Effort estimate",
    "Appendix A — Verbatim copy targets",
    "Appendix B — Firebase config & Firestore collections",
    "Appendix C — Firestore rules audit checklist",
    "Appendix D — Out of scope / follow-ups",
    "Appendix E — Server-side companion changes",
    "Appendix F — Notification path B (RNFirebase Messaging) reference",
]
story.append(bullets(toc, style=ParagraphStyle("TOC", parent=bullet_style, fontSize=9.5, leading=12)))


# ============================================================================
# 1. Brief for cold reader
# ============================================================================
story.append(PageBreak())
story.append(P("1. Brief for cold reader", h1))

story.append(P("What is being built", h2))
story.append(P(
    "<b>ShiurPod</b> is a Torah audio podcast app (Expo SDK 54, React Native, expo-router, TypeScript, "
    "Drizzle ORM + Postgres backend). It already ships to Android and iOS with a working "
    "downloads / queue / mini-player / push-notifications stack. The user maintains it solo. "
    "Source: their local repo at <font face='%s'>C:\\Users\\Guest2\\Documents\\Kosher-Feed</font>." % MONO_FONT, body))
story.append(P(
    "<b>YTC Alumni</b> is a separate Yeshiva Toras Chaim Alumni app (Expo SDK 52, also React Native + "
    "expo-router, with a Firebase JS SDK 11 backend on the Firebase project <font face='%s'>toras-chaim-shiurim</font>). "
    "Source: <font face='%s'>https://github.com/abbrach1/ytcalumni1</font> — the relevant variant is "
    "the <font face='%s'>expo-app/</font> subfolder. The repo also contains parallel iOS-Swift, "
    "Android-Kotlin, and an older RN copy; ignore those for porting purposes." % (MONO_FONT, MONO_FONT, MONO_FONT), body))
story.append(P(
    "<b>Goal.</b> Add a code-gated YTC section to ShiurPod (Android-only). User flow:", body))
story.append(numbered([
    "User enters an unlock code in ShiurPod Settings.",
    "A YTC entry appears (Settings link; tab visibility is decided in §2).",
    "Tapping it opens a Firebase email/password login screen (YTC's own Firebase project).",
    "On successful sign-in, an approval check (Firestore lookup) decides whether the user sees the YTC "
    "tabs (Home / Shiurim / Events / Contacts) or a 'pending approval' screen.",
    "All audio plays through ShiurPod's existing player. YTC notifications arrive via a backend bridge "
    "(see §13) and route into the YTC subtree on tap.",
]))

story.append(P("Constraints", h2))
story.append(bullets([
    "<b>Android-only.</b> No iOS work. This eliminates the APNs delegate conflict between expo-notifications and Firebase Messaging.",
    "<b>No new native modules</b> on the recommended path. The Firebase JS SDK is pure JS; no <font face='%s'>@react-native-firebase/*</font> required for v1." % MONO_FONT,
    "<b>Quarantine.</b> All YTC code lives under <font face='%s'>app/ytc/</font>, <font face='%s'>lib/ytc/</font>, "
    "<font face='%s'>contexts/YtcAuthContext.tsx</font>, <font face='%s'>constants/ytcColors.ts</font>. " % (MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT) +
    "Removable in a single PR.",
    "<b>Lazy Firebase init.</b> <font face='%s'>initializeApp()</font> must not run at app cold-start. " % MONO_FONT +
    "It runs only when a YTC route mounts (§9).",
    "<b>RemoteConfig from day one.</b> The unlock code lives in the existing <font face='%s'>RemoteConfigContext</font> " % MONO_FONT +
    "with a fallback constant. Rotation does not require a release.",
]))


# ============================================================================
# 2. Decisions already made
# ============================================================================
story.append(PageBreak())
story.append(P("2. Decisions already made (locked in)", h1))
story.append(P(
    "These were debated and resolved in the planning conversation. Do not relitigate unless the user "
    "explicitly raises them. Each row gives the decision, the rationale, and where it surfaces in this plan.", body))

decisions_table = [
    ["#", "Decision", "Rationale", "Surfaces in"],
    ["D1", "Code lives quarantined under app/ytc/, lib/ytc/, contexts/YtcAuthContext.tsx, constants/ytcColors.ts.",
     "Removable in one PR; lazy-init friendly; clear ownership.", "§5, §11"],
    ["D2", "Unlock gate uses RemoteConfig (key: ytcUnlockCode) with a fallback constant.",
     "Allows server-side rotation without a release. ShiurPod already wires RemoteConfig.", "§8"],
    ["D3", "Unlock UI is a dedicated route (app/ytc-unlock.tsx), not an inline modal in settings.",
     "ShiurPod settings has no TextInput/modal pattern. Dedicated route matches existing flows (feedback, messages).", "§8"],
    ["D4", "Firebase init is lazy. lib/ytc/firebase.ts exports getYtcFirebase() that initializes on first call only.",
     "Avoids paying init cost (and network for Firestore long-polling) for users who never unlock.", "§9"],
    ["D5", "Audio plays through ShiurPod's existing AudioPlayerContext via a synthetic Episode/Feed adapter.",
     "Avoids dual audio sessions (expo-av + expo-audio fight on Android).", "§12"],
    ["D6", "YTC episodes use id prefix 'ytc:' so they are filterable in stats / positions / downloads later.",
     "Future-proofs against polluting ShiurPod stats with YTC plays.", "§12"],
    ["D7", "Playback positions are dual-written: ShiurPod's POST /api/playback-positions (for in-app resume) AND ytc Firestore users/{uid}/preferences/positions/{shiurId} (for cross-device parity with native YTC apps).",
     "ShiurPod path gives the in-app mini-player a resume target; Firestore path matches native YTC apps' canonical store.",
     "§12"],
    ["D8", "Notifications use a backend bridge (path A): a worker subscribes to YTC FCM topics and re-emits to ShiurPod's existing Expo Push pipeline. Native FCM (path B) is documented in Appendix F as an alternative.",
     "Coin-flip-close to B, but A keeps shiurpod's notification stack untouched and avoids manifest-merge conflicts between expo-notifications and @react-native-firebase/messaging.",
     "§13, App. F"],
    ["D9", "Notification payload contract reuses the existing data.screen field (values 'ytc-home', 'ytc-shiurim', 'ytc-events', 'ytc-contacts'). Optional data.ytcShiurId for deep links to a specific shiur.",
     "Matches the existing tap-routing branch shape in app/_layout.tsx.", "§13"],
    ["D10", "A 'ytc' Android notification channel is added so users can independently mute YTC pushes.",
     "Standard Android UX. Channel id: 'ytc'.", "§13"],
    ["D11", "Sign-out semantics: locking from settings clears the unlock flag AND signs out of Firebase. Signing out from inside YTC clears Firebase only — the unlock flag persists.",
     "Avoids session inheritance when the device is handed over. Signing out of ShiurPod's main account does NOT affect YTC.", "§8, §10"],
    ["D12", "Audio refactor uses ShiurPod's player; do NOT add expo-av.",
     "Two audio sessions on Android race for focus.", "§12"],
    ["D13", "YTC plays do NOT count toward ShiurPod listening stats. Stats screen filters by 'ytc:' id prefix.",
     "User-confirmed: keep stats domain-specific.", "App. D, §12"],
    ["D14", "Downloads/offline for YTC shiurim is OUT OF SCOPE for v1. Add to Appendix D as a follow-up.",
     "Significant new work; not blocking.", "App. D"],
    ["D15", "Firestore rules MUST be audited before ship (see Appendix C).",
     "ShiurPod is now bound to the security posture of a Firebase project the team may not own.", "App. C"],
    ["D16", "iOS port is OUT OF SCOPE.",
     "User specified Android-only. Re-enables APNs work later if iOS is added.", "—"],
]
story.append(table(decisions_table, col_widths=[0.35*inch, 1.85*inch, 3.0*inch, 1.6*inch]))


# ============================================================================
# 3. ShiurPod codebase reference
# ============================================================================
story.append(PageBreak())
story.append(P("3. ShiurPod codebase reference", h1))
story.append(P(
    "Verified against the working tree on 2026-05-07. Line numbers may drift; treat them as anchors, not exact "
    "addresses. Search by symbol where the reference matters.", small))

story.append(P("3.1 Routes (app/)", h2))
story.append(bullets([
    "<b>Tab routes</b> (app/(tabs)/): index (home), following, favorites, downloads, settings. <i>5 tabs</i>; "
    "downloads + settings hidden on web via <font face='%s'>href: isWeb ? null : undefined</font>." % MONO_FONT,
    "<b>Stack siblings</b> (app/): onboarding, player (modal), queue (modal), all-shiurim, all-maggidei-shiur, "
    "category/[id], stats, storage, debug-logs, legal, messages, feedback, podcast/[id], maggid-shiur/[author], "
    "+native-intent, +not-found.",
    "All registered in <font face='%s'>app/_layout.tsx</font> via <font face='%s'>&lt;Stack.Screen name=...&gt;</font>." % (MONO_FONT, MONO_FONT),
]))

story.append(P("3.2 Episode and Feed types", h2))
story.append(P("<b>Path:</b> <font face='%s'>lib/types.ts</font>" % MONO_FONT, body))
story.append(code('''export interface Feed {
  id: string;
  title: string;
  rssUrl: string;
  imageUrl: string | null;
  description: string | null;
  author: string | null;
  categoryId: string | null;
  categoryIds?: string[];
  isActive: boolean;
  isFeatured: boolean;
  scheduledPublishAt: string | null;
  lastFetchedAt: string | null;
  createdAt: string;
  sourceNetwork: string | null;
  tatSpeakerId?: number | null;
}

export interface Episode {
  id: string;
  feedId: string;
  title: string;
  description: string | null;
  audioUrl: string;
  duration: string | null;          // ISO 8601 duration or "HH:MM:SS"
  publishedAt: string | null;       // ISO date string
  guid: string;
  imageUrl: string | null;
  adminNotes: string | null;
  sourceSheetUrl: string | null;
  createdAt: string;
  tatLectureId?: number | null;
  noDownload?: boolean;
}'''))

story.append(P("3.3 AudioPlayerContext", h2))
story.append(P(
    "<b>Path:</b> <font face='%s'>contexts/AudioPlayerContext.tsx</font> (~1380 lines).<br/>"
    "<b>Hook:</b> <font face='%s'>useAudioPlayer()</font>.<br/>"
    "<b>Critical signature:</b> <font face='%s'>playEpisode(episode: Episode, feed: Feed): Promise&lt;void&gt;</font> "
    "— requires real <font face='%s'>Episode</font> and <font face='%s'>Feed</font> objects (not just a URL). "
    "This is what drives the synthetic-wrapper requirement in §12." % (MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT), body))
story.append(P("Full context value shape (relevant subset):", body))
story.append(code('''interface AudioPlayerContextValue {
  currentEpisode: Episode | null;
  currentFeed: Feed | null;
  playback: {
    isPlaying: boolean;
    isLoading: boolean;
    positionMs: number;
    durationMs: number;
    playbackRate: number;
    playbackError?: string | null;
  };
  playEpisode: (episode: Episode, feed: Feed) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seekTo: (positionMs: number) => Promise<void>;
  skip: (seconds: number) => Promise<void>;
  setRate: (rate: number) => Promise<void>;
  stop: () => Promise<void>;
  getSavedPosition: (episodeId: string) => Promise<number>;
  // ...queue, sleepTimer, recently-played, etc.
}'''))
story.append(P(
    "Position persistence: <font face='%s'>savePosition(episodeId, feedId, positionMs, durationMs)</font> writes to "
    "AsyncStorage AND POSTs to <font face='%s'>/api/playback-positions</font>. The server endpoint at "
    "<font face='%s'>server/routes.ts:764</font> does <i>not</i> validate that episodeId/feedId reference real rows — "
    "synthesized YTC ids (<font face='%s'>ytc:&lt;shiurId&gt;</font>) go through cleanly." % (MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT), body))

story.append(P("3.4 Settings screen pattern", h2))
story.append(P("<b>Path:</b> <font face='%s'>app/(tabs)/settings.tsx</font> (~853 lines)" % MONO_FONT, body))
story.append(P(
    "Each section is a <font face='%s'>&lt;View style={[styles.section, ...]}&gt;</font> wrapper containing an "
    "ALL-CAPS section header (<font face='%s'>styles.sectionHeader</font>) and a "
    "<font face='%s'>&lt;View style={styles.sectionContent}&gt;</font> wrapper around <font face='%s'>&lt;SettingRow&gt;</font> "
    "rows. Rows use <font face='%s'>&lt;View style={styles.divider} /&gt;</font> as separators. Pickers go through "
    "<font face='%s'>&lt;OptionPickerModal&gt;</font>. <b>There is no inline TextInput / Alert.prompt / "
    "&lt;Modal&gt; pattern in this file</b> — drives D3." % (MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT), body))
story.append(P("SettingRow signature (top of the same file, ~line 30):", body))
story.append(code('''interface SettingRowProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  subtitle?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
  autoFocus?: boolean;
}'''))

story.append(P("3.5 Push notifications", h2))
story.append(P("<b>Path:</b> <font face='%s'>lib/push-notifications.ts</font>" % MONO_FONT, body))
story.append(P("Existing channels (<font face='%s'>setupPushNotificationChannels</font>, line ~104):" % MONO_FONT, body))
story.append(bullets([
    "<b>default</b> — MAX importance, vibrate, light #1a73e8, sound default, badge",
    "<b>new-episodes</b> — same shape, used for new-episode pushes",
]))
story.append(P("Tap-data shape (<font face='%s'>getNotificationData</font>, line ~335):" % MONO_FONT, body))
story.append(code('''export function getNotificationData(response: Notifications.NotificationResponse): {
  episodeId?: string;
  feedId?: string;
  type?: string;
  screen?: string;        // <-- existing field, reused for YTC routing (D9)
  conversationId?: string;
} { /* ... */ }'''))
story.append(P("Tap routing (<font face='%s'>handleNotificationResponse</font> in app/_layout.tsx, line ~89):" % MONO_FONT, body))
story.append(code('''if (data.screen === "messages") {
  router.push("/messages" as any);
} else if (data.feedId) {
  router.push(`/podcast/${data.feedId}` as any);
}
// YTC branch goes here (see §13).'''))

story.append(P("3.6 RemoteConfigContext", h2))
story.append(P("<b>Path:</b> <font face='%s'>contexts/RemoteConfigContext.tsx</font>" % MONO_FONT, body))
story.append(P(
    "Fetches from <font face='%s'>{api}/api/config</font> on mount; merges with <font face='%s'>DEFAULT_CONFIG</font>; "
    "caches in AsyncStorage under <font face='%s'>@shiurpod_remote_config</font>. The <font face='%s'>RemoteConfig</font> "
    "interface uses <font face='%s'>[key: string]: any</font> so adding new keys requires NO type extension. "
    "Hook: <font face='%s'>useRemoteConfig().config.ytcUnlockCode</font>." % (MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT), body))
story.append(P("To add the unlock code key, ALSO update DEFAULT_CONFIG with a fallback string:", body))
story.append(code('''const DEFAULT_CONFIG: RemoteConfig = {
  // ...existing keys...
  ytcUnlockCode: "1234",  // fallback; real value served from /api/config
};'''))

story.append(P("3.7 Other relevant surfaces", h2))
story.append(bullets([
    "<font face='%s'>contexts/AudioPlayerContext.tsx</font>'s <font face='%s'>recentlyPlayed</font> state is in-memory; " % (MONO_FONT, MONO_FONT) +
    "no DB write needed for YTC recently-played to participate.",
    "<font face='%s'>components/MiniPlayerHost.tsx</font> renders the global mini-player; YTC reuses it without changes." % MONO_FONT,
    "<font face='%s'>lib/error-logger.ts</font> exports <font face='%s'>addLog(level, msg, stack?, channel?)</font>; " % (MONO_FONT, MONO_FONT) +
    "use channel <font face='%s'>'ytc'</font> for all YTC-related logs." % MONO_FONT,
    "<font face='%s'>lib/query-client.ts</font> exports <font face='%s'>apiRequest</font>, <font face='%s'>queryClient</font>, " % (MONO_FONT, MONO_FONT, MONO_FONT) +
    "<font face='%s'>getApiUrl</font>." % MONO_FONT,
    "Path alias <font face='%s'>@/</font> resolves to repo root (per tsconfig.json)." % MONO_FONT,
]))


# ============================================================================
# 4. YTC source reference
# ============================================================================
story.append(PageBreak())
story.append(P("4. YTC source reference", h1))

story.append(P("4.1 Where to fetch", h2))
story.append(P(
    "Repo: <font face='%s'>https://github.com/abbrach1/ytcalumni1</font>. The variant we port is "
    "<font face='%s'>expo-app/</font>. Other folders (<font face='%s'>android-app/</font>, "
    "<font face='%s'>ytcalumni1/</font> [iOS Swift], <font face='%s'>react-native/</font>) are reference only — "
    "do not port from them." % (MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT), body))
story.append(P("Clone command:", body))
story.append(code("git clone --depth 1 https://github.com/abbrach1/ytcalumni1 /tmp/ytc-source", font_size=9))

story.append(P("4.2 expo-app file inventory", h2))
ytc_inv = [
    ["Path",                                    "Lines", "Role / port action"],
    ["expo-app/services/firebase.ts",           "~180",  "Copy verbatim into lib/ytc/firebase.ts; wrap in lazy init (§9)."],
    ["expo-app/contexts/AuthContext.tsx",       "~70",   "Copy verbatim into contexts/YtcAuthContext.tsx; mount in app/ytc/_layout.tsx only (§10)."],
    ["expo-app/contexts/AudioContext.tsx",      "~200",  "DROP. Replaced by ShiurPod's AudioPlayerContext via adapter (§12)."],
    ["expo-app/components/MiniPlayer.tsx",      "~80",   "DROP. ShiurPod's MiniPlayerHost handles this."],
    ["expo-app/constants/Colors.ts",            "~30",   "Copy into constants/ytcColors.ts (rename to avoid collision with ShiurPod's Colors)."],
    ["expo-app/app/_layout.tsx",                "~40",   "Logic merged into app/ytc/_layout.tsx (§10). Do not copy as-is."],
    ["expo-app/app/(auth)/_layout.tsx",         "5",     "Copy into app/ytc/(auth)/_layout.tsx."],
    ["expo-app/app/(auth)/login.tsx",           "259",   "Copy into app/ytc/(auth)/login.tsx; apply refactor recipe (§11)."],
    ["expo-app/app/(auth)/pending.tsx",         "117",   "Copy into app/ytc/(auth)/pending.tsx; apply refactor recipe."],
    ["expo-app/app/(tabs)/_layout.tsx",         "82",    "Copy into app/ytc/(tabs)/_layout.tsx; remove the in-file MiniPlayer wrapper."],
    ["expo-app/app/(tabs)/index.tsx",           "365",   "Copy; apply refactor recipe + audio adapter."],
    ["expo-app/app/(tabs)/shiurim.tsx",         "514",   "Copy; apply refactor recipe + audio adapter."],
    ["expo-app/app/(tabs)/events.tsx",          "208",   "Copy; apply refactor recipe."],
    ["expo-app/app/(tabs)/contacts.tsx",        "362",   "Copy; apply refactor recipe."],
    ["expo-app/types/*",                        "—",     "Copy types into types/ytc.ts (Shiur, Event, Rebbe, Announcement, etc.)."],
    ["expo-app/components/*",                   "—",     "Inspect and port any non-MiniPlayer components alongside the screens that use them."],
]
story.append(table(ytc_inv, col_widths=[2.7*inch, 0.55*inch, 3.55*inch]))

story.append(P("4.3 Firestore collections used (by expo-app)", h2))
fc = [
    ["Collection",                "Purpose"],
    ["shiurim",                   "Audio shiurim catalog: title, rebbe, date, audioUrl, pdfUrl, tags, playCount, downloadCount, series, description"],
    ["events",                    "Events / simchos calendar: eventName, personFamily, type, date, location, time, imageUrl, description"],
    ["announcements",             "Banner announcements (filter where enabled==true): title, content, type, date, enabled"],
    ["carouselImages",            "Home carousel: url, caption, order"],
    ["rebbeim",                   "Rebbe directory: name, title, email, phone, photoUrl"],
    ["alumniContactSubmissions",  "Alumni-submitted contacts; status='approved' shown in directory"],
    ["alumniDatabase",            "Alumni records keyed by lowercase email — primary approval source"],
    ["approvedEmails",            "Fallback approval list (by doc id OR by 'email' field)"],
    ["admins",                    "Admin email list, keyed by lowercase email"],
    ["accessRequests",            "Pending requests from non-approved sign-ups (write-only from app)"],
    ["users/{uid}/preferences/",  "Per-user data (positions, saved shiurim) — used by native YTC apps; mirror writes here (D7)"],
    ["settings/featuredShiur",    "Configurable featured shiur; not used by expo-app port directly"],
]
story.append(table(fc, col_widths=[1.85*inch, 4.95*inch]))

story.append(P("4.4 Approval logic (verbatim, from ytc/services/firebase.ts)", h2))
story.append(code('''export async function checkUserApproval(email: string): Promise<{ approved: boolean; admin: boolean }> {
  const normalizedEmail = email.toLowerCase();
  let approved = false;
  let admin = false;
  try {
    // 1. Check alumniDatabase by lowercase email as doc id
    const alumniDoc = await getDoc(doc(db, "alumniDatabase", normalizedEmail));
    if (alumniDoc.exists()) approved = true;
    // 2. Fallback: approvedEmails by doc id
    if (!approved) {
      const approvedDoc = await getDoc(doc(db, "approvedEmails", normalizedEmail));
      if (approvedDoc.exists()) approved = true;
    }
    // 3. Fallback: approvedEmails by 'email' field
    if (!approved) {
      const q = query(collection(db, "approvedEmails"), where("email", "==", normalizedEmail));
      const snap = await getDocs(q);
      if (!snap.empty) approved = true;
    }
    // 4. Admin check
    const adminDoc = await getDoc(doc(db, "admins", normalizedEmail));
    if (adminDoc.exists()) admin = true;
  } catch (e) {
    console.warn("Approval check error:", e);
  }
  return { approved, admin };
}'''))


# ============================================================================
# 5. Architecture & file layout
# ============================================================================
story.append(PageBreak())
story.append(P("5. Architecture & file layout", h1))

tree = (
"<b>NEW files:</b><br/>"
"&nbsp;&nbsp;app/<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;ytc-unlock.tsx                            <i>unlock code entry screen (D3)</i><br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;ytc/<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;_layout.tsx                       <i>auth-gate layout, mounts YtcAuthProvider</i><br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(auth)/<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;_layout.tsx<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;login.tsx<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;pending.tsx<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(tabs)/<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;_layout.tsx<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;index.tsx<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;shiurim.tsx<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;events.tsx<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;contacts.tsx<br/>"
"&nbsp;&nbsp;contexts/<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;YtcAuthContext.tsx                       <i>Firebase auth + approval state</i><br/>"
"&nbsp;&nbsp;lib/<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;ytc/<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;firebase.ts                       <i>lazy init + Firestore queries</i><br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;unlock.ts                         <i>AsyncStorage flag + RemoteConfig check</i><br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;audio-adapter.ts                  <i>synthetic Episode/Feed wrappers (§12)</i><br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;positions.ts                      <i>dual-write to ShiurPod + Firestore (§12)</i><br/>"
"&nbsp;&nbsp;constants/<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;ytcColors.ts                             <i>navy/gold/cream palette</i><br/>"
"&nbsp;&nbsp;types/<br/>"
"&nbsp;&nbsp;&nbsp;&nbsp;ytc.ts                                   <i>Shiur, Event, Rebbe, Announcement</i><br/>"
"<br/>"
"<b>MODIFIED files:</b><br/>"
"&nbsp;&nbsp;package.json                              <i>add 'firebase' dep</i><br/>"
"&nbsp;&nbsp;metro.config.js                           <i>only if firebase resolution complains</i><br/>"
"&nbsp;&nbsp;contexts/RemoteConfigContext.tsx          <i>add ytcUnlockCode to DEFAULT_CONFIG</i><br/>"
"&nbsp;&nbsp;app/_layout.tsx                           <i>extend handleNotificationResponse + add /ytc + /ytc-unlock to Stack</i><br/>"
"&nbsp;&nbsp;app/(tabs)/settings.tsx                   <i>add YTC Alumni section</i><br/>"
"&nbsp;&nbsp;lib/push-notifications.ts                 <i>add 'ytc' Android channel</i><br/>"
"&nbsp;&nbsp;contexts/AudioPlayerContext.tsx           <i>(optional) skip /api/playback-positions for ytc:* ids; alternate path is in lib/ytc/positions.ts</i><br/>"
)
story.append(P(tree, code_block))


# ============================================================================
# 6. Phase 0 — Pre-flight
# ============================================================================
story.append(PageBreak())
story.append(P("6. Phase 0 — Pre-flight checks", h1))
story.append(P("Run these before writing any code. They take 5 minutes and prevent surprises.", body))
story.append(numbered([
    "Confirm working tree is clean: <font face='%s'>git status</font>." % MONO_FONT,
    "Confirm shiurpod's package.json does NOT already contain <font face='%s'>firebase</font> or " % MONO_FONT +
    "<font face='%s'>@react-native-firebase/*</font> (greenfield install expected)." % MONO_FONT,
    "Confirm <font face='%s'>contexts/RemoteConfigContext.tsx</font> exists and exports <font face='%s'>useRemoteConfig</font>." % (MONO_FONT, MONO_FONT),
    "Confirm <font face='%s'>contexts/AudioPlayerContext.tsx</font> exports <font face='%s'>useAudioPlayer</font> with <font face='%s'>playEpisode(episode, feed)</font>." % (MONO_FONT, MONO_FONT, MONO_FONT),
    "Confirm <font face='%s'>lib/push-notifications.ts</font> exports <font face='%s'>setupPushNotificationChannels</font> and <font face='%s'>getNotificationData</font>." % (MONO_FONT, MONO_FONT, MONO_FONT),
    "Confirm <font face='%s'>app/_layout.tsx</font> contains <font face='%s'>handleNotificationResponse</font>." % (MONO_FONT, MONO_FONT),
    "Verify the YTC repo is reachable (<font face='%s'>git ls-remote https://github.com/abbrach1/ytcalumni1</font>)." % MONO_FONT,
    "Open Appendix C and decide: who owns the firestore.rules audit? Block ship until done.",
]))


# ============================================================================
# 7. Phase 1 — Dependencies & Metro
# ============================================================================
story.append(P("7. Phase 1 — Dependencies & Metro config", h1))
story.append(P("Time: ~30 min. Adds the Firebase JS SDK; tweaks Metro only if needed.", body))

story.append(P("7.1 Add Firebase to package.json", h2))
story.append(code("npm install firebase@^11.1.0 --save", font_size=9))
story.append(P("7.2 Verify Metro can resolve Firebase", h2))
story.append(P("Run <font face='%s'>npx expo start --clear</font>. If you see errors about <font face='%s'>.cjs</font> "
    "files or 'package.json exports', append to <font face='%s'>metro.config.js</font>:" % (MONO_FONT, MONO_FONT, MONO_FONT), body))
story.append(code('''// metro.config.js (append before module.exports)
config.resolver.sourceExts.push("cjs");
config.resolver.unstable_enablePackageExports = false;'''))
story.append(P("7.3 No app.json plugin changes required.", h2))
story.append(P("The existing <font face='%s'>expo-notifications</font> plugin handles push for both apps. "
    "Do NOT add <font face='%s'>googleServicesFile</font>; the Firebase JS SDK does not use it." % (MONO_FONT, MONO_FONT), body))


# ============================================================================
# 8. Phase 2 — Unlock gate
# ============================================================================
story.append(PageBreak())
story.append(P("8. Phase 2 — Unlock gate", h1))
story.append(P("Time: ~1 hr. Adds the unlock flag, a route to enter the code, and a settings entry.", body))

story.append(P("8.1 Add ytcUnlockCode to RemoteConfig", h2))
story.append(P("Edit <font face='%s'>contexts/RemoteConfigContext.tsx</font> — add a key to "
    "<font face='%s'>DEFAULT_CONFIG</font> (search for the literal block):" % (MONO_FONT, MONO_FONT), body))
story.append(code('''const DEFAULT_CONFIG: RemoteConfig = {
  // ...existing keys...
  recommendationsLimit: 10,
  ytcUnlockCode: "1234",  // FALLBACK ONLY; real value comes from /api/config
};'''))
story.append(P("Companion server change: see Appendix E.", body))

story.append(P("8.2 lib/ytc/unlock.ts", h2))
story.append(code('''import AsyncStorage from "@react-native-async-storage/async-storage";

const UNLOCK_KEY = "@shiurpod_ytc_unlocked";

// In-memory listeners so the settings UI / tab bar can react without reload.
const listeners = new Set<() => void>();
function emit() { listeners.forEach(fn => fn()); }
export function onUnlockChanged(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export async function isUnlocked(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(UNLOCK_KEY)) === "1";
  } catch {
    return false;
  }
}

/**
 * Validate the entered code against RemoteConfig.ytcUnlockCode and persist.
 * Caller passes in the current code from useRemoteConfig().
 */
export async function tryUnlock(entered: string, expected: string): Promise<boolean> {
  if (!expected || entered.trim() !== expected.trim()) return false;
  await AsyncStorage.setItem(UNLOCK_KEY, "1");
  emit();
  return true;
}

/** Lock + sign out of Firebase (D11). */
export async function lock(): Promise<void> {
  await AsyncStorage.removeItem(UNLOCK_KEY);
  // Lazy import so we never pull Firebase into the root bundle.
  try {
    const { firebaseSignOutIfInitialized } = await import("@/lib/ytc/firebase");
    await firebaseSignOutIfInitialized();
  } catch {}
  emit();
}'''))

story.append(P("8.3 Hook for components", h2))
story.append(code('''// lib/ytc/unlock.ts (continued)
import { useEffect, useState } from "react";

export function useYtcUnlocked(): boolean {
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    let mounted = true;
    isUnlocked().then(v => mounted && setUnlocked(v));
    const off = onUnlockChanged(() => isUnlocked().then(v => mounted && setUnlocked(v)));
    return () => { mounted = false; off(); };
  }, []);
  return unlocked;
}'''))

story.append(P("8.4 app/ytc-unlock.tsx (new screen)", h2))
story.append(P("Mirrors the visual style of feedback.tsx / messages.tsx (full-screen modal-style form).", body))
story.append(code('''import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, KeyboardAvoidingView, Platform } from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";
import { useRemoteConfig } from "@/contexts/RemoteConfigContext";
import { tryUnlock } from "@/lib/ytc/unlock";
import { mediumHaptic } from "@/lib/haptics";

export default function YtcUnlockScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useAppColorScheme() === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { config } = useRemoteConfig();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    const expected = (config as any).ytcUnlockCode || "";
    const ok = await tryUnlock(code, expected);
    setSubmitting(false);
    if (ok) {
      mediumHaptic();
      router.replace("/ytc");
    } else {
      Alert.alert("Incorrect code", "The access code you entered is not valid.");
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 20, flex: 1 }}>
        <Pressable onPress={() => router.back()} style={{ alignSelf: "flex-start", padding: 8 }}>
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "700", color: colors.text, marginTop: 12 }}>YTC Alumni Access</Text>
        <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 6 }}>
          Enter your access code to enable the YTC Alumni section.
        </Text>
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="Access code"
          placeholderTextColor={colors.textSecondary}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={onSubmit}
          style={{
            marginTop: 24, fontSize: 18, color: colors.text,
            borderWidth: 1, borderColor: colors.border, borderRadius: 10,
            paddingHorizontal: 14, paddingVertical: 12, backgroundColor: colors.surface,
          }}
        />
        <Pressable
          onPress={onSubmit}
          disabled={submitting || !code}
          style={{ marginTop: 16, backgroundColor: colors.accent, padding: 14, borderRadius: 10, opacity: submitting || !code ? 0.5 : 1 }}>
          <Text style={{ color: "#fff", fontWeight: "600", textAlign: "center", fontSize: 16 }}>Unlock</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}'''))

story.append(P("8.5 Settings section (modify app/(tabs)/settings.tsx)", h2))
story.append(P("Add a section near the bottom (above the existing 'About' / 'Legal' section). Insert "
    "after the existing sections close. Use the existing SettingRow + section patterns:", body))
story.append(code('''import { useYtcUnlocked, lock as lockYtc } from "@/lib/ytc/unlock";
// inside SettingsScreenInner:
const ytcUnlocked = useYtcUnlocked();

// JSX (place where appropriate):
<View style={[styles.section, { borderColor: colors.cardBorder }]}>
  <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>YTC ALUMNI</Text>
  <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
    {ytcUnlocked ? (
      <>
        <SettingRow
          icon={<Ionicons name="school" size={20} color={colors.accent} />}
          label="YTC Alumni"
          subtitle="Enabled"
          onPress={() => { lightHaptic(); router.push("/ytc"); }}
        />
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <SettingRow
          icon={<Ionicons name="lock-closed" size={20} color={colors.accent} />}
          label="Disable YTC access"
          onPress={() => {
            Alert.alert("Disable YTC", "This will sign you out of YTC and hide the section.", [
              { text: "Cancel", style: "cancel" },
              { text: "Disable", style: "destructive", onPress: () => { lockYtc(); } },
            ]);
          }}
        />
      </>
    ) : (
      <SettingRow
        icon={<Ionicons name="key" size={20} color={colors.accent} />}
        label="Enter access code"
        onPress={() => { lightHaptic(); router.push("/ytc-unlock"); }}
      />
    )}
  </View>
</View>'''))

story.append(P("8.6 Stack registration (modify app/_layout.tsx)", h2))
story.append(P("Add two routes inside <font face='%s'>RootLayoutNav</font>'s &lt;Stack&gt;:" % MONO_FONT, body))
story.append(code('''<Stack.Screen name="ytc-unlock" options={{ headerShown: false, presentation: "modal", animation: "slide_from_bottom" }} />
<Stack.Screen name="ytc" options={{ headerShown: false }} />'''))


# ============================================================================
# 9. Phase 3 — Lazy Firebase service
# ============================================================================
story.append(PageBreak())
story.append(P("9. Phase 3 — Lazy Firebase service", h1))
story.append(P("Time: ~1 hr. Critical: <b>initializeApp must NOT run at app cold-start.</b>", body))

story.append(P("9.1 lib/ytc/firebase.ts (lazy-init pattern)", h2))
story.append(code('''/**
 * YTC Firebase service. ALL access goes through getYtcFirebase(); never import
 * 'firebase/app' directly elsewhere. The lazy init is what keeps Firebase out
 * of the root bundle for users who never unlock the section.
 */
import type { FirebaseApp } from "firebase/app";
import type { Auth, User } from "firebase/auth";
import type { Firestore, DocumentSnapshot } from "firebase/firestore";

// Public client config (safe to commit; identical to the value in
// ytcalumni1/expo-app/services/firebase.ts).
const firebaseConfig = {
  apiKey: "AIzaSyB-j6Itt_DKVLOm5BGsuygVUD6YoPKQyS8",
  authDomain: "toras-chaim-shiurim.firebaseapp.com",
  projectId: "toras-chaim-shiurim",
  storageBucket: "toras-chaim-shiurim.firebasestorage.app",
  messagingSenderId: "95643621522",
  appId: "1:95643621522:ios:a75e5f1bdfaba692986e4b",
};

let _initialized: { app: FirebaseApp; auth: Auth; db: Firestore } | null = null;
let _initPromise: Promise<typeof _initialized> | null = null;

export async function getYtcFirebase() {
  if (_initialized) return _initialized;
  if (!_initPromise) {
    _initPromise = (async () => {
      const { initializeApp, getApps } = await import("firebase/app");
      const { getAuth } = await import("firebase/auth");
      const { getFirestore } = await import("firebase/firestore");
      const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
      _initialized = { app, auth: getAuth(app), db: getFirestore(app) };
      return _initialized;
    })();
  }
  return _initPromise;
}

/** Sign out only if Firebase has been initialized. Safe to call from lock(). */
export async function firebaseSignOutIfInitialized() {
  if (!_initialized) return;
  const { signOut } = await import("firebase/auth");
  try { await signOut(_initialized.auth); } catch {}
}

// Optional: re-export onAuthStateChanged through the lazy path.
export async function subscribeAuth(cb: (user: User | null) => void): Promise<() => void> {
  const { auth } = await getYtcFirebase();
  const { onAuthStateChanged } = await import("firebase/auth");
  return onAuthStateChanged(auth, cb);
}'''))

story.append(P("9.2 Firestore query helpers", h2))
story.append(P(
    "Port the rest of <font face='%s'>ytcalumni1/expo-app/services/firebase.ts</font> functions verbatim, but " % MONO_FONT +
    "replace the static <font face='%s'>db</font> reference with a call to <font face='%s'>getYtcFirebase()</font>. " % (MONO_FONT, MONO_FONT) +
    "Pattern:", body))
story.append(code('''// Original:  const snap = await getDocs(query(collection(db, "shiurim"), orderBy("date", "desc")));
// Lazy:
export async function fetchShiurim() {
  const { db } = await getYtcFirebase();
  const { collection, query, orderBy, getDocs } = await import("firebase/firestore");
  const snap = await getDocs(query(collection(db, "shiurim"), orderBy("date", "desc")));
  return snap.docs.map(docToShiur).filter(Boolean);
}'''))
story.append(P("Apply this pattern to: <font face='%s'>fetchShiurim, fetchMostRecentShiur, incrementPlayCount, "
    "fetchEvents, fetchUpcomingEvents, fetchAnnouncements, fetchCarouselImages, fetchRebbeim, "
    "fetchApprovedAlumni, checkUserApproval, submitAccessRequest</font>." % MONO_FONT, body))

story.append(P("9.3 Bundle audit", h2))
story.append(P("After implementation, verify lazy init by:", body))
story.append(numbered([
    "Cold-starting the app without YTC unlocked.",
    "Searching the Metro bundle for <font face='%s'>'firebase/app'</font> or " % MONO_FONT +
    "<font face='%s'>'AIzaSyB-j6Itt_DKVLOm5BGsuygVUD6YoPKQyS8'</font>: it should appear in async chunks " % MONO_FONT +
    "but not the root bundle.",
    "Checking with the React Native debugger that <font face='%s'>firebase/app</font>'s "
    "<font face='%s'>initializeApp</font> is NOT called until the user navigates to /ytc-unlock or /ytc." % (MONO_FONT, MONO_FONT),
]))


# ============================================================================
# 10. Phase 4 — YtcAuthContext + auth gate
# ============================================================================
story.append(PageBreak())
story.append(P("10. Phase 4 — YtcAuthContext + auth-gate layout", h1))
story.append(P("Time: ~1.5 hr. Provides Firebase auth state + approval flag, scoped to the /ytc subtree.", body))

story.append(P("10.1 contexts/YtcAuthContext.tsx", h2))
story.append(code('''import React, { createContext, useContext, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { getYtcFirebase, subscribeAuth } from "@/lib/ytc/firebase";
import { checkUserApproval } from "@/lib/ytc/firebase"; // export this function from firebase.ts

interface YtcAuthState {
  user: User | null;
  isApproved: boolean;
  isAdmin: boolean;
  isLoading: boolean;
}

interface YtcAuthContextValue extends YtcAuthState {
  signOut: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const YtcAuthContext = createContext<YtcAuthContextValue>({
  user: null, isApproved: false, isAdmin: false, isLoading: true,
  signOut: async () => {}, refreshStatus: async () => {},
});

export function YtcAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<YtcAuthState>({
    user: null, isApproved: false, isAdmin: false, isLoading: true,
  });

  const updateApproval = async (user: User) => {
    if (!user.email) return;
    const { approved, admin } = await checkUserApproval(user.email);
    setState(prev => ({ ...prev, user, isApproved: approved, isAdmin: admin, isLoading: false }));
  };

  useEffect(() => {
    let unsub: (() => void) | null = null;
    (async () => {
      unsub = await subscribeAuth(async (user) => {
        if (user) await updateApproval(user);
        else setState({ user: null, isApproved: false, isAdmin: false, isLoading: false });
      });
    })();
    return () => { unsub?.(); };
  }, []);

  const signOut = async () => {
    const { firebaseSignOutIfInitialized } = await import("@/lib/ytc/firebase");
    await firebaseSignOutIfInitialized();
  };
  const refreshStatus = async () => { if (state.user) await updateApproval(state.user); };

  return (
    <YtcAuthContext.Provider value={{ ...state, signOut, refreshStatus }}>
      {children}
    </YtcAuthContext.Provider>
  );
}

export const useYtcAuth = () => useContext(YtcAuthContext);'''))

story.append(P("10.2 app/ytc/_layout.tsx", h2))
story.append(code('''import { useEffect } from "react";
import { Stack, router } from "expo-router";
import { YtcAuthProvider, useYtcAuth } from "@/contexts/YtcAuthContext";

function YtcGate() {
  const { user, isApproved, isLoading } = useYtcAuth();
  useEffect(() => {
    if (isLoading) return;
    if (!user) router.replace("/ytc/(auth)/login");
    else if (!isApproved) router.replace("/ytc/(auth)/pending");
    else router.replace("/ytc/(tabs)");
  }, [user, isApproved, isLoading]);
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

export default function YtcRootLayout() {
  return (
    <YtcAuthProvider>
      <YtcGate />
    </YtcAuthProvider>
  );
}'''))


# ============================================================================
# 11. Phase 5 — Route porting
# ============================================================================
story.append(PageBreak())
story.append(P("11. Phase 5 — Route porting (refactor recipe)", h1))
story.append(P("Time: ~6–8 hr. Mostly mechanical for 3 of 5 screens; the home and shiurim screens take audio integration work too (§12).", body))

story.append(P("11.1 Refactor recipe (apply per-file)", h2))
story.append(P("For each ported file from <font face='%s'>ytcalumni1/expo-app/app/</font>:" % MONO_FONT, body))
story.append(numbered([
    "Replace <font face='%s'>'../contexts/AuthContext'</font> &rarr; " % MONO_FONT +
    "<font face='%s'>'@/contexts/YtcAuthContext'</font>." % MONO_FONT,
    "Replace <font face='%s'>'../services/firebase'</font> &rarr; <font face='%s'>'@/lib/ytc/firebase'</font>." % (MONO_FONT, MONO_FONT),
    "Replace <font face='%s'>'../constants/Colors'</font> &rarr; <font face='%s'>'@/constants/ytcColors'</font>." % (MONO_FONT, MONO_FONT),
    "Replace any <font face='%s'>'../types'</font> &rarr; <font face='%s'>'@/types/ytc'</font>." % (MONO_FONT, MONO_FONT),
    "Replace any <font face='%s'>'../components/MiniPlayer'</font> imports — DROP the import; ShiurPod's MiniPlayerHost handles it." % MONO_FONT,
    "Replace audio: <font face='%s'>useAudio()</font> &rarr; <font face='%s'>useAudioPlayer()</font> + the audio adapter (§12)." % (MONO_FONT, MONO_FONT),
    "If a file imports <font face='%s'>expo-av</font> directly, remove that import; route through ShiurPod's player." % MONO_FONT,
    "Add the <font face='%s'>'use client'</font>-equivalent or any TS strictness fixups your tsconfig requires." % MONO_FONT,
]))

story.append(P("11.2 Per-file notes", h2))
notes_table = [
    ["Target file", "Notes beyond recipe"],
    ["app/ytc/(auth)/_layout.tsx", "Just a Stack with two screens. No special handling."],
    ["app/ytc/(auth)/login.tsx",
     "Imports <font face='%s'>signInWithEmailAndPassword</font> from <font face='%s'>firebase/auth</font>. Convert to lazy: import it inside the submit handler. Same for <font face='%s'>createUserWithEmailAndPassword</font>." % (MONO_FONT, MONO_FONT, MONO_FONT)],
    ["app/ytc/(auth)/pending.tsx", "Posts to accessRequests collection. Replace with the new lazy fetchers from lib/ytc/firebase."],
    ["app/ytc/(tabs)/_layout.tsx",
     "DROP the wrapped MiniPlayer view at the bottom. ShiurPod's <font face='%s'>MiniPlayerHost</font> already overlays globally." % MONO_FONT],
    ["app/ytc/(tabs)/index.tsx",
     "Home screen. Fetches carousel, recent shiur, upcoming events, announcements. Replace play-shiur button with adapter call (§12). No download button."],
    ["app/ytc/(tabs)/shiurim.tsx",
     "Largest screen. Filtering + sorting in-memory. Each shiur tile triggers <font face='%s'>playYtcShiur(shiur)</font> from §12. Pass through play-count increment." % MONO_FONT],
    ["app/ytc/(tabs)/events.tsx", "Read-only list. Recipe alone is sufficient."],
    ["app/ytc/(tabs)/contacts.tsx", "Read-only list. Phone/email links use <font face='%s'>Linking.openURL</font> (already in expo). Recipe alone is sufficient." % MONO_FONT],
]
story.append(table(notes_table, col_widths=[1.85*inch, 4.95*inch]))

story.append(P("11.3 Provider order in app/ytc/_layout.tsx", h2))
story.append(P("YtcAuthProvider mounts inside the YTC subtree only. Do NOT add it to the root layout.", body))


# ============================================================================
# 12. Phase 6 — Audio adapter
# ============================================================================
story.append(PageBreak())
story.append(P("12. Phase 6 — Audio adapter", h1))
story.append(P("Time: ~2–3 hr. The most code-heavy phase.", body))

story.append(P("12.1 lib/ytc/audio-adapter.ts", h2))
story.append(P("Synthesizes shiurpod-shaped Episode and Feed objects from a YTC Shiur, then plays via "
    "<font face='%s'>useAudioPlayer().playEpisode</font>." % MONO_FONT, body))
story.append(code('''import type { Episode, Feed } from "@/lib/types";
import type { Shiur } from "@/types/ytc";

const YTC_FEED_PREFIX = "ytc:feed:";
const YTC_EPISODE_PREFIX = "ytc:";

/** Synthesize a virtual feed per rebbe. Used as Feed for ShiurPod's player. */
export function ytcRebbeToFeed(rebbeName: string): Feed {
  const id = `${YTC_FEED_PREFIX}${rebbeName.toLowerCase().replace(/\\s+/g, "-")}`;
  return {
    id,
    title: rebbeName,
    rssUrl: "",                  // not a real RSS feed
    imageUrl: null,
    description: null,
    author: rebbeName,
    categoryId: null,
    isActive: true,
    isFeatured: false,
    scheduledPublishAt: null,
    lastFetchedAt: null,
    createdAt: new Date().toISOString(),
    sourceNetwork: "ytc",
  };
}

export function ytcShiurToEpisode(shiur: Shiur, feed: Feed): Episode {
  return {
    id: `${YTC_EPISODE_PREFIX}${shiur.id}`,
    feedId: feed.id,
    title: shiur.title,
    description: shiur.description ?? null,
    audioUrl: shiur.audioUrl,
    duration: null,              // ytc Shiur has no duration field; player computes from media
    publishedAt: shiur.date || null,
    guid: `${YTC_EPISODE_PREFIX}${shiur.id}`,
    imageUrl: null,
    adminNotes: null,
    sourceSheetUrl: shiur.pdfUrl ?? null,
    createdAt: shiur.date || new Date().toISOString(),
    noDownload: true,            // D14: downloads OOS for v1
  };
}

export function isYtcEpisodeId(id: string): boolean {
  return id.startsWith(YTC_EPISODE_PREFIX);
}'''))

story.append(P("12.2 Play helper that wraps useAudioPlayer", h2))
story.append(code('''// app/ytc/(tabs)/shiurim.tsx and index.tsx
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { ytcRebbeToFeed, ytcShiurToEpisode } from "@/lib/ytc/audio-adapter";
import { incrementPlayCount } from "@/lib/ytc/firebase";

function useYtcPlay() {
  const { playEpisode } = useAudioPlayer();
  return async (shiur: Shiur) => {
    const feed = ytcRebbeToFeed(shiur.rebbe || "YTC");
    const episode = ytcShiurToEpisode(shiur, feed);
    await playEpisode(episode, feed);
    incrementPlayCount(shiur.id).catch(() => {}); // Firestore, fire-and-forget
  };
}'''))

story.append(P("12.3 Position dual-write (D7)", h2))
story.append(P("ShiurPod's AudioPlayerContext already POSTs to <font face='%s'>/api/playback-positions</font> on "
    "every position change. To also mirror to Firestore <font face='%s'>users/{uid}/preferences/positions/{shiurId}</font>, "
    "subscribe to position changes from inside the YTC subtree (so it only runs when YTC is active):" % (MONO_FONT, MONO_FONT), body))
story.append(code('''// lib/ytc/positions.ts
import { onPositionsChanged, loadPositions } from "@/contexts/AudioPlayerContext";
import { getYtcFirebase } from "@/lib/ytc/firebase";
import { isYtcEpisodeId } from "@/lib/ytc/audio-adapter";

let installed = false;
export function installYtcPositionMirror() {
  if (installed) return;
  installed = true;
  let writing: Promise<any> = Promise.resolve();
  onPositionsChanged(async () => {
    writing = writing.then(async () => {
      const positions = await loadPositions();
      const { db, auth } = await getYtcFirebase();
      const uid = auth.currentUser?.uid;
      if (!uid) return;
      const { doc, setDoc } = await import("firebase/firestore");
      for (const [id, p] of Object.entries(positions)) {
        if (!isYtcEpisodeId(id)) continue;
        const shiurId = id.slice("ytc:".length);
        await setDoc(doc(db, `users/${uid}/preferences/positions/${shiurId}`), {
          positionMs: p.positionMs,
          durationMs: p.durationMs,
          updatedAt: p.updatedAt,
        }, { merge: true });
      }
    }).catch(() => {});
  });
}'''))
story.append(P("Call <font face='%s'>installYtcPositionMirror()</font> once from inside <font face='%s'>YtcAuthProvider</font> "
    "after the user is signed in. It is a no-op if YTC is not active." % (MONO_FONT, MONO_FONT), body))

story.append(P("12.4 Optional: skip ShiurPod position-sync for ytc:* ids", h2))
story.append(P("If polluting <font face='%s'>playback_positions</font> on the server with synthesized YTC ids is "
    "undesirable, edit <font face='%s'>contexts/AudioPlayerContext.tsx</font> in <font face='%s'>syncPositionToServer</font> " % (MONO_FONT, MONO_FONT, MONO_FONT) +
    "(line ~179) to early-return when <font face='%s'>episodeId.startsWith('ytc:')</font>. Keep AsyncStorage write " % MONO_FONT +
    "(needed for in-app resume). This is a one-line change:", body))
story.append(code('''async function syncPositionToServer(episodeId: string, feedId: string, positionMs: number, durationMs: number) {
  if (episodeId.startsWith("ytc:")) return;   // YTC mirrors via lib/ytc/positions.ts instead
  // ...existing implementation...
}'''))


# ============================================================================
# 13. Phase 7 — Notifications
# ============================================================================
story.append(PageBreak())
story.append(P("13. Phase 7 — Notifications (recommended path: backend bridge)", h1))
story.append(P("Time: ~3 hr (+server work). The recommended path keeps shiurpod's existing Expo Push pipeline as the only on-device receiver.", body))

story.append(P("13.1 Architecture", h2))
story.append(P("YTC's notification sender currently emits to FCM topics (<font face='%s'>all_users</font>, "
    "<font face='%s'>announcements</font>, <font face='%s'>new_shiurim</font>, <font face='%s'>events</font>). "
    "We do NOT subscribe shiurpod to those topics directly (would require @react-native-firebase/messaging — "
    "Appendix F). Instead a server-side bridge does the topic-to-user fan-out and re-emits via Expo Push to "
    "shiurpod tokens linked to YTC users." % (MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT), body))

story.append(P("Diagram (text):", body))
story.append(code('''YTC server publishes to FCM topic 'new_shiurim'
        |
        v
[Bridge worker] subscribes to FCM topics OR receives webhook
        |
        v
For each YTC user mapped to a shiurpod expoPushToken,
emit Expo Push payload:
  {
    to: expoPushToken,
    title: "New shiur from Rabbi X",
    body: shiur.title,
    data: { screen: "ytc-shiurim", ytcShiurId: shiur.id, app: "ytc" },
    channelId: "ytc",
  }'''))

story.append(P("13.2 Add 'ytc' Android channel", h2))
story.append(P("Edit <font face='%s'>lib/push-notifications.ts</font> in <font face='%s'>setupPushNotificationChannels</font>:" % (MONO_FONT, MONO_FONT), body))
story.append(code('''await Notifications.setNotificationChannelAsync("ytc", {
  name: "YTC Alumni",
  importance: Notifications.AndroidImportance.HIGH,
  vibrationPattern: [0, 250, 250, 250],
  lightColor: "#19263F",
  sound: "default",
  enableVibrate: true,
  showBadge: true,
});'''))

story.append(P("13.3 Extend tap routing (app/_layout.tsx)", h2))
story.append(P("Inside <font face='%s'>handleNotificationResponse</font>, before the existing branches:" % MONO_FONT, body))
story.append(code('''import { isUnlocked } from "@/lib/ytc/unlock";
// ...inside handleNotificationResponse, in the setTimeout:
if (data.screen?.startsWith("ytc-")) {
  isUnlocked().then(ok => {
    if (!ok) {
      router.push("/(tabs)/settings" as any);
      return;
    }
    if (data.screen === "ytc-shiurim") router.push("/ytc/(tabs)/shiurim" as any);
    else if (data.screen === "ytc-events") router.push("/ytc/(tabs)/events" as any);
    else if (data.screen === "ytc-contacts") router.push("/ytc/(tabs)/contacts" as any);
    else router.push("/ytc/(tabs)" as any);
    // Optional deep link to a specific shiur if data.ytcShiurId exists.
  });
  return;
}'''))

story.append(P("13.4 Extend getNotificationData (lib/push-notifications.ts)", h2))
story.append(code('''export function getNotificationData(response: Notifications.NotificationResponse): {
  episodeId?: string;
  feedId?: string;
  type?: string;
  screen?: string;
  conversationId?: string;
  ytcShiurId?: string;   // <-- NEW
} {
  const data = response.notification.request.content.data as Record<string, any> | undefined;
  if (!data) return {};
  return {
    episodeId: data.episodeId, feedId: data.feedId, type: data.type,
    screen: data.screen, conversationId: data.conversationId,
    ytcShiurId: data.ytcShiurId,
  };
}'''))

story.append(P("13.5 Device linking endpoint", h2))
story.append(P("On YTC successful login, the app posts to a new shiurpod endpoint:", body))
story.append(code('''POST /api/ytc/link-device
{ "deviceId": "<shiurpod-device-id>", "ytcUid": "<firebase-uid>" }'''))
story.append(P("Server stores the mapping in a new table (Appendix E). The bridge worker uses it to translate "
    "YTC topic events into per-user Expo Push sends.", body))

story.append(P("13.6 Client side of the link", h2))
story.append(code('''// In contexts/YtcAuthContext.tsx, after isApproved becomes true:
useEffect(() => {
  if (!state.user || !state.isApproved) return;
  (async () => {
    try {
      const deviceId = await getDeviceId();
      await apiRequest("POST", "/api/ytc/link-device", {
        deviceId, ytcUid: state.user.uid,
      });
    } catch (e) {
      addLog("warn", `ytc link-device failed: ${(e as any)?.message || e}`, undefined, "ytc");
    }
  })();
}, [state.user, state.isApproved]);'''))


# ============================================================================
# 14. Phase 8 — Verification
# ============================================================================
story.append(PageBreak())
story.append(P("14. Phase 8 — Verification checklist", h1))
story.append(P("Walk through every item before declaring done.", body))

verify = [
    "<b>Cold start (locked).</b> Fresh install, no unlock. Search Metro bundle: 'firebase/app' should appear in async chunks only. <font face='%s'>initializeApp</font> never called per debug breakpoint." % MONO_FONT,
    "<b>Wrong code.</b> /ytc-unlock with wrong code -> alert, no flag flip, no Firebase init.",
    "<b>Right code.</b> /ytc-unlock with correct code -> router.replace('/ytc') -> auth gate -> login. Settings UI updates without app reload.",
    "<b>Sign up flow.</b> Non-approved email -> /ytc/(auth)/pending. Tapping 'request access' creates accessRequests doc.",
    "<b>Approved sign-in.</b> Approved email -> /ytc/(tabs). Home shows carousel/recent/announcements without errors.",
    "<b>Audio: YTC plays in shiurpod player.</b> Tap a shiur -> mini-player appears -> full player opens. Episode title is correct, position bar moves.",
    "<b>Audio: cross-app session.</b> Start a regular shiurpod episode, then play a YTC shiur, then return to shiurpod. No double-audio, no orphaned focus.",
    "<b>Audio: position resume.</b> Play a YTC shiur 30s in, force-quit, reopen, return to /ytc -> player resumes at 30s (in-app) AND Firestore positions doc has matching value.",
    "<b>Stats untouched.</b> Listening stats screen does not show YTC titles. (D13)",
    "<b>Notifications channel.</b> adb settings UI shows 3 channels: default, new-episodes, ytc.",
    "<b>Notification tap (locked).</b> Send a test push with data.screen='ytc-shiurim'. Tap -> routes to /(tabs)/settings (because YTC is locked).",
    "<b>Notification tap (unlocked).</b> Same push, after unlock -> routes to /ytc/(tabs)/shiurim.",
    "<b>Lock from settings.</b> Disable YTC -> tab gone, /ytc-unlock fresh ask, Firebase signed out. /ytc routes return to login if visited directly.",
    "<b>Sign-out independence.</b> Sign out of shiurpod main account (if applicable) -> YTC unlock and YTC Firebase session both untouched.",
    "<b>RemoteConfig rotation.</b> Change ytcUnlockCode server-side -> next /ytc-unlock attempt with old code fails; new code works.",
    "<b>No iOS regression.</b> If iOS build is still produced (even though YTC is Android-only), confirm app boots normally and the YTC settings entry is hidden or non-functional. (Plan: still hide on iOS via Platform.OS check or just leave settings entry enabled but route to a 'Android only' notice.)",
    "<b>Bundle size.</b> Compare release APK size pre/post — Firebase JS adds ~200KB compressed. Acceptable.",
    "<b>Firestore rules audit.</b> Appendix C completed and signed off.",
]
story.append(bullets(verify))


# ============================================================================
# 15. Effort estimate
# ============================================================================
story.append(P("15. Effort estimate", h1))
effort = [
    ["Phase",                           "Time",        "Risk areas"],
    ["1. Deps & Metro",                 "~30 min",     "Metro cjs / package-exports tweak"],
    ["2. Unlock gate",                  "~1 hr",       "—"],
    ["3. Lazy Firebase service",        "~1 hr",       "Bundle audit takes longer if first-time"],
    ["4. YtcAuthContext + gate",        "~1.5 hr",     "Lazy import boundaries"],
    ["5. Route porting",                "~6–8 hr",     "Mechanical refactor; verify visual parity"],
    ["6. Audio adapter",                "~2–3 hr",     "Position dual-write race conditions; play-count fire-and-forget timing"],
    ["7. Notifications + bridge wire",  "~3 hr (+server)", "Bridge worker is server-side work; channel + routing on-device is small"],
    ["8. Verification",                 "~1.5 hr",     "Audio session regression scenarios"],
    ["Firestore rules audit",           "~1 hr",       "External dependency; do early"],
    ["Total (client side)",             "~2.5–3 days", ""],
]
story.append(table(effort, col_widths=[1.9*inch, 1.3*inch, 3.6*inch]))


# ============================================================================
# Appendices
# ============================================================================
story.append(PageBreak())
story.append(P("Appendix A — Verbatim copy targets", h1))
story.append(P("Run from a freshly cloned <font face='%s'>/tmp/ytc-source</font>. The 'shiurpod path' column "
    "is where the file lands in the shiurpod repo." % MONO_FONT, body))
copy_targets = [
    ["YTC source path",                                       "ShiurPod path"],
    ["expo-app/services/firebase.ts",                          "lib/ytc/firebase.ts (apply lazy-init wrapper §9)"],
    ["expo-app/contexts/AuthContext.tsx",                      "contexts/YtcAuthContext.tsx"],
    ["expo-app/constants/Colors.ts",                           "constants/ytcColors.ts"],
    ["expo-app/types/index.ts (or types/*.ts)",                "types/ytc.ts"],
    ["expo-app/app/(auth)/_layout.tsx",                        "app/ytc/(auth)/_layout.tsx"],
    ["expo-app/app/(auth)/login.tsx",                          "app/ytc/(auth)/login.tsx"],
    ["expo-app/app/(auth)/pending.tsx",                        "app/ytc/(auth)/pending.tsx"],
    ["expo-app/app/(tabs)/_layout.tsx",                        "app/ytc/(tabs)/_layout.tsx"],
    ["expo-app/app/(tabs)/index.tsx",                          "app/ytc/(tabs)/index.tsx"],
    ["expo-app/app/(tabs)/shiurim.tsx",                        "app/ytc/(tabs)/shiurim.tsx"],
    ["expo-app/app/(tabs)/events.tsx",                         "app/ytc/(tabs)/events.tsx"],
    ["expo-app/app/(tabs)/contacts.tsx",                       "app/ytc/(tabs)/contacts.tsx"],
]
story.append(table(copy_targets, col_widths=[3.4*inch, 3.4*inch]))


story.append(P("Appendix B — Firebase config & Firestore collections", h1))
story.append(P("Public client config (commit-safe, identical across all YTC variants):", body))
story.append(code('''{
  apiKey: "AIzaSyB-j6Itt_DKVLOm5BGsuygVUD6YoPKQyS8",
  authDomain: "toras-chaim-shiurim.firebaseapp.com",
  projectId: "toras-chaim-shiurim",
  storageBucket: "toras-chaim-shiurim.firebasestorage.app",
  messagingSenderId: "95643621522",
  appId: "1:95643621522:ios:a75e5f1bdfaba692986e4b"
}'''))
story.append(P("Firestore collections used by ports here: see §4.3. FCM topics used by native YTC apps: "
    "<font face='%s'>all_users</font>, <font face='%s'>announcements</font>, <font face='%s'>new_shiurim</font>, "
    "<font face='%s'>events</font>." % (MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT), body))


story.append(P("Appendix C — Firestore rules audit checklist", h1))
story.append(P("Before ship, somebody who can read the YTC Firebase project needs to verify:", body))
story.append(bullets([
    "Reads on collections <font face='%s'>shiurim, events, announcements, carouselImages, rebbeim</font> are public OR " % MONO_FONT +
    "scoped to authenticated users (and shiurpod users will be authenticated post-login).",
    "Reads on <font face='%s'>alumniDatabase, approvedEmails, admins</font> are restricted such that an attacker " % MONO_FONT +
    "with the apiKey + a Firebase test account cannot dump the email lists.",
    "Writes on <font face='%s'>accessRequests, alumniContactSubmissions, simchaSubmissions</font> are rate-limited " % MONO_FONT +
    "or otherwise abuse-resistant.",
    "Writes on <font face='%s'>users/{uid}/preferences/*</font> are scoped to the owning uid (so dual-writes " % MONO_FONT +
    "from shiurpod cannot tamper with other users' data).",
    "<font face='%s'>shiurim.playCount</font> increment is allowed for any authenticated user (used by " % MONO_FONT +
    "<font face='%s'>incrementPlayCount</font>)." % MONO_FONT,
]))


story.append(P("Appendix D — Out of scope / follow-ups", h1))
story.append(bullets([
    "<b>Downloads / offline for YTC shiurim.</b> Synthesized Episode has <font face='%s'>noDownload: true</font> for v1. " % MONO_FONT +
    "Adding offline support means deciding whether YTC files live in shiurpod's downloads dir alongside other shiurim, " +
    "what storage budget gets allocated, and whether unsubscribing from YTC purges them.",
    "<b>YTC plays counted in shiurpod stats.</b> Currently filtered out (D13). If the user changes their mind, " +
    "remove the filter — synthesized ids already make it easy to opt YTC in.",
    "<b>iOS port.</b> Not blocked architecturally — the JS SDK is cross-platform. APNs delegate concern returns; " +
    "see Appendix F if path B is later chosen.",
    "<b>Path B (RNFirebase Messaging).</b> See Appendix F. Allows direct topic subscription without a backend bridge; " +
    "tradeoff is native module + manifest-merge work.",
    "<b>Auth biometrics on top of unlock code.</b> Trivial to add via <font face='%s'>expo-local-authentication</font> " % MONO_FONT +
    "but currently not in scope.",
    "<b>Code-rotation UX.</b> If RemoteConfig rotates the unlock code, currently-unlocked devices stay unlocked. " +
    "If the user wants forced re-validation, add a config version key and re-check.",
    "<b>Featured shiur on home.</b> Native YTC apps render <font face='%s'>settings/featuredShiur</font>; the expo-app " % MONO_FONT +
    "does not. If desired, add it during the home-screen port.",
]))


story.append(P("Appendix E — Server-side companion changes", h1))
story.append(P("Two changes to the shiurpod backend (server/):", body))
story.append(P("1. /api/config: serve ytcUnlockCode", h3))
story.append(code('''// server/routes.ts (or wherever /api/config is handled)
res.json({
  // ...existing fields...
  ytcUnlockCode: process.env.YTC_UNLOCK_CODE || "1234",
});'''))
story.append(P("2. /api/ytc/link-device: store device <-> ytcUid mapping", h3))
story.append(code('''// drizzle schema (shared/schema.ts or wherever table defs live)
export const ytcDeviceLinks = pgTable("ytc_device_links", {
  deviceId: text("device_id").primaryKey(),
  ytcUid: text("ytc_uid").notNull(),
  linkedAt: timestamp("linked_at").defaultNow().notNull(),
});

// server/routes.ts
app.post("/api/ytc/link-device", async (req, res) => {
  const { deviceId, ytcUid } = req.body;
  if (!deviceId || !ytcUid) return res.status(400).json({ error: "deviceId and ytcUid required" });
  await db.insert(ytcDeviceLinks)
    .values({ deviceId, ytcUid })
    .onConflictDoUpdate({ target: ytcDeviceLinks.deviceId, set: { ytcUid, linkedAt: new Date() } });
  res.json({ ok: true });
});'''))
story.append(P("3. (Optional, for path A bridge) Worker that consumes YTC FCM topic events and sends Expo Push:", h3))
story.append(P("Implementation depends on where YTC's notification sender lives. Two patterns:", body))
story.append(bullets([
    "<b>Webhook</b> — modify YTC's sender to POST topic events to "
    "<font face='%s'>/api/ytc/topic-event</font> on shiurpod. Shiurpod looks up linked device tokens for that " % MONO_FONT +
    "topic-equivalent audience and sends Expo Push.",
    "<b>FCM consumer</b> — a Node worker uses the Firebase Admin SDK to subscribe via the FCM HTTP v1 API " +
    "(or a Firebase Cloud Function on the YTC project that fires on topic events) and POSTs to shiurpod.",
]))
story.append(P("Either way, the Expo Push payload should be:", body))
story.append(code('''{
  "to": "<expoPushToken>",
  "title": "<from topic event>",
  "body":  "<from topic event>",
  "data":  { "screen": "ytc-shiurim" | "ytc-events" | "ytc-home" | "ytc-contacts",
             "ytcShiurId": "<optional>", "app": "ytc" },
  "channelId": "ytc",
  "android": { "priority": "high" }
}'''))


story.append(P("Appendix F — Notification path B (RNFirebase Messaging)", h1))
story.append(P("Reference only. Use this if D8 is reversed.", body))
story.append(P("F.1 Dependencies", h2))
story.append(code('''npm install @react-native-firebase/app @react-native-firebase/messaging --save'''))
story.append(P("Add config plugin entries to app.json:", body))
story.append(code('''"plugins": [
  ...,
  "@react-native-firebase/app",
  "@react-native-firebase/messaging"
]'''))
story.append(P("F.2 Place google-services.json", h2))
story.append(P("Download from the Firebase console for the <font face='%s'>toras-chaim-shiurim</font> project "
    "(Android app section) and reference it from app.json:" % MONO_FONT, body))
story.append(code('''"android": {
  "package": "com.shiurpod.app",   // or whatever shiurpod's existing package is
  "googleServicesFile": "./google-services.json"
}'''))
story.append(P("F.3 Manifest-merge collision", h2))
story.append(P("Both <font face='%s'>expo-notifications</font> and <font face='%s'>@react-native-firebase/messaging</font> "
    "register a <font face='%s'>FirebaseMessagingService</font> with intent filter <font face='%s'>com.google.firebase.MESSAGING_EVENT</font>. " % (MONO_FONT, MONO_FONT, MONO_FONT, MONO_FONT) +
    "Only one wins. Resolution pattern: let RNFirebase be the FCM receiver, and use expo-notifications for "
    "display only via <font face='%s'>scheduleNotificationAsync</font> in a <font face='%s'>setBackgroundMessageHandler</font>:" % (MONO_FONT, MONO_FONT), body))
story.append(code('''import messaging from "@react-native-firebase/messaging";
import * as Notifications from "expo-notifications";

messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: remoteMessage.notification?.title ?? "YTC Alumni",
      body:  remoteMessage.notification?.body ?? "",
      data:  remoteMessage.data ?? {},
      sound: "default",
    },
    trigger: null,
  });
});

// Subscribe topics on YTC sign-in:
await messaging().subscribeToTopic("all_users");
await messaging().subscribeToTopic("new_shiurim");
await messaging().subscribeToTopic("events");
await messaging().subscribeToTopic("announcements");

// Unsubscribe on YTC sign-out / lock.'''))
story.append(P("F.4 Trade vs path A", h2))
story.append(bullets([
    "Pros: no backend bridge; topic subscription is the canonical path used by native YTC apps.",
    "Cons: native module → custom dev client rebuild; manifest-merge collision must be tested on every EAS build; "
    "two notification systems on the device increase the surface for regressions.",
]))


story.append(Spacer(1, 18))
story.append(P("End of document.", small))


# ============================================================================
# Build
# ============================================================================
doc.build(story, onFirstPage=page_footer, onLaterPages=page_footer)
print(f"Wrote: {OUT_PATH}")
