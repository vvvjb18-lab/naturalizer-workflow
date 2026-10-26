# Skills used by the API rewrite

The API rewrite is not an agent, so it cannot call the ZCode `Skill` tool. Instead the pipeline loads a concise `PROMPT.md` from the selected skill folder and injects it into the rewrite prompt. The full `SKILL.md`, references and scripts stay here for reference and for local checks.

| Folder | Source | License | How it is used |
|---|---|---|---|
| `academic-humanizer/` | [junbolian/Academic-Humanizer](https://github.com/junbolian/Academic-Humanizer) | MIT | `PROMPT.md` is injected into the API rewrite; `scripts/check_revision.py` can be run as an extra invariant check |
| `avoid-ai-writing/` | [conorbronsdon/avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing) | MIT | `PROMPT.md` is used as the editing/quality contract; `detector/` and `scripts/` can be run locally |

`polish.config.json`:

```json
"skill": "academic-humanizer"
```

Set `"skill": "none"` to disable injection. The loader reads `PROMPT.md` first, then `SKILL.md`, and truncates at about 14k characters.

The skills are writing-quality tools, not AI-detector verdicts. Removing AI-isms may or may not change a Turnitin score; always verify with the official report.
