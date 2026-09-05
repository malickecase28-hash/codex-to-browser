from pathlib import Path

path = Path("packages/node/tests/unit/dev-autonomous-api.test.ts")
text = path.read_text(encoding="utf-8")
old = '''import type {
  DevAutonomousChatPort,
  DevAutonomousLocalPort
} from "../../src/dev/autonomous-engine.js";
'''
new = '''import {
  DevAutonomousPortError,
  type DevAutonomousChatPort,
  type DevAutonomousLocalPort
} from "../../src/dev/autonomous-engine.js";
'''
if text.count(old) != 1:
    raise SystemExit("expected one autonomous engine type import")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
