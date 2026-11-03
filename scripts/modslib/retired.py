from __future__ import annotations

from dataclasses import dataclass

from modslib.generate import MARKETPLACE_NAME


@dataclass(frozen=True)
class Retired:
    """A mod removed from the catalog whose existing installs must still be removable."""

    name: str
    has_codex: bool
    has_opencode: bool

    @property
    def plugin_id(self) -> str:
        return f"{self.name}@{MARKETPLACE_NAME}"

    def manual_steps(self) -> list[str]:
        """What the installer cannot do for the hosts it never installed into."""
        steps: list[str] = []
        if self.has_codex:
            steps.append(
                f"codex: run `codex plugin remove {self.plugin_id}`; leftover "
                f'[hooks.state."{self.plugin_id}:..."] entries in ~/.codex/config.toml are harmless and can be deleted'
            )
        if self.has_opencode:
            steps.append(
                f"opencode: remove the entry ending in mods/{self.name}/opencode from plugins in opencode.json"
            )
        steps.append(
            f"optional: delete ~/.config/iuliandita-mods/{self.name}.json and the {self.name} files "
            "under ~/.local/share/iuliandita-mods"
        )
        return steps


RETIRED: dict[str, Retired] = {
    r.name: r
    for r in (
        Retired("prompt-gate", has_codex=True, has_opencode=True),
        Retired("skill-pick", has_codex=True, has_opencode=True),
    )
}
