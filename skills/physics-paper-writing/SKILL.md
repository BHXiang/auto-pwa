---
name: physics-paper-writing
description: 'Use when drafting or revising a physics research paper: argument chain, section moves, the judgment audit, readability rules, and the blind-reader test with a context-free sub-agent.'
---

# Physics paper writing

A workflow for turning a result into a paper that a physicist outside the project
can read, check, and cite. Written for HEP/experimental physics; the method
applies to any quantitative paper.

**Core rule.** The reader is not in your head. Every claim must be either shown in
the paper (number, figure, table, equation) or explicitly marked as an assumption
or limitation. Papers usually fail not because the physics is wrong, but because
the reader cannot tell what was demonstrated from what was asserted.

---

## 1. Write the argument chain first

Before drafting, write one paragraph:

```
field stake -> unresolved bottleneck -> precise question -> proposed move
-> evidence path -> contribution -> boundary
```

If a link is missing, fix the research or the evidence, not the prose. Every
section must be readable as *context -> content -> conclusion*; if a link is
missing, mark it as a framing problem instead of hiding it with adjectives.

## 2. Revise through the funnel (top-down)

1. **Document** — one claim? who is the reader? which venue?
2. **Sections** — does each have one job, in the right order?
3. **Paragraphs** — one idea each, topic sentence, explicit connection.
4. **Sentences** — actor in subject, action in verb, short subject–verb distance.
5. **Words** — delete intensifiers; replace vague claims with measured ones.
6. **Mechanics** — citations, notation, figure/table consistency.

Never polish sentences before the section order is right.

## 3. Section moves

- **Abstract**: context -> gap -> approach -> 2–4 quantitative results -> scoped
  implication -> boundary. No citations. No claim that is not in the paper.
- **Introduction**: field stake -> what is already solved -> the bottleneck that
  is *not* solved -> why the obvious fix is insufficient -> what this paper does
  -> contribution preview with the type of evidence.
- **Problem / requirements**: define the object and the loop; state requirements
  R1…Rn; map each requirement to the section that satisfies it.
- **Mechanism**: failure mode -> mechanism -> why it is checkable/monotone -> one
  concrete rejected example. Do not duplicate the motivation already given in
  the introduction; point back to it.
- **Evaluation**: question -> samples and protocol (pre-registered criteria) ->
  action -> evidence -> comparison -> local answer. Always report the sample size,
  the baseline, and the cost alongside the accuracy.
- **Discussion**: advance -> relation to prior work -> alternative explanations ->
  limitations (specific) -> future work.
- **Conclusion**: contribution -> decisive evidence -> scoped implication. It must
  not be more certain than the results.

## 4. The judgment audit (the most common failure)

For every "success" claim, write next to it: the pre-registered criterion, the
measured value, and whether it passed. If it did not pass, say so in the same
sentence. Reviewers will find the mismatch; better that you find it first.

Distinguish carefully:

- "model content recovered" vs "fit converged";
- "accepted because significant" vs "retained because the truth was known" vs
  "diagnostic step" vs "bookkeeping (parameters fixed, likelihood unchanged)";
- "the fit is near the truth" vs a 14σ difference whose statistical error is
  small because the model is mismatched.

Give `n`, degrees of freedom, and the threshold formula (e.g. `2ΔNLL ~ χ²_k`,
`ΔNLL = 3` for two parameters at `p ≈ 0.05`). If a rule has exceptions, state the
rule and the exception in one place; never let the results section contradict the
method section. A rule that is stated but not followed is worse than no rule.

## 5. Terminology and readability

- Define every term at first use: jargon imported from another field (fold, pure
  function, monotone, ledger, digest, skill, context), internal tool names, and
  domain notation (`J^{PC}`, `[J,P]`, BWR, ONE, trans).
- Prefer a plain phrase plus the term in parentheses: "a summary recomputed from
  the log (the digest)".
- Replace "we can see that" with the number; replace "significantly" with the
  statistical meaning; delete "notably, importantly, remarkably, seamlessly".
- One idea per paragraph; topic sentence; no paragraph longer than ~8 sentences.
- Define symbols once and use one word for one object. Do not alternate
  round/iteration/fit/trial without defining the four terms.
- Figures must be self-contained: axes, units, what is plotted, and the claim
  they support. If a figure only repeats the neighbouring table, delete it.
- Tables: row labels must fit; `n` and denominators must be visible; caveats go
  in the caption or the text.

## 6. The blind-reader test (the core method)

The author cannot see the paper's gaps. A reader who has never seen the code can.

### Protocol

1. **Spawn a reader with no inherited context.** Use a sub-agent that is *not*
   forked from the writing conversation and has no access to the source code,
   docs, git history, or other analyses. Tell it explicitly what it may read:
   the manuscript and the figures only.
2. **Give it a reader persona, not an author persona.** State the audience, e.g.
   "a HEP physicist who does PWA but not LLM/agent development". Do not pick an
   expert in the exact method; pick the reader you are writing for.
3. **Ask for a restatement first.** "In 3–5 sentences, in your own words: what
   problem, what approach, what evidence, what boundary. Do not copy the
   abstract." If the restatement is wrong, the paper's story is wrong.
4. **Split the problems into two lists.**
   - **A. Implementation details** that need the code (file format, default
     value, exact algorithm). These are normal; the reader can consult the
     repository. List them, do not rewrite the paper for them.
   - **B. Sentences the reader cannot understand without the code.** For each:
     quote the sentence, give the section, name the specific uncertainty, and
     propose a rewrite. These are the writing defects.
5. **Ask for consistency and evidence checks.** Does each success claim match its
   stated criterion? Do abstract, introduction, and conclusion tell the same
   story? Are there numbers that do not add up? Is any conclusion stronger than
   the evidence?
6. **Ask which figures/tables are not self-contained, redundant, or do not
   support the claim.**
7. **Ask: if only three things could be fixed, which three?** This forces the
   reader to rank, and gives the author a revision order.

Do not defend the paper in the prompt. Ask for a direct, unkind, specific report.

### Prompt template

```
You are a [target reader, e.g. HEP physicist who does PWA but not LLM/agent
development]. You have not seen the code, the documentation, or the project.
Read only [manuscript path] and the figures [list the files]. Do not read source
code, docs, git, runs, or other analyses; do not search the web. Do not modify
any file. This is a pure reading test.

Read as a referee: title, abstract, introduction, section by section, and stop at
each figure and table. Then answer, in [language]:

1. In your own words (3-5 sentences): what problem does the paper address, what
   does it propose, what is the evidence, and where is the boundary? Do not copy
   the abstract.
2. Where does the narrative break ("why is this here?", "how did we get here?")?
   Quote the sentence and give the section.
3. Split every problem into two lists:
   A. implementation details you would need the code to answer (normal, not a
      writing defect);
   B. sentences you cannot understand even though no code is needed (quote the
      sentence, name the specific uncertainty, suggest a rewrite).
   Check in particular: are field-specific and internal terms defined at first
   use? are the statistical criteria and thresholds explained? can each figure
   and table be read without the text?
4. Does each "success" claim match the criterion stated earlier? Do abstract,
   introduction, and conclusion agree? Is any conclusion stronger than the
   evidence? Are there numbers that do not add up?
5. Which figures/tables are not self-contained, redundant, or do not support the
   claim?
6. If only three things could be fixed, which three, in order?
```

### Triage

- **B items and consistency items** -> fix the paper.
- **A items** -> either add one sentence of justification, or accept them and
  state in the availability section that the code is the reference.
- **If the report is generic or mostly A**, the method failed; do not pretend
  otherwise. Try a different persona or a more specific prompt, or conclude that
  the paper is already at the target reader's level.

### Why it works

The reader has no access to the code, so it cannot fill gaps from memory; it sees
only what the paper says. The A/B split prevents the author from dismissing all
feedback as "they don't know the implementation". Quotable sentences make the
feedback actionable, and the "three things" ranking turns it into a revision
plan.

### Common failure modes

- The reader sneaks a look at the repository. Forbid it explicitly, list the
  allowed files, and check its answer for code-level details it could not have
  known.
- The persona is too close to the authors ("expert in exactly this method"). Then
  it will share the authors' blind spots. Use the actual target reader.
- The prompt asks "is it good?" — too vague. Ask for restatement, quotes, and
  categories.
- The author argues with the report instead of triaging it. Fix first, discuss
  later.
- Re-running the reader in the same session. Use a fresh reader; do not show it
  the old report.

## 7. Revision order after the report

1. **Consistency and judgment** — a wrong claim is worse than a clumsy sentence.
2. **Story** — section order, missing links, unsupported transitions.
3. **B sentences** — plain language and definitions.
4. **Figures and tables** — self-contained, delete decorative ones.
5. **Re-run the blind reader** (fresh session, same persona). Stop when the B
   list contains only terms that are defined in the paper.

## 8. Final checklist

- [ ] Title names the object and the contribution, not a slogan.
- [ ] Abstract has 2–4 numbers and a boundary; no citations.
- [ ] Each section has one job; each paragraph one claim.
- [ ] Every number is traceable to an artifact, table, or equation.
- [ ] Every success has its criterion and value; every failure is stated.
- [ ] Every figure/table is self-contained, referenced, and supports a claim.
- [ ] Terminology is defined once; no synonym drift.
- [ ] Limitations are specific: n, samples, one run, no background, fixed
      parameters, unverified attribution.
- [ ] The conclusion does not exceed the evidence.
- [ ] Read the compiled PDF, not only the `.tex`.

## 9. Anti-patterns

- A prose "skill" or prompt offered as a substitute for a mechanism that must be
  enforced in code.
- A figure whose only content is the table next to it.
- "Recovered exactly" when the fit-quality criterion failed.
- "Neighbourhood" for a 14σ difference.
- A success story that skips the failed step.
- One number in the abstract and another in the table.
- Implementation jargon (fold, monotone, ledger, digest) used before definition.
- A rule stated in the method section and broken in the results section.

## 10. Quick Chinese summary

1. 先写论证链，再写正文；按 "文档→章节→段落→句子→词" 的顺序改。
2. 每个"成功"都配上预先登记的判据、数值、是否通过；不通过就明说。
3. 术语在首次出现处用大白话解释，再给术语。
4. 用**无上下文的 sub-agent 当读者**：只给它论文和图，让它复述主旨、引用看不懂的句子，并把问题分成 A（需要看代码，正常）和 B（句子本身看不懂，要改）。
5. 按 B 类和一致性问题的清单改，再换一个新读者复测。
