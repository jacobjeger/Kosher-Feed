import React from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router } from "expo-router";
import EpisodeItem from "@/components/EpisodeItem";
import { lightHaptic } from "@/lib/haptics";
import type { Feed, Episode } from "@/lib/types";

interface SearchSectionProps {
  searchQuery: string;
  searchResults: Feed[];
  searchedEpisodes: Episode[];
  speakerSearchResults: { author: string; feeds: Feed[] }[];
  isSearchLoading: boolean;
  allFeeds: Feed[];
  colors: any;
  isOnline: boolean;
}

const SearchResultItem = React.memo(function SearchResultItem({ feed, colors }: { feed: Feed; colors: any }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.searchResult,
        { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.9 : 1 },
      ]}
      onPress={() => { lightHaptic(); router.push(`/podcast/${feed.id}`); }}
    >
      {feed.imageUrl ? (
        <Image source={{ uri: feed.imageUrl }} style={styles.searchResultImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
      ) : (
        <View style={[styles.searchResultImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
          <Ionicons name="mic" size={20} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.searchResultInfo}>
        <Text style={[styles.searchResultTitle, { color: colors.text }]} numberOfLines={1}>
          {feed.title}
        </Text>
        {feed.author && (
          <Text style={[styles.searchResultAuthor, { color: colors.textSecondary }]} numberOfLines={1}>
            {feed.author}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
    </Pressable>
  );
});

export default React.memo(function SearchSection({ searchQuery, searchResults, searchedEpisodes, speakerSearchResults, isSearchLoading, allFeeds, colors, isOnline }: SearchSectionProps) {
  if (searchResults.length === 0 && searchedEpisodes.length === 0 && speakerSearchResults.length === 0 && searchQuery.trim().length >= 3 && !isSearchLoading) {
    return (
      <View style={styles.searchResultsSection}>
        <View style={styles.noResults}>
          <Ionicons name="search-outline" size={40} color={colors.textSecondary} />
          <Text style={[styles.noResultsText, { color: colors.textSecondary }]}>
            No results found for &quot;{searchQuery}&quot;
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.searchResultsSection}>
      {speakerSearchResults.length > 0 && (
        <>
          <Text style={[styles.searchSectionLabel, { color: colors.textSecondary }]}>Maggidei Shiur</Text>
          <View style={{ paddingHorizontal: 20 }}>
            {speakerSearchResults.map((speaker) => (
              <Pressable
                key={speaker.author}
                style={({ pressed }) => [
                  styles.searchResult,
                  { backgroundColor: colors.card, borderColor: colors.cardBorder, opacity: pressed ? 0.9 : 1 },
                ]}
                onPress={() => { lightHaptic(); router.push({ pathname: "/maggid-shiur/[author]" as any, params: { author: speaker.author, feedIds: speaker.feeds.map((f: Feed) => f.id).join(",") } }); }}
              >
                {speaker.feeds[0]?.imageUrl ? (
                  <Image source={{ uri: speaker.feeds[0].imageUrl }} style={styles.searchResultImage} contentFit="cover" cachePolicy="memory-disk" transition={0} />
                ) : (
                  <View style={[styles.searchResultImage, { backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }]}>
                    <Ionicons name="person" size={20} color={colors.textSecondary} />
                  </View>
                )}
                <View style={styles.searchResultInfo}>
                  <Text style={[styles.searchResultTitle, { color: colors.text }]} numberOfLines={1}>
                    {speaker.author}
                  </Text>
                  <Text style={[styles.searchResultAuthor, { color: colors.textSecondary }]} numberOfLines={1}>
                    {speaker.feeds.length} {speaker.feeds.length === 1 ? "shiur" : "shiurim"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
              </Pressable>
            ))}
          </View>
        </>
      )}
      {searchResults.length > 0 && (
        <>
          <Text style={[styles.searchSectionLabel, { color: colors.textSecondary }]}>Shiurim</Text>
          <View style={{ paddingHorizontal: 20 }}>
            {searchResults.map((feed) => (
              <SearchResultItem key={feed.id} feed={feed} colors={colors} />
            ))}
          </View>
        </>
      )}
      {searchedEpisodes.length > 0 && (
        <>
          <Text style={[styles.searchSectionLabel, { color: colors.textSecondary }]}>Episodes</Text>
          <View style={{ paddingHorizontal: 16 }}>
            {searchedEpisodes.map((ep) => {
              const epFeed = allFeeds.find(f => f.id === ep.feedId);
              if (!epFeed) return null;
              return <EpisodeItem key={ep.id} episode={ep} feed={epFeed} showFeedTitle isOnline={isOnline} />;
            })}
          </View>
        </>
      )}
      {searchQuery.trim().length < 3 && searchResults.length === 0 && speakerSearchResults.length === 0 && (
        <View style={styles.noResults}>
          <Text style={[styles.noResultsText, { color: colors.textSecondary }]}>
            Type 3+ characters to search episodes
          </Text>
        </View>
      )}
      {isSearchLoading && (
        <ActivityIndicator size="small" color={colors.accent} style={{ marginTop: 12 }} />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  searchResultsSection: {
    paddingTop: 4,
    paddingBottom: 20,
  },
  searchSectionLabel: {
    fontSize: 13,
    fontWeight: "600" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  searchResult: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 10,
    paddingRight: 14,
  },
  searchResultImage: {
    width: 56,
    height: 56,
    borderRadius: 12,
    marginLeft: 12,
    marginVertical: 10,
  },
  searchResultInfo: {
    flex: 1,
    paddingHorizontal: 14,
    gap: 2,
  },
  searchResultTitle: {
    fontSize: 15,
    fontWeight: "600" as const,
  },
  searchResultAuthor: {
    fontSize: 12,
  },
  noResults: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
    gap: 12,
  },
  noResultsText: {
    fontSize: 14,
    textAlign: "center",
  },
});
