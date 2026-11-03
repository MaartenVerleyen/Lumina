# Lumina server

The server keeps the photo libraries scanned (thumbnails, faces, smart search, captions) and serves the web
client to logged-in users. It listens on `127.0.0.1:8080` only, as plain HTTP. Tailscale puts HTTPS in front
of it for the devices on your tailnet, so nothing is reachable from the LAN or the internet.

## Start it (Docker)

```bash
docker compose -f server/docker-compose.yml up -d --build
docker compose -f server/docker-compose.yml logs -f lumina
```

The photo library is `/srv/photos` on the host (change it in `docker-compose.yml`). The database, caches and
AI models live in the `lumina-data` volume.

## Accounts

Create the first account, an admin. The password is asked twice and not shown:

```bash
docker compose -f server/docker-compose.yml exec lumina /opt/lumina/lumina-server create-user maarten --role admin
```

Roles, lowest first: `guest` (only the albums shared with them), `viewer` (browse and search), `uploader`
(as viewer until uploads exist), `editor` (ratings, tags, people, albums, sharing albums), `admin` (everything,
on the whole server, including moving files and starting scans).

A user's role is their default for every library. On a server with more than one library it can be set
differently per library: an editor of their own library and a guest of someone else's, say. Albums shared
with someone (from the album's menu, "Share with…") add those photos to what they may look at.

```bash
lumina-server users                      # who has which role, and their roles per library
lumina-server set-role anna editor       # the default role
lumina-server set-library-role anna /photos/bob guest    # a different role on one library
lumina-server set-library-role anna /photos/bob default  # back to her default there
lumina-server set-password anna          # also logs anna out everywhere
lumina-server remove-user anna
```

Admins can do all of this in the browser too: account menu › Server admin (accounts and roles per library,
the server's state and backlog with buttons to start a rescan, face scan, smart search index or captions per
library, and restoring a `.luminabackup` by upload; the server starts again by itself after a restore and keeps
its accounts).

Failed logins hold back the next try for that name and address (429 with Retry-After), up to 30 seconds;
attempts sent at the same time are not all checked. A session lasts until logout or 90 days without use.

## HTTPS through Tailscale

In the Tailscale admin console, turn on MagicDNS and HTTPS certificates (DNS page). Then, on the server:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve status
```

`--bg` keeps it running, also after a reboot. The address is `https://<machine>.<tailnet>.ts.net`, for example
`https://cachy.tailaa193b.ts.net`. To stop: `sudo tailscale serve --https=443 off`.

## Without Docker

```bash
npm ci && npm run build                                   # the web client, into dist/
cd src-tauri && cargo build --release -p lumina-server
LUMINA_DATA_DIR=~/LuminaData LUMINA_LIBRARIES=~/Pictures LUMINA_WEB_DIR=../dist \
  ./target/release/lumina-server serve
```

Settings can also go in `lumina-server.toml` (`data_dir`, `libraries`, `ollama_url`, `caption_model`,
`listen`, `web_dir`); the `LUMINA_*` variables override it. `lumina-server help` lists every command.
