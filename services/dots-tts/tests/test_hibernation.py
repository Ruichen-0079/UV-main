"""GPU hibernation lifecycle tests — fakes only, no real CUDA."""
import sys
import threading
import time
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Service


class FakeTensor:
    def float(self):
        return self

    def detach(self):
        return self

    def cpu(self):
        return self

    def squeeze(self):
        return self

    def numpy(self):
        return np.ones(1600, dtype=np.float32) * 0.1


class FakeRuntime:
    def __init__(self):
        self.alive = True

    def generate(self, **_kwargs):
        if not self.alive:
            raise RuntimeError("runtime unloaded")
        return {"audio": FakeTensor(), "sample_rate": 1600}


def _service(factory=None, idle=0.05):
    created = []

    def default_factory():
        rt = FakeRuntime()
        created.append(rt)
        return rt

    service = Service(
        runtime_factory=factory or default_factory,
        idle_hibernate_seconds=idle,
        start_idle_watcher=False,
    )
    service.model_path = Path("/nonexistent/model")
    service.reference = Path("/nonexistent/ref.wav")
    service.transcript = "reference transcript"
    service.created = created
    return service


class HibernationTests(unittest.TestCase):
    def test_warm_idle_unload_resume_synthesize_idle_shutdown(self):
        service = _service(idle=0.05)
        service.runtime = service._create_runtime()
        service.state = "ready"
        service._touch()
        self.assertEqual(service.health_payload()["gpu_resident"], True)

        # Force idle past threshold
        service._last_activity = time.monotonic() - 1.0
        self.assertTrue(service.try_hibernate())
        self.assertEqual(service.state, "hibernated")
        self.assertIsNone(service.runtime)
        payload = service.health_payload()
        self.assertTrue(payload["ready_on_demand"])
        self.assertFalse(payload["model_loaded"])
        self.assertFalse(payload["gpu_resident"])

        wav = b"RIFF" + b"\0" * 8 + b"WAVE" + b"\0" * 32
        service._generate_wav_bytes = lambda text, language: wav
        status, body = service.synthesize(dict(requestId="r1", text="Hello", language="EN"))
        self.assertEqual(status, 200)
        self.assertEqual(body, wav)
        self.assertEqual(service.state, "ready")
        self.assertIsNotNone(service.runtime)
        self.assertGreaterEqual(len(service.created), 2)

        service._last_activity = time.monotonic() - 1.0
        self.assertTrue(service.try_hibernate())
        service.shutdown()
        self.assertIsNone(service.runtime)
        self.assertEqual(service.state, "hibernated")

    def test_concurrent_request_around_hibernation_boundary(self):
        service = _service(idle=60)
        service.runtime = service._create_runtime()
        service.state = "ready"
        gate = threading.Event()
        started = threading.Event()

        def slow_generate(text, language):
            started.set()
            gate.wait(2.0)
            return b"RIFFxxxxWAVExxxx" + b"\0" * 28

        service._generate_wav_bytes = slow_generate
        results = []

        def first():
            results.append(service.synthesize(dict(requestId="a", text="One", language="EN")))

        t = threading.Thread(target=first)
        t.start()
        self.assertTrue(started.wait(1.0))
        # Second request while first holds the lock (including during restore path)
        status_busy, body_busy = service.synthesize(dict(requestId="b", text="Two", language="EN"))
        self.assertEqual(status_busy, 429)
        self.assertEqual(body_busy["error"], "busy")
        # Idle hibernate must not steal the lock mid-synthesis
        service._last_activity = time.monotonic() - 999
        self.assertFalse(service.try_hibernate())
        gate.set()
        t.join(2.0)
        self.assertEqual(results[0][0], 200)
        self.assertEqual(service.state, "ready")

    def test_cancellation_before_and_after_restore(self):
        service = _service(idle=60)
        service.state = "hibernated"
        service.runtime = None
        service.cancel("gone")
        status, body = service.synthesize(dict(requestId="gone", text="Hello", language="EN"))
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "cancelled")
        # Restore path then cancel fence after generate
        service.state = "hibernated"
        service.runtime = None

        def gen(text, language):
            service.cancel("late")
            return b"RIFF" + b"\0" * 40

        service._generate_wav_bytes = gen
        status, body = service.synthesize(dict(requestId="late", text="Hello", language="EN"))
        self.assertEqual(status, 409)

    def test_shutdown_while_hibernated_and_while_loaded(self):
        service = _service(idle=60)
        service.runtime = service._create_runtime()
        service.state = "ready"
        service.shutdown()
        self.assertIsNone(service.runtime)
        self.assertEqual(service.state, "hibernated")

        service2 = _service(idle=60)
        service2.state = "hibernated"
        service2.runtime = None
        service2.shutdown()
        self.assertEqual(service2.state, "hibernated")
        self.assertIsNone(service2.runtime)

    def test_no_race_hibernate_requires_lock(self):
        service = _service(idle=0.01)
        service.runtime = service._create_runtime()
        service.state = "ready"
        service._last_activity = time.monotonic() - 10
        service.lock.acquire()
        try:
            self.assertFalse(service.try_hibernate())
            self.assertEqual(service.state, "ready")
            self.assertIsNotNone(service.runtime)
        finally:
            service.lock.release()
        self.assertTrue(service.try_hibernate())
        self.assertEqual(service.state, "hibernated")

    def test_idle_disabled(self):
        service = _service(idle=0)
        service.runtime = service._create_runtime()
        service.state = "ready"
        service._last_activity = time.monotonic() - 999
        self.assertFalse(service.try_hibernate())
        self.assertEqual(service.state, "ready")

    def test_health_truthful_for_hibernated(self):
        service = _service(idle=60)
        service.state = "hibernated"
        service.runtime = None
        payload = service.health_payload()
        self.assertEqual(payload["state"], "hibernated")
        self.assertTrue(payload["ready_on_demand"])
        self.assertFalse(payload["gpu_resident"])

    def test_watcher_unloads_after_idle(self):
        service = Service(
            runtime_factory=FakeRuntime,
            idle_hibernate_seconds=0.05,
            start_idle_watcher=True,
        )
        service.model_path = Path("/x")
        service.reference = Path("/y")
        service.transcript = "t"
        service.runtime = FakeRuntime()
        service.state = "ready"
        service._last_activity = time.monotonic() - 1.0
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and service.state != "hibernated":
            time.sleep(0.05)
        self.assertEqual(service.state, "hibernated")
        service.shutdown()


if __name__ == "__main__":
    unittest.main()
