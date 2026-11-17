from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

DRIVER_PATH = Path(sys.argv.pop(1))
MODULE = {"__file__": str(DRIVER_PATH)}
with patch.object(sys, "argv", ["driver.py", "submit", "/unused"]):
    source = DRIVER_PATH.read_text().rsplit('\nif sys.argv[1]', 1)[0]
    exec(compile(source, 'driver.py', 'exec'), MODULE)


class NotebookDriverCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)
        MODULE["STATE"] = self.state
        MODULE["STARTUP_SECONDS"] = 0.1
        MODULE["INTERRUPT_SECONDS"] = 0.1


    def request(self):
        return dict(root=str(self.state), code="value", timeout_ms=1, id="cell")


