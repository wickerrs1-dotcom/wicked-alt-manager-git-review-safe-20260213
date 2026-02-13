# Wicked Alt Manager (v2.0.1)

**Minecraft:** 1.8.9 | **Protocol:** minecraft-protocol | **Auth:** Microsoft Device Code | **License:** MIT

## Overview

Production-grade 24/7 alt pool manager for competitive factions:
- **20 slots** across 2 servers (A & B), or force all alts to one server via config
- Safe connection queue + smart reconnect backoff
- Discord remote control with role-gating
- Per-alt detailed logging
- **Zero errors, fully optimized**

## Quick Start

### Prerequisites
- **Node.js 20 LTS+** ([download](https://nodejs.org/))

### Step 1: Configure Discord Token
Preferred (more secure): put token in a separate text file and point to it from `.env`:
```env
DISCORD_TOKEN_FILE=secrets/discord_token.txt
```

Or set token directly in `.env`:
```env
DISCORD_TOKEN=your_bot_token_here
```
Get token: https://discord.com/developers/applications

### Step 2: Configure Accounts
Edit `accounts.json`:
```json
{
	"alts": [
		{ "email": "account_one", "enabled": true, "server": "A" },
		{ "email": "account_two", "enabled": false, "server": "B" }
	]
}
```

- Keep all accounts in the file
- Toggle `enabled` true/false per alt
- Choose preferred server with `server: "A" | "B"`

Edit `config.json` to control server mode:
```json
"servers": {
	"A": { "enabled": true, "host": "example-a.server.invalid", "port": 25565, "joinCommand": "/server factions" },
	"B": { "enabled": true, "host": "example-b.server.invalid", "port": 25565, "joinCommand": "/factions" }
}
```
- If only one server is enabled, all alts run on that server.
- If both are enabled, alts are split evenly.

### Step 3: Choose Startup Method

**Dev/Test:**
```
run.bat
```
Single run, good for testing.

**Simple Deployment (Recommended):**
```
run_forever.bat
```
Auto-restarts if bot crashes. Works on any Windows PC.

**Production (PM2):**
```
pm2-run.bat
```
Professional process manager. Check: `pm2 status`

## Discord Commands

Type in control channel (prefix: `.alts`):

```
.alts                          # Help
.alts list                     # Show all alts
.alts status <all|ign|slot#>
.alts perms                    # Show role capabilities
.alts health                   # Live bot/session health summary
.alts examples                 # Command examples
.alts say <ign> <message>       # ign can be: all | A | B | ign | slot#
.alts cmd <ign> </command>      # ign can be: all | A | B | ign | slot#
.alts tpyes [target]
.alts fhome [target]
.alts ftop [target]
.alts fshow [target]
.alts spawn [target]
.alts home [target]
.alts bal [target]
.alts start <all|A|B|ign|slot#>
.alts stop <all|A|B|ign|slot#>
.alts restart <all|A|B|ign|slot#>
.alts enable <all|A|B|ign|slot#>    # OP-only
.alts disable <all|A|B|ign|slot#>   # OP-only
.alts watch <status|chat|all> <on|off>  # Fine-grained watch control
.alts move <target> <A|B>
.alts balance                  # Auto-balance servers
.alts hold                     # Pause reconnects
.alts resume                   # Resume reconnects
.alts kill                     # Emergency stop
```

Access model:
- Grand Master user ID `798280002004582410`: full control
- Control role ID from `DISCORD_CONTROL_ROLE_ID`: safe limited command set

## First-Time Microsoft Auth

Each alt needs auth on first launch:
- Bot shows device code in logs
- Go to https://microsoft.com/devicelogin
- Enter the code
- Tokens auto-save to `state/auth-cache/`
- Restarts are automatic after that

## File Layout

```
├── accounts.json       # Alt list + enabled/server flags
├── config.json         # Server hosts, join commands, timing/backoff
├── .env               # Discord token (created automatically)
├── run.bat            # Dev: single run
├── run_forever.bat    # Simple: auto-restart
├── pm2-run.bat        # Production: PM2 daemon
├── src/               # TypeScript source
├── dist/              # Compiled JS (auto-generated)
├── state/
│   ├── alts.json      # Runtime state
│   └── auth-cache/    # Microsoft tokens
├── logs/              # Per-alt logs
└── package.json       # Dependencies
```

## Troubleshooting

**Bot won't start?**
- ✓ Check `.env` has your token
- ✓ Check `accounts.json` has at least one enabled alt
- ✓ Node.js installed? `node --version`

**Alt not connecting?**
- ✓ Check `logs/system.log` for errors
- ✓ Alt may be in backoff period (check: `.alts list`)
- ✓ May need first-time Microsoft auth

**Build fails?**
- Delete `dist/` and `node_modules/` folders
- Run a startup script again (auto-installs)

## Automated Testing Mode (Disabled by Default)

Testing/debug features are **off** unless enabled in `config.json`:

```json
"testing": {
	"enabled": false,
	"autoStart": false,
	"durationHours": 12,
	"commandIntervalMs": 90000,
	"phaseOneAlts": 2,
	"phaseOneHours": 2,
	"phaseTwoAlts": 13,
	"includeDisruptiveCommands": false
}
```

- `enabled: true` turns on test framework wiring.
- `autoStart: true` starts unattended soak test at startup.
- `includeDisruptiveCommands: true` allows timed move/balance/purge command checks.

When enabled, test artifacts are written to:
- `logs/selftest-status.json` (live status)
- `logs/selftest-report.json` (final report)

## Features

✓ Zero compilation errors  
✓ Production-optimized code  
✓ Complete input validation  
✓ Comprehensive error logging  
✓ Type-safe TypeScript  
✓ No dead code or duplication
