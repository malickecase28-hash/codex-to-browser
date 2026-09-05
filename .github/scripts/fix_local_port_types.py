from pathlib import Path

path = Path("packages/node/src/dev/codex-cli-local-port.ts")
text = path.read_text(encoding="utf-8")
old = "  private readonly model?: string;\n  private readonly profile?: string;"
new = "  private readonly model: string | undefined;\n  private readonly profile: string | undefined;"
if text.count(old) != 1:
    raise SystemExit(f"expected one strict optional-property patch site, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
