#!/usr/bin/env python3
"""Push service tests. No network, no browser.

Run:  python3 tests/push_test.py
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

WORK = Path(tempfile.mkdtemp(prefix="kp-push-test-"))
os.environ["KP_PUSH_STORE"] = str(WORK / "subs.json")
os.environ["KP_DATA_JSON"] = str(ROOT / "tests" / "live.json")
os.environ["KP_VAPID_PUBLIC"] = "BNDIYVuTpnD3ht9Dn0WOi9cuRgXWrAnjmtjXOs3DhVsLuz2EgVT9EQP8Pc2CEC5t2N2Yg9uRGfMaT5JJUlRIfxw"

import push_server as P  # noqa: E402

PASS = FAIL = 0


def ok(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


CHROME = "https://fcm.googleapis.com/fcm/send/abc123"
APPLE = "https://web.push.apple.com/QRSTUV"


def sub(time="08:00", days=(1, 2, 3, 4, 5), tz="Africa/Nairobi", last=None, endpoint=CHROME):
    return {"subscription": {"endpoint": endpoint, "keys": {"p256dh": "x", "auth": "y"}},
            "time": time, "days": list(days), "tz": tz, "lastSent": last}


def at(iso):
    return datetime.fromisoformat(iso).replace(tzinfo=timezone.utc)


print("── ENDPOINT ALLOWLIST (an open relay would be an SSRF)")
ok("accepts Chrome/FCM", P.valid_endpoint(CHROME))
ok("accepts Apple", P.valid_endpoint(APPLE))
ok("accepts Mozilla", P.valid_endpoint("https://updates.push.services.mozilla.com/wpush/v2/xyz"))
ok("rejects an internal address", not P.valid_endpoint("https://169.254.169.254/latest/meta-data/"))
ok("rejects localhost", not P.valid_endpoint("https://127.0.0.1:8100/steal"))
ok("rejects plain http", not P.valid_endpoint("http://fcm.googleapis.com/fcm/send/a"))
ok("rejects a lookalike domain", not P.valid_endpoint("https://fcm.googleapis.com.evil.test/x"))
ok("rejects rubbish", not P.valid_endpoint("not-a-url"))

print("\n── WHEN A DEVICE IS DUE (Nairobi is UTC+3)")
# 08:00 Nairobi on Monday 24 August 2026 == 05:00 UTC
ok("due at the chosen minute", P.is_due(sub(), at("2026-08-24T05:00:00")))
ok("not due an hour early", not P.is_due(sub(), at("2026-08-24T04:00:00")))
ok("still due inside the grace window", P.is_due(sub(), at("2026-08-24T07:30:00")))
ok("dropped once too late to be breakfast", not P.is_due(sub(), at("2026-08-24T09:00:00")))
ok("not sent twice on the same day",
   not P.is_due(sub(last="2026-08-24"), at("2026-08-24T05:30:00")))
ok("sends again the next day", P.is_due(sub(last="2026-08-24"), at("2026-08-25T05:00:00")))

print("\n── DAYS (the app counts Sunday as 0, Python counts Monday as 0)")
# 30 August 2026 is a Sunday, 29 August a Saturday
ok("weekdays-only skips Sunday", not P.is_due(sub(), at("2026-08-30T05:00:00")))
ok("weekdays-only skips Saturday", not P.is_due(sub(), at("2026-08-29T05:00:00")))
ok("Sunday-only fires on Sunday", P.is_due(sub(days=(0,)), at("2026-08-30T05:00:00")))
ok("Saturday-only fires on Saturday", P.is_due(sub(days=(6,)), at("2026-08-29T05:00:00")))
ok("no days selected never fires", not P.is_due(sub(days=()), at("2026-08-24T05:00:00")))

print("\n── OTHER TIMEZONES")
# 08:00 in London (BST, UTC+1) on that Monday == 07:00 UTC
ok("London device fires on London time", P.is_due(sub(tz="Europe/London"), at("2026-08-24T07:00:00")))
ok("London device not fired on Nairobi time",
   not P.is_due(sub(tz="Europe/London"), at("2026-08-24T05:00:00")))
ok("an unknown timezone is not a crash", not P.is_due(sub(tz="Mars/Olympus"), at("2026-08-24T05:00:00")))

print("\n── THE NOTIFICATION TEXT")
title, body = P.briefing(P.load_data())
ok("titled Kenya Pulse", title == "Kenya Pulse")
ok("leads with policy and prices", "CBR" in body and "Inflation" in body, body.replace("\n", " | "))
ok("names the best real return", "Best real return" in body, body.replace("\n", " | "))
ok("short enough for a lock screen", len(body) <= 140, f"{len(body)} chars")
ok("survives an empty feed", P.briefing({})[1] != "")

print("\n── THE API")
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(P.build_app())
r = client.post("/subscribe", json={"subscription": {"endpoint": CHROME, "keys": {}},
                                    "time": "07:30", "days": [1, 3, 5], "tz": "Africa/Nairobi"})
ok("subscribe accepted", r.status_code == 200, r.text)
stored = json.loads(Path(os.environ["KP_PUSH_STORE"]).read_text())
ok("stored against its endpoint", CHROME in stored)
ok("kept the chosen time and days",
   stored[CHROME]["time"] == "07:30" and stored[CHROME]["days"] == [1, 3, 5])
ok("store is not world-readable",
   oct(Path(os.environ["KP_PUSH_STORE"]).stat().st_mode)[-3:] == "600",
   oct(Path(os.environ["KP_PUSH_STORE"]).stat().st_mode)[-3:])

r = client.post("/subscribe", json={"subscription": {"endpoint": CHROME, "keys": {}},
                                    "time": "09:00", "days": [0], "tz": "Africa/Nairobi"})
stored = json.loads(Path(os.environ["KP_PUSH_STORE"]).read_text())
ok("re-subscribing updates rather than duplicates", len(stored) == 1 and stored[CHROME]["time"] == "09:00")

bad = client.post("/subscribe", json={"subscription": {"endpoint": "https://169.254.169.254/x"}})
ok("rejects an endpoint that is not a push service", bad.status_code == 400, bad.text)
bad = client.post("/subscribe", json={"subscription": {"endpoint": CHROME}, "time": "25:99"})
ok("rejects a nonsense time", bad.status_code == 400, bad.text)
r = client.post("/subscribe", json={"subscription": {"endpoint": CHROME}, "tz": "Mars/Olympus"})
stored = json.loads(Path(os.environ["KP_PUSH_STORE"]).read_text())
ok("falls back to Nairobi on an unknown timezone", stored[CHROME]["tz"] == "Africa/Nairobi")
r = client.post("/subscribe", json={"subscription": {"endpoint": CHROME}, "days": [1, 9, -2, 3, 3]})
stored = json.loads(Path(os.environ["KP_PUSH_STORE"]).read_text())
ok("filters impossible days", stored[CHROME]["days"] == [1, 3], str(stored[CHROME]["days"]))

ok("serves the public key", client.get("/key").json()["key"].startswith("B"))
ok("health reports the count", client.get("/health").json()["subscriptions"] == 1)

r = client.post("/refresh", json={"oldEndpoint": CHROME,
                                  "subscription": {"endpoint": APPLE, "keys": {}}})
stored = json.loads(Path(os.environ["KP_PUSH_STORE"]).read_text())
ok("rotation carries the preferences to the new address",
   r.status_code == 200 and APPLE in stored and CHROME not in stored
   and stored[APPLE]["days"] == [1, 3])
ok("rotation of an unknown subscription is a 404",
   client.post("/refresh", json={"oldEndpoint": "https://fcm.googleapis.com/fcm/send/nope",
                                 "subscription": {"endpoint": CHROME}}).status_code == 404)

client.post("/unsubscribe", json={"endpoint": APPLE})
ok("unsubscribe empties the store",
   json.loads(Path(os.environ["KP_PUSH_STORE"]).read_text()) == {})

print("\n── A SENDING PASS")
client.post("/subscribe", json={"subscription": {"endpoint": CHROME, "keys": {}},
                                "time": "08:00", "days": [0, 1, 2, 3, 4, 5, 6], "tz": "Africa/Nairobi"})
client.post("/subscribe", json={"subscription": {"endpoint": APPLE, "keys": {}},
                                "time": "20:00", "days": [0, 1, 2, 3, 4, 5, 6], "tz": "Africa/Nairobi"})
seen = []
tally = P.send_due(now_utc=at("2026-08-24T05:00:00"), sender=lambda s, p: seen.append((s, p)))
ok("sent to the device whose hour it is", tally["sent"] == 1, json.dumps(tally))
ok("left the evening device alone", tally["skipped"] == 1, json.dumps(tally))
ok("payload carries title, body and a deep link",
   json.loads(seen[0][1]).get("url") == "/#edge" and json.loads(seen[0][1]).get("title") == "Kenya Pulse")

again = P.send_due(now_utc=at("2026-08-24T05:15:00"), sender=lambda s, p: seen.append((s, p)))
ok("a second cron run in the same hour sends nothing", again["sent"] == 0, json.dumps(again))
ok("only ever one push queued", len(seen) == 1, f"{len(seen)}")

print("\n── A DELIBERATE TEST SEND")
forced = []
tally = P.send_due(now_utc=at("2026-08-24T11:00:00"), sender=lambda s, p: forced.append(s), force=True)
ok("reaches every device whatever the hour", tally["sent"] == 2, json.dumps(tally))
after = json.loads(Path(os.environ["KP_PUSH_STORE"]).read_text())
ok("does not consume the real morning send",
   all(v.get("lastSent") != "2026-08-24" for k, v in after.items() if k == APPLE),
   json.dumps({k[-6:]: v.get("lastSent") for k, v in after.items()}))
ok("so the genuine one still fires later",
   P.is_due(after[APPLE], at("2026-08-24T17:00:00")), json.dumps(after[APPLE]))

print("\n── A DEAD DEVICE IS DROPPED")


class Gone(Exception):
    pass


def dead_sender(_s, _p):
    from pywebpush import WebPushException

    class R:
        status_code = 410
        text = "gone"
    raise WebPushException("gone", response=R())


P.send_due(now_utc=at("2026-08-25T05:00:00"), sender=dead_sender)
left = json.loads(Path(os.environ["KP_PUSH_STORE"]).read_text())
ok("a 410 removes the subscription", CHROME not in left, str(list(left)))

print("\n── REAL VAPID SIGNING AND PAYLOAD ENCRYPTION")
# Proves the generated key is usable and the body encrypts, without sending.
import base64  # noqa: E402

from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from pywebpush import WebPusher  # noqa: E402
from py_vapid import Vapid  # noqa: E402

v = Vapid()
v.generate_keys()
priv = base64.urlsafe_b64encode(
    v.private_key.private_numbers().private_value.to_bytes(32, "big")).decode().rstrip("=")

# a real receiver key pair, as a browser would mint
recv = ec.generate_private_key(ec.SECP256R1())
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat  # noqa: E402
p256dh = base64.urlsafe_b64encode(
    recv.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)).decode().rstrip("=")
auth = base64.urlsafe_b64encode(os.urandom(16)).decode().rstrip("=")

info = {"endpoint": CHROME, "keys": {"p256dh": p256dh, "auth": auth}}
try:
    from pywebpush import webpush
    curl = webpush(subscription_info=info, data=json.dumps({"title": "Kenya Pulse", "body": "x"}),
                   vapid_private_key=priv, vapid_claims={"sub": "mailto:hello@gachichio.org"},
                   curl=True, ttl=600)
    ok("VAPID header is signed with the generated key", "authorization: vapid t=" in curl.lower(),
       curl[:120])
    ok("payload is encrypted, not sent in the clear", "aes128gcm" in curl.lower())
except Exception as e:  # noqa: BLE001
    ok("VAPID signing", False, repr(e))

enc = WebPusher(info).encode(json.dumps({"a": 1}))
ok("ciphertext is bytes on the wire", isinstance(enc.get("body"), (bytes, bytearray)))

# curl mode writes the encrypted body beside the tests; it is not ours to keep
Path("encrypted.data").unlink(missing_ok=True)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
