const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

function stripProtocol(domain) {
  let urlString = domain.trim();

  if (!/^https?:\/\//i.test(urlString)) {
    urlString = `https://${urlString}`;
  }

  return new URL(urlString).host;
}

function getDeploymentDomain() {
  if (process.env.EXPO_PUBLIC_DOMAIN) {
    return stripProtocol(process.env.EXPO_PUBLIC_DOMAIN);
  }

  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return stripProtocol(process.env.RAILWAY_PUBLIC_DOMAIN);
  }

  if (process.env.DEPLOY_DOMAIN) {
    return stripProtocol(process.env.DEPLOY_DOMAIN);
  }

  console.error(
    "ERROR: No deployment domain found. Set EXPO_PUBLIC_DOMAIN, RAILWAY_PUBLIC_DOMAIN, or DEPLOY_DOMAIN",
  );
  process.exit(1);
}

function runCommand(cmd, args, env) {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${cmd} ${args.join(" ")}`);
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      const output = data.toString().trim();
      stdout += data.toString();
      if (output) console.log(`  ${output}`);
    });

    proc.stderr.on("data", (data) => {
      const output = data.toString().trim();
      stderr += data.toString();
      if (output) console.error(`  ${output}`);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
  });
}

function prepareDirectories(timestamp) {
  console.log("Preparing build directories...");

  if (fs.existsSync("static-build")) {
    fs.rmSync("static-build", { recursive: true });
  }

  const dirs = [
    path.join("static-build", timestamp, "_expo", "static", "js", "ios"),
    path.join("static-build", timestamp, "_expo", "static", "js", "android"),
    path.join("static-build", timestamp, "_expo", "static", "js", "assets"),
    path.join("static-build", "ios"),
    path.join("static-build", "android"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  console.log("Build:", timestamp);
}

function findBundle(exportDir, platform) {
  // expo export puts bundles at _expo/static/js/{platform}/entry-{hash}.hbc
  const jsDir = path.join(exportDir, "_expo", "static", "js", platform);
  if (fs.existsSync(jsDir)) {
    const files = fs.readdirSync(jsDir).filter(
      (f) => f.endsWith(".hbc") || f.endsWith(".js"),
    );
    if (files.length > 0) {
      return path.join(jsDir, files[0]);
    }
  }
  return null;
}

function buildExpoGoManifest(platform, timestamp, baseUrl, appJson, assets) {
  const expoConfig = appJson.expo;

  let runtimeVersion = "exposdk:54.0.0";
  try {
    const expoPkg = JSON.parse(
      fs.readFileSync("node_modules/expo/package.json", "utf-8"),
    );
    runtimeVersion = `exposdk:${expoPkg.version}`;
  } catch {
    console.warn("Could not read expo version, using default runtime version");
  }

  const manifest = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion,
    launchAsset: {
      url: `${baseUrl}/${timestamp}/_expo/static/js/${platform}/bundle.js`,
      key: `bundle-${timestamp}`,
      contentType: "application/javascript",
    },
    assets: assets.map((asset) => {
      const extToMime = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        ttf: "font/ttf",
        otf: "font/otf",
        woff: "font/woff",
        woff2: "font/woff2",
        svg: "image/svg+xml",
        mp3: "audio/mpeg",
        wav: "audio/wav",
      };

      return {
        url: `${baseUrl}/${timestamp}/_expo/static/js/assets/${asset.hash}`,
        key: asset.hash,
        hash: asset.hash,
        contentType: extToMime[asset.ext] || "application/octet-stream",
      };
    }),
    extra: {
      expoClient: {
        ...expoConfig,
        hostUri: baseUrl.replace("https://", "") + "/" + platform,
      },
      expoGo: {
        debuggerHost: baseUrl.replace("https://", "") + "/" + platform,
        developer: { tool: "expo-cli" },
        packagerOpts: { dev: false },
        mainModuleName: "node_modules/expo-router/entry",
      },
    },
  };

  return manifest;
}

async function main() {
  console.log("Building static Expo deployment...");

  const domain = getDeploymentDomain();
  const baseUrl = `https://${domain}`;
  const timestamp = `${Date.now()}-${process.pid}`;
  const env = { EXPO_PUBLIC_DOMAIN: domain };
  const nativeDir = "dist-native";

  prepareDirectories(timestamp);

  // Clean previous exports
  for (const dir of [nativeDir, "dist"]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
  }

  // Step 1: Export native bundles (iOS + Android) using expo export
  // This runs Metro internally in a single pass — much faster than starting a server
  console.log("Exporting iOS and Android bundles...");
  await runCommand(
    "npx",
    ["expo", "export", "--platform", "ios", "--platform", "android", "--output-dir", nativeDir],
    env,
  );

  // Step 2: Read metadata to understand the export output
  const metadataPath = path.join(nativeDir, "metadata.json");
  if (!fs.existsSync(metadataPath)) {
    exitWithError("Export did not produce metadata.json");
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));

  // Step 3: Copy bundles to static-build
  for (const platform of ["ios", "android"]) {
    const bundleSrc = findBundle(nativeDir, platform);
    if (!bundleSrc) {
      exitWithError(`Could not find ${platform} bundle in export output`);
    }

    const bundleDest = path.join(
      "static-build",
      timestamp,
      "_expo",
      "static",
      "js",
      platform,
      "bundle.js",
    );

    fs.copyFileSync(bundleSrc, bundleDest);
    const size = (fs.statSync(bundleDest).size / 1024).toFixed(1);
    console.log(`${platform} bundle copied (${size} KB)`);
  }

  // Step 4: Copy assets and collect asset info for manifests
  console.log("Copying assets...");
  const assetsDir = path.join(nativeDir, "assets");
  const uniqueAssets = new Map();

  // Use metadata to get proper asset info (hash + extension)
  for (const platform of ["ios", "android"]) {
    const platformMeta = metadata.fileMetadata?.[platform];
    if (!platformMeta?.assets) continue;

    for (const asset of platformMeta.assets) {
      // asset.path is like "assets/{hash}", asset.ext is the file extension
      const hash = path.basename(asset.path);
      if (!uniqueAssets.has(hash)) {
        uniqueAssets.set(hash, { hash, ext: asset.ext });
      }
    }
  }

  // Copy all asset files
  const destAssetsDir = path.join(
    "static-build",
    timestamp,
    "_expo",
    "static",
    "js",
    "assets",
  );

  if (fs.existsSync(assetsDir)) {
    const assetFiles = fs.readdirSync(assetsDir);
    for (const file of assetFiles) {
      const srcPath = path.join(assetsDir, file);
      if (fs.statSync(srcPath).isFile()) {
        fs.copyFileSync(srcPath, path.join(destAssetsDir, file));
      }
    }
    console.log(`Copied ${assetFiles.length} assets`);
  }

  // Step 5: Generate Expo Go manifests
  console.log("Generating Expo Go manifests...");
  const appJson = JSON.parse(fs.readFileSync("app.json", "utf-8"));
  const assetsList = Array.from(uniqueAssets.values());

  for (const platform of ["ios", "android"]) {
    const manifest = buildExpoGoManifest(
      platform,
      timestamp,
      baseUrl,
      appJson,
      assetsList,
    );

    fs.writeFileSync(
      path.join("static-build", platform, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    console.log(`${platform} manifest generated`);
  }

  // Step 6: Export web build
  console.log("Exporting web build...");
  if (fs.existsSync("dist")) {
    fs.rmSync("dist", { recursive: true });
  }

  await runCommand("npx", ["expo", "export", "--platform", "web"], env);

  const distDir = path.resolve("dist");
  const webappDir = path.join("static-build", "webapp");
  if (fs.existsSync(distDir)) {
    console.log("Copying web export to static-build/webapp...");
    fs.cpSync(distDir, webappDir, { recursive: true });
    console.log("Web export copied");
  }

  // Clean up temp native export
  if (fs.existsSync(nativeDir)) {
    fs.rmSync(nativeDir, { recursive: true });
  }

  console.log("Build complete! Deploy to:", baseUrl);
  process.exit(0);
}

main().catch((error) => {
  console.error("Build failed:", error.message);
  process.exit(1);
});
