# Avoid AI Writing — API editing contract (distilled)

Source: [conorbronsdon/avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing), MIT, v3.37.0.
The full skill, pattern catalog and detector scripts are kept in this folder. This file is the concise contract injected into the API rewrite prompt and the quality judge.

## Editing contract

- **Source fidelity.** Ground every factual addition or correction in the supplied source. Preserve meaning, attribution, quantities, units, negation, conditions, causal relationships and level of certainty. Never invent facts, experience, stance or confidence.
- **Detection alone does not authorize rewriting.** A match is a candidate; it becomes a finding only after reading its context; it becomes an edit only when the requested scope authorizes it.
- **Protected content.** Quotations, attributed passages, code, tables, URLs, identifiers, frontmatter and other protected regions retain their content. Report findings inside them; do not rewrite them.
- **Context and intent.** Preserve weak matches, legitimate technical uses, necessary hedges, intentional rhetoric and authentic irregularities. When context is missing, do not force an edit.
- **Voice and register.** With no explicit transformation request, preserve the source's established voice and register. Do not add personality, humour or opinion.
- **Minimal edits.** Change the justified, authorized spans; leave already-human passages untouched. Do not rewrite the whole document to demonstrate editing.
- **No-op is valid.** If there is no justified finding, return the text unchanged.

## What to remove (only when justified)

- P0 credibility killers: cutoff disclaimers, chatbot artifacts, empty offers to help.
- Stock AI vocabulary, significance boilerplate, formulaic openers, announced emphasis, copula avoidance, negative parallelism, tacked-on `-ing` evaluations, three-item rhetorical lists.
- Repeated sentence skeletons, invented contrasts, cue colons, meta-narrative, restatement sentences, signpost connectives at every paragraph start.
- Em-dash chains, two or more semicolons in a paragraph, parenthetical asides in most sentences.

Do not turn this into a detector-evasion pass. The patterns are a quality signal, not proof of authorship.
