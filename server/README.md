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

## Uploads

Accounts with the `uploader` role or higher (on the upload library) can upload. Files go to
`<library>/uploads/<user name>/` and are indexed at once; the pipeline adds faces, smart search and captions as
for any new photo. The upload library is `upload_library` in the configuration file (`LUMINA_UPLOAD_LIBRARY`),
by default the first library. Unfinished uploads wait in `<data folder>/incoming/` and are removed after 7 days
without progress; the server keeps 5 GB of its disk free.

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

Running it natively is the easier way to pick folders on the server's disks: any folder can become a library
from the admin page, where in Docker it has to be mounted into the container first.

### As a service, with the tray (Linux)

```bash
# CachyOS / Arch: the tray needs GTK and an app indicator library
sudo pacman -S gtk3 libayatana-appindicator
cd src-tauri && cargo build --release -p lumina-server -p lumina-tray
install -Dm755 target/release/lumina-server target/release/lumina-tray -t ~/.local/bin/
mkdir -p ~/.config/lumina ~/.local/share/lumina
cat > ~/.config/lumina/lumina-server.toml <<'EOF'
data_dir = "/mnt/ssd/lumina-data"      # the database and caches: on the SSD
libraries = ["/mnt/hdd/photos"]        # the photos: on the HDD
web_dir = "/home/you/lumina/dist"      # the built web client
EOF
cp ../server/lumina-server.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now lumina-server
loginctl enable-linger "$USER"         # keeps running when you're logged out, and starts at boot
cp ../server/lumina-tray.desktop ~/.config/autostart/   # the tray at login
```

Use absolute paths in the configuration file: the service starts in `~/.local/share/lumina`.

The tray's icon is green when the server is idle, blue while it works and grey when it doesn't answer.
Clicking it shows what the server is doing ("Indexing: 12,000 of 50,000 · about 20 min left"), Open admin
page, and Start, Stop and Restart (through `systemctl --user`). It reads the key the server writes in its
data folder at each start (`local-access.key`), so it needs no account. `lumina-tray --help` lists its
options: `--service NAME --system` for a system service, `--compose FILE` for Docker, or
`--start CMD --stop CMD`. With Docker the tray reads the key inside the container (`docker compose exec`),
so your account must be allowed to run `docker`; the compose file stays as it is:

```bash
lumina-tray --compose ~/lumina/server/docker-compose.yml
```

For a server installed as a system service, as on cachy, the tray reads the same configuration file:

```bash
lumina-tray --config /srv/lumina/lumina-server.toml --service lumina-server --system
```

Start and Stop then go through `sudo` without a password when the sudoers rule under Upgrading is in
place, and otherwise ask for it in a window.

The tray shows no tooltip on Linux (the tray library has none there); its menu has the same lines. KDE Plasma
shows tray icons as they are; GNOME needs the AppIndicator extension.

On Windows, put `lumina-tray.exe` next to `lumina-server.exe` and the configuration file; the tray starts
and stops the server itself.

### Libraries and settings on the admin page

Admin page → Libraries adds a folder (typed, or picked with Browse) and takes one off; Settings sets where
uploads go, the caption model and Ollama's address. They apply at once, without a restart, and are saved in
`server-settings.json` in the data folder, on top of `lumina-server.toml`. A setting given by a `LUMINA_*`
variable stays as the variable says, and the admin page shows it as fixed. A library taken off is no longer
scanned or shown, but its photos' ratings, faces and albums stay in the database: adding the folder again
brings them back.

### Upgrading

Every release carries a ready server bundle, built on GitHub (`.github/workflows/server.yml`, about 15
minutes after the release is published): `lumina-server-<version>-linux-x86_64.tar.gz` with the server, ONNX
Runtime's GPU libraries, the tray and the web client. `upgrade-server.sh` installs it on a server set up as
a system service (on cachy: `/srv/lumina`, `lumina-server.service`), and comes along in the bundle as
`/srv/lumina/bin/upgrade-server.sh`. From Windows, in one go:

```bash
ssh -t cachy 'bash /srv/lumina/bin/upgrade-server.sh'                  # the latest release
ssh -t cachy 'bash /srv/lumina/bin/upgrade-server.sh v6.0.0'           # that release
ssh -t cachy 'bash /srv/lumina/bin/upgrade-server.sh --from-source'    # built from ~/Projects/Lumina (main)
ssh -t cachy 'bash /srv/lumina/bin/upgrade-server.sh --rollback'
```

(Before the first release with a bundle, the script is at `~/Projects/Lumina/scripts/linux/upgrade-server.sh`.)

It downloads the bundle and checks its SHA-256 (or builds it from the checkout while the old server keeps
running). It then copies the database with SQLite's backup API into `/srv/lumina/backups/` (the last three
kept), keeps the running program and web client as `.prev`, puts the new ones in place and restarts the
service. If the new version doesn't answer within two minutes, it shows the log and puts the previous version
back. An installed tray is replaced and started again. The server is down only for the restart; a first start
after a big upgrade may take a little longer while it brings the database up to date.

To install new releases by themselves, every night at 04:30 when there is one (`--if-newer`):

```bash
cp server/lumina-upgrade.service server/lumina-upgrade.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now lumina-upgrade.timer
loginctl enable-linger "$USER"     # so it also runs when you're not logged in
journalctl --user -u lumina-upgrade -n 40    # what the last run did
```

The restart asks for your sudo password. To let the script (and the tray) restart the server without it,
allow just that once:

```bash
echo "$USER ALL=(root) NOPASSWD: /usr/bin/systemctl start lumina-server, /usr/bin/systemctl stop lumina-server, /usr/bin/systemctl restart lumina-server" |
  sudo tee /etc/sudoers.d/lumina-server && sudo chmod 440 /etc/sudoers.d/lumina-server && sudo visudo -c
```

`LUMINA_HOME`, `LUMINA_SERVICE`, `LUMINA_REPO`, `LUMINA_SRC` and `LUMINA_RESTART` point it at another install,
service, GitHub repository, checkout or restart command (for instance `systemctl --user restart lumina-server`
for a user service).
