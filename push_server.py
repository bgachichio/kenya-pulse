#!/usr/bin/env python3
"""Kenya Pulse — push service.

Two jobs in one file, because they share a store and nothing else:

    --serve       a small API the app subscribes to (bound to localhost,
                  reverse-proxied by Caddy at /pulse/push/)
    --send-due    one pass over the subscriptions, sending to any device whose
                  local time has come. Cron runs it; it exits.

Why a server at all: a timer inside the page only runs while the page is open,
which is the one moment a reminder is not needed. Web push is the only way a
browser hears anything while it is closed, and web push needs someone to do
the sending.

What is stored per device: the push endpoint the browser minted, the two keys
that encrypt to it, a time, a set of days, and a timezone name. No account, no
identifier, nothing that says who the device belongs to.

The VAPID private key is read from the environment. It is never written here,
never logged, and never committed — see --genkeys.
"""
import argparse
import fcntl
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

HERE = Path(__file__).resolve().parent
STORE = Path(os.environ.get("KP_PUSH_STORE", HERE / "push-subscriptions.json"))
LOCK = STORE.with_suffix(".lock")
DATA = Path(os.environ.get("KP_DATA_JSON", HERE / "public" / "data.json"))

# A briefing three hours late is still breakfast reading. One twelve hours late
# is a phone buzzing at bedtime about this morning, so the send is dropped.
GRACE = timedelta(hours=3)
MAX_SUBS = 5000

# The endpoint is a URL this server will POST to, supplied by whoever calls
# /subscribe. Unchecked, that is an open relay pointed at our own network.
# Only the four real push services are accepted.
ALLOWED_HOSTS = (
    ".googleapis.com",       # Chrome, Edge, and every Chromium browser
    ".mozilla.com",          # Firefox
    ".push.apple.com",       # Safari, iOS
    ".notify.windows.com",   # Windows
)


# --------------------------------------------------------------------------
# store
# --------------------------------------------------------------------------
def _read() -> dict:
    try:
        return json.loads(STORE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write(subs: dict) -> None:
    """Replace atomically, mode 600. A half-written store loses every
    subscriber, and there is no way to ask them to sign up again."""
    STORE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(STORE.parent), prefix=".push-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(subs, fh, indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, STORE)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class _Lock:
    """Cron can overlap a slow run with the next one. Second one waits."""

    def __enter__(self):
        LOCK.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(LOCK, "w")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()


def valid_endpoint(endpoint: str) -> bool:
    try:
        u = urlparse(endpoint)
    except ValueError:
        return False
    if u.scheme != "https" or not u.hostname:
        return False
    host = u.hostname.lower()
    return any(host == a.lstrip(".") or host.endswith(a) for a in ALLOWED_HOSTS)


def valid_time(t: str) -> bool:
    try:
        hh, mm = t.split(":")
        return 0 <= int(hh) <= 23 and 0 <= int(mm) <= 59
    except (ValueError, AttributeError):
        return False


def valid_tz(name: str) -> bool:
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return False


# --------------------------------------------------------------------------
# what the notification says
# --------------------------------------------------------------------------
def briefing(data: dict) -> tuple[str, str]:
    """Two lines: where policy and prices sit, and what the best real return
    is. Anything longer is truncated by the phone anyway."""
    sig = {s.get("id"): s for s in data.get("signals", []) if isinstance(s, dict)}

    def fmt(key: str) -> str | None:
        s = sig.get(key)
        if not s or not isinstance(s.get("value"), (int, float)):
            return None
        return f"{s['value']}{s.get('unit') or ''}"

    bits = [f"{label} {v}" for label, v in (
        ("CBR", fmt("cbr")), ("Inflation", fmt("inflation")), ("KES/USD", fmt("kes_usd"))
    ) if v]
    line1 = " · ".join(bits) or "Today's readings are ready."

    line2 = ""
    ladder = [r for r in data.get("ladder", []) if isinstance(r.get("real"), (int, float))]
    if ladder:
        best = max(ladder, key=lambda r: r["real"])
        sign = "+" if best["real"] > 0 else ""
        line2 = f"Best real return: {best.get('label', '—')} {sign}{best['real']:.2f}%"

    return "Kenya Pulse", "\n".join(x for x in (line1, line2) if x)


def load_data() -> dict:
    try:
        return json.loads(DATA.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# --------------------------------------------------------------------------
# sending
# --------------------------------------------------------------------------
def is_due(sub: dict, now_utc: datetime) -> bool:
    if not sub.get("days"):
        return False
    try:
        local = now_utc.astimezone(ZoneInfo(sub.get("tz") or "Africa/Nairobi"))
    except (ZoneInfoNotFoundError, ValueError):
        return False
    # The app stores days the way JavaScript counts them: Sunday is 0.
    if ((local.weekday() + 1) % 7) not in sub["days"]:
        return False
    hh, mm = (int(x) for x in sub.get("time", "08:00").split(":"))
    target = local.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if local < target or (local - target) > GRACE:
        return False
    return sub.get("lastSent") != local.date().isoformat()


def send_due(now_utc: datetime | None = None, sender=None, force: bool = False) -> dict:
    """Returns counts rather than printing, so the tests can read them.

    force ignores the schedule and sends to everyone now. It deliberately does
    not stamp lastSent: a test at four in the afternoon must not swallow
    tomorrow's real briefing."""
    import requests
    from pywebpush import WebPushException, webpush

    now_utc = now_utc or datetime.now(timezone.utc)
    private = os.environ.get("KP_VAPID_PRIVATE", "")
    subject = os.environ.get("KP_VAPID_SUBJECT", "mailto:hello@gachichio.org")
    if not private and sender is None:
        raise SystemExit("KP_VAPID_PRIVATE is not set — see --genkeys")

    title, body = briefing(load_data())
    payload = json.dumps({"title": title, "body": body, "url": "/#edge"})
    tally = {"sent": 0, "failed": 0, "dropped": 0, "skipped": 0}

    with _Lock():
        subs = _read()
        for endpoint, sub in list(subs.items()):
            if not force and not is_due(sub, now_utc):
                tally["skipped"] += 1
                continue
            local = now_utc.astimezone(ZoneInfo(sub.get("tz") or "Africa/Nairobi"))
            try:
                if sender is not None:
                    sender(sub, payload)
                else:
                    webpush(
                        subscription_info=sub["subscription"], data=payload,
                        vapid_private_key=private, vapid_claims={"sub": subject},
                        ttl=int(GRACE.total_seconds()),
                    )
                if not force:
                    sub["lastSent"] = local.date().isoformat()
                sub.pop("failures", None)
                tally["sent"] += 1
            except WebPushException as e:
                code = getattr(e.response, "status_code", 0)
                # 404 and 410 are the push service saying this device is gone
                # for good. Anything else may be transient; three strikes.
                sub["failures"] = sub.get("failures", 0) + 1
                if code in (404, 410) or sub["failures"] >= 3:
                    subs.pop(endpoint, None)
                    tally["dropped"] += 1
                else:
                    tally["failed"] += 1
            except (requests.RequestException, ValueError, KeyError, TypeError):
                # A network wobble, or one corrupt record. Neither is a reason
                # to abandon the pass and leave everyone else unsent. Anything
                # outside this set is a bug and is allowed to crash loudly.
                sub["failures"] = sub.get("failures", 0) + 1
                tally["failed"] += 1
        _write(subs)
    return tally


# --------------------------------------------------------------------------
# the API
# --------------------------------------------------------------------------
def build_app():
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel, Field

    class Sub(BaseModel):
        subscription: dict
        time: str = Field(default="08:00", max_length=5)
        days: list[int] = Field(default_factory=list, max_length=7)
        tz: str = Field(default="Africa/Nairobi", max_length=64)

    class Drop(BaseModel):
        endpoint: str = Field(max_length=1024)

    class Refresh(BaseModel):
        oldEndpoint: str = Field(max_length=1024)
        subscription: dict

    app = FastAPI(title="Kenya Pulse push", docs_url=None, redoc_url=None)
    # The app is served from its own origin, so the browser will not let it
    # call this one without permission. Only the app's origins are given it.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o for o in os.environ.get(
            "KP_PUSH_ORIGINS",
            "https://kenyapulse.gachichio.org,https://kenya-pulse-app.vercel.app",
        ).split(",") if o],
        allow_methods=["GET", "POST"], allow_headers=["content-type"],
    )

    @app.get("/health")
    def health():
        with _Lock():
            return {"ok": True, "subscriptions": len(_read())}

    @app.get("/key")
    def key():
        pub = os.environ.get("KP_VAPID_PUBLIC", "")
        if not pub:
            raise HTTPException(503, "no key configured")
        return {"key": pub}

    @app.post("/subscribe")
    def subscribe(s: Sub):
        endpoint = str(s.subscription.get("endpoint", ""))
        if not valid_endpoint(endpoint):
            raise HTTPException(400, "endpoint not a known push service")
        if not valid_time(s.time):
            raise HTTPException(400, "time must be HH:MM")
        days = sorted({d for d in s.days if isinstance(d, int) and 0 <= d <= 6})
        tz = s.tz if valid_tz(s.tz) else "Africa/Nairobi"
        with _Lock():
            subs = _read()
            if endpoint not in subs and len(subs) >= MAX_SUBS:
                raise HTTPException(503, "at capacity")
            prior = subs.get(endpoint, {})
            subs[endpoint] = {
                "subscription": s.subscription, "time": s.time, "days": days, "tz": tz,
                "added": prior.get("added") or datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "lastSent": prior.get("lastSent"),
            }
            _write(subs)
        return {"ok": True}

    @app.post("/unsubscribe")
    def unsubscribe(d: Drop):
        with _Lock():
            subs = _read()
            subs.pop(d.endpoint, None)
            _write(subs)
        return {"ok": True}

    @app.post("/refresh")
    def refresh(r: Refresh):
        """The browser rotated the subscription. Carry the preferences over
        rather than making the device set them again."""
        endpoint = str(r.subscription.get("endpoint", ""))
        if not valid_endpoint(endpoint):
            raise HTTPException(400, "endpoint not a known push service")
        with _Lock():
            subs = _read()
            prior = subs.pop(r.oldEndpoint, None)
            if prior is None:
                raise HTTPException(404, "unknown subscription")
            prior["subscription"] = r.subscription
            prior.pop("failures", None)
            subs[endpoint] = prior
            _write(subs)
        return {"ok": True}

    return app


# --------------------------------------------------------------------------
# keys
# --------------------------------------------------------------------------
def genkeys(path: Path) -> int:
    """Writes the pair to an env file at mode 600 and prints only the public
    half. A private key that reaches a terminal reaches the scrollback, the
    shell history and any log shipping the box does."""
    import base64

    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    from py_vapid import Vapid

    if path.exists():
        print(f"{path} exists — refusing to overwrite a live key", file=sys.stderr)
        return 1
    v = Vapid()
    v.generate_keys()

    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    priv_b64 = b64(v.private_key.private_numbers().private_value.to_bytes(32, "big"))
    pub_b64 = b64(v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))

    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(f"KP_VAPID_PRIVATE={priv_b64}\n")
        fh.write(f"KP_VAPID_PUBLIC={pub_b64}\n")
        fh.write("KP_VAPID_SUBJECT=mailto:hello@gachichio.org\n")
    print(f"Wrote {path} (mode 600). Public key, which the app fetches:\n{pub_b64}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Kenya Pulse push service")
    p.add_argument("--serve", action="store_true", help="run the API")
    p.add_argument("--send-due", action="store_true", help="one sending pass, then exit")
    p.add_argument("--test-send", action="store_true",
                   help="send to every subscription now, ignoring the schedule")
    p.add_argument("--genkeys", metavar="ENVFILE", help="create a VAPID pair at mode 600")
    p.add_argument("--list", action="store_true", help="count subscriptions")
    p.add_argument("--port", type=int, default=8100)
    a = p.parse_args()

    if a.genkeys:
        return genkeys(Path(a.genkeys).expanduser())
    if a.list:
        subs = _read()
        print(f"{len(subs)} subscription(s)")
        for s in subs.values():
            print(f"  {s.get('time')} {s.get('days')} {s.get('tz')} last={s.get('lastSent')}")
        return 0
    if a.test_send:
        print(json.dumps(send_due(force=True)))
        return 0
    if a.send_due:
        print(json.dumps(send_due()))
        return 0
    if a.serve:
        import uvicorn
        # localhost only. Caddy is the one thing that faces the internet.
        uvicorn.run(build_app(), host="127.0.0.1", port=a.port, log_level="warning")
        return 0
    p.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
