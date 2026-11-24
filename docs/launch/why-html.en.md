# In the AI era, your notes should be HTML, not Markdown

> Read the typeset version (made with hReader itself): <https://jingmox.github.io/hReader/examples/why-html.html> (Chinese)

## Two moments that changed my mind

The first: I was using AI to organize my notes and dropped in a bunch of audio recordings. In Markdown, audio is either a bare link or a naked player; summaries, transcripts, and speakers end up scattered. By the fifth clip the note was unreadable.

The second: at a hackathon, several teams skipped slides and presented straight from an HTML page their AI had generated on the spot. Charts, collapsible sections, motion — better looking than a deck, and far easier to change.

Together they raised a question: **why did Markdown win notes and docs in the first place, and does that reason still hold when AI does the writing?**

## Markdown won by not letting you do layout

HTML is strictly more expressive than Markdown: columns, cards, side-by-side comparisons, figures, disclosures, audio and video, inline charts. Nobody disputes that.

Yet for a decade and a half, writers chose Markdown — because **the cost of layout was paid by humans**. Hand-writing HTML is exhausting, so we accepted a format that says "just write text, let the tool handle style." Markdown's victory was a trade: give up expressiveness, get low cost.

## AI just paid that cost

Today, more and more notes and documents are drafted by AI while humans direct, review, and revise. For a model, emitting HTML costs about the same as emitting Markdown.

So HTML's expressiveness is suddenly **free**. You don't need to know CSS to get a note with cards, comparisons, collapsible transcripts, and playable recordings.

## But AI layout is too free — and that's a new kind of mess

Anyone who has tried this hits the next problem: **the AI lays things out differently every time.**

One document uses cards, the next uses tables; one has a purple gradient, the next a navy border; ten documents give you ten different "warning" boxes. Each looks fine on its own; put them in one library and it's messier than Markdown ever was.

My audio-stuffed note had the same root cause: **HTML wasn't too weak — it had no constraints.**

## The fix: a constrained layout system for AI

hReader gives the AI a set of rules for how things must look:

- **7 semantic components** — KPI grid, insight callout, warning callout, split comparison, deep-dive disclosure, step timeline, diagram stage. The AI decides _what_ a piece of content is, not _how it looks_.
- **Content and appearance are separate** — components only declare meaning (`data-hr-component="callout-warning"`); the theme decides the look. Re-theming never touches prose and costs zero tokens.
- **Tone can be constrained too** — alongside the visual theme, give the AI a writing-style spec and a forbidden-phrase list, then lint with one command.

Ask an AI for ten meeting notes and you get ten equally tidy documents, with recordings, summaries, and transcripts always in the same place.

## Patch, don't regenerate

AI-generated documents always need edits. The usual move — "regenerate the whole thing" — fixes one spot and breaks three others.

hReader gives every block a stable `data-hr-id`. An agent reads the outline, reads only the block it needs, and replaces only that block, with atomic writes and undo.

Humans get the same precision: select a sentence in the reader, write "use a concrete example here," and the agent picks up the annotation, patches just that block, and the page live-reloads. **You point; the AI does the work.**

## The file is yours

Every document is a plain `.html` file on your own disk. Double-click and it opens in any browser — nothing to install.

It isn't tied to any AI vendor. Claude Code, Cursor, Codex, DeepSeek, or any agent that speaks MCP or Skills can read and write the same file. The more AI output you have, the more it matters that it lives with you.

## Beyond notes

Notes are just the start. HTML can hold far more than Markdown: slides, reports, dashboards, interactive explainers — even a calculator sitting next to a financial table.

All of these share the "AI is too free" problem, so they share the fix: **let HTML provide the expressiveness; let constraints provide the consistency.** The unified embed shell has shipped (`media-card`: audio or video + caption + a collapsible transcript, in one kind of card); next on the roadmap are more themes, Markdown import, and controlled interactive components.

## Where it honestly stands

hReader v1.0 was just open-sourced and it's early:

- 8 components and 1 theme so far, with five document kinds (note, report, minutes, brief, slides);
- layout constraints are checked on write (`hr check`, plus `warnings` in every `hr patch` receipt), but they only warn and never reject a write;
- the desktop app needs Node 22 on your machine and the installers aren't signed yet, so MCP or the Agent Skill is the recommended starting point.

If you write notes or reports with AI — or already present with HTML — I'd love for you to try it, and to hear what you'd want to embed in a document.

- GitHub: <https://github.com/JingMox/hReader>
- Gallery: <https://jingmox.github.io/hReader/>
