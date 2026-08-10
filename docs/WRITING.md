# Writing conventions

These govern everything a human reads in this repository: documentation, interface copy, comments,
commit messages and pull request text.

They are in the repository because `docs/agents/writer.md` instructs the writer to read them before
every editing session, and until now they lived only on one machine. A committed agent pointing at
an uncommitted file is a broken instruction.

Where these disagree with general writing advice, these win.

---

## Voice

Be direct. Have opinions. Use specific examples and names, not vague claims. State the point first,
then support it. Trust the reader to recognise what matters without labelling it "significant" or
"important".

---

## Banned words

Never use these:

delve, dive into, navigate (figurative), underscore, bolster, foster, harness, leverage, unpack,
shed light on, pave the way, pivotal, groundbreaking, cutting-edge, transformative, game-changing,
innovative, robust, comprehensive, seamless, intricate, nuanced (as empty praise), vibrant,
multifaceted, holistic, testament, landscape (figurative), realm

---

## Banned phrases

- "In today's [fast-paced/rapidly evolving/digital] world..."
- "It's important/worth noting that..."
- "One of the most [important/significant/crucial]..."
- "When it comes to..." / "At its core..." / "At the end of the day..."
- "This is where X comes in" / "Let's break it down"
- "Plays a crucial role in..." / "It cannot be overstated..."
- "...underscoring the importance of..." / "...highlighting the need for..."
- "...reflecting a broader trend toward..." / "...marking a significant shift in..."

---

## Banned structures

- "It's not just X, it's Y"
- "Not only X, but Y"
- "This isn't about X. It's about Y."
- "No X. No Y. Just Z."

They mimic insight without providing any.

---

## Structure

- Vary paragraph and sentence length. No uniform blocks.
- Never use the "Bold term: explanation sentence" list format. It is the most recognisable AI
  pattern there is.
- No signposting. Not "Let's explore", not "Now let's turn to". Make the point.
- Do not open with a sweeping contextual statement. Do not close with a summary or an inspirational
  wrap-up. Start and end on substance.
- Do not restate the question before answering it.

---

## Style

- Use contractions. "It's", "don't", "won't".
- Zero em dashes and zero en dashes, ever. Use commas, parentheses, a colon, or two sentences. Keep
  the hyphen only for real compounds like "real-world", never as a clause separator.
- No smart quotes, no curly quotes, no ellipsis characters. Straight quotes and plain punctuation
  only.
- Do not over-format. Plain prose often beats headers and bullets.
- Drop preamble ("Great question!"), performative enthusiasm ("exciting", "incredible",
  "powerful"), and unsolicited caveats.
- Match tone to context. Casual question, casual answer.

---

## Language

Respect the grammar of the language you are writing in. Grammar wins over every punctuation rule
above.

French specifically: write native French, not translated English. Accents are mandatory and never
optional, including on capitals where French requires them. Use the correct typography for the
language, and use guillemets where the text calls for quotation marks in French. Watch agreement,
tense and register. If a sentence reads like it was translated word by word from English, rewrite
it.

Every interface label must flex for a longer French translation, so i18n wiring exists from the
first commit even while the interface ships in English.

---

## Final check before finishing

1. Read it out loud. Any sentence that sounds like a press release gets rewritten.
2. Are you repeating the same point in different words? Say it once.
3. Does the opening sentence set the scene with a grand statement about the state of the world?
   Delete it and start with the second sentence.
4. Scan for em dashes, en dashes and smart quotes. There must be none.
