#!/usr/bin/env python3
"""Install the portable visual-artifacts skill into local Claude Code. Python 3.9+."""
import argparse
import json
from pathlib import Path, PurePosixPath
import shutil
import tempfile
import time

NAME = "build-visual-artifacts"
EMBEDDED_FILES = None
START = "<!-- visual-artifacts-default:start -->"
END = "<!-- visual-artifacts-default:end -->"
RULE = """For every new or revised visual React/HTML artifact, use the build-visual-artifacts skill. Default to a readable dark theme, generous spacing, accessible interaction, and one active panel for multi-stage carousel explanations. Verify the target runtime before choosing imports. Follow explicit user style requests and existing project design systems. Apply this rule to visual artifacts, not unrelated documents or backend work."""


def payload():
    if EMBEDDED_FILES is not None:
        return EMBEDDED_FILES
    source = Path(__file__).resolve().parent.parent
    if not (source / "SKILL.md").is_file():
        raise ValueError("Run the self-contained installer or keep this script inside the complete skill folder.")
    return {str(p.relative_to(source)): p.read_text(encoding="utf-8")
            for p in sorted(source.rglob("*")) if p.is_file()
            and "__pycache__" not in p.parts and p.suffix != ".pyc"}


def updated_rule(original):
    block = START + "\n" + RULE + "\n" + END
    if START not in original and END not in original:
        return original + ("\n\n" if original else "") + block + "\n"
    if original.count(START) != 1 or original.count(END) != 1:
        raise ValueError("Default-rule markers are incomplete or duplicated. Fix them before installing.")
    start, end = original.index(START), original.index(END)
    if end < start:
        raise ValueError("Default-rule markers are in the wrong order.")
    return original[:start] + block + original[end + len(END):]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude-dir", type=Path, default=Path.home() / ".claude",
                        help="Claude configuration directory (default: ~/.claude)")
    parser.add_argument("--skill-only", action="store_true", help="Skip adding the visual-artifact preference to CLAUDE.md")
    parser.add_argument("--dry-run", action="store_true", help="Print planned paths without writing anything")
    args = parser.parse_args()
    files = payload()
    for relative, content in files.items():
        path = PurePosixPath(relative)
        if path.is_absolute() or ".." in path.parts or not isinstance(content, str):
            raise ValueError("Invalid file in the installer payload.")
    directory = args.claude_dir.expanduser().resolve()
    target = directory / "skills" / NAME
    preference = directory / "CLAUDE.md"
    original = preference.read_text(encoding="utf-8") if preference.exists() else ""
    updated = original if args.skill_only else updated_rule(original)
    print(f"Skill location: {target}")
    if not args.skill_only:
        print(f"Default visual-artifact preference: {preference}")
    print("No npm packages, MCP servers, or account settings are changed.")
    if args.dry_run:
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    existing = ({str(p.relative_to(target)): p.read_text(encoding="utf-8")
                 for p in target.rglob("*") if p.is_file()
                 and "__pycache__" not in p.parts and p.suffix != ".pyc"}
                if target.is_dir() else None)
    if existing != files:
        stamp = str(time.time_ns())
        backup = target.with_name(target.name + ".backup-" + stamp)
        # Keep backups outside skills/ so Claude does not discover them as duplicate skills.
        backup = directory / "skill-backups" / backup.name
        stage = Path(tempfile.mkdtemp(prefix="visual-artifacts-", dir=directory))
        moved = False
        try:
            for relative, content in files.items():
                destination = stage / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(content, encoding="utf-8")
            if target.exists():
                backup.parent.mkdir(parents=True, exist_ok=True)
                target.rename(backup)
                moved = True
            stage.rename(target)
        except Exception:
            if moved and not target.exists():
                backup.rename(target)
            raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)
        if moved:
            print(f"Previous skill preserved: {backup}")
        print(f"Installed {len(files)} skill files.")
    else:
        print("Skill is already current.")
    if updated != original:
        if preference.exists():
            backup_file = preference.with_name(preference.name + ".backup-" + str(time.time_ns()))
            shutil.copy2(preference, backup_file)
            print(f"Previous instructions preserved: {backup_file}")
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                         prefix="visual-preference-", delete=False) as handle:
            handle.write(updated)
            temporary = Path(handle.name)
        try:
            temporary.replace(preference)
        finally:
            temporary.unlink(missing_ok=True)
        print("Added the default visual-artifact preference; existing instructions preserved.")
    print("Open a new local Claude Code session and run /build-visual-artifacts.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Installation failed: {exc}")
