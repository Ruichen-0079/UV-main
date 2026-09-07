"""Narrow dots output correction; never changes internal or trailing pauses."""
import numpy as np


def trim_leading_silence(audio, sample_rate):
    window = max(1, round(sample_rate * 0.01))
    # Conservative absolute RMS gate, at most three seconds removed, with 80ms lead-in.
    limit = min(len(audio), round(sample_rate * 3.08))
    for start in range(0, limit, window):
        if np.sqrt(np.mean(np.square(audio[start:start + window], dtype=np.float64))) >= 0.003:
            cut = max(0, start - round(sample_rate * 0.08))
            return audio[cut:] if cut >= round(sample_rate * 0.2) else audio
    return audio  # Quiet/all-silent output is never blindly truncated.
