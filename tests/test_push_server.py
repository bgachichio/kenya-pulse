"""The push API's routes, run against a throwaway store with no network and no real keys.

Run:  python -m unittest tests.test_push_server      (needs requirements-push.txt and httpx for Starlette's test client)
This is what CI runs after installing the pinned requirements, so a dependency update that breaks the API fails before it ships.
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
GOOD = {"subscription": {"endpoint": "https://fcm.googleapis.com/fcm/send/abc123", "keys": {"p256dh": "x", "auth": "y"}},
        "time": "07:30", "days": [0, 1, 2], "tz": "Africa/Nairobi"}


def load_app():
    os.environ["KP_VAPID_PUBLIC"] = "TESTKEY"
    spec = importlib.util.spec_from_file_location("push_server_under_test", HERE / "push_server.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.STORE = Path(tempfile.mkdtemp()) / "subs.json"      # never the real subscriber file
    m.LOCK = m.STORE.with_suffix(".lock")
    from starlette.testclient import TestClient
    return m, TestClient(m.build_app())


class PushServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m, cls.c = load_app()

    def test_health_counts_subscribers(self):
        before = self.c.get("/health").json()["subscriptions"]
        self.assertEqual(self.c.post("/subscribe", json=GOOD).status_code, 200)
        r = self.c.get("/health"); self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True, "subscriptions": before + 1})

    def test_key_route(self):
        r = self.c.get("/key"); self.assertEqual((r.status_code, r.json()), (200, {"key": "TESTKEY"}))

    def test_unknown_push_service_is_refused(self):
        bad = dict(GOOD, subscription={"endpoint": "https://evil.example/x", "keys": {}})
        r = self.c.post("/subscribe", json=bad); self.assertEqual(r.status_code, 400)

    def test_bad_time_is_refused(self):
        r = self.c.post("/subscribe", json=dict(GOOD, time="25:99")); self.assertEqual(r.status_code, 400)

    def test_malformed_body_is_a_422(self):
        self.assertEqual(self.c.post("/subscribe", json={"nope": 1}).status_code, 422)

    def test_cors_allows_only_the_app_origin(self):
        ok = self.c.options("/subscribe", headers={"Origin": "https://kenyapulse.gachichio.org", "Access-Control-Request-Method": "POST"})
        self.assertEqual(ok.status_code, 200); self.assertEqual(ok.headers.get("access-control-allow-origin"), "https://kenyapulse.gachichio.org")
        other = self.c.options("/subscribe", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        self.assertNotEqual(other.headers.get("access-control-allow-origin"), "https://evil.example")


if __name__ == "__main__":
    unittest.main()
