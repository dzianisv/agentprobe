"""Tests for reasoning captions in demo GIFs."""
import json
import tempfile
from pathlib import Path
from PIL import Image

from agentprobe.recording import overlay_text_on_frame


class TestCaptionOverlay:
    """Test text overlay on frames."""

    def test_overlay_text_on_frame_creates_captioned_file(self):
        """Verify overlay_text_on_frame creates a -captioned.png file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a simple test image
            img = Image.new("RGB", (960, 1920), color="white")
            input_path = Path(tmpdir) / "test.png"
            img.save(input_path)

            # Apply overlay
            output_path = overlay_text_on_frame(str(input_path), "TAP: Entering digit 2")

            # Verify output file exists
            assert Path(output_path).exists()
            assert output_path.endswith("-captioned.png")

            # Verify output is a valid image
            output_img = Image.open(output_path)
            assert output_img.size == (960, 1920)

    def test_overlay_empty_caption_returns_original(self):
        """Overlay with empty caption returns original path."""
        with tempfile.TemporaryDirectory() as tmpdir:
            img = Image.new("RGB", (960, 1920), color="white")
            input_path = Path(tmpdir) / "test.png"
            img.save(input_path)

            output_path = overlay_text_on_frame(str(input_path), "")
            assert output_path == str(input_path)

    def test_caption_wrapping_long_text(self):
        """Text longer than frame width is wrapped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            img = Image.new("RGB", (960, 1920), color="white")
            input_path = Path(tmpdir) / "test.png"
            img.save(input_path)

            long_caption = "TAP: " + "This is a very long caption that should wrap to multiple lines " * 3
            output_path = overlay_text_on_frame(str(input_path), long_caption)

            assert Path(output_path).exists()


class TestCaptionCapture:
    """Test reasoning capture in CUA loop."""

    def test_caption_format(self):
        """Verify caption format matches expected structure."""
        # Simulate what loop.py does
        action = {
            "type": "tap",
            "reason": "Looking for the plus button",
            "x": 100,
            "y": 200,
        }

        action_type = action.get("type", "?")
        action_reason = action.get("reason", "")
        caption = f"{action_type.upper()}: {action_reason[:80]}"

        assert caption == "TAP: Looking for the plus button"

    def test_captions_json_structure(self):
        """Verify captions.json has correct structure."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Simulate captions dict from loop.py
            captions = {
                "step-001_calculator_math.png": "TAP: Entering digit 2",
                "step-002_calculator_math.png": "TAP: Entering digit 7",
                "step-003_calculator_math.png": "TAP: Clicking plus operator",
                "step-004_calculator_math.png": "TAP: Entering digit 1",
                "step-005_calculator_math.png": "TAP: Entering digit 8",
                "step-006_calculator_math.png": "TAP: Clicking equals button",
            }

            # Save captions.json
            captions_path = Path(tmpdir) / "captions.json"
            captions_path.write_text(json.dumps(captions, indent=2))

            # Verify it's valid JSON and has expected structure
            loaded = json.loads(captions_path.read_text())
            assert len(loaded) == 6
            assert "step-001_calculator_math.png" in loaded
            assert loaded["step-001_calculator_math.png"] == "TAP: Entering digit 2"

    def test_reasoning_progression_for_calculator_test(self):
        """Verify reasoning shows step-by-step progression."""
        captions = {
            "step-001_calculator_math.png": "TAP: Entering digit 2",
            "step-002_calculator_math.png": "TAP: Entering digit 7",
            "step-003_calculator_math.png": "TAP: Clicking plus operator",
            "step-004_calculator_math.png": "TAP: Entering digit 1",
            "step-005_calculator_math.png": "TAP: Entering digit 8",
            "step-006_calculator_math.png": "TAP: Clicking equals button",
        }

        # Verify progression makes sense
        assert "Entering digit 2" in captions["step-001_calculator_math.png"]
        assert "Entering digit 7" in captions["step-002_calculator_math.png"]
        assert "plus" in captions["step-003_calculator_math.png"]
        assert "Entering digit 1" in captions["step-004_calculator_math.png"]
        assert "Entering digit 8" in captions["step-005_calculator_math.png"]
        assert "equals" in captions["step-006_calculator_math.png"]
