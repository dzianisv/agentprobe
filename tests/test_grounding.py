"""Unit tests for agentprobe.grounding -- the Holo coordinate scaling contract.

Holo's grounding API returns {"x", "y"} normalized to [0, 1000] on each axis.
Getting the scale-to-pixels conversion wrong means every click misses its
target, so this is tested directly and in isolation from any network call.
"""
import pytest

from agentprobe.grounding import HoloRateLimiter, scale_holo_coords


# ---------------------------------------------------------------------------
# scale_holo_coords
# ---------------------------------------------------------------------------

def test_scale_holo_coords_center():
    # Holo's normalized center (500, 500) on a 1080x2340 screen (the
    # emulator's actual resolution) should land near its pixel center.
    x, y = scale_holo_coords(500, 500, 1080, 2340)
    assert x == 540
    assert y == 1170


def test_scale_holo_coords_top_left_origin():
    x, y = scale_holo_coords(0, 0, 1080, 2340)
    assert (x, y) == (0, 0)


def test_scale_holo_coords_bottom_right_clamped_in_bounds():
    # x=1000, y=1000 is Holo's max value; scaled naively that's
    # (1080, 2340), one pixel past the last valid index on each axis --
    # must clamp to stay a valid tap target.
    x, y = scale_holo_coords(1000, 1000, 1080, 2340)
    assert x == 1079
    assert y == 2339


def test_scale_holo_coords_arbitrary_point_matches_manual_math():
    # 250/1000 * 1080 = 270; 750/1000 * 2340 = 1755
    x, y = scale_holo_coords(250, 750, 1080, 2340)
    assert x == 270
    assert y == 1755


def test_scale_holo_coords_different_resolution_not_hardcoded():
    # Must actually scale by the passed-in image size, not a fixed constant --
    # same normalized point, different screen, different pixel result.
    x1, y1 = scale_holo_coords(500, 500, 1080, 2340)
    x2, y2 = scale_holo_coords(500, 500, 800, 480)
    assert (x1, y1) != (x2, y2)
    assert (x2, y2) == (400, 240)


def test_scale_holo_coords_rejects_non_positive_dimensions():
    with pytest.raises(ValueError):
        scale_holo_coords(500, 500, 0, 2340)
    with pytest.raises(ValueError):
        scale_holo_coords(500, 500, 1080, -1)


# ---------------------------------------------------------------------------
# HoloRateLimiter -- pure timing logic, no network
# ---------------------------------------------------------------------------

def test_rate_limiter_first_call_does_not_block(monkeypatch):
    slept = []
    monkeypatch.setattr("agentprobe.grounding.time.sleep", lambda s: slept.append(s))
    limiter = HoloRateLimiter(min_interval_s=12.5)
    limiter.wait()
    assert slept == []  # nothing to wait for on the very first call


def test_rate_limiter_second_call_waits_remaining_interval(monkeypatch):
    fake_now = [1000.0]
    monkeypatch.setattr("agentprobe.grounding.time.monotonic", lambda: fake_now[0])
    slept = []
    monkeypatch.setattr("agentprobe.grounding.time.sleep", lambda s: slept.append(s))

    limiter = HoloRateLimiter(min_interval_s=12.5)
    limiter.wait()  # t=1000, no sleep
    fake_now[0] = 1003.0  # only 3s elapsed, need to wait 9.5s more
    limiter.wait()
    assert slept == [9.5]


def test_rate_limiter_no_wait_if_interval_already_elapsed(monkeypatch):
    fake_now = [1000.0]
    monkeypatch.setattr("agentprobe.grounding.time.monotonic", lambda: fake_now[0])
    slept = []
    monkeypatch.setattr("agentprobe.grounding.time.sleep", lambda s: slept.append(s))

    limiter = HoloRateLimiter(min_interval_s=12.5)
    limiter.wait()
    fake_now[0] = 1020.0  # 20s elapsed, well past the 12.5s minimum
    limiter.wait()
    assert slept == []
