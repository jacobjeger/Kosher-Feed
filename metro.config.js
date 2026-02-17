const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "shaka-player/dist/shaka-player.ui": path.resolve(__dirname, "lib/mocks/shaka-player-ui.js"),
};

module.exports = config;
