# podcast-summary-agent

A daily intelligence brief surfacing high-signal moments from tech/AI podcasts,
biased by an editable interest profile. Polls a set of YouTube channels (and
optionally searches YouTube for named people / companies), pulls transcripts,
runs Claude over them to extract and rank notable claims, and emails an HTML
brief with timestamp deep-links. Tune the bias by editing `config/profile.md`
through the included web UI.

Architecture notes and design rules live in [`CLAUDE.md`](./CLAUDE.md). This
README is just the "how do I run it?" guide.

---

## Local quickstart

Requires Node 22.5+.

```bash
git clone <this-repo>
cd podcast-summary-agent
npm install

# bring your own keys (see "Required accounts" below)
cp .env.example .env
# edit .env

# open the web UI on http://localhost:3000 (auto-opens your browser)
npm run web
```

From the UI you can edit `config/sources.yaml` (channels + watched
individuals/companies) and `config/profile.md` (the ranking bias).

Then run the pipeline:

```bash
npm run brief:dry          # full daily run, writes HTML to data/briefs/, no email sent
npm run brief              # same but emails via SendGrid
```

The web UI binds to `127.0.0.1` locally, so it's only reachable from your own
machine. Nothing is shared with anyone else's deployment.

---

## Required accounts

You need three third-party accounts. All have free tiers that are plenty for
personal use.

| Service | What it's for | Env var | Sign up |
|---|---|---|---|
| **Anthropic** | LLM (Claude) for extract + rank passes | `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| **youtube-transcript.io** | Fetching YouTube captions | `YOUTUBE_TRANSCRIPT_IO_TOKEN` | https://www.youtube-transcript.io |
| **SendGrid** | Sending the daily brief email | `SENDGRID_API_KEY`, `SENDGRID_FROM`, `SENDGRID_TO` | https://sendgrid.com |

SendGrid is optional if you only ever run `--dry-run` (the HTML lands in
`data/briefs/` and you can open it directly).

Typical per-day Anthropic spend with a handful of episodes is ~$1–2. See the
"Cost discipline" section of CLAUDE.md.

---

## Optional: YouTube cookies

If you deploy to a datacenter IP (Railway, Fly, etc.), YouTube may block
unauthenticated requests for video metadata. To work around this, export your
logged-in YouTube cookies and place them at `data/cookies.txt`:

1. Install the "Get cookies.txt LOCALLY" browser extension.
2. Log into YouTube in your browser.
3. Export cookies for `youtube.com`, save as `data/cookies.txt`.
4. On Railway: upload it to the persistent volume (or paste via SSH).

You can usually skip this when running locally on a residential connection.

---

## Production deployment (Railway)

Railway is what's tested. Any host that can run Node 22, persist a volume, and
schedule a cron job will work — substitute as needed.

### One-time Railway setup

1. **Create a Railway project.** https://railway.app → New Project → Empty Project.
2. **Add two services** in the same project, both pointed at your fork of this repo:
   - **`web`** — leave the default config; it uses `railway.json`, which runs
     `npm run web` and exposes a `/healthz` healthcheck.
   - **`cron`** — in the service's Settings, set the **Config Path** to
     `railway.cron.json`. That overrides the start command to `npm run brief`
     and disables auto-restart (it should run once a day and exit).
3. **Attach a persistent volume** to **both** services. Mount path: `/data` on
   each. Railway sets the env var `RAILWAY_VOLUME_MOUNT_PATH=/data` automatically,
   which switches the code into production-paths mode (state.db, transcripts,
   briefs, cookies, and `/data/config/` all live on the volume).

   Note: the same volume must be attached to both services so cron and web see
   the same database. Configure the second attachment under the service's
   Settings → Volumes.

4. **Set environment variables** on both services (the same set on each):

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   YOUTUBE_TRANSCRIPT_IO_TOKEN=...
   SENDGRID_API_KEY=SG....
   SENDGRID_FROM=you@yourdomain.com
   SENDGRID_TO=you@yourdomain.com
   ```

5. **Configure the cron schedule.** In the `cron` service: Settings → Cron Schedule
   → set to e.g. `0 11 * * *` (daily 11:00 UTC = 7am ET). The service will run
   `npm run brief` once at that time and exit.

6. **Expose the web service** at a public domain. Settings → Networking →
   Generate Domain (or attach a custom one). At this point the UI is reachable
   on the public internet **with no auth** — set up Cloudflare Access before
   sending anyone the URL (see next section).

7. **Seed your configuration.** On first boot, the web service copies the
   committed `config/profile.md` and `config/sources.yaml` from the image into
   `/data/config/`. After that, edits via the web UI persist on the volume
   across deploys. If you want to migrate an existing local `state.db`, use
   the UI's "Database backup & restore → Restore from file" button.

### Putting Cloudflare Access in front of the web UI

The Express server has no built-in auth — auth lives at Cloudflare. This setup
is free, takes about 10 minutes, and gives you SSO/email-OTP login.

1. **Point the domain through Cloudflare.** Add your domain to Cloudflare (or
   use a subdomain you already manage there). Create a `CNAME` record pointing
   to the Railway-provided hostname.
2. **Enable Zero Trust** at https://one.dash.cloudflare.com → Zero Trust →
   Access → Applications → Add an application → **Self-hosted**.
3. **Add an Access policy.** Application domain: your chosen hostname.
   Policy: `Include` → `Emails` → list the addresses (yours + anyone you
   want to share UI access with). Action: `Allow`. Identity provider:
   `One-time PIN` (email OTP) is the simplest.
4. **Done.** Anyone hitting the hostname now gets a Cloudflare email-OTP
   challenge before reaching the app.

If you only need to access the UI from your own machine, you can skip auth
entirely: set `RAILWAY_TCP_PROXY_PORT` or use `railway ssh` to tunnel into the
container and access the UI via SSH port-forwarding. Just **do not expose the
web service on a public hostname without auth** — the `/api/admin/*` endpoints
allow database restore.

---

## Env vars reference

| Variable | Required? | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API key |
| `YOUTUBE_TRANSCRIPT_IO_TOKEN` | yes | Transcript service token |
| `SENDGRID_API_KEY` | for email | Omit to use `--dry-run` only |
| `SENDGRID_FROM` | for email | Must be a SendGrid-verified sender |
| `SENDGRID_TO` | for email | Recipient address |
| `RAILWAY_VOLUME_MOUNT_PATH` | auto-set by Railway | Triggers production-paths mode when present |
| `PORT` | auto-set by Railway | Web server binds `0.0.0.0:$PORT` when set |
| `WEB_PORT` | optional, local only | Default 3000; binds `127.0.0.1` |

---

## Useful commands

```bash
npm run web                            # web UI
npm run brief                          # daily run, send email
npm run brief:dry                      # daily run, write HTML to disk only
node src/cli.js --episode "<url>"      # ad-hoc, single video
npm run resolve-channels               # populate channel_id from @handle
npm run discovery:audit                # inspect recent discovery decisions
npm run backup                         # snapshot state.db to data/backups/
```

For everything else — architecture, schema invariants, cost notes, known
pitfalls — see [`CLAUDE.md`](./CLAUDE.md).
