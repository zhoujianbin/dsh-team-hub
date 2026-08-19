import path from "node:path";
import os from "node:os";

export const SYSTEMD_UNIT = "dsh-team-hub.service";

export function systemdUnit({ home, node = process.execPath, entry }) {
  return `[Unit]
Description=dsh-team-hub gateway
After=network.target

[Service]
Type=simple
Environment=DSH_TEAM_HUB_HOME=${home}
ExecStart=${node} ${entry} start
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function systemdPath() {
  return path.join(os.homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
}
