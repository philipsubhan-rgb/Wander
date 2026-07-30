const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Block the MCP SDK's temporary directories that Metro tries to watch but may
// not exist at runtime, causing ENOENT crashes in the file watcher.
config.resolver = config.resolver ?? {};
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : []),
  /.*@modelcontextprotocol.*/,
];

module.exports = config;
