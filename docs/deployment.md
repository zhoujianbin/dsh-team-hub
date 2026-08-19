# Deployment

## Recommended layout

Run DSH and dsh-team-hub on the same machine:

```text
team browsers → dsh-team-hub :3090 → DSH 127.0.0.1:3080
```

Keep DSH bound to loopback. Only the gateway listens on the LAN interface.

## macOS service

```bash
dsh-team-hub service install
launchctl load ~/Library/LaunchAgents/com.dshteamhub.gateway.plist
```

Check status:

```bash
launchctl list | grep dshteamhub
```

## Linux systemd user service

```bash
dsh-team-hub service install
systemctl --user enable --now dsh-team-hub.service
```

Check status:

```bash
systemctl --user status dsh-team-hub.service
```

## Proxy note

If team members use proxy software such as Clash/Surge, ensure the server LAN IP or subnet is in the direct/bypass list. A stale HTTP proxy can make pages load but WebSockets fail.

## Firewall

Only expose the gateway port to the team subnet. Do not expose DSH's loopback port.
