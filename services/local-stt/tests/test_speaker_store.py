import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from speaker_store import (  # noqa: E402
    SpeakerStore,
    attach_cluster_voice_profile_matches,
    cluster_audio_is_matchable,
    collect_cluster_audio,
    is_mixed_capture,
    unique_cluster_ids,
    voice_profile_match_from_identify,
)


def unit(index: int, dim: int = 4) -> np.ndarray:
    vector = np.zeros(dim, dtype=np.float32)
    vector[index] = 1.0
    return vector


class SpeakerStoreTests(unittest.TestCase):
    def test_enrolled_profile_matches_same_vector(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.55)
            store.enroll("vp_7", "desk-mic", unit(0))
            result = store.identify(unit(0))
            self.assertEqual(result["identity"], "KNOWN")
            self.assertEqual(result["speakerId"], "vp_7")
            match = voice_profile_match_from_identify(result)
            self.assertEqual(match, {"status": "MATCHED", "voiceProfileId": "vp_7"})
            self.assertNotIn("score", match)
            self.assertNotIn("personId", match)

    def test_below_threshold_is_no_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.95)
            store.enroll("vp_7", "desk-mic", unit(0))
            other = unit(0) * 0.1 + unit(1) * 0.9
            result = store.identify(other)
            self.assertEqual(result["identity"], "UNKNOWN")
            self.assertIsNone(result["speakerId"])
            self.assertEqual(voice_profile_match_from_identify(result), {"status": "NO_MATCH"})

    def test_persisted_vectors_reload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            first = SpeakerStore(directory, dim=4, threshold=0.55)
            first.enroll("vp_7", "desk-mic", unit(2))
            self.assertEqual(stat.S_IMODE(os.stat(directory / "speakers.json").st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(directory / "speakers.npz").st_mode), 0o600)
            payload = json.loads((directory / "speakers.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["speakers"][0]["speakerId"], "vp_7")
            self.assertNotIn("embedding", json.dumps(payload))
            restarted = SpeakerStore(directory, dim=4, threshold=0.55)
            result = restarted.identify(unit(2))
            self.assertEqual(result["speakerId"], "vp_7")

    def test_legacy_speaker_id_is_not_a_person_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SpeakerStore(Path(tmp), dim=4, threshold=0.55)
            store.enroll("ruichen", "label-only", unit(1))
            result = store.identify(unit(1))
            match = voice_profile_match_from_identify(result)
            self.assertEqual(match["voiceProfileId"], "ruichen")
            self.assertNotEqual(match["voiceProfileId"], "person_ruichen")
            public = store.list_public()[0]
            self.assertNotIn("personId", public)
            serialized = json.dumps({"identify": result, "match": match, "public": public})
            self.assertNotIn("personId", serialized)
            self.assertNotIn("canonicalName", serialized)


class ClusterMatchTests(unittest.TestCase):
    def test_two_unknown_clusters_stay_distinct(self) -> None:
        segments = [
            {"startMs": 0, "endMs": 1000, "speaker": "0"},
            {"startMs": 1100, "endMs": 2200, "speaker": "1"},
        ]
        self.assertEqual(unique_cluster_ids(segments), ["0", "1"])
        self.assertTrue(is_mixed_capture(segments))
        attached = attach_cluster_voice_profile_matches(
            segments,
            {
                "0": {"status": "NO_MATCH"},
                "1": {"status": "NO_MATCH"},
            },
        )
        self.assertEqual(attached[0]["speaker"], "0")
        self.assertEqual(attached[1]["speaker"], "1")
        self.assertNotEqual(attached[0]["speaker"], attached[1]["speaker"])

    def test_known_and_unknown_clusters_remain_distinct(self) -> None:
        segments = [
            {"startMs": 0, "endMs": 800, "speaker": "0"},
            {"startMs": 900, "endMs": 1700, "speaker": "1"},
        ]
        attached = attach_cluster_voice_profile_matches(
            segments,
            {
                "0": {"status": "MATCHED", "voiceProfileId": "vp_7"},
                "1": {"status": "NO_MATCH"},
            },
        )
        self.assertEqual(attached[0]["voiceProfileMatch"]["voiceProfileId"], "vp_7")
        self.assertEqual(attached[1]["voiceProfileMatch"]["status"], "NO_MATCH")
        self.assertNotEqual(attached[0]["speaker"], attached[1]["speaker"])

    def test_mixed_capture_does_not_share_one_whole_audio_match(self) -> None:
        segments = [
            {"startMs": 0, "endMs": 500, "speaker": "0"},
            {"startMs": 600, "endMs": 1200, "speaker": "1"},
        ]
        self.assertTrue(is_mixed_capture(segments))
        # Whole-audio identity is omitted for mixed captures; each cluster is
        # independent, including when one cluster has no matchable audio.
        attached = attach_cluster_voice_profile_matches(
            segments,
            {
                "0": {"status": "MATCHED", "voiceProfileId": "vp_7"},
                "1": {"status": "NO_MATCH"},
            },
        )
        ids = {item["voiceProfileMatch"].get("voiceProfileId") for item in attached}
        self.assertIn("vp_7", ids)
        self.assertIn(None, ids)

    def test_cluster_span_collection_concatenates_same_cluster_only(self) -> None:
        samples = np.arange(16000, dtype=np.float32)
        segments = [
            {"startMs": 0, "endMs": 250, "speaker": "0"},
            {"startMs": 250, "endMs": 500, "speaker": "1"},
            {"startMs": 500, "endMs": 750, "speaker": "0"},
        ]
        clips = collect_cluster_audio(samples, 16000, segments)
        self.assertEqual(set(clips), {"0", "1"})
        self.assertEqual(clips["0"].shape[0], 8000)
        self.assertEqual(clips["1"].shape[0], 4000)
        self.assertTrue(np.array_equal(clips["0"], np.concatenate([samples[0:4000], samples[8000:12000]])))
        self.assertFalse(cluster_audio_is_matchable(clips["1"], 16000))
        self.assertTrue(cluster_audio_is_matchable(clips["0"], 16000))


if __name__ == "__main__":
    unittest.main()
