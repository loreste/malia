"""Offline installer failure tests. Never modifies the user's shell profile."""
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def test_staging_checksum_upgrade_and_missing_binary(self):
        with tempfile.TemporaryDirectory(prefix="malia installer ") as temporary:
            root = Path(temporary)
            mock = root / "tools"
            mock.mkdir()
            curl = mock / "curl"
            curl.write_text('''#!/bin/sh
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -w) shift ;;
    https:*) url="$1" ;;
  esac
  shift
done
case "$url" in
  */SHA256SUMS) cp "$MALIA_TEST_SUMS" "$out" ;;
  *) cp "$MALIA_TEST_ARCHIVE" "$out"; printf '200' ;;
esac
''')
            curl.chmod(0o755)
            archive = root / "archive.tar.gz"
            sums = root / "SHA256SUMS"
            install = root / "installed space"
            env = dict(os.environ, PATH=str(mock) + os.pathsep + os.environ["PATH"],
                       MALIA_INSTALL_DIR=str(install), MALIA_NO_MODIFY_PATH="1",
                       MALIA_TEST_SUMS=str(sums), MALIA_TEST_ARCHIVE=str(archive))
            def prepare(name="malia", version="1.0", valid=True):
                script = f"#!/bin/sh\necho malia {version}\nexit {0 if valid else 1}\n".encode()
                with tarfile.open(archive, "w:gz") as tar:
                    entry = tarfile.TarInfo(name)
                    entry.size, entry.mode = len(script), 0o755
                    tar.addfile(entry, io.BytesIO(script))
                checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
                sums.write_text("\n".join(f"{checksum}  malia-{target}.tar.gz" for target in
                    ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "linux-x64-musl", "linux-arm64-musl"]))
            def run():
                return subprocess.run(["sh", str(ROOT / "scripts/install.sh")], env=env,
                                      capture_output=True, text=True, timeout=20)
            prepare()
            self.assertEqual(run().returncode, 0)
            self.assertEqual(run().returncode, 0)
            self.assertTrue((install / "bin/jse").is_file())
            before = (install / "bin/malia").read_bytes()
            sums.write_text("bad checksum")
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual((install / "bin/malia").read_bytes(), before)
            prepare(name="unrelated")
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual((install / "bin/malia").read_bytes(), before)
            prepare(version="2.0", valid=False)
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual((install / "bin/malia").read_bytes(), before)
            prepare(version="2.0")
            self.assertEqual(run().returncode, 0)
            self.assertIn(b"2.0", (install / "bin/malia").read_bytes())


if __name__ == "__main__":
    unittest.main()
