<div align="center" width="100%">
    <img src="./public/icon.svg" width="128" alt="Ayoratou Logo" />
</div>

# Uptime Ayoratou

Self-hosted monitoring and public status pages.

<a target="_blank" href="https://hub.docker.com/r/ayoratou99/uptime-ayoratou"><img src="https://img.shields.io/docker/pulls/ayoratou99/uptime-ayoratou" alt="Docker pulls" /></a>
<a target="_blank" href="https://hub.docker.com/r/ayoratou99/uptime-ayoratou"><img src="https://img.shields.io/docker/v/ayoratou99/uptime-ayoratou?label=docker%20image%20ver." alt="Docker image version" /></a>
<img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT licence" />

---

## About this project

**Uptime Ayoratou is a proposal version by MVONE AYORATOU Arthur.**

It is built on [Uptime Kuma](https://github.com/louislam/uptime-kuma), the
self-hosted monitoring tool created and maintained by
[Louis Lam](https://github.com/louislam). All of the original work, and the
overwhelming majority of the code here, is theirs. This fork keeps the MIT
licence and exists to add features for a specific set of needs, not to compete
with or replace the original.

If you want the original project, go there — it is actively maintained and has
a large community behind it:

- Upstream repository: https://github.com/louislam/uptime-kuma
- Upstream documentation and wiki: https://github.com/louislam/uptime-kuma/wiki
- Upstream live demo: https://demo.kuma.pet/start-demo

For anything not described below, the upstream documentation applies unchanged.

---

## What this fork adds

Everything Uptime Kuma does, plus the following.

### Multiple users with real permissions

Upstream supports a single administrator. This fork adds accounts with three
roles (admin, editor, viewer) and **per-user permission overrides** on top of
the role, so you can say "this editor may also edit everyone else's monitors"
without promoting them to an administrator.

Sixteen permissions cover monitors, status pages, maintenance, notifications,
settings and user management, each with `own` and `all` variants. The last
active administrator cannot be deleted, disabled or demoted, so an installation
cannot lock itself out.

### Mandatory two-factor authentication

TOTP (Google Authenticator and compatible apps) is **required for every
account**. A correct password proves who you are but does not create a session:
until an authenticator code confirms enrolment, there is no login. Users cannot
turn their own 2FA off.

Administrators can reset any user's 2FA from Settings → Users. That signs the
user out and makes them scan a new code at their next login, which is the
recovery path for a lost device.

### Richer HTTP checks

Upstream lets an HTTP monitor check the status code, or match one keyword, or
run one JSON query. This fork lets you combine assertions about the response
itself with AND/OR:

| Variable                 | Checks                                       |
| ------------------------ | -------------------------------------------- |
| `status code`            | numeric comparison                           |
| `response time (ms)`     | numeric comparison                           |
| `content type`           | string comparison — how you require JSON     |
| `response body`          | string comparison, plus regex                |
| `response size (bytes)`  | numeric comparison                           |
| `response is valid JSON` | yes/no, decided by actually parsing the body |

Regex accepts either a bare pattern or `/pattern/flags`, so case-insensitive
and dotall matching are reachable. An invalid pattern reports itself by name
rather than surfacing a raw `SyntaxError` from the check.

### Incident history that is actually history

Upstream overwrites an incident when you post a follow-up, losing the earlier
text. Here each change is appended to a timeline with a status
(investigating → identified → monitoring → resolved), a timestamp and an
author, and the full history is shown on the public page.

Incidents on the status page are collapsible, and a **See all incidents** view
adds search across titles, bodies and timeline updates, filters by status,
ongoing/past and date range, and CSV/JSON export.

### Automatic incidents for sustained downtime

A monitor can post an incident automatically once it has been down continuously
for 5, 10, 15, 30 or 60 minutes. The delay is the point: a brief blip should not
put a notice in front of the public.

**Automatic incidents are never closed automatically.** A monitor coming back
means the check passes again, not that the problem is understood or that your
users have been given an explanation, so updating and resolving stay with
whoever is handling it.

### Public email subscriptions

Visitors can subscribe to a status page and be emailed about incidents, updates
and monitor state changes. Subscription is double opt-in — a confirmation link
must be opened before anything is delivered — and every message carries a
one-click unsubscribe link.

SMTP is configured once for the whole instance under
Settings → Status Page Email, separately from monitor notifications, with a
"send test email" button to check it before you rely on it.

### AyosPush WhatsApp notifications

An additional notification provider that sends approved WhatsApp template
messages through AyosPush. It appears under chat platforms as
_WhatsApp (AyosPush)_.

### Smaller changes

- Monitors show who created them
- Redesigned status page header: overall state, how many services are
  operational, and how fresh the page is
- The interface is rebranded throughout, including all 78 translations

---

## Install

### Docker Compose

```bash
mkdir uptime-ayoratou
cd uptime-ayoratou
curl -o compose.yaml https://raw.githubusercontent.com/Ayoratou99/uptime-ayoratou/ayoratou/compose.yaml
docker compose up -d
```

`compose.yaml` in this repository builds the image from source. To run the
published image instead, remove the `build:` block so only `image:` remains. If
you do build locally, run `npm run build` first — the frontend is baked into
the image.

### Docker

```bash
docker run -d --restart=always -p 3001:3001 -v uptime-ayoratou:/app/data --name uptime-ayoratou ayoratou99/uptime-ayoratou:latest
```

It listens on all interfaces, for example http://localhost:3001.

To expose it to localhost only:

```bash
docker run -d --restart=always -p 127.0.0.1:3001:3001 -v uptime-ayoratou:/app/data --name uptime-ayoratou ayoratou99/uptime-ayoratou:latest
```

> **Warning**
> Network file systems such as NFS are not supported for the data directory.
> Map a local directory or a Docker volume.

### Without Docker

Requirements are unchanged from upstream: Node.js >= 20.4, Git, and
[pm2](https://pm2.keymetrics.io/) to run it in the background. Major Linux
distributions and Windows 10 / Server 2012 R2 or newer are supported;
FreeBSD, OpenBSD and NetBSD are not.

```bash
git clone https://github.com/Ayoratou99/uptime-ayoratou.git
cd uptime-ayoratou
git checkout ayoratou
npm ci
npm run build

# Try it
node server/server.js

# Or run it in the background
npm install pm2 -g && pm2 install pm2-logrotate
pm2 start server/server.js --name uptime-ayoratou
pm2 startup && pm2 save
```

### First run

1. Choose a database. SQLite is fine for most installations.
2. Create the first administrator account.
3. **Scan the QR code with your authenticator app** and enter the six digit
   code. Two-factor authentication is mandatory, so this step cannot be
   skipped — keep the device handy.

---

## Screenshots

Screenshots have not been captured for this fork yet. The upstream images show
the original interface, so they are deliberately not reused here: they would
misrepresent what this version actually looks like.

To add your own, put them in `docs/screenshots/` and reference them:

```markdown
![Dashboard](./docs/screenshots/dashboard.png)
![Status page](./docs/screenshots/status-page.png)
![Users and permissions](./docs/screenshots/users.png)
![Monitor conditions](./docs/screenshots/conditions.png)
![Incident timeline](./docs/screenshots/incident-timeline.png)
```

---

## Credits and licence

Uptime Kuma is © Louis Lam and its contributors, released under the MIT
licence. This fork is released under the same licence, reproduced unchanged in
[LICENSE](./LICENSE).

If you find this useful, please consider starring
[the original project](https://github.com/louislam/uptime-kuma) — it is the
reason this exists.

### Support

This fork is a personal proposal and carries no support commitment. For
questions about the underlying product, the upstream community is the right
place:

- [Upstream issues](https://github.com/louislam/uptime-kuma/issues)
- [r/UptimeKuma](https://www.reddit.com/r/UptimeKuma/)

Please do not raise issues about this fork with the upstream maintainers.

### Translations

Translations come from upstream and are managed through
[Weblate](https://weblate.kuma.pet/projects/uptime-kuma/uptime-kuma/).
Contribute them there so the whole community benefits, rather than here.
