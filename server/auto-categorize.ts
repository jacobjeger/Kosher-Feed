import * as storage from "./storage";

const log = console.log;

// Canonical categories with keyword matching
export const CANONICAL_CATEGORIES: { name: string; slug: string }[] = [
  { name: "Gemara", slug: "gemara" },
  { name: "Mishnah", slug: "mishnah" },
  { name: "Halacha", slug: "halacha" },
  { name: "Parasha", slug: "parasha" },
  { name: "Chumash", slug: "chumash" },
  { name: "Nach", slug: "nach" },
  { name: "Mussar", slug: "mussar" },
  { name: "Chassidus", slug: "chassidus" },
  { name: "Hashkafa", slug: "hashkafa" },
  { name: "Tefillah", slug: "tefillah" },
  { name: "Yomim Tovim", slug: "yomim-tovim" },
];

// Keywords mapped to category slugs (all lowercase for matching)
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  gemara: [
    "gemara", "talmud", "daf yomi", "daf hayomi", "masechta", "maseches",
    "masechet", "bavli", "shas", "sugya", "sugyos", "tosfos", "tosafot",
    "rashi on talmud", "bava kamma", "bava metzia", "bava basra", "bava batra",
    "sanhedrin", "shabbos", "shabbat", "eruvin", "pesachim", "yoma",
    "sukkah", "beitzah", "rosh hashanah", "taanis", "taanit", "megillah",
    "moed katan", "chagigah", "yevamos", "yevamot", "kesubos", "ketubot",
    "nedarim", "nazir", "sotah", "gittin", "kiddushin", "baba kama",
    "baba metsia", "baba batra", "avodah zarah", "horayos", "zevachim",
    "menachos", "chullin", "bechoros", "arachin", "temurah", "kerisos",
    "meilah", "tamid", "middos", "kinnim", "niddah", "makos", "makkot",
    "shevuos", "shevuot",
  ],
  mishnah: [
    "mishnah", "mishna", "mishnayos", "mishnayot", "mishnaiot",
    "pirkei avos", "pirkei avot", "ethics of the fathers",
  ],
  halacha: [
    "halacha", "halakha", "halachos", "halakhot", "shulchan aruch",
    "shulhan arukh", "orach chaim", "yoreh deah", "even haezer",
    "choshen mishpat", "mishnah berurah", "mishna berura", "kitzur",
    "hilchos", "hilchot", "laws of", "dinim", "issur veheter",
    "brachos", "brachot", "practical halacha",
  ],
  parasha: [
    "parasha", "parashat", "parshat", "parsha", "parshas",
    "weekly portion", "torah portion", "sedra", "sidra",
    "bereishis", "bereshit", "noach", "lech lecha",
    "vayeira", "chayei sarah", "toldos", "toldot",
    "vayeitzei", "vayishlach", "vayeishev", "mikeitz", "miketz",
    "vayigash", "vayechi", "shemos", "shemot", "vaeira",
    "bo", "beshalach", "yisro", "yitro", "mishpatim",
    "terumah", "tetzaveh", "ki sisa", "ki tisa",
    "vayakhel", "pekudei", "vayikra", "tzav",
    "shemini", "tazria", "metzora", "acharei mos", "acharei mot",
    "kedoshim", "emor", "behar", "bechukosai", "bechukotai",
    "bamidbar", "naso", "behaaloscha", "beha'alotcha",
    "shelach", "korach", "chukas", "chukat", "balak",
    "pinchas", "matos", "matot", "masei", "devarim",
    "vaeschanan", "vaetchanan", "eikev", "re'eh", "reeh",
    "shoftim", "ki seitzei", "ki tetze", "ki savo", "ki tavo",
    "nitzavim", "vayeilech", "haazinu", "vezos habracha",
    "vezot haberacha",
  ],
  chumash: [
    "chumash", "torah", "five books", "bereishis", "bereshit",
    "shemos", "shemot", "vayikra", "bamidbar", "devarim",
    "genesis", "exodus", "leviticus", "numbers", "deuteronomy",
    "rashi on chumash", "rashi on torah", "ramban on torah",
    "sforno", "ohr hachaim", "or hachaim", "kli yakar",
  ],
  nach: [
    "nach", "navi", "neviim", "nevi'im", "kesuvim", "ketuvim",
    "tehillim", "psalms", "mishlei", "proverbs", "iyov", "job",
    "shir hashirim", "song of songs", "koheles", "kohelet",
    "ecclesiastes", "ruth", "megillas", "esther", "eicha",
    "lamentations", "daniel", "ezra", "nechemiah", "nehemiah",
    "divrei hayamim", "chronicles", "yehoshua", "joshua",
    "shoftim", "judges", "shmuel", "samuel", "melachim", "kings",
    "yeshayahu", "isaiah", "yirmiyahu", "jeremiah", "yechezkel",
    "ezekiel", "hoshea", "hosea", "yoel", "joel", "amos",
    "ovadiah", "obadiah", "yonah", "jonah", "michah", "micah",
    "nachum", "nahum", "chavakuk", "habakkuk", "tzefaniah",
    "zephaniah", "chaggai", "haggai", "zechariah", "malachi",
    "trei asar", "twelve prophets",
  ],
  mussar: [
    "mussar", "musar", "middos", "middot", "character traits",
    "self improvement", "mesilas yesharim", "mesilat yesharim",
    "path of the just", "orchos tzaddikim", "orchot tzadikim",
    "chovos halevavos", "chovot halevavot", "duties of the heart",
    "shaarei teshuvah", "sha'arei teshuva", "gates of repentance",
    "tomer devorah", "pele yoetz",
  ],
  chassidus: [
    "chassidus", "chasidut", "chassidut", "hasidut", "hasidism",
    "tanya", "likutei moharan", "likutey moharan", "breslov",
    "breslev", "chabad", "lubavitch", "rebbe", "baal shem tov",
    "besht", "sfas emes", "sefat emet", "kedushas levi",
    "noam elimelech", "mei hashiloach", "tiferes shlomo",
    "nesivos shalom", "netivot shalom", "aish kodesh",
    "piaseczno", "piacezna", "izbitz", "izhbitz",
  ],
  hashkafa: [
    "hashkafa", "hashkafah", "jewish philosophy", "jewish thought",
    "emunah", "emuna", "faith", "bitachon", "trust in god",
    "moreh nevuchim", "guide for the perplexed", "rambam philosophy",
    "kuzari", "derech hashem", "derekh hashem", "way of god",
    "daas tevunos", "da'at tevunot", "nefesh hachaim",
    "worldview", "machshava", "machshevet",
  ],
  tefillah: [
    "tefillah", "tefilah", "tefila", "prayer", "davening",
    "siddur", "shemoneh esrei", "shemone esre", "amidah",
    "brachos", "brachot", "blessings", "krias shema",
    "kriat shema", "shema", "pesukei dezimra", "pesukei d'zimra",
    "hallel", "birkas hamazon", "birkat hamazon", "bentching",
  ],
  "yomim-tovim": [
    "yomim tovim", "holidays", "yom tov", "chag", "chagim",
    "rosh hashana", "rosh hashanah", "yom kippur",
    "sukkos", "sukkot", "succos", "succot",
    "simchas torah", "simchat torah", "shemini atzeres", "shemini atzeret",
    "chanukah", "chanuka", "hanukkah", "hanukah",
    "purim", "pesach", "passover", "seder",
    "shavuos", "shavuot", "lag baomer", "lag b'omer",
    "tisha b'av", "tisha bav", "tishah b'av",
    "sefirah", "sefirat haomer", "counting the omer",
    "tu bishvat", "tu b'shvat", "yom haatzmaut",
    "yom hazikaron", "yom yerushalayim",
    "three weeks", "nine days", "bein hametzarim",
    "elul", "aseres yemei teshuvah", "ten days of repentance",
  ],
};

// Platform URL prefix -> auto-assigned category slug
const PLATFORM_OVERRIDES: Record<string, string> = {
  "alldaf://": "gemara",
  "allmishnah://": "mishnah",
  "allparsha://": "parasha",
};

// Match a text string against keywords, return matching slugs
export function matchTopicToCategories(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const matches: string[] = [];
  for (const [slug, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      // Word boundary match: keyword must not be embedded in a longer word
      const idx = lower.indexOf(kw);
      if (idx !== -1) {
        const before = idx > 0 ? lower[idx - 1] : " ";
        const after = idx + kw.length < lower.length ? lower[idx + kw.length] : " ";
        const isBoundary = (ch: string) => !/[a-z0-9']/.test(ch);
        if (isBoundary(before) && isBoundary(after)) {
          matches.push(slug);
          break; // One match per category is enough
        }
      }
    }
  }
  return matches;
}

// Main auto-categorization entry point
// Only categorize feeds that are clearly dedicated to a single topic
// (e.g. "Daf Yomi", "Parsha Shiur") — mixed-topic feeds stay uncategorized
export async function autoCategorizeFeeds(): Promise<{ updated: number; skipped: number }> {
  log("Auto-categorize: starting...");

  // Ensure all canonical categories exist, get slug->id map
  const slugToId = await storage.ensureCanonicalCategories(CANONICAL_CATEGORIES);

  const allFeeds = await storage.getActiveFeeds();

  // Batch-load all feed IDs that have manual categories to avoid N+1
  const manualFeedIds = await storage.getFeedIdsWithManualCategories();

  let updated = 0;
  let skipped = 0;

  for (const feed of allFeeds) {
    // Skip feeds with manual categories
    if (manualFeedIds.has(feed.id)) {
      skipped++;
      continue;
    }

    // 1. Platform override — these are definitively single-topic feeds
    let platformCategory: string | null = null;
    for (const [prefix, slug] of Object.entries(PLATFORM_OVERRIDES)) {
      if (feed.rssUrl.startsWith(prefix)) {
        platformCategory = slug;
        break;
      }
    }

    if (platformCategory) {
      const catId = slugToId.get(platformCategory);
      if (catId) {
        await storage.setAutoFeedCategories(feed.id, [catId]);
        updated++;
      }
      continue;
    }

    // 2. Check feed title/description for a clear topic indicator
    const feedText = [feed.title, feed.description].filter(Boolean).join(" ");
    const feedTopicMatches = matchTopicToCategories(feedText);

    // 3. Analyze episodes to see if the feed consistently covers one topic
    const episodes = await storage.getEpisodesByFeedPaginated(feed.id, 1, 20);

    // Need at least 3 episodes to judge consistency
    if (episodes.length < 3) {
      // With very few episodes, only categorize if the feed title clearly indicates a topic
      if (feedTopicMatches.length === 1) {
        const catId = slugToId.get(feedTopicMatches[0]);
        if (catId) {
          await storage.setAutoFeedCategories(feed.id, [catId]);
          updated++;
        }
      }
      continue;
    }

    // Count how many episodes match each category
    const episodeCategoryCounts = new Map<string, number>();
    for (const ep of episodes) {
      const epText = [ep.title, ep.description].filter(Boolean).join(" ");
      const epMatches = matchTopicToCategories(epText);
      for (const slug of epMatches) {
        episodeCategoryCounts.set(slug, (episodeCategoryCounts.get(slug) || 0) + 1);
      }
    }

    // Find the dominant category — the one that appears in the most episodes
    let bestSlug: string | null = null;
    let bestCount = 0;
    for (const [slug, count] of episodeCategoryCounts.entries()) {
      if (count > bestCount) {
        bestSlug = slug;
        bestCount = count;
      }
    }

    if (!bestSlug) continue;

    const consistencyRatio = bestCount / episodes.length;

    // Only categorize if the feed is clearly dedicated to this topic:
    // - If feed title matches the category: require 60%+ episode consistency
    // - If only episodes match (no title match): require 80%+ episode consistency
    const titleMatchesCategory = feedTopicMatches.includes(bestSlug);
    const requiredConsistency = titleMatchesCategory ? 0.6 : 0.8;

    if (consistencyRatio >= requiredConsistency) {
      const catId = slugToId.get(bestSlug);
      if (catId) {
        await storage.setAutoFeedCategories(feed.id, [catId]);
        updated++;
      }
    } else {
      // Not consistent enough — clear any previous auto-categories
      await storage.setAutoFeedCategories(feed.id, []);
    }
  }

  log(`Auto-categorize: ${updated} feeds updated, ${skipped} skipped (manual categories)`);
  return { updated, skipped };
}
