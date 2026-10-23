# Deploying Duet on your own VPS

What you'll end up with, all on one small Linux server:

```
 Browser ──HTTPS──▶ Caddy (:443, auto certificates) ──▶ Duet Node server (127.0.0.1:3000)
 Browser ──TURN───▶ coturn (:3478 + UDP 49152–65535)   ← only for pairs that can't connect directly
```

Time: about 30 minutes. Cost: about €4–6/month.
Commands below are for **Ubuntu 24.04** and assume the address **duet.sumitbaweza.com**. Replace it everywhere if you
pick another, including in `deploy/Caddyfile`, `deploy/turnserver.conf` and `deploy/duet.env.example`.

---

## 1. Code on GitHub ✓

Done: the code is at **https://github.com/sumitbaweza/duet** (public), and the server downloads it from there.
After you change something locally, `git push` it, then run the update command at the end of this guide on the server.

## 2. Create the server

- **Hetzner Cloud** (recommended): the smallest shared-CPU plan (e.g. CX22). Its large included traffic suits TURN relaying.
- **DigitalOcean**: Basic Droplet, $6/month plan.

When creating it, choose **Ubuntu 24.04** and add your **SSH key**. Note the server's **IPv4 address**.
Check each provider's current prices and included traffic.

## 3. Point your domain at it

At your domain provider (wherever sumitbaweza.com's DNS is managed), add:

| Type | Name | Value |
|---|---|---|
| A | `duet` | your server's IPv4 address |

Wait a few minutes until `ping duet.sumitbaweza.com` shows that IP.

## 4. Set up the server

Log in as root from Windows PowerShell / Terminal:

```bash
ssh root@YOUR_SERVER_IP
```

Then run these blocks in order (copy and paste each block).

**Updates and firewall**

```bash
apt update && apt -y upgrade
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49152:65535/udp
ufw --force enable
```

**Node.js 22, git and coturn**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs git coturn
node --version
```

**Caddy (HTTPS web server)**

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

**The app**

```bash
useradd --system --create-home --shell /usr/sbin/nologin duet
git clone https://github.com/sumitbaweza/duet.git /opt/duet
chown -R duet:duet /opt/duet
cd /opt/duet && sudo -u duet npm ci --omit=dev
```

**Shared TURN secret + config files.** This generates a random secret, puts it in both places, and fills in your IP.

```bash
SECRET=$(openssl rand -hex 32)
IP=$(curl -4s https://ifconfig.me)
echo "Server IP: $IP"

cp /opt/duet/deploy/turnserver.conf /etc/turnserver.conf
sed -i "s/REPLACE_WITH_THE_SAME_LONG_RANDOM_SECRET/$SECRET/; s/REPLACE_WITH_SERVER_IP/$IP/" /etc/turnserver.conf
chown root:turnserver /etc/turnserver.conf && chmod 640 /etc/turnserver.conf

cp /opt/duet/deploy/duet.env.example /etc/duet.env
sed -i "s/REPLACE_WITH_THE_SAME_LONG_RANDOM_SECRET_AS_COTURN/$SECRET/" /etc/duet.env
chown root:duet /etc/duet.env && chmod 640 /etc/duet.env

cp /opt/duet/deploy/duet.service /etc/systemd/system/duet.service
cp /opt/duet/deploy/Caddyfile /etc/caddy/Caddyfile
```

**Start everything**

```bash
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now duet coturn
systemctl reload caddy
systemctl --no-pager status duet coturn caddy | grep -E "●|Active"
```

All three should say `active (running)`.

## 5. Check it works

1. Open **https://duet.sumitbaweza.com/healthz** in your browser. You should see `{"ok":true,...}` with a padlock (HTTPS).
2. Open **https://duet.sumitbaweza.com/api/ice-servers**. It should list a `turn:` entry with a `username` like
   `1793...:duet`.
3. Test the relay: open the
   [Trickle ICE test page](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/), remove the
   default server, then add `turn:duet.sumitbaweza.com:3478` with the username and credential from step 2. Click
   **Gather candidates**. A row of type **relay** means TURN works.
4. Real test: one person on Wi-Fi, the other on **mobile data**. Create and join a room, and play a movie. The pill in the
   player's top bar shows **Direct** or **Relayed**. Both should play.

## Updating after you change the code

Push to GitHub, then on the server:

```bash
sudo bash /opt/duet/deploy/update.sh
```

It pulls the code, installs dependencies, restarts the app and prints the health check. A restart clears active rooms, so
anyone mid-movie just rejoins with the same code.

## Day-to-day

| Task | Command |
|---|---|
| Live app logs | `journalctl -u duet -f` |
| TURN logs | `journalctl -u coturn -f` |
| Restart app | `systemctl restart duet` |
| OS security updates | `apt update && apt -y upgrade` (Ubuntu also installs security updates automatically) |
| Check bandwidth used | your provider's dashboard → server → Graphs / Traffic |

## Notes

- **Keep one app process.** Rooms live in memory, so don't run the app on several servers or with multiple workers.
- **Bandwidth:** a relayed movie uses about 1.5–4 GB through TURN; direct connections use none of your server's bandwidth.
  `max-bps` in `turnserver.conf` caps each relay session at about 24 Mbit/s.
- **TURN passwords are temporary:** the app creates a new one every time a room opens, valid 6 hours, signed with the
  shared secret. If the secret ever leaks, generate a new one and update both `/etc/turnserver.conf` and `/etc/duet.env`,
  then run `systemctl restart coturn duet`.
- **Stricter networks** (some offices) block everything except port 443. Supporting them needs TURN over TLS on 443
  through a second IP or a different domain. Add that later if users report "Connecting…" forever.
