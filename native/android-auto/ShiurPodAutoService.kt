package expo.modules.audio.service

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.LibraryResult
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.ListeningExecutorService
import com.google.common.util.concurrent.MoreExecutors
import com.google.common.util.concurrent.SettableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.URL
import java.net.URLEncoder
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

@OptIn(UnstableApi::class)
class ShiurPodAutoService : MediaLibraryService() {

  private var librarySession: MediaLibrarySession? = null
  private var placeholderPlayer: ExoPlayer? = null
  private val ioExecutor: ListeningExecutorService = MoreExecutors.listeningDecorator(Executors.newFixedThreadPool(4))
  private val cachedTree: ConcurrentHashMap<String, List<MediaItem>> = ConcurrentHashMap()
  private val cacheTimestamps: ConcurrentHashMap<String, Long> = ConcurrentHashMap()
  private val feedMetadataCache: ConcurrentHashMap<String, JSONObject> = ConcurrentHashMap()
  // Cache positions keyed by episodeId for resume support
  private val positionCache: ConcurrentHashMap<String, Long> = ConcurrentHashMap()
  // Cache downloaded artwork bytes keyed by URL (max ~200 entries to bound memory)
  private val artworkCache: ConcurrentHashMap<String, ByteArray?> = ConcurrentHashMap()
  private var cacheTimestamp: Long = 0
  private val CACHE_TTL_MS = 5 * 60 * 1000L
  private val RECENTLY_PLAYED_TTL_MS = 60 * 1000L // 1 min for recently played
  private val PLACEHOLDER_TIMEOUT_MS = 30_000L
  private lateinit var apiBaseUrl: String
  private lateinit var defaultArtworkUri: android.net.Uri
  private val mainHandler = Handler(Looper.getMainLooper())
  private var placeholderTimeoutRunnable: Runnable? = null

  companion object {
    private const val TAG = "ShiurPodAuto"
    private const val ROOT_ID = "shiurpod_root"
    private const val RECENTLY_PLAYED_ID = "recently_played"
    private const val MY_SHIURIM_ID = "my_shiurim"
    private const val POPULAR_ID = "popular"
    private const val CATEGORIES_ID = "categories"
    private const val CATEGORY_PREFIX = "category_"
    private const val DEFAULT_API_BASE_URL = "https://kosher-feed-production.up.railway.app"

    private const val CONTENT_STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"
    private const val CONTENT_STYLE_BROWSABLE_HINT = "android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"
    private const val CONTENT_STYLE_PLAYABLE_HINT = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"
    private const val CONTENT_STYLE_LIST_ITEM_HINT_VALUE = 1
    private const val CONTENT_STYLE_GRID_ITEM_HINT_VALUE = 2

    @Volatile
    private var instance: ShiurPodAutoService? = null

    fun onRealSessionAvailable(player: Player) {
      instance?.swapToRealPlayer(player)
    }
  }

  override fun onCreate() {
    super.onCreate()
    instance = this

    apiBaseUrl = try {
      val appInfo = packageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
      appInfo.metaData?.getString("shiurpod_api_url") ?: DEFAULT_API_BASE_URL
    } catch (e: Exception) {
      Log.w(TAG, "Failed to read API URL from manifest, using default", e)
      DEFAULT_API_BASE_URL
    }

    // Default artwork: use hosted ShiurPod logo
    defaultArtworkUri = android.net.Uri.parse("$apiBaseUrl/api/images/icon.png")

    val player: Player = run {
      ExoPlayer.Builder(this)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .setUsage(C.USAGE_MEDIA)
            .build(),
          false
        )
        .setSeekForwardIncrementMs(30_000L)
        .setSeekBackIncrementMs(10_000L)
        .build()
        .also { placeholder ->
          placeholderPlayer = placeholder
          placeholderTimeoutRunnable = Runnable {
            if (placeholderPlayer != null) {
              Log.d(TAG, "Placeholder player timeout — releasing unused placeholder")
              placeholderPlayer?.release()
              placeholderPlayer = null
            }
          }
          mainHandler.postDelayed(placeholderTimeoutRunnable!!, PLACEHOLDER_TIMEOUT_MS)
        }
    }

    librarySession = MediaLibrarySession.Builder(this, player, LibraryCallback())
      .setId("shiurpod_auto_library")
      .build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? {
    return librarySession
  }

  private fun swapToRealPlayer(realPlayer: Player) {
    val session = librarySession ?: return
    if (placeholderPlayer != null) {
      placeholderTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
      placeholderTimeoutRunnable = null

      if (placeholderPlayer?.isPlaying == true) {
        placeholderPlayer?.stop()
      }
      session.player = realPlayer
      placeholderPlayer?.release()
      placeholderPlayer = null
      Log.d(TAG, "Swapped to real player from AudioControlsService")
    }
  }

  private fun readDeviceId(): String? {
    return try {
      val filesDir = applicationContext.filesDir
      val deviceIdFile = java.io.File(filesDir, "shiurpod_device_id.txt")
      if (deviceIdFile.exists()) {
        deviceIdFile.readText().trim()
      } else {
        Log.d(TAG, "Device ID file not found — user hasn't opened app yet")
        null
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to read device ID", e)
      null
    }
  }

  private fun fetchJson(urlString: String): String? {
    var conn: HttpURLConnection? = null
    return try {
      val url = URL(urlString)
      conn = url.openConnection() as HttpURLConnection
      conn.connectTimeout = 8000
      conn.readTimeout = 8000
      conn.requestMethod = "GET"
      conn.setRequestProperty("Accept", "application/json")

      if (conn.responseCode == 200) {
        val reader = BufferedReader(InputStreamReader(conn.inputStream))
        val response = reader.readText()
        reader.close()
        response
      } else {
        Log.w(TAG, "HTTP ${conn.responseCode} fetching $urlString")
        null
      }
    } catch (e: SocketTimeoutException) {
      Log.w(TAG, "Timeout fetching $urlString", e)
      null
    } catch (e: UnknownHostException) {
      Log.w(TAG, "No network fetching $urlString", e)
      null
    } catch (e: IOException) {
      Log.w(TAG, "IO error fetching $urlString", e)
      null
    } catch (e: Exception) {
      Log.e(TAG, "Unexpected error fetching $urlString", e)
      null
    } finally {
      conn?.disconnect()
    }
  }

  /**
   * Download an image URL and return PNG bytes scaled to max 400x400.
   * Returns null on failure. Results are cached in-memory.
   */
  private fun downloadArtwork(urlString: String): ByteArray? {
    artworkCache[urlString]?.let { return it }
    if (artworkCache.containsKey(urlString)) return null

    return try {
      val url = URL(urlString)
      val conn = url.openConnection() as HttpURLConnection
      conn.connectTimeout = 5000
      conn.readTimeout = 5000
      conn.instanceFollowRedirects = true
      conn.setRequestProperty("Accept", "image/*")

      if (conn.responseCode != 200) {
        Log.w(TAG, "Artwork HTTP ${conn.responseCode} for $urlString")
        artworkCache[urlString] = null
        return null
      }

      val raw = conn.inputStream.readBytes()
      conn.disconnect()

      val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(raw, 0, raw.size, opts)

      val maxDim = 400
      var sampleSize = 1
      while (opts.outWidth / sampleSize > maxDim || opts.outHeight / sampleSize > maxDim) {
        sampleSize *= 2
      }

      val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
      val bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size, decodeOpts)
      if (bitmap == null) {
        Log.w(TAG, "Failed to decode artwork from $urlString")
        artworkCache[urlString] = null
        return null
      }

      val baos = ByteArrayOutputStream()
      bitmap.compress(Bitmap.CompressFormat.PNG, 90, baos)
      bitmap.recycle()
      val bytes = baos.toByteArray()

      artworkCache[urlString] = bytes
      Log.d(TAG, "Cached artwork ${bytes.size} bytes for $urlString")
      bytes
    } catch (e: Exception) {
      Log.w(TAG, "Failed to download artwork $urlString", e)
      artworkCache[urlString] = null
      null
    }
  }

  /** Apply artwork to a MediaMetadata builder — downloads bytes for Android Auto compatibility */
  private fun applyArtwork(builder: MediaMetadata.Builder, imageUrl: String) {
    val url = imageUrl.ifEmpty { defaultArtworkUri.toString() }
    val bytes = downloadArtwork(url)
    if (bytes != null) {
      builder.setArtworkData(bytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
    }
    // Always set URI as fallback for non-Android-Auto clients
    builder.setArtworkUri(android.net.Uri.parse(url))
  }

  private fun isCacheValid(key: String): Boolean {
    val ts = cacheTimestamps[key] ?: return false
    val ttl = if (key == RECENTLY_PLAYED_ID) RECENTLY_PLAYED_TTL_MS else CACHE_TTL_MS
    return System.currentTimeMillis() - ts < ttl
  }

  private fun cacheItems(key: String, items: List<MediaItem>) {
    cachedTree[key] = items
    cacheTimestamps[key] = System.currentTimeMillis()
  }

  private fun parseDurationToMs(duration: String?): Long {
    if (duration.isNullOrBlank()) return 0L
    return try {
      val parts = duration.split(":").map { it.trim().toLong() }
      when (parts.size) {
        3 -> (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000
        2 -> (parts[0] * 60 + parts[1]) * 1000
        1 -> parts[0] * 1000
        else -> 0L
      }
    } catch (e: Exception) {
      0L
    }
  }

  private fun buildRootItems(): List<MediaItem> {
    val gridExtras = Bundle().apply {
      putBoolean(CONTENT_STYLE_SUPPORTED, true)
      putInt(CONTENT_STYLE_BROWSABLE_HINT, CONTENT_STYLE_GRID_ITEM_HINT_VALUE)
      putInt(CONTENT_STYLE_PLAYABLE_HINT, CONTENT_STYLE_LIST_ITEM_HINT_VALUE)
    }

    return listOf(
      MediaItem.Builder()
        .setMediaId(MY_SHIURIM_ID)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("My Shiurim")
            .setSubtitle("Your subscribed feeds")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .setExtras(gridExtras)
            .build()
        )
        .build(),
      MediaItem.Builder()
        .setMediaId(CATEGORIES_ID)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("Browse")
            .setSubtitle("Gemara, Halacha, Parsha & more")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .setExtras(gridExtras)
            .build()
        )
        .build(),
      MediaItem.Builder()
        .setMediaId(RECENTLY_PLAYED_ID)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("Recently Played")
            .setSubtitle("Continue where you left off")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .setExtras(gridExtras)
            .build()
        )
        .build(),
      MediaItem.Builder()
        .setMediaId(POPULAR_ID)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("Popular This Week")
            .setSubtitle("Trending shiurim")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .setExtras(gridExtras)
            .build()
        )
        .build()
    )
  }

  private fun parseFeedItems(feeds: JSONArray): List<MediaItem> {
    val items = mutableListOf<MediaItem>()
    for (i in 0 until feeds.length()) {
      val feed = feeds.getJSONObject(i)
      val feedId = feed.getString("id")
      val title = feed.optString("title", "Unknown Feed")
      val imageUrl = feed.optString("imageUrl", "")
      val author = feed.optString("author", "")

      feedMetadataCache[feedId] = feed

      val metadataBuilder = MediaMetadata.Builder()
        .setTitle(title)
        .setIsBrowsable(true)
        .setIsPlayable(false)
        .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST)

      if (author.isNotEmpty()) {
        metadataBuilder.setArtist(author)
        metadataBuilder.setSubtitle(author)
      }

      // Download artwork bytes for Android Auto compatibility
      applyArtwork(metadataBuilder, imageUrl)

      items.add(
        MediaItem.Builder()
          .setMediaId("feed_$feedId")
          .setMediaMetadata(metadataBuilder.build())
          .build()
      )
    }
    return items
  }

  private fun fetchSubscribedFeeds(): List<MediaItem> {
    val deviceId = readDeviceId() ?: return listOf(buildInfoItem("Open ShiurPod to set up"))
    val json = fetchJson("$apiBaseUrl/api/subscriptions/$deviceId/feeds")
      ?: return listOf(buildInfoItem("No connection"))

    return try {
      val feeds = JSONArray(json)
      if (feeds.length() == 0) return listOf(buildInfoItem("No subscriptions yet"))
      parseFeedItems(feeds)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to parse subscribed feeds", e)
      listOf(buildInfoItem("Error loading feeds"))
    }
  }

  private fun fetchAllFeeds(): List<MediaItem> {
    val json = fetchJson("$apiBaseUrl/api/feeds")
      ?: return listOf(buildInfoItem("No connection"))

    return try {
      val feeds = JSONArray(json)
      parseFeedItems(feeds)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to parse all feeds", e)
      listOf(buildInfoItem("Error loading feeds"))
    }
  }

  private fun fetchCategories(): List<MediaItem> {
    val json = fetchJson("$apiBaseUrl/api/categories")
      ?: return listOf(buildInfoItem("No connection"))

    return try {
      val cats = JSONArray(json)
      val items = mutableListOf<MediaItem>()
      for (i in 0 until cats.length()) {
        val cat = cats.getJSONObject(i)
        val catId = cat.getString("id")
        val name = cat.optString("name", "Unknown")

        val catMetadata = MediaMetadata.Builder()
            .setTitle(name)
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
        applyArtwork(catMetadata, "")

        items.add(
          MediaItem.Builder()
            .setMediaId("$CATEGORY_PREFIX$catId")
            .setMediaMetadata(catMetadata.build())
            .build()
        )
      }
      items
    } catch (e: Exception) {
      Log.e(TAG, "Failed to parse categories", e)
      listOf(buildInfoItem("Error loading categories"))
    }
  }

  private fun fetchFeedsByCategory(categoryId: String): List<MediaItem> {
    val json = fetchJson("$apiBaseUrl/api/feeds/category/$categoryId")
      ?: return listOf(buildInfoItem("No connection"))

    return try {
      val feeds = JSONArray(json)
      if (feeds.length() == 0) return listOf(buildInfoItem("No feeds in this category"))
      parseFeedItems(feeds)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to parse category feeds", e)
      listOf(buildInfoItem("Error loading feeds"))
    }
  }

  private fun fetchPopularEpisodes(): List<MediaItem> {
    val json = fetchJson("$apiBaseUrl/api/episodes/popular?limit=15")
      ?: return listOf(buildInfoItem("No connection"))

    return try {
      val episodes = JSONArray(json)
      val items = mutableListOf<MediaItem>()

      for (i in 0 until episodes.length()) {
        val ep = episodes.getJSONObject(i)
        val epId = ep.optString("episodeId", ep.optString("id", ""))
        val title = ep.optString("title", "Episode")
        val audioUrl = ep.optString("audioUrl", "")
        val feedId = ep.optString("feedId", "")
        val imageUrl = ep.optString("imageUrl", "")
        val duration = ep.optString("duration", "")
        val description = ep.optString("description", "")
        val listenCount = ep.optInt("listenCount", 0)

        if (audioUrl.isEmpty()) continue

        val durationMs = parseDurationToMs(duration)

        val speaker = description.ifEmpty { null }
        val subtitle = if (speaker != null) "$speaker · $listenCount listens" else "$listenCount listens this week"

        val metadataBuilder = MediaMetadata.Builder()
          .setTitle(title)
          .setArtist(speaker ?: "")
          .setSubtitle(subtitle)
          .setIsBrowsable(false)
          .setIsPlayable(true)
          .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
        applyArtwork(metadataBuilder, imageUrl)

        if (durationMs > 0) {
          metadataBuilder.setExtras(Bundle().apply {
            putLong("android.media.metadata.DURATION", durationMs)
          })
        }

        items.add(
          MediaItem.Builder()
            .setMediaId("episode_${feedId}_${epId}")
            .setMediaMetadata(metadataBuilder.build())
            .setRequestMetadata(
              MediaItem.RequestMetadata.Builder()
                .setMediaUri(android.net.Uri.parse(audioUrl))
                .build()
            )
            .build()
        )
      }

      items
    } catch (e: Exception) {
      Log.e(TAG, "Failed to parse popular episodes", e)
      listOf(buildInfoItem("Error loading popular"))
    }
  }

  private fun fetchRecentlyPlayed(): List<MediaItem> {
    val deviceId = readDeviceId() ?: return listOf(buildInfoItem("Open ShiurPod to set up"))
    val json = fetchJson("$apiBaseUrl/api/playback-positions/$deviceId/recent?limit=15")
      ?: return listOf(buildInfoItem("No connection"))

    return try {
      val entries = JSONArray(json)
      if (entries.length() == 0) return listOf(buildInfoItem("No recent shiurim"))
      val items = mutableListOf<MediaItem>()

      for (i in 0 until entries.length()) {
        val entry = entries.getJSONObject(i)
        val epId = entry.optString("episodeId", "")
        val feedId = entry.optString("feedId", "")
        val title = entry.optString("episodeTitle", "Episode")
        val audioUrl = entry.optString("audioUrl", "")
        val feedTitle = entry.optString("feedTitle", "")
        val feedAuthor = entry.optString("feedAuthor", "")
        val positionMs = entry.optLong("positionMs", 0)
        val durationMs = entry.optLong("durationMs", 0)
        val episodeImageUrl = entry.optString("episodeImageUrl", "")
        val feedImageUrl = entry.optString("feedImageUrl", "")

        if (audioUrl.isEmpty()) continue

        // Cache position for resume support
        positionCache[epId] = positionMs

        val artworkUrl = when {
          episodeImageUrl.isNotEmpty() -> episodeImageUrl
          feedImageUrl.isNotEmpty() -> feedImageUrl
          else -> ""
        }

        // Show progress in subtitle
        val progressPercent = if (durationMs > 0) (positionMs * 100 / durationMs).toInt() else 0
        val subtitle = when {
          feedAuthor.isNotEmpty() -> "$feedAuthor · ${progressPercent}% played"
          feedTitle.isNotEmpty() -> "$feedTitle · ${progressPercent}% played"
          else -> "${progressPercent}% played"
        }

        val metadataBuilder = MediaMetadata.Builder()
          .setTitle(title)
          .setArtist(feedAuthor.ifEmpty { feedTitle })
          .setAlbumTitle(feedTitle)
          .setSubtitle(subtitle)
          .setIsBrowsable(false)
          .setIsPlayable(true)
          .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
        applyArtwork(metadataBuilder, artworkUrl)

        if (durationMs > 0) {
          metadataBuilder.setExtras(Bundle().apply {
            putLong("android.media.metadata.DURATION", durationMs)
          })
        }

        items.add(
          MediaItem.Builder()
            .setMediaId("episode_${feedId}_${epId}")
            .setMediaMetadata(metadataBuilder.build())
            .setRequestMetadata(
              MediaItem.RequestMetadata.Builder()
                .setMediaUri(android.net.Uri.parse(audioUrl))
                .build()
            )
            .build()
        )
      }

      items
    } catch (e: Exception) {
      Log.e(TAG, "Failed to parse recently played", e)
      listOf(buildInfoItem("Error loading recent"))
    }
  }

  private fun fetchEpisodes(feedId: String): List<MediaItem> {
    val json = fetchJson("$apiBaseUrl/api/feeds/$feedId/episodes?limit=15&slim=1")
      ?: return listOf(buildInfoItem("No connection"))

    val feedMeta = feedMetadataCache[feedId]
    val feedTitle = feedMeta?.optString("title", "ShiurPod") ?: "ShiurPod"
    val feedImageUrl = feedMeta?.optString("imageUrl", "") ?: ""
    val feedAuthor = feedMeta?.optString("author", "") ?: ""

    return try {
      val episodes = JSONArray(json)
      val items = mutableListOf<MediaItem>()

      for (i in 0 until episodes.length()) {
        val ep = episodes.getJSONObject(i)
        val epId = ep.getString("id")
        val title = ep.optString("title", "Episode")
        val audioUrl = ep.optString("audioUrl", "")
        val duration = ep.optString("duration", "")
        val publishedAt = ep.optString("publishedAt", "")
        val episodeImageUrl = ep.optString("imageUrl", "")

        if (audioUrl.isEmpty()) continue

        val durationMs = parseDurationToMs(duration)

        val artworkUrl = when {
          episodeImageUrl.isNotEmpty() -> episodeImageUrl
          feedImageUrl.isNotEmpty() -> feedImageUrl
          else -> ""
        }

        val subtitle = when {
          feedAuthor.isNotEmpty() && publishedAt.isNotEmpty() -> {
            val dateStr = publishedAt.take(10)
            "$feedAuthor · $dateStr"
          }
          feedAuthor.isNotEmpty() -> feedAuthor
          publishedAt.isNotEmpty() -> publishedAt.take(10)
          else -> feedTitle
        }

        val metadataBuilder = MediaMetadata.Builder()
          .setTitle(title)
          .setArtist(feedAuthor.ifEmpty { feedTitle })
          .setAlbumTitle(feedTitle)
          .setSubtitle(subtitle)
          .setIsBrowsable(false)
          .setIsPlayable(true)
          .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
        applyArtwork(metadataBuilder, artworkUrl)

        if (durationMs > 0) {
          metadataBuilder.setExtras(Bundle().apply {
            putLong("android.media.metadata.DURATION", durationMs)
          })
        }

        items.add(
          MediaItem.Builder()
            .setMediaId("episode_${feedId}_${epId}")
            .setMediaMetadata(metadataBuilder.build())
            .setRequestMetadata(
              MediaItem.RequestMetadata.Builder()
                .setMediaUri(android.net.Uri.parse(audioUrl))
                .build()
            )
            .build()
        )
      }

      items
    } catch (e: Exception) {
      Log.e(TAG, "Failed to parse episodes for feed $feedId", e)
      listOf(buildInfoItem("Error loading episodes"))
    }
  }

  private fun searchFeeds(query: String): List<MediaItem> {
    val encoded = URLEncoder.encode(query, "UTF-8")
    val json = fetchJson("$apiBaseUrl/api/feeds/search?q=$encoded&limit=15")
      ?: return listOf(buildInfoItem("No connection"))

    return try {
      val feeds = JSONArray(json)
      if (feeds.length() == 0) return listOf(buildInfoItem("No results for \"$query\""))
      parseFeedItems(feeds)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to parse search results", e)
      listOf(buildInfoItem("Search error"))
    }
  }

  private fun buildInfoItem(message: String): MediaItem {
    return MediaItem.Builder()
      .setMediaId("info_${System.currentTimeMillis()}")
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(message)
          .setIsBrowsable(false)
          .setIsPlayable(false)
          .build()
      )
      .build()
  }

  inner class LibraryCallback : MediaLibrarySession.Callback {
    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val rootExtras = Bundle().apply {
        putBoolean(CONTENT_STYLE_SUPPORTED, true)
        putInt(CONTENT_STYLE_BROWSABLE_HINT, CONTENT_STYLE_GRID_ITEM_HINT_VALUE)
        putInt(CONTENT_STYLE_PLAYABLE_HINT, CONTENT_STYLE_LIST_ITEM_HINT_VALUE)
      }

      val root = MediaItem.Builder()
        .setMediaId(ROOT_ID)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("ShiurPod")
            .setSubtitle("Torah audio on the go")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .setExtras(rootExtras)
            .build()
        )
        .build()

      val rootParams = LibraryParams.Builder().setExtras(rootExtras).build()
      return Futures.immediateFuture(LibraryResult.ofItem(root, rootParams))
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val future = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
      ioExecutor.execute {
        try {
          // Check per-key cache
          if (isCacheValid(parentId)) {
            val cached = cachedTree[parentId]
            if (cached != null) {
              future.set(LibraryResult.ofItemList(ImmutableList.copyOf(cached), params))
              return@execute
            }
          }

          val children = when (parentId) {
            ROOT_ID -> buildRootItems()
            RECENTLY_PLAYED_ID -> fetchRecentlyPlayed()
            MY_SHIURIM_ID -> fetchSubscribedFeeds()
            POPULAR_ID -> fetchPopularEpisodes()
            CATEGORIES_ID -> fetchCategories()
            else -> {
              when {
                parentId.startsWith(CATEGORY_PREFIX) -> {
                  val categoryId = parentId.removePrefix(CATEGORY_PREFIX)
                  fetchFeedsByCategory(categoryId)
                }
                parentId.startsWith("feed_") -> {
                  val feedId = parentId.removePrefix("feed_")
                  fetchEpisodes(feedId)
                }
                else -> emptyList()
              }
            }
          }

          cacheItems(parentId, children)
          future.set(LibraryResult.ofItemList(ImmutableList.copyOf(children), params))
        } catch (e: Exception) {
          Log.e(TAG, "Error getting children for $parentId", e)
          val errorCode = when (e) {
            is SocketTimeoutException -> LibraryResult.RESULT_ERROR_IO
            is UnknownHostException -> LibraryResult.RESULT_ERROR_IO
            is IOException -> LibraryResult.RESULT_ERROR_IO
            else -> LibraryResult.RESULT_ERROR_UNKNOWN
          }
          future.set(LibraryResult.ofError(errorCode))
        }
      }
      return future
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String
    ): ListenableFuture<LibraryResult<MediaItem>> {
      for ((_, items) in cachedTree) {
        val item = items.find { it.mediaId == mediaId }
        if (item != null) {
          return Futures.immediateFuture(LibraryResult.ofItem(item, null))
        }
      }
      return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
    }

    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<Void>> {
      // Kick off search in background, results returned via onGetSearchResult
      ioExecutor.execute {
        val results = searchFeeds(query)
        cacheItems("search_$query", results)
        session.notifySearchResultChanged(browser, query, results.size, params)
      }
      return Futures.immediateFuture(LibraryResult.ofVoid())
    }

    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val future = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
      ioExecutor.execute {
        val cacheKey = "search_$query"
        val cached = cachedTree[cacheKey]
        val results = cached ?: searchFeeds(query).also { cacheItems(cacheKey, it) }
        future.set(LibraryResult.ofItemList(ImmutableList.copyOf(results), params))
      }
      return future
    }

    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>
    ): ListenableFuture<MutableList<MediaItem>> {
      val future = SettableFuture.create<MutableList<MediaItem>>()
      ioExecutor.execute {
        val resolved = mediaItems.map { item ->
          val uri = item.requestMetadata.mediaUri
          if (uri != null) {
            MediaItem.Builder()
              .setMediaId(item.mediaId)
              .setUri(uri)
              .setMediaMetadata(item.mediaMetadata)
              .setRequestMetadata(item.requestMetadata)
              .build()
          } else {
            var resolvedItem = item
            for ((_, items) in cachedTree) {
              val cached = items.find { it.mediaId == item.mediaId }
              if (cached?.requestMetadata?.mediaUri != null) {
                resolvedItem = MediaItem.Builder()
                  .setMediaId(item.mediaId)
                  .setUri(cached.requestMetadata.mediaUri)
                  .setMediaMetadata(item.mediaMetadata)
                  .setRequestMetadata(item.requestMetadata)
                  .build()
                break
              }
            }
            resolvedItem
          }
        }.toMutableList()

        future.set(resolved)

        // Resume from saved position after player prepares
        if (resolved.isNotEmpty()) {
          val firstItem = resolved[0]
          val episodeId = firstItem.mediaId.split("_").lastOrNull() ?: ""
          val savedPosition = positionCache[episodeId]

          if (savedPosition != null && savedPosition > 0) {
            // Fetch position from server if not cached, otherwise use cached
            mainHandler.postDelayed({
              val player = mediaSession.player
              if (player.playbackState == Player.STATE_READY || player.playbackState == Player.STATE_BUFFERING) {
                val duration = player.duration
                // Don't resume if >95% complete — start from beginning
                if (duration > 0 && savedPosition < duration * 95 / 100) {
                  player.seekTo(savedPosition)
                  Log.d(TAG, "Resumed playback at ${savedPosition}ms")
                }
              }
            }, 1000) // Delay to let player prepare
          } else if (episodeId.isNotEmpty()) {
            // Try fetching position from server
            ioExecutor.execute {
              val deviceId = readDeviceId() ?: return@execute
              val posJson = fetchJson("$apiBaseUrl/api/positions/$deviceId/$episodeId")
              if (posJson != null) {
                try {
                  val pos = JSONObject(posJson)
                  val posMs = pos.optLong("positionMs", 0)
                  val durMs = pos.optLong("durationMs", 0)
                  val completed = pos.optBoolean("completed", false)
                  if (posMs > 0 && !completed && (durMs == 0L || posMs < durMs * 95 / 100)) {
                    positionCache[episodeId] = posMs
                    mainHandler.postDelayed({
                      val player = mediaSession.player
                      if (player.playbackState == Player.STATE_READY || player.playbackState == Player.STATE_BUFFERING) {
                        player.seekTo(posMs)
                        Log.d(TAG, "Resumed playback from server position at ${posMs}ms")
                      }
                    }, 1500)
                  }
                } catch (e: Exception) {
                  Log.w(TAG, "Failed to parse position for $episodeId", e)
                }
              }
            }
          }
        }
      }
      return future
    }
  }

  override fun onDestroy() {
    instance = null
    placeholderTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
    placeholderTimeoutRunnable = null
    librarySession?.let { it.release() }
    librarySession = null
    placeholderPlayer?.let { it.release() }
    placeholderPlayer = null
    ioExecutor.shutdown()
    super<MediaLibraryService>.onDestroy()
  }
}
