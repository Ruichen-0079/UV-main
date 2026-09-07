"""Opt-in real CPU model gate. Never writes the daily acoustic profile store."""
import base64
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
import wave


@unittest.skipUnless(os.environ.get("YUVI_STT_MODEL_DIR"), "set YUVI_STT_MODEL_DIR for real model validation")
class LiveSpeechTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from server import SttEngine, _read_wav_bytes
        cls.temp = tempfile.TemporaryDirectory(prefix="yuvi-acoustic-gate-")
        cls.models = Path(os.environ["YUVI_STT_MODEL_DIR"])
        cls.engine = SttEngine(cls.models, 4, Path(cls.temp.name), 0.55)
        cls.read_wav = staticmethod(_read_wav_bytes)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def body(self, samples, rate=16000):
        import numpy as np
        raw = io.BytesIO()
        with wave.open(raw, "wb") as wav:
            wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
            wav.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
        return {"audioBase64": base64.b64encode(raw.getvalue()).decode(), "mimeType": "audio/wav"}

    def test_real_transcript_enrollment_later_match_restart_and_no_match(self):
        import numpy as np
        from speaker_store import SpeakerStore
        fixture = self.models / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/test_wavs/zh.wav"
        rate, samples = self.read_wav(fixture.read_bytes())
        result = self.engine.handle_transcribe({**self.body(samples, rate), "diarize": True, "identify": True})
        self.assertTrue(result["text"].strip())
        self.assertEqual(result["language"], "zh")
        for segment in result["segments"] or []:
            self.assertIn("text", segment)
        split = len(samples) // 2
        self.engine.handle_enroll({**self.body(samples[:split], rate), "voiceProfileId": "gate-speaker", "label": "Test acoustic profile"})
        later = self.engine.handle_identify(self.body(samples[split:], rate))
        self.assertEqual(later["voiceProfileMatch"], {"status": "MATCHED", "voiceProfileId": "gate-speaker"})
        self.engine.store = SpeakerStore(Path(self.temp.name), self.engine.extractor.dim, 0.55)
        self.assertEqual(self.engine.handle_identify(self.body(samples[split:], rate))["voiceProfileMatch"], later["voiceProfileMatch"])
        self.assertEqual(self.engine.handle_identify(self.body(np.zeros(32000)))["voiceProfileMatch"], {"status": "NO_MATCH"})
        for name in ("speakers.json", "speakers.npz"):
            self.assertEqual((Path(self.temp.name) / name).stat().st_mode & 0o777, 0o600)
        self.engine.store.delete("gate-speaker")

    def test_mixed_capture_has_cluster_local_profiles_and_words(self):
        from speaker_store import collect_cluster_audio
        rate, samples = self.read_wav((self.models / "0-four-speakers-zh.wav").read_bytes())
        segments = self.engine.diarize(rate, samples)
        clips = collect_cluster_audio(samples, rate, segments)
        self.assertGreaterEqual(len(clips), 2)
        for cluster, clip in clips.items():
            self.engine.store.enroll(f"gate-cluster-{cluster}", "Test cluster", self.engine.embed(rate, clip))
        result = self.engine.handle_transcribe({**self.body(samples, rate), "diarize": True, "identify": True})
        self.assertIsNone(result["voiceProfileMatch"])
        self.assertIsNone(result["identity"])
        matched = {}
        for segment in result["segments"]:
            self.assertIn("text", segment)
            match = segment["voiceProfileMatch"]
            self.assertEqual(match["status"], "MATCHED")
            matched.setdefault(segment["speaker"], set()).add(match["voiceProfileId"])
        self.assertTrue(all(len(ids) == 1 for ids in matched.values()))
        self.assertEqual(len({next(iter(ids)) for ids in matched.values()}), len(matched))
        self.assertEqual(self.engine.handle_identify(self.body(samples, rate))["voiceProfileMatch"], {"status": "NO_MATCH"})
        with self.assertRaisesRegex(ValueError, "one speaker"):
            self.engine.handle_enroll({**self.body(samples, rate), "voiceProfileId": "mixed", "label": "Invalid mixed enrollment"})
        for cluster in clips:
            self.engine.store.delete(f"gate-cluster-{cluster}")


if __name__ == "__main__":
    unittest.main()
