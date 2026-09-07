import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audio_output import trim_leading_silence
from server import Service

class OutputTests(unittest.TestCase):
    def test_only_leading_silence(self):
        speech = np.concatenate([np.ones(500) * .1, np.zeros(700), np.ones(500) * .1, np.zeros(600)])
        original = np.concatenate([np.zeros(1500), speech])
        result = trim_leading_silence(original, 1000)
        np.testing.assert_array_equal(result, np.concatenate([np.zeros(80), speech]))
    def test_bounded_and_quiet(self):
        for original in [np.zeros(5000), np.ones(5000)*.001, np.concatenate([np.zeros(3200), np.ones(500)])]:
            np.testing.assert_array_equal(trim_leading_silence(original, 1000), original)
    def test_short_lead_preserved(self):
        original = np.concatenate([np.zeros(100), np.ones(500)])
        np.testing.assert_array_equal(trim_leading_silence(original, 1000), original)
    def test_warmup_busy_and_cancel_before_admission(self):
        service = Service()
        body = dict(requestId="one", text="Hello", language="EN")
        self.assertEqual(service.synthesize(body)[0], 503)
        service.state = "ready"
        service.lock.acquire()
        self.assertEqual(service.synthesize(body)[0], 429)
        service.lock.release()
        service.cancel("one")
        self.assertEqual(service.synthesize(body)[0], 409)
        for i in range(1000): service.cancel(str(i))
        self.assertEqual(len(service.cancelled), 256)

if __name__ == "__main__": unittest.main()
