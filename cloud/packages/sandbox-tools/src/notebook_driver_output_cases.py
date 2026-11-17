import tracemalloc
from unittest.mock import patch
from notebook_fixture_support import MODULE, NotebookDriverCase


class NotebookOutputTests(NotebookDriverCase):
    def test_large_single_messages_have_bounded_utf8_allocation(self):
        half = MODULE["TEXT_MAX_BYTES"] // 2
        for character in ("x", "🙂"):
            for already_full in (False, True):
                with self.subTest(character=character, already_full=already_full):
                    chunk = "HEAD" + character * (60 * 1024 * 1024 // len(character.encode())) + "TAIL"
                    buffer = MODULE["TextBuffer"]()
                    prefix = "previous" * half if already_full else ""
                    buffer.append(prefix)
                    tracemalloc.start()
                    try:
                        buffer.append(chunk)
                        _, peak = tracemalloc.get_traced_memory()
                    finally:
                        tracemalloc.stop()
                    self.assertLess(peak, 100000)
                    encoded = (prefix + chunk).encode()
                    self.assertEqual(buffer.total, len(encoded))
                    self.assertEqual(buffer.head, encoded[:half])
                    self.assertEqual(buffer.tail, encoded[-half:])
                    self.assertTrue(buffer.render().endswith("TAIL"))

    def test_text_buffer_is_bounded_and_keeps_head_and_tail(self):
        buffer = MODULE["TextBuffer"]()
        buffer.append("HEAD" + "x" * MODULE["TEXT_MAX_BYTES"])
        tracemalloc.start()
        for _ in range(100000):
            buffer.append("logs")
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        buffer.append("TRACEBACK")
        self.assertLess(peak, 100000)
        self.assertLessEqual(len(buffer.head) + len(buffer.tail), MODULE["TEXT_MAX_BYTES"])
        self.assertTrue(buffer.render().startswith("HEAD"))
        self.assertTrue(buffer.render().endswith("TRACEBACK"))
        self.assertIn("bytes omitted", buffer.render())
        small = MODULE["TextBuffer"]()
        small.append("small")
        self.assertEqual(small.render(), "small")


    def test_oversized_artifacts_are_rejected_before_join_or_decode(self):
        for length in (60 * 1024 * 1024, 180 * 1024 * 1024):
            value = "A" * length
            for payload in (value, [value]):
                with self.subTest(length=length, fragmented=isinstance(payload, list)):
                    tracemalloc.start()
                    try:
                        with patch.object(MODULE["base64"], "b64decode") as decode:
                            with self.assertRaises(MODULE["ArtifactBudgetError"]):
                                MODULE["artifact_bytes"](payload, "image/png", 0)
                            decode.assert_not_called()
                        _, peak = tracemalloc.get_traced_memory()
                    finally:
                        tracemalloc.stop()
                    self.assertLess(peak, 100000)
        # Count rejection must precede even reading the next artifact value.
        with self.assertRaises(MODULE["ArtifactBudgetError"]):
            MODULE["artifact_bytes"](object(), "image/png", MODULE["ARTIFACTS_MAX"])
        self.assertEqual(MODULE["artifact_bytes"]("aGVsbG8=", "image/png", 0), b"hello")
        self.assertEqual(MODULE["artifact_bytes"](["<b>", "hi</b>"], "text/html", 0), b"<b>hi</b>")


    def test_png_limit_includes_padding_without_allocating_oversized_output(self):
        limit = MODULE["ARTIFACT_MAX_BYTES"]
        for size in (limit, limit + 1):
            encoded = MODULE["base64"].b64encode(b"x" * size).decode()
            if size == limit:
                self.assertEqual(len(MODULE["artifact_bytes"](encoded, "image/png", 0)), limit)
                fragmented = [encoded[:-2], encoded[-2:-1], encoded[-1:], ""]
                self.assertEqual(len(MODULE["artifact_bytes"](fragmented, "image/png", 0)), limit)
            else:
                with patch.object(MODULE["base64"], "b64decode") as decode:
                    with self.assertRaises(MODULE["ArtifactBudgetError"]):
                        MODULE["artifact_bytes"](encoded, "image/png", 0)
                    decode.assert_not_called()


