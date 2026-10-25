"""Build the Python launcher using the repository's single Node CLI source."""

import sys
from pathlib import Path

from setuptools import setup

sys.path.insert(0, str(Path(__file__).parent / "python"))
from build_support import NodeCliBuild  # noqa: E402

setup(cmdclass={"build_py": NodeCliBuild})
