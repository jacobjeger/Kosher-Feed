import type { YoutubeRule } from "@shared/schema";

// Keyword rules for the YouTube review queue.
//
// The review gate exists so nothing reaches listeners unseen. These rules let
// that gate be automated for cases where the answer is mechanical — "every
// upload titled 'Daf Yomi …' is in, every 'Shorts' clip is out" — without
// giving up the gate entirely for everything else.
//
// Deliberate asymmetry: reject wins over approve. A wrongly-rejected shiur sits
// in the Rejected tab and can be restored; a wrongly-approved one has already
// been published. When the rules disagree, take the recoverable mistake.

export type RuleAction = "approve" | "reject";

export interface RuleDecision {
  action: RuleAction;
  rule: YoutubeRule;
}

export interface RuleTarget {
  title: string;
  description?: string | null;
}

function fieldText(rule: YoutubeRule, item: RuleTarget): string {
  switch (rule.field) {
    case "description": return item.description || "";
    case "both": return `${item.title}\n${item.description || ""}`;
    default: return item.title;
  }
}

// A bad regex from the admin form must never take down ingest — treat an
// uncompilable pattern as "does not match" and let the UI flag it.
export function ruleMatches(rule: YoutubeRule, item: RuleTarget): boolean {
  const haystack = fieldText(rule, item);
  if (!rule.pattern) return false;

  if (rule.matchType === "regex") {
    try {
      return new RegExp(rule.pattern, "i").test(haystack);
    } catch {
      return false;
    }
  }
  return haystack.toLowerCase().includes(rule.pattern.toLowerCase());
}

export function isValidRulePattern(matchType: string, pattern: string): string | null {
  if (!pattern || !pattern.trim()) return "Pattern is required";
  if (matchType === "regex") {
    try {
      new RegExp(pattern, "i");
    } catch (e: any) {
      return `Invalid regular expression: ${e.message?.slice(0, 120)}`;
    }
  }
  return null;
}

// Pick the winning rule for one video. Rules should already be filtered to
// those that apply to this feed (feed-specific plus global).
export function evaluateRules(rules: YoutubeRule[], item: RuleTarget): RuleDecision | null {
  let approve: YoutubeRule | null = null;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(rule, item)) continue;
    // Reject short-circuits — nothing outranks it.
    if (rule.action === "reject") return { action: "reject", rule };
    if (!approve) approve = rule;
  }

  return approve ? { action: "approve", rule: approve } : null;
}

// Rules relevant to a feed: its own, plus the global ones. Feed-scoped rules
// are listed first so they win ties among approve rules.
export function rulesForFeed(all: YoutubeRule[], feedId: string): YoutubeRule[] {
  return [
    ...all.filter(r => r.feedId === feedId),
    ...all.filter(r => r.feedId === null),
  ];
}

export function describeRule(rule: YoutubeRule): string {
  const verb = rule.action === "reject" ? "Auto-rejected" : "Auto-approved";
  const how = rule.matchType === "regex" ? "matches /" + rule.pattern + "/i" : `contains "${rule.pattern}"`;
  return `${verb}: ${rule.field} ${how}`;
}
