# Admin console

URL: `/admin`

## Overview

Shows the configured DSH upstream, user count, workspace count, session count, and recent audit events.

## Users

Admins can:

- Create an admin or member
- Disable a member without deleting history
- Re-enable a disabled user
- Reset a password and force a first-login change

The last active admin cannot be disabled.

## Workspaces

Shows learned DSH workspace IDs and their owners. Member workspace directories are named after usernames by default.

## Audit

Shows recent structured audit events. Use this to investigate:

- Failed logins
- Policy denials
- Allowed privileged operations
- Admin user changes
- Compatibility failures

## System

Shows runtime status and runs the DSH compatibility self-test.
