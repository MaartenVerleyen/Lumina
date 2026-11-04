# Releasing Lumina

A release is a GitHub release with four files. Installed copies of Lumina find new releases by themselves
through `latest.json`.

| File | What it is for |
| :--- | :--- |
| `Lumina-Setup-x.y.z.exe` | the guided setup for new users (app, Ollama, AI models) |
| `Lumina_x.y.z_x64-setup.exe` | the plain installer; the updater downloads and runs this one |
| `Lumina_x.y.z_x64-setup.exe.sig` | its update signature |
| `latest.json` | version, release notes, and where the installer and signature are |

## Making a release

1. Set the version everywhere:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\set-version.ps1 3.7.0
   ```
2. Add the release notes to `RELEASE_NOTES` in `src/utils/welcome.ts`. Updating users see them in the update
   banner, in "What's new" after the update, and on the GitHub release page.
3. Commit and push.
4. Try it without publishing:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -DryRun
   ```
   Everything lands in `release\`.
5. Publish:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\release.ps1
   ```
   This needs the GitHub CLI, signed in once with `gh auth login`.

## Linux and Mac

Publishing the release starts the GitHub workflow `.github/workflows/desktop.yml`. It builds the same tag for
Linux (AppImage and .deb, on Ubuntu 24.04) and the Mac (Apple Silicon .dmg), adds the files to the release,
and adds `linux-x86_64` and `darwin-aarch64` to `latest.json` once the release script has put it up (about
20 minutes after publishing). Follow it under Actions on GitHub.

- Updates on Linux and Mac need the update key as the repository secret `TAURI_SIGNING_PRIVATE_KEY` (the
  contents of the key file; Settings → Secrets and variables → Actions). Without it the builds are still
  added, without update signatures, and `latest.json` keeps Windows only.
- To try a build without touching any release: Actions → Desktop builds → Run workflow, with a branch or tag.
  The files are kept as the run's artifacts for 14 days.

## The update key

Lumina only installs updates signed with the update key. Its public half is in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`). The private half is on the release PC only:
`%USERPROFILE%\.tauri\lumina-updater.key`. Override its location with `TAURI_SIGNING_PRIVATE_KEY`.

- **Back it up** somewhere safe, for example a password manager. If it is lost, installed copies can't update
  any more: everyone would have to reinstall from a new key.
- **Never** commit it or share it.
- The key has no password. To add one before the first public release, generate a new pair with
  `npx tauri signer generate -w %USERPROFILE%\.tauri\lumina-updater.key -f` and put the new public key in
  `tauri.conf.json`. Then set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when releasing.

## Code signing (Windows "unknown publisher")

Without a code-signing certificate, Windows SmartScreen warns about an unknown publisher when people download
Lumina. Everything is ready for a certificate. `scripts/sign.ps1` signs every file Tauri builds, and the
release script uses it for Lumina Setup too. Until a certificate is set up it only prints a warning.

1. **Get a certificate.** Microsoft's own Azure Artifact Signing is not available to individuals in the EU.
   Options are an OV code-signing certificate from a certificate authority such as Certum, SSL.com or Sectigo.
   - Certum has a cheaper "open source" certificate when the repository is public.
   - Certificates now live on a hardware token or in the CA's cloud signing service.
   - Expect a short identity check.
2. **Tell Lumina how to sign** with a command line in the `LUMINA_SIGN_COMMAND` environment variable, where
   `{file}` stands for the file to sign:
   - A certificate in the Windows store or on a token:
     ```powershell
     setx LUMINA_SIGN_COMMAND "signtool sign /fd sha256 /tr http://time.certum.pl /td sha256 /sha1 <THUMBPRINT> {file}"
     ```
   - A cloud signing service: use the command line its tool documents, with `{file}` in place of the file
     name.
3. **Release as usual.** The release script stops warning once signing is configured.

SmartScreen also builds trust per publisher over downloads. A new certificate can still show a warning for
the first while.
