import path from "node:path";
import os from "node:os";

export const LAUNCHD_LABEL = "com.dshteamhub.gateway";

export function launchdPlist({ home, node = process.execPath, entry }) {
  const log = path.join(home, "logs", "service.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${entry}</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>DSH_TEAM_HUB_HOME</key><string>${home}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>`;
}

export function launchdPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", LAUNCHD_LABEL + ".plist");
}
