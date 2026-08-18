# Kenya Pulse — deployment

Written to be followed start to finish without prior knowledge. Every command is
copy-paste. After each one there is a **You should see** line — if what you get
does not match, stop and read the fix underneath rather than carrying on.

Nothing here can break your existing setup. The collector is a separate folder
and a separate cron entry; it does not touch your PM2 services or your site.

---

## What you are building

```
   Your VM (always on)                    Your phone
   ┌──────────────────────┐              ┌──────────────┐
   │  a Python script     │   reads      │              │
   │  wakes twice a month │ ───────────▶ │  Kenya Pulse │
   │  writes data.json    │   over the   │     app      │
   │                      │   internet   │              │
   │  tells you on        │              └──────────────┘
   │  Telegram if         │
   │  something moved     │
   └──────────────────────┘
```

One script. One file. One app that reads it. That is the whole system.

---

## Before you start

On the **Lenovo** (Zorin), open a terminal with `Ctrl` + `Alt` + `T` and check
you have what you need:

```bash
ssh -V && git --version && node --version && gcloud --version | head -1
```

**You should see** four version lines. Anything missing:

```bash
sudo apt update
sudo apt install -y openssh-client git curl        # ssh and git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
```

For `gcloud`, if it is missing:

```bash
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
gcloud init
```

You only need `gcloud` for **Part 0**, to look up your VM's address and install
your key. Everything after that is plain `ssh`.

---

# Part 0 · Getting into your VM from your terminal

You said SSH is not working. This part fixes that, and by the end you will be
able to type `ssh pulse` and land straight in.

**A little background, so the steps make sense.** SSH logs you into a remote
machine using a pair of files called *keys*. The **private key** stays on your
laptop and is never shared. The **public key** goes onto the server. When you
connect, the two are checked against each other. Google Cloud has its own way of
getting your public key onto the VM, and that is usually where this breaks.

---

## 0.1 · Find your VM's address

```bash
gcloud compute instances list
```

**You should see** something like:

```
NAME             ZONE                MACHINE_TYPE   STATUS   EXTERNAL_IP
deltabot-vm-za   africa-south1-a     e2-small       RUNNING  34.35.132.153
```

Write down the **EXTERNAL_IP**. That is the address you will SSH to.

**If STATUS says TERMINATED** the VM is switched off. Start it:

```bash
gcloud compute instances start deltabot-vm-za --zone=africa-south1-a
```

**If EXTERNAL_IP is blank** the VM has no public address, so nothing can reach
it. Give it one:

```bash
gcloud compute instances add-access-config deltabot-vm-za \
  --zone=africa-south1-a --access-config-name="external-nat"
```

**If the command itself fails** with an authentication error, run
`gcloud auth login` and sign in through the browser window that opens.

> **Worth doing.** By default that IP can change when the VM restarts, which
> silently breaks your SSH shortcut later. To pin it permanently:
> ```bash
> gcloud compute addresses create pulse-ip --region=africa-south1
> ```
> Then attach it in the Console under **VPC network → IP addresses**. Optional,
> but it saves a confusing afternoon in six months.

---

## 0.2 · Make an SSH key

Check whether you already have one:

```bash
ls -l ~/.ssh/
```

If you see `id_ed25519` or `id_rsa`, you have a key. You can still make a
dedicated one for this, which keeps things tidy:

```bash
ssh-keygen -t ed25519 -C "brian@zorin" -f ~/.ssh/gcp_pulse -N ""
```

**You should see** `Your identification has been saved in
/home/<you>/.ssh/gcp_pulse` and a randomart picture.

That made two files. `gcp_pulse` is private — never share it, never commit it.
`gcp_pulse.pub` is public and is meant to be handed out.

`-N ""` means no passphrase, so cron and scripts do not stop to ask. If you would
rather have one, drop `-N ""` and you will be prompted.

Lock down the permissions — SSH refuses to use a key other people could read:

```bash
chmod 700 ~/.ssh && chmod 600 ~/.ssh/gcp_pulse && chmod 644 ~/.ssh/gcp_pulse.pub
```

Now look at your public key:

```bash
cat ~/.ssh/gcp_pulse.pub
```

**You should see** one long line starting `ssh-ed25519 AAAAC3Nza...` and ending
`brian@zorin`. Keep this terminal open — you need to copy that line next.

---

## 0.3 · Give the VM your public key

Three routes. **Try route A first.** If it fails, route C always works.

### Route A — one command

```bash
gcloud compute instances add-metadata deltabot-vm-za \
  --zone=africa-south1-a \
  --metadata "ssh-keys=bgkaranja:$(cat ~/.ssh/gcp_pulse.pub)"
```

**You should see** `Updated [https://www.googleapis.com/compute/v1/...]`.

The format matters: it is **your Linux username, a colon, then the whole key**.
`bgkaranja` is the username you will log in as. Google reads that prefix to
decide which account the key belongs to.

> **Careful.** `add-metadata` with `ssh-keys` **replaces** any keys already
> there. If other people or machines use this VM, first run
> `gcloud compute instances describe deltabot-vm-za --zone=africa-south1-a --format="value(metadata.items.filter(\"key:ssh-keys\").extract(\"value\"))"`
> and add your line to what comes back rather than overwriting it.

### Route B — through the web Console

1. Go to **console.cloud.google.com** → **Compute Engine** → **VM instances**.
2. Click **deltabot-vm-za**, then **Edit** at the top.
3. Scroll to **SSH Keys** → **Add item**.
4. Paste the whole `ssh-ed25519 AAAA... brian@zorin` line.
5. **Save**.

Google reads the username from the comment at the end of the key. To be certain
it uses `bgkaranja`, change the end of the pasted line from `brian@zorin` to
`bgkaranja` before saving.

### Route C — the escape hatch that always works

On the VM instances page there is an **SSH** button next to your VM. Click it. A
browser terminal opens — this uses Google's own credentials and works even when
your keys do not.

Once you are in that browser terminal, paste your public key in by hand:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "PASTE_YOUR_PUBLIC_KEY_LINE_HERE" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
whoami
```

**You should see** your username printed by `whoami` — note it, because that is
the user you must SSH as. If it is not `bgkaranja`, use whatever it prints
everywhere below.

---

## 0.4 · Open the door

SSH runs on port 22, and it has to be allowed through the firewall:

```bash
gcloud compute firewall-rules list --filter="allowed.ports=22"
```

**You should see** a rule named something like `default-allow-ssh`. If nothing
comes back, create one:

```bash
gcloud compute firewall-rules create allow-ssh \
  --allow=tcp:22 --source-ranges=0.0.0.0/0 \
  --description="SSH access"
```

`0.0.0.0/0` means anyone may *attempt* to connect. They still cannot get in
without your private key, so this is normal. To be stricter, replace it with your
own address followed by `/32` — find it with `curl -s ifconfig.me`. Note that
home broadband addresses usually change, so you would need to update the rule
each time.

---

## 0.5 · Connect

```bash
ssh -i ~/.ssh/gcp_pulse bgkaranja@34.35.132.153
```

Use your own IP from step 0.1.

**First time** you will be asked:

```
The authenticity of host '34.35.132.153' can't be established.
ED25519 key fingerprint is SHA256:...
Are you sure you want to continue connecting (yes/no)?
```

Type `yes` and press Enter. This happens once.

**You should see** a welcome message and a prompt ending in `$`, something like
`bgkaranja@deltabot-vm-za:~$`. You are on the VM.

Confirm it:

```bash
whoami && hostname && df -h / | tail -1
```

**You should see** your username, the VM's name, and how much disk is free.

### If it did not work

Run it again with `-v` to see where it stops:

```bash
ssh -v -i ~/.ssh/gcp_pulse bgkaranja@34.35.132.153
```

Match what you see against this table:

| What you see | What it means | Fix |
|---|---|---|
| `Connection timed out` | Nothing is answering | Firewall (0.4) or VM is off (0.1) |
| `Connection refused` | Machine is there, SSH is not running | Use Route C browser SSH, then `sudo systemctl start ssh` |
| `Permission denied (publickey)` | Your key is not accepted | Key never landed (0.3), or wrong username |
| `Too many authentication failures` | SSH is offering every key you own | Add `-o IdentitiesOnly=yes` |
| `UNPROTECTED PRIVATE KEY FILE` | Permissions too loose | `chmod 600 ~/.ssh/gcp_pulse` |
| `Could not resolve hostname` | Typo in the address | Re-check the IP from 0.1 |
| Asks for a **password** | Key ignored, falling back | Wrong username, or OS Login is on — see below |

**About OS Login.** Google has a second key system called OS Login. When it is
switched on, the keys you put in metadata are **ignored entirely** and your
username becomes a mangled version of your email. Check:

```bash
gcloud compute instances describe deltabot-vm-za --zone=africa-south1-a \
  --format="value(metadata.items.filter(\"key:enable-oslogin\").extract(\"value\"))"
```

Blank means OS Login is off and metadata keys work — carry on. If it says
`TRUE`, either register your key with OS Login:

```bash
gcloud compute os-login ssh-keys add --key-file=~/.ssh/gcp_pulse.pub
gcloud compute os-login describe-profile --format="value(posixAccounts[0].username)"
```

and use that username, or turn OS Login off for this VM:

```bash
gcloud compute instances add-metadata deltabot-vm-za \
  --zone=africa-south1-a --metadata enable-oslogin=FALSE
```

---

## 0.6 · Make it one word

Typing the full command every time is tedious and easy to fumble. On the
**Lenovo**:

```bash
mkdir -p ~/.ssh && cat >> ~/.ssh/config << 'EOF'

Host pulse
    HostName 34.35.132.153
    User bgkaranja
    IdentityFile ~/.ssh/gcp_pulse
    IdentitiesOnly yes
    ServerAliveInterval 60
EOF
chmod 600 ~/.ssh/config
```

Change `HostName` to your IP and `User` to your username. `ServerAliveInterval`
stops the connection dropping while you read something.

Check it reads correctly before trusting it:

```bash
ssh -G pulse | grep -E "^(hostname|user|identityfile)"
```

**You should see** your IP, your username and the key path.

Now:

```bash
ssh pulse
```

**You should see** the VM prompt. That is the whole of Part 0 done.

From here on, **`ssh pulse` means "get onto the VM"** and typing `exit` means
"come back to the laptop".

---

## 0.7 · Copying files, and which way round

`scp` copies files over SSH. The order is always **from, then to**.

```bash
# laptop  ──▶  VM     (this is the direction you need most)
scp ~/Downloads/kenya_pulse.py pulse:~/kenya-pulse/

# VM  ──▶  laptop
scp pulse:~/kenya-pulse/run.log ~/Desktop/

# a whole folder needs -r
scp -r ~/projects/app/dist/* pulse:~/kenya-pulse-app/
```

The `pulse:` prefix means "on the VM". No prefix means "on this laptop". The
part after the colon is the path on the VM, where `~` is your home folder.

**Run scp from the laptop, not from inside the VM.** A common mistake is to
`ssh pulse` first and then try to copy — from there, your laptop is the remote
machine and the paths are all wrong. If your prompt shows the VM's name, type
`exit` first.

---

# Part 1 · The collector, on the VM

## 1 · Copy the script across

On the **laptop** (check your prompt does not say the VM name):

```bash
ssh pulse "mkdir -p ~/kenya-pulse/public"
scp ~/Downloads/kenya_pulse.py pulse:~/kenya-pulse/
```

The first line runs one command on the VM without logging in properly. Handy.

**You should see** a progress line ending `100%`.

Confirm it arrived:

```bash
ssh pulse "ls -la ~/kenya-pulse/"
```

**You should see** `kenya_pulse.py` listed.

---

## 2 · Install the three libraries

```bash
ssh pulse
```

You are now on the VM. Everything until `exit` runs there.

```bash
cd ~/kenya-pulse
pip3 install --user --break-system-packages requests beautifulsoup4 lxml
```

**You should see** `Successfully installed ...`, or `Requirement already
satisfied`.

`--break-system-packages` sounds alarming but is not. Ubuntu 24.04 protects the
system Python from casual installs; this flag says "yes, I mean it". Combined
with `--user` it installs only into your own home folder.

Verify:

```bash
python3 -c "import requests, bs4, lxml; print('ok')"
```

**You should see** `ok`. Nothing else.

---

## 3 · Prove the sources work *from the VM*

The most important step in this guide.

Websites can allow your laptop and block your server, because servers live in
data centres and some sites treat those differently. So the sources must be
tested from the machine that will actually be fetching them.

```bash
python3 kenya_pulse.py --health
```

**You should see**

```
  SOURCE                 STATUS      NOTE
  ----------------------------------------------------------
  CBK key rates          reachable   86 KB in 1.2s
  NSE statistics         reachable   89 KB in 0.9s
  FRED                   reachable   3 KB in 0.3s
  IMF DataMapper         reachable   118 KB in 9.8s
  World Bank             reachable   0 KB in 0.4s
  Currency fallback      reachable   2 KB in 0.2s

  6 of 6 reachable.
```

**Four of six is enough to continue** — CBK, FRED, IMF and World Bank carry the
rates, the global anchor, the forecasts and the long history.

**If CBK or NSE say DOWN** but work when you run the script on your laptop, the
VM's address is being filtered. The simplest answer is to run the collector on
the Lenovo instead and copy the result up. Add this to the laptop's crontab:

```bash
0 7 1,16 * *  cd ~/kenya-pulse && python3 kenya_pulse.py && scp public/*.json pulse:~/kenya-pulse/public/
```

Everything else in this guide stays the same.

---

## 4 · Fill in what only exists in PDFs

A dozen figures are published as PDFs and cannot be fetched automatically. You
type them once a month. It takes about a minute.

Still on the VM:

```bash
cat > ~/kenya-pulse/manual.json << 'EOF'
{
  "core": 3.2, "credit": 10.2, "npl": 14.6, "pmi": 51.8,
  "reserves": 15.25, "cover": 6.3, "cab": -3.0, "gdp": 5.3,
  "debt": 13.02, "debt_gdp": 69.9, "debtserv": 69,
  "tbill182": 9.34, "tbill364": 10.12, "bond10": 13.45,
  "infra": 12.80, "mmf_top": 12.10, "mmf_avg": 9.10
}
EOF
```

Those are correct as at August 2026, so you can move on and update them later.

**One to change now if you can.** `mmf_top` should be **your own fund's** current
rate, not the industry best. The ladder only helps if it compares rates you can
actually get.

Put these in your calendar — knowing when to look is most of the work:

| Release | Publisher | When |
|---|---|---|
| CPI and inflation | KNBS | last working day, monthly |
| Stanbic PMI | S&P Global | first working day, monthly |
| MPC decision | CBK | every second month, next October 2026 |
| Debt bulletin | National Treasury | mid-month |
| Quarterly GDP | KNBS | about 10 weeks after quarter end |

To edit the file later: `ssh pulse` then `nano ~/kenya-pulse/manual.json`. In
nano, `Ctrl`+`O` then Enter saves, `Ctrl`+`X` exits.

---

## 5 · The first run

Always do the dry run first. It prints everything and writes nothing.

```bash
python3 kenya_pulse.py --dry
```

**You should see** the briefing, then the ladder, the chain and the breaks. It
takes about a hundred seconds — most of that is waiting on the IMF, which is
slow but free.

**Read the ladder before going further.** If the numbers look wrong, the rates in
`manual.json` are wrong, and no amount of deployment fixes bad input.

Now for real:

```bash
python3 kenya_pulse.py
ls -lh public/
```

**You should see** `data.json` at roughly 13K and `spine.json` at roughly 9K.

If `data.json` is under 3K, too many sources failed. Go back to step 3.

---

## 6 · Telegram alerts

Notifications on a phone normally need a service worker, HTTPS, a key pair and a
push server. A Telegram bot needs a token. Same result, far fewer parts, and it
works on iPhones too.

**On your phone:**

1. Open Telegram, search **@BotFather**, start a chat.
2. Send `/newbot`.
3. Give it a name, then a username ending in `bot`.
4. It replies with a token like `8123456789:AAH...`. Copy it.
5. Search for the bot you just made and **send it any message** — it cannot
   message you first.

**On the laptop**, find your chat id by opening this in a browser, with your
token in place of `<TOKEN>`:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Look for `"chat":{"id":123456789`. That number is your chat id.

**On the VM:**

```bash
cat >> ~/.bashrc << 'EOF'
export KP_TG_TOKEN="paste-your-token"
export KP_TG_CHAT="paste-your-chat-id"
export KP_Z="1.5"
EOF
source ~/.bashrc
python3 kenya_pulse.py
```

**You should see** a message arrive on your phone.

---

## 7 · Make it run by itself

```bash
crontab -e
```

If asked which editor, choose **nano** (usually option 1).

Paste at the bottom, with your own token and chat id:

```cron
KP_TG_TOKEN=paste-your-token
KP_TG_CHAT=paste-your-chat-id
0 7 1,16 * *  cd /home/bgkaranja/kenya-pulse && /usr/bin/python3 kenya_pulse.py >> run.log 2>&1
0 7 * * 6     cd /home/bgkaranja/kenya-pulse && /usr/bin/python3 kenya_pulse.py --fast >> run.log 2>&1
0 4 1 1 *     cd /home/bgkaranja/kenya-pulse && /usr/bin/python3 kenya_pulse.py --compact >> run.log 2>&1
```

Save with `Ctrl`+`O`, Enter, then `Ctrl`+`X`.

Reading the timing: `0 7 1,16 * *` is minute 0, hour 7, on the 1st and 16th, any
month, any weekday. `0 7 * * 6` is 07:00 every Saturday.

**The two `KP_` lines at the top are not optional.** Cron does not read
`.bashrc`, so without them the job runs perfectly and never sends a thing. This
is the single most common failure here.

Check it saved:

```bash
crontab -l
```

**You should see** your lines. Use full paths in cron — `/home/bgkaranja/...`
not `~` — because cron does not always know where home is.

---

## 8 · Publish the file

The app needs to fetch `data.json` over the internet. You already run nginx.

```bash
sudo nano /etc/nginx/sites-available/gachichio
```

Find the `server { ... }` block for your site and add inside it:

```nginx
location /pulse/ {
    alias /home/bgkaranja/kenya-pulse/public/;
    add_header Access-Control-Allow-Origin  *;
    add_header Cache-Control "public, max-age=300";
    autoindex off;
}
```

Save and exit, then:

```bash
sudo nginx -t
```

**You should see** `syntax is ok` and `test is successful`. If not, do **not**
reload — re-read what you pasted. A broken config plus a reload takes your site
down.

```bash
sudo systemctl reload nginx
curl -s https://gachichio.org/pulse/data.json | head -c 120
```

**You should see** JSON starting `{"asOf":"2026-...`.

That `Access-Control-Allow-Origin` line is what lets the app read the file from a
different domain. Without it the browser blocks the request and the app quietly
falls back to its built-in figures.

Now leave the VM:

```bash
exit
```

---

# Part 2 · The app, on the laptop

## 9 · Set it up

Build on the Lenovo. Never on the VM — `npm install` will exhaust its memory.

```bash
cd ~/projects
npm create vite@latest kenya-pulse-app -- --template react
```

Choose **React**, then **JavaScript** when asked.

```bash
cd kenya-pulse-app
npm install
npm install -D vite-plugin-pwa
cp ~/Downloads/KenyaPulse.jsx src/App.jsx
echo "body{margin:0}" > src/index.css
npm run dev
```

**You should see** `Local: http://localhost:5173/`. Open it. Five tabs, a green
mark, and real figures.

Stop the server with `Ctrl`+`C` when you have looked around.

---

## 10 · Make it installable on a phone

```bash
cat > vite.config.js << 'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    manifest: {
      name: 'Kenya Pulse',
      short_name: 'Pulse',
      description: 'The Kenyan economy at a glance, and where money is being paid',
      theme_color: '#237352',
      background_color: '#FAF8F4',
      display: 'standalone',
      orientation: 'portrait',
      start_url: '/',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    },
    workbox: {
      runtimeCaching: [{
        urlPattern: /\/pulse\/.*\.json$/,
        handler: 'NetworkFirst',
        options: { cacheName: 'pulse-data',
          expiration: { maxEntries: 10, maxAgeSeconds: 604800 } }
      }]
    }
  })]
})
EOF
```

`NetworkFirst` means the app tries the live file and falls back to the last copy
it saw. It still works with no signal.

Now the icon:

```bash
cat > icon.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="512" height="512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#2E8C64"/><stop offset="58%" stop-color="#237352"/>
    <stop offset="100%" stop-color="#B0642A"/></linearGradient></defs>
  <rect width="48" height="48" rx="13" fill="url(#g)"/>
  <path d="M7 27h6.5l3.6-11 5.4 20 4.6-15 3.2 8.5h11" fill="none" stroke="#fff"
    stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="38.5" cy="29.5" r="2.9" fill="#fff"/>
</svg>
EOF

sudo apt install -y librsvg2-bin
rsvg-convert -w 512 -h 512 icon.svg -o public/icon-512.png
rsvg-convert -w 192 -h 192 icon.svg -o public/icon-192.png
ls -l public/icon-*.png
```

**You should see** two PNG files.

A pulse trace that reads as both a heartbeat and a chart, green through to
copper, with a dot on the last reading — the line is still running.

---

## 11 · Put it online

The quickest route:

```bash
npm run build
npx vercel --prod
```

Follow the prompts. **You should see** a live URL at the end. Copy it.

Or host it on your own VM, which keeps everything on one domain:

```bash
npm run build
ssh pulse "mkdir -p ~/kenya-pulse-app"
scp -r dist/* pulse:~/kenya-pulse-app/
```

Then on the VM, add to the same nginx file:

```nginx
location /pulse-app/ {
    alias /home/bgkaranja/kenya-pulse-app/;
    try_files $uri $uri/ /pulse-app/index.html;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

# Part 3 · GitHub

## 12 · Publish the code

On the laptop:

```bash
mkdir -p ~/projects/kenya-pulse && cd ~/projects/kenya-pulse
cp ~/Downloads/kenya_pulse.py .
mkdir -p app/src && cp ~/Downloads/KenyaPulse.jsx app/src/App.jsx
cp ~/Downloads/README.md ~/Downloads/DEPLOY.md .
git init && git branch -M main
```

Tell git what to leave out:

```bash
cat > .gitignore << 'EOF'
history.jsonl
history.jsonl.bak
state.json
archive/
run.log
public/data.json
public/spine.json
manual.json
node_modules/
dist/
.env
.DS_Store
EOF
```

Data is generated, not source. `manual.json` is ignored because it is a record of
what you watch — ship an example instead:

```bash
cat > manual.example.json << 'EOF'
{
  "core": 0, "credit": 0, "npl": 0, "pmi": 0,
  "reserves": 0, "cover": 0, "cab": 0, "gdp": 0,
  "debt": 0, "debt_gdp": 0, "debtserv": 0,
  "tbill182": 0, "tbill364": 0, "bond10": 0,
  "infra": 0, "mmf_top": 0, "mmf_avg": 0
}
EOF
```

Add a licence, then commit:

```bash
printf 'MIT License\n\nCopyright (c) 2026 Brian Gachichio\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED.\n' > LICENSE

git add -A
git status
```

**You should see** your files staged, and **no** `manual.json`, `run.log` or
`.json` data files. If any appear, fix `.gitignore` before committing.

```bash
git commit -m "Kenya Pulse: thirty indicators, six free sources, three layers of signal"
```

Now push. GitHub no longer accepts passwords, so use a key — the same idea as
Part 0:

```bash
ssh-keygen -t ed25519 -C "brian@github" -f ~/.ssh/github -N ""
cat ~/.ssh/github.pub
```

Copy that line, then on github.com go to **Settings → SSH and GPG keys → New SSH
key**, paste, save. Then:

```bash
cat >> ~/.ssh/config << 'EOF'

Host github.com
    User git
    IdentityFile ~/.ssh/github
    IdentitiesOnly yes
EOF

ssh -T git@github.com
```

**You should see** `Hi bgachichio! You've successfully authenticated`. The words
"does not provide shell access" after it are normal.

Create the repository on github.com — green **New** button, name it
`kenya-pulse`, **do not** tick any initialise options — then:

```bash
git remote add origin git@github.com:bgachichio/kenya-pulse.git
git push -u origin main
```

**You should see** `branch 'main' set up to track 'origin/main'`.

> **Never commit your Telegram token.** It lives in `.bashrc` and the crontab
> only. If one ever gets pushed, send `/revoke` to @BotFather — deleting the
> commit does not help once it has left your machine.

---

# Part 4 · Your phone

## 13 · Install it

1. Open the URL in **Chrome** on the Pixel.
2. Three dots → **Add to Home screen** → **Install**.
3. Open it from the home screen.
4. Tap **⚙** → paste `https://gachichio.org/pulse/data.json` into **Data feed**.
5. Go to the **Data** tab → **Sync now**.

**You should see** the badge change from **seeded** to **live**.

While you are in settings, set the three tax sliders to whatever your own advice
says. The ladder recomputes and re-sorts as you drag.

**Check it stuck:** close the app completely and reopen. Theme, text size, feed
and tax settings should all still be there.

---

## 14 · Sharing it

Anyone with the link can use it. It is a website — no login, no app store.

**Android** — Chrome offers **Install app**.

**iPhone and iPad** — it works, with three things worth saying up front:

- Installing is **Share → Add to Home Screen**, and **only from Safari**. Chrome
  on iOS cannot install it. Tell people, or they will think it is broken.
- Web push needs iOS 16.4 or later. Telegram avoids the problem entirely.
- iOS wipes stored settings for web apps left unopened for about a week. Someone
  who checks monthly may have to re-enter the feed URL.

**Decide what you are sharing.** The app reads a public file, so anyone with the
URL can read your feed. Every figure in it is published national data. What is
yours is the reading of it.

| You want | Do this |
|---|---|
| Fully open | Share the URL |
| Numbers open, your commentary private | Blank the `call` field and each break's `reading` text before building a public copy |
| Private | Put Cloudflare Access in front of `/pulse-app/` — free to 50 users, email-code sign-in |

---

## When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `ssh pulse` times out | Firewall or VM off | Steps 0.1 and 0.4 |
| `Permission denied (publickey)` | Key not installed, or wrong user | Step 0.3, route C always works |
| Asked for a password | OS Login is on | See the note at the end of 0.5 |
| `scp` says "No such file" | Running it from the VM | `exit` first; scp runs from the laptop |
| App says **seeded** after syncing | Missing CORS header | Re-check the nginx block in step 8 |
| `--health` shows a source DOWN | VM's address filtered | Run the collector on the laptop, step 3 |
| Cron runs but no Telegram | No environment in cron | The two `KP_` lines at the top, step 7 |
| Telegram silent | Never messaged the bot | Send it any message, then retry |
| Chain says "needs more readings" | Fewer than three runs logged | Expected. It fills in on its own |
| An indicator shows an age badge | Its source failed | Working as intended — last good reading, labelled |
| Ladder looks wrong | Stale rates | Update `manual.json` |
| `nginx -t` fails | Typo in the config | Fix it before reloading, or the site goes down |

---

## Words used here

| Word | Meaning |
|---|---|
| **SSH** | Logging into another computer over the internet, securely |
| **key pair** | Two files. Private stays with you, public goes on the server |
| **scp** | Copying files over SSH |
| **cron** | The scheduler that runs things at set times |
| **nginx** | The program that serves your website |
| **CORS** | A browser rule about reading files from another domain |
| **PWA** | A website that installs like an app |
| **metadata** | Settings attached to a Google Cloud VM, including SSH keys |
| **OS Login** | Google's alternative key system, which overrides metadata keys |

---

## Living with it

- **Most weeks, nothing.** Cron runs, Telegram speaks when something moves.
- **Once a month**, after KNBS publishes: `ssh pulse`, then
  `nano ~/kenya-pulse/manual.json`.
- **Twice a year**, April and October: the IMF publishes new forecasts and they
  refresh on the next full run.
- **Once a year**: the log gets compacted, already scheduled.

To check on it any time:

```bash
ssh pulse "tail -20 ~/kenya-pulse/run.log"
```

---

Made with ❤️ by [Brian Gachichio](https://gachichio.org)
